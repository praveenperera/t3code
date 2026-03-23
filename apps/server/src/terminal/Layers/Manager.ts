import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_TERMINAL_ID,
  LOCAL_EXECUTION_TARGET_ID,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { Effect, Encoding, Layer, Schema } from "effect";

import { createLogger } from "../../logger";
import { PtyAdapter, PtyAdapterShape, type PtyExitEvent, type PtyProcess } from "../Services/PTY";
import { runProcess } from "../../processRunner";
import { ServerConfig } from "../../config";
import { ExecutionTargetService } from "../../executionTarget/Services/ExecutionTargetService";
import { type SshConnectionSpec } from "../../executionTarget/ssh";
import {
  ShellCandidate,
  TerminalError,
  TerminalLaunchSpec,
  TerminalManager,
  TerminalManagerShape,
  TerminalSessionState,
  TerminalStartInput,
} from "../Services/Manager";
import { createSshTerminalProcess, type SshTerminalProcessInput } from "../sshTerminalProcess";

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);

const decodeTerminalOpenInput = Schema.decodeUnknownSync(TerminalOpenInput);
const decodeTerminalRestartInput = Schema.decodeUnknownSync(TerminalRestartInput);
const decodeTerminalWriteInput = Schema.decodeUnknownSync(TerminalWriteInput);
const decodeTerminalResizeInput = Schema.decodeUnknownSync(TerminalResizeInput);
const decodeTerminalClearInput = Schema.decodeUnknownSync(TerminalClearInput);
const decodeTerminalCloseInput = Schema.decodeUnknownSync(TerminalCloseInput);

type TerminalSubprocessChecker = (terminalPid: number) => Promise<boolean>;

function defaultShellResolver(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "bash";
}

function normalizeShellCommand(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (process.platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function shellCandidateFromCommand(command: string | null): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = path.basename(command).toLowerCase();
  if (process.platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(shellResolver: () => string): ShellCandidate[] {
  const requested = shellCandidateFromCommand(normalizeShellCommand(shellResolver()));

  if (process.platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand(process.env.ComSpec ?? null),
      shellCandidateFromCommand("powershell.exe"),
      shellCandidateFromCommand("cmd.exe"),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(process.env.SHELL)),
    shellCandidateFromCommand("/bin/zsh"),
    shellCandidateFromCommand("/bin/bash"),
    shellCandidateFromCommand("/bin/sh"),
    shellCandidateFromCommand("zsh"),
    shellCandidateFromCommand("bash"),
    shellCandidateFromCommand("sh"),
  ]);
}

function isRetryableShellSpawnError(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      const cause = (current as { cause?: unknown }).cause;
      if (cause) {
        queue.push(cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

async function checkWindowsSubprocessActivity(terminalPid: number): Promise<boolean> {
  const command = [
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" -ErrorAction SilentlyContinue`,
    "if ($children) { exit 0 }",
    "exit 1",
  ].join("; ");
  try {
    const result = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

async function checkPosixSubprocessActivity(terminalPid: number): Promise<boolean> {
  try {
    const pgrepResult = await runProcess("pgrep", ["-P", String(terminalPid)], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 32_768,
      outputMode: "truncate",
    });
    if (pgrepResult.code === 0) {
      return pgrepResult.stdout.trim().length > 0;
    }
    if (pgrepResult.code === 1) {
      return false;
    }
  } catch {
    // Fall back to ps when pgrep is unavailable.
  }

  try {
    const psResult = await runProcess("ps", ["-eo", "pid=,ppid="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 262_144,
      outputMode: "truncate",
    });
    if (psResult.code !== 0) {
      return false;
    }

    for (const line of psResult.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      if (ppid === terminalPid) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function defaultSubprocessChecker(terminalPid: number): Promise<boolean> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return false;
  }
  if (process.platform === "win32") {
    return checkWindowsSubprocessActivity(terminalPid);
  }
  return checkPosixSubprocessActivity(terminalPid);
}

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSafeTargetId(targetId: string): string {
  return Encoding.encodeBase64Url(targetId);
}

function toSessionKey(targetId: string, threadId: string, terminalId: string): string {
  return `${targetId}\u0000${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return spawnEnv;
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerEvents {
  event: [event: TerminalEvent];
}

interface TerminalManagerOptions {
  logsDir?: string;
  historyLineLimit?: number;
  ptyAdapter: PtyAdapterShape;
  resolveLaunchSpec?: (targetId: string) => Promise<TerminalLaunchSpec>;
  createSshProcess?: (input: SshTerminalProcessInput) => Promise<PtyProcess>;
  shellResolver?: () => string;
  subprocessChecker?: TerminalSubprocessChecker;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
}

export class TerminalManagerRuntime extends EventEmitter<TerminalManagerEvents> {
  private readonly sessions = new Map<string, TerminalSessionState>();
  private readonly logsDir: string;
  private readonly historyLineLimit: number;
  private readonly ptyAdapter: PtyAdapterShape;
  private readonly resolveLaunchSpec: (targetId: string) => Promise<TerminalLaunchSpec>;
  private readonly createSshProcess: (input: SshTerminalProcessInput) => Promise<PtyProcess>;
  private readonly shellResolver: () => string;
  private readonly persistQueues = new Map<string, Promise<void>>();
  private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingPersistHistory = new Map<string, string>();
  private readonly threadLocks = new Map<string, Promise<void>>();
  private readonly persistDebounceMs: number;
  private readonly subprocessChecker: TerminalSubprocessChecker;
  private readonly subprocessPollIntervalMs: number;
  private readonly processKillGraceMs: number;
  private readonly maxRetainedInactiveSessions: number;
  private subprocessPollTimer: ReturnType<typeof setInterval> | null = null;
  private subprocessPollInFlight = false;
  private readonly killEscalationTimers = new Map<PtyProcess, ReturnType<typeof setTimeout>>();
  private readonly logger = createLogger("terminal");

  constructor(options: TerminalManagerOptions) {
    super();
    this.logsDir = options.logsDir ?? path.resolve(process.cwd(), ".logs", "terminals");
    this.historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
    this.ptyAdapter = options.ptyAdapter;
    this.resolveLaunchSpec =
      options.resolveLaunchSpec ?? (async () => ({ kind: "local" }) satisfies TerminalLaunchSpec);
    this.createSshProcess = options.createSshProcess ?? createSshTerminalProcess;
    this.shellResolver = options.shellResolver ?? defaultShellResolver;
    this.persistDebounceMs = DEFAULT_PERSIST_DEBOUNCE_MS;
    this.subprocessChecker = options.subprocessChecker ?? defaultSubprocessChecker;
    this.subprocessPollIntervalMs =
      options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
    this.processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
    this.maxRetainedInactiveSessions =
      options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  async open(raw: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const input = decodeTerminalOpenInput(raw);
    const targetId = input.targetId ?? LOCAL_EXECUTION_TARGET_ID;
    return this.runWithThreadLock(input.threadId, async () => {
      const launchSpec = await this.resolveLaunchSpec(targetId);
      await this.assertValidCwd(input.cwd, launchSpec);

      const sessionKey = toSessionKey(targetId, input.threadId, input.terminalId);
      const existing = this.sessions.get(sessionKey);
      if (!existing) {
        await this.flushPersistQueue(targetId, input.threadId, input.terminalId);
        const history = await this.readHistory(targetId, input.threadId, input.terminalId);
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        const session: TerminalSessionState = {
          threadId: input.threadId,
          targetId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history,
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          supportsSubprocessPolling: false,
          runtimeEnv: normalizedRuntimeEnv(input.env),
        };
        this.sessions.set(sessionKey, session);
        this.evictInactiveSessionsIfNeeded();
        await this.startSession(session, { ...input, targetId, cols, rows }, launchSpec, "started");
        return this.snapshot(session);
      }

      const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
      const currentRuntimeEnv = existing.runtimeEnv;
      const targetCols = input.cols ?? existing.cols;
      const targetRows = input.rows ?? existing.rows;
      const runtimeEnvChanged =
        JSON.stringify(currentRuntimeEnv) !== JSON.stringify(nextRuntimeEnv);

      if (existing.cwd !== input.cwd || runtimeEnvChanged) {
        this.stopProcess(existing);
        existing.cwd = input.cwd;
        existing.runtimeEnv = nextRuntimeEnv;
        existing.history = "";
        await this.persistHistory(
          existing.targetId,
          existing.threadId,
          existing.terminalId,
          existing.history,
        );
      } else if (existing.status === "exited" || existing.status === "error") {
        existing.runtimeEnv = nextRuntimeEnv;
        existing.history = "";
        await this.persistHistory(
          existing.targetId,
          existing.threadId,
          existing.terminalId,
          existing.history,
        );
      } else if (currentRuntimeEnv !== nextRuntimeEnv) {
        existing.runtimeEnv = nextRuntimeEnv;
      }

      if (!existing.process) {
        await this.startSession(
          existing,
          { ...input, targetId, cols: targetCols, rows: targetRows },
          launchSpec,
          "started",
        );
        return this.snapshot(existing);
      }

      if (existing.cols !== targetCols || existing.rows !== targetRows) {
        existing.cols = targetCols;
        existing.rows = targetRows;
        existing.process.resize(targetCols, targetRows);
        existing.updatedAt = new Date().toISOString();
      }

      return this.snapshot(existing);
    });
  }

  async write(raw: TerminalWriteInput): Promise<void> {
    const input = decodeTerminalWriteInput(raw);
    const session = this.requireSession(input.targetId, input.threadId, input.terminalId);
    if (!session.process || session.status !== "running") {
      if (session.status === "exited") {
        return;
      }
      throw new Error(
        `Terminal is not running for thread: ${input.threadId}, terminal: ${input.terminalId}`,
      );
    }
    session.process.write(input.data);
  }

  async resize(raw: TerminalResizeInput): Promise<void> {
    const input = decodeTerminalResizeInput(raw);
    const targetId = input.targetId ?? LOCAL_EXECUTION_TARGET_ID;
    await this.runWithThreadLock(input.threadId, async () => {
      const session = this.sessions.get(toSessionKey(targetId, input.threadId, input.terminalId));
      if (!session) {
        return;
      }
      session.cols = input.cols;
      session.rows = input.rows;
      session.updatedAt = new Date().toISOString();
      if (!session.process || session.status !== "running") {
        return;
      }
      session.process.resize(input.cols, input.rows);
    });
  }

  async clear(raw: TerminalClearInput): Promise<void> {
    const input = decodeTerminalClearInput(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      const session = this.requireSession(input.targetId, input.threadId, input.terminalId);
      session.history = "";
      session.updatedAt = new Date().toISOString();
      await this.persistHistory(
        session.targetId,
        input.threadId,
        input.terminalId,
        session.history,
      );
      this.emitEvent({
        type: "cleared",
        threadId: input.threadId,
        targetId: session.targetId,
        terminalId: input.terminalId,
        createdAt: new Date().toISOString(),
      });
    });
  }

  async restart(raw: TerminalRestartInput): Promise<TerminalSessionSnapshot> {
    const input = decodeTerminalRestartInput(raw);
    const targetId = input.targetId ?? LOCAL_EXECUTION_TARGET_ID;
    return this.runWithThreadLock(input.threadId, async () => {
      const launchSpec = await this.resolveLaunchSpec(targetId);
      await this.assertValidCwd(input.cwd, launchSpec);

      const sessionKey = toSessionKey(targetId, input.threadId, input.terminalId);
      let session = this.sessions.get(sessionKey);
      if (!session) {
        const cols = input.cols ?? DEFAULT_OPEN_COLS;
        const rows = input.rows ?? DEFAULT_OPEN_ROWS;
        session = {
          threadId: input.threadId,
          targetId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          status: "starting",
          pid: null,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: new Date().toISOString(),
          cols,
          rows,
          process: null,
          unsubscribeData: null,
          unsubscribeExit: null,
          hasRunningSubprocess: false,
          supportsSubprocessPolling: false,
          runtimeEnv: normalizedRuntimeEnv(input.env),
        };
        this.sessions.set(sessionKey, session);
        this.evictInactiveSessionsIfNeeded();
      } else {
        this.stopProcess(session);
        session.cwd = input.cwd;
        session.runtimeEnv = normalizedRuntimeEnv(input.env);
      }

      const cols = input.cols ?? session.cols;
      const rows = input.rows ?? session.rows;

      session.history = "";
      await this.persistHistory(targetId, input.threadId, input.terminalId, session.history);
      await this.startSession(session, { ...input, targetId, cols, rows }, launchSpec, "restarted");
      return this.snapshot(session);
    });
  }

  async close(raw: TerminalCloseInput): Promise<void> {
    const input = decodeTerminalCloseInput(raw);
    await this.runWithThreadLock(input.threadId, async () => {
      if (input.terminalId) {
        await this.closeSession(
          input.targetId,
          input.threadId,
          input.terminalId,
          input.deleteHistory === true,
        );
        return;
      }

      const threadSessions = this.sessionsForThread(input.threadId);
      for (const session of threadSessions) {
        this.stopProcess(session);
        this.sessions.delete(toSessionKey(session.targetId, session.threadId, session.terminalId));
      }
      await Promise.all(
        threadSessions.map((session) =>
          this.flushPersistQueue(session.targetId, session.threadId, session.terminalId),
        ),
      );

      if (input.deleteHistory) {
        await this.deleteAllHistoryForThread(input.threadId);
      }
      this.updateSubprocessPollingState();
    });
  }

  dispose(): void {
    this.stopSubprocessPolling();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      this.stopProcess(session);
    }
    for (const timer of this.persistTimers.values()) {
      clearTimeout(timer);
    }
    this.persistTimers.clear();
    for (const timer of this.killEscalationTimers.values()) {
      clearTimeout(timer);
    }
    this.killEscalationTimers.clear();
    this.pendingPersistHistory.clear();
    this.threadLocks.clear();
    this.persistQueues.clear();
  }

  private async startSession(
    session: TerminalSessionState,
    input: TerminalStartInput,
    launchSpec: TerminalLaunchSpec,
    eventType: "started" | "restarted",
  ): Promise<void> {
    this.stopProcess(session);

    session.status = "starting";
    session.cwd = input.cwd;
    session.cols = input.cols;
    session.rows = input.rows;
    session.exitCode = null;
    session.exitSignal = null;
    session.hasRunningSubprocess = false;
    session.supportsSubprocessPolling = launchSpec.kind === "local";
    session.updatedAt = new Date().toISOString();

    let ptyProcess: PtyProcess | null = null;
    let startedShell: string | null = null;
    try {
      if (launchSpec.kind === "local") {
        const shellCandidates = resolveShellCandidates(this.shellResolver);
        const terminalEnv = createTerminalSpawnEnv(process.env, session.runtimeEnv);
        let lastSpawnError: unknown = null;

        const spawnWithCandidate = (candidate: ShellCandidate) =>
          Effect.runPromise(
            this.ptyAdapter.spawn({
              shell: candidate.shell,
              ...(candidate.args ? { args: candidate.args } : {}),
              cwd: session.cwd,
              cols: session.cols,
              rows: session.rows,
              env: terminalEnv,
            }),
          );

        const trySpawn = async (
          candidates: ShellCandidate[],
          index = 0,
        ): Promise<{ process: PtyProcess; shellLabel: string } | null> => {
          if (index >= candidates.length) {
            return null;
          }
          const candidate = candidates[index];
          if (!candidate) {
            return null;
          }

          try {
            const process = await spawnWithCandidate(candidate);
            return { process, shellLabel: formatShellCandidate(candidate) };
          } catch (error) {
            lastSpawnError = error;
            if (!isRetryableShellSpawnError(error)) {
              throw error;
            }
            return trySpawn(candidates, index + 1);
          }
        };

        const spawnResult = await trySpawn(shellCandidates);
        if (spawnResult) {
          ptyProcess = spawnResult.process;
          startedShell = spawnResult.shellLabel;
        }

        if (!ptyProcess) {
          const detail =
            lastSpawnError instanceof Error ? lastSpawnError.message : "Terminal start failed";
          const tried =
            shellCandidates.length > 0
              ? ` Tried shells: ${shellCandidates.map((candidate) => formatShellCandidate(candidate)).join(", ")}.`
              : "";
          throw new Error(`${detail}.${tried}`.trim());
        }
      } else {
        ptyProcess = await this.createSshProcess({
          connection: launchSpec satisfies SshConnectionSpec,
          cwd: session.cwd,
          ...(session.runtimeEnv ? { env: session.runtimeEnv } : {}),
          cols: session.cols,
          rows: session.rows,
        });
        startedShell = `ssh://${launchSpec.user ? `${launchSpec.user}@` : ""}${launchSpec.host}`;
      }

      session.process = ptyProcess;
      session.pid = ptyProcess.pid;
      session.status = "running";
      session.updatedAt = new Date().toISOString();
      session.unsubscribeData = ptyProcess.onData((data) => {
        this.onProcessData(session, data);
      });
      session.unsubscribeExit = ptyProcess.onExit((event) => {
        this.onProcessExit(session, event);
      });
      this.updateSubprocessPollingState();
      this.emitEvent({
        type: eventType,
        threadId: session.threadId,
        targetId: session.targetId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        snapshot: this.snapshot(session),
      });
    } catch (error) {
      if (ptyProcess) {
        this.killProcessWithEscalation(ptyProcess, session.threadId, session.terminalId);
      }
      session.status = "error";
      session.pid = null;
      session.process = null;
      session.hasRunningSubprocess = false;
      session.supportsSubprocessPolling = false;
      session.updatedAt = new Date().toISOString();
      this.evictInactiveSessionsIfNeeded();
      this.updateSubprocessPollingState();
      const message = error instanceof Error ? error.message : "Terminal start failed";
      this.emitEvent({
        type: "error",
        threadId: session.threadId,
        targetId: session.targetId,
        terminalId: session.terminalId,
        createdAt: new Date().toISOString(),
        message,
      });
      this.logger.error("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        error: message,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  }

  private onProcessData(session: TerminalSessionState, data: string): void {
    session.history = capHistory(`${session.history}${data}`, this.historyLineLimit);
    session.updatedAt = new Date().toISOString();
    this.queuePersist(session.targetId, session.threadId, session.terminalId, session.history);
    this.emitEvent({
      type: "output",
      threadId: session.threadId,
      targetId: session.targetId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      data,
    });
  }

  private onProcessExit(session: TerminalSessionState, event: PtyExitEvent): void {
    this.clearKillEscalationTimer(session.process);
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.status = "exited";
    session.exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
    session.exitSignal = Number.isInteger(event.signal) ? event.signal : null;
    session.updatedAt = new Date().toISOString();
    this.emitEvent({
      type: "exited",
      threadId: session.threadId,
      targetId: session.targetId,
      terminalId: session.terminalId,
      createdAt: new Date().toISOString(),
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
    });
    this.evictInactiveSessionsIfNeeded();
    this.updateSubprocessPollingState();
  }

  private stopProcess(session: TerminalSessionState): void {
    const process = session.process;
    if (!process) return;
    this.cleanupProcessHandles(session);
    session.process = null;
    session.pid = null;
    session.hasRunningSubprocess = false;
    session.status = "exited";
    session.updatedAt = new Date().toISOString();
    this.killProcessWithEscalation(process, session.threadId, session.terminalId);
    this.evictInactiveSessionsIfNeeded();
    this.updateSubprocessPollingState();
  }

  private cleanupProcessHandles(session: TerminalSessionState): void {
    session.unsubscribeData?.();
    session.unsubscribeData = null;
    session.unsubscribeExit?.();
    session.unsubscribeExit = null;
  }

  private clearKillEscalationTimer(process: PtyProcess | null): void {
    if (!process) return;
    const timer = this.killEscalationTimers.get(process);
    if (!timer) return;
    clearTimeout(timer);
    this.killEscalationTimers.delete(process);
  }

  private killProcessWithEscalation(
    process: PtyProcess,
    threadId: string,
    terminalId: string,
  ): void {
    this.clearKillEscalationTimer(process);
    try {
      process.kill("SIGTERM");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("failed to kill terminal process", {
        threadId,
        terminalId,
        signal: "SIGTERM",
        error: message,
      });
      return;
    }

    const timer = setTimeout(() => {
      this.killEscalationTimers.delete(process);
      try {
        process.kill("SIGKILL");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("failed to force-kill terminal process", {
          threadId,
          terminalId,
          signal: "SIGKILL",
          error: message,
        });
      }
    }, this.processKillGraceMs);
    timer.unref?.();
    this.killEscalationTimers.set(process, timer);
  }

  private evictInactiveSessionsIfNeeded(): void {
    const inactiveSessions = [...this.sessions.values()].filter(
      (session) => session.status !== "running",
    );
    if (inactiveSessions.length <= this.maxRetainedInactiveSessions) {
      return;
    }

    inactiveSessions.sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.threadId.localeCompare(right.threadId) ||
        left.terminalId.localeCompare(right.terminalId),
    );
    const toEvict = inactiveSessions.length - this.maxRetainedInactiveSessions;
    for (const session of inactiveSessions.slice(0, toEvict)) {
      const key = toSessionKey(session.targetId, session.threadId, session.terminalId);
      this.sessions.delete(key);
      this.clearPersistTimer(session.targetId, session.threadId, session.terminalId);
      this.pendingPersistHistory.delete(key);
      this.persistQueues.delete(key);
      this.clearKillEscalationTimer(session.process);
    }
  }

  private queuePersist(
    targetId: string,
    threadId: string,
    terminalId: string,
    history: string,
  ): void {
    const persistenceKey = toSessionKey(targetId, threadId, terminalId);
    this.pendingPersistHistory.set(persistenceKey, history);
    this.schedulePersist(targetId, threadId, terminalId);
  }

  private async persistHistory(
    targetId: string,
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(targetId, threadId, terminalId);
    this.clearPersistTimer(targetId, threadId, terminalId);
    this.pendingPersistHistory.delete(persistenceKey);
    await this.enqueuePersistWrite(targetId, threadId, terminalId, history);
  }

  private enqueuePersistWrite(
    targetId: string,
    threadId: string,
    terminalId: string,
    history: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(targetId, threadId, terminalId);
    const task = async () => {
      await fs.promises.writeFile(
        this.historyPath(targetId, threadId, terminalId),
        history,
        "utf8",
      );
    };
    const previous = this.persistQueues.get(persistenceKey) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        this.logger.warn("failed to persist terminal history", {
          threadId,
          terminalId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.persistQueues.set(persistenceKey, next);
    const finalized = next.finally(() => {
      if (this.persistQueues.get(persistenceKey) === next) {
        this.persistQueues.delete(persistenceKey);
      }
      if (
        this.pendingPersistHistory.has(persistenceKey) &&
        !this.persistTimers.has(persistenceKey)
      ) {
        this.schedulePersist(targetId, threadId, terminalId);
      }
    });
    void finalized.catch(() => undefined);
    return finalized;
  }

  private schedulePersist(targetId: string, threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(targetId, threadId, terminalId);
    if (this.persistTimers.has(persistenceKey)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(persistenceKey);
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory === undefined) return;
      this.pendingPersistHistory.delete(persistenceKey);
      void this.enqueuePersistWrite(targetId, threadId, terminalId, pendingHistory);
    }, this.persistDebounceMs);
    this.persistTimers.set(persistenceKey, timer);
  }

  private clearPersistTimer(targetId: string, threadId: string, terminalId: string): void {
    const persistenceKey = toSessionKey(targetId, threadId, terminalId);
    const timer = this.persistTimers.get(persistenceKey);
    if (!timer) return;
    clearTimeout(timer);
    this.persistTimers.delete(persistenceKey);
  }

  private async readHistory(
    targetId: string,
    threadId: string,
    terminalId: string,
  ): Promise<string> {
    const nextPath = this.historyPath(targetId, threadId, terminalId);
    try {
      const raw = await fs.promises.readFile(nextPath, "utf8");
      const capped = capHistory(raw, this.historyLineLimit);
      if (capped !== raw) {
        await fs.promises.writeFile(nextPath, capped, "utf8");
      }
      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    if (targetId !== LOCAL_EXECUTION_TARGET_ID || terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
    }

    const legacyPath = this.legacyHistoryPath(threadId);
    try {
      const raw = await fs.promises.readFile(legacyPath, "utf8");
      const capped = capHistory(raw, this.historyLineLimit);

      // Migrate legacy transcript filename to the terminal-scoped path.
      await fs.promises.writeFile(nextPath, capped, "utf8");
      try {
        await fs.promises.rm(legacyPath, { force: true });
      } catch (cleanupError) {
        this.logger.warn("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }

      return capped;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  private async deleteHistory(
    targetId: string,
    threadId: string,
    terminalId: string,
  ): Promise<void> {
    const deletions = [
      fs.promises.rm(this.historyPath(targetId, threadId, terminalId), { force: true }),
    ];
    if (targetId === LOCAL_EXECUTION_TARGET_ID && terminalId === DEFAULT_TERMINAL_ID) {
      deletions.push(fs.promises.rm(this.legacyHistoryPath(threadId), { force: true }));
    }
    try {
      await Promise.all(deletions);
    } catch (error) {
      this.logger.warn("failed to delete terminal history", {
        threadId,
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushPersistQueue(
    targetId: string,
    threadId: string,
    terminalId: string,
  ): Promise<void> {
    const persistenceKey = toSessionKey(targetId, threadId, terminalId);
    this.clearPersistTimer(targetId, threadId, terminalId);

    while (true) {
      const pendingHistory = this.pendingPersistHistory.get(persistenceKey);
      if (pendingHistory !== undefined) {
        this.pendingPersistHistory.delete(persistenceKey);
        await this.enqueuePersistWrite(targetId, threadId, terminalId, pendingHistory);
      }

      const pending = this.persistQueues.get(persistenceKey);
      if (!pending) {
        return;
      }
      await pending.catch(() => undefined);
    }
  }

  private updateSubprocessPollingState(): void {
    const hasRunningSessions = [...this.sessions.values()].some(
      (session) =>
        session.status === "running" && session.pid !== null && session.supportsSubprocessPolling,
    );
    if (hasRunningSessions) {
      this.ensureSubprocessPolling();
      return;
    }
    this.stopSubprocessPolling();
  }

  private ensureSubprocessPolling(): void {
    if (this.subprocessPollTimer) return;
    this.subprocessPollTimer = setInterval(() => {
      void this.pollSubprocessActivity();
    }, this.subprocessPollIntervalMs);
    this.subprocessPollTimer.unref?.();
    void this.pollSubprocessActivity();
  }

  private stopSubprocessPolling(): void {
    if (!this.subprocessPollTimer) return;
    clearInterval(this.subprocessPollTimer);
    this.subprocessPollTimer = null;
  }

  private async pollSubprocessActivity(): Promise<void> {
    if (this.subprocessPollInFlight) return;

    const runningSessions = [...this.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" &&
        session.supportsSubprocessPolling &&
        Number.isInteger(session.pid),
    );
    if (runningSessions.length === 0) {
      this.stopSubprocessPolling();
      return;
    }

    this.subprocessPollInFlight = true;
    try {
      await Promise.all(
        runningSessions.map(async (session) => {
          const terminalPid = session.pid;
          let hasRunningSubprocess = false;
          try {
            hasRunningSubprocess = await this.subprocessChecker(terminalPid);
          } catch (error) {
            this.logger.warn("failed to check terminal subprocess activity", {
              threadId: session.threadId,
              terminalId: session.terminalId,
              terminalPid,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          const liveSession = this.sessions.get(
            toSessionKey(session.targetId, session.threadId, session.terminalId),
          );
          if (!liveSession || liveSession.status !== "running" || liveSession.pid !== terminalPid) {
            return;
          }
          if (liveSession.hasRunningSubprocess === hasRunningSubprocess) {
            return;
          }

          liveSession.hasRunningSubprocess = hasRunningSubprocess;
          liveSession.updatedAt = new Date().toISOString();
          this.emitEvent({
            type: "activity",
            threadId: liveSession.threadId,
            targetId: liveSession.targetId,
            terminalId: liveSession.terminalId,
            createdAt: new Date().toISOString(),
            hasRunningSubprocess,
          });
        }),
      );
    } finally {
      this.subprocessPollInFlight = false;
    }
  }

  private async assertValidCwd(cwd: string, launchSpec: TerminalLaunchSpec): Promise<void> {
    if (launchSpec.kind !== "local") {
      return;
    }
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Terminal cwd does not exist: ${cwd}`, { cause: error });
      }
      throw error;
    }
    if (!stats.isDirectory()) {
      throw new Error(`Terminal cwd is not a directory: ${cwd}`);
    }
  }

  private async closeSession(
    targetId: string | undefined,
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
  ): Promise<void> {
    const session = this.requireSession(targetId, threadId, terminalId);
    const key = toSessionKey(session.targetId, threadId, terminalId);
    this.stopProcess(session);
    this.sessions.delete(key);
    this.updateSubprocessPollingState();
    await this.flushPersistQueue(session.targetId, threadId, terminalId);
    if (deleteHistory) {
      await this.deleteHistory(session.targetId, threadId, terminalId);
    }
  }

  private sessionsForThread(threadId: string): TerminalSessionState[] {
    return [...this.sessions.values()].filter((session) => session.threadId === threadId);
  }

  private async deleteAllHistoryForThread(threadId: string): Promise<void> {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    try {
      const entries = await fs.promises.readdir(this.logsDir, { withFileTypes: true });
      const removals = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter(
          (name) =>
            name === `${toSafeThreadId(threadId)}.log` ||
            name === `${legacySafeThreadId(threadId)}.log` ||
            name.startsWith(threadPrefix),
        )
        .map((name) => fs.promises.rm(path.join(this.logsDir, name), { force: true }));
      await Promise.all(removals);
    } catch (error) {
      this.logger.warn("failed to delete terminal histories for thread", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requireSession(
    targetId: string | undefined,
    threadId: string,
    terminalId: string,
  ): TerminalSessionState {
    const exactTargetId = targetId ?? LOCAL_EXECUTION_TARGET_ID;
    const exactSession = this.sessions.get(toSessionKey(exactTargetId, threadId, terminalId));
    if (exactSession) {
      return exactSession;
    }

    if (targetId === undefined) {
      const matchingSessions = [...this.sessions.values()].filter(
        (session) => session.threadId === threadId && session.terminalId === terminalId,
      );
      if (matchingSessions.length === 1) {
        return matchingSessions[0]!;
      }
    }

    throw new Error(`Unknown terminal thread: ${threadId}, terminal: ${terminalId}`);
  }

  private snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
    return {
      threadId: session.threadId,
      targetId: session.targetId,
      terminalId: session.terminalId,
      cwd: session.cwd,
      status: session.status,
      pid: session.pid,
      history: session.history,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      updatedAt: session.updatedAt,
    };
  }

  private emitEvent(event: TerminalEvent): void {
    this.emit("event", event);
  }

  private historyPath(targetId: string, threadId: string, terminalId: string): string {
    const threadPart = toSafeThreadId(threadId);
    if (targetId === LOCAL_EXECUTION_TARGET_ID && terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(this.logsDir, `${threadPart}.log`);
    }
    const targetPart = toSafeTargetId(targetId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(this.logsDir, `${threadPart}_${targetPart}.log`);
    }
    return path.join(
      this.logsDir,
      `${threadPart}_${targetPart}_${toSafeTerminalId(terminalId)}.log`,
    );
  }

  private legacyHistoryPath(threadId: string): string {
    return path.join(this.logsDir, `${legacySafeThreadId(threadId)}.log`);
  }

  private async runWithThreadLock<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.threadLocks.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(threadId, current);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.threadLocks.get(threadId) === current) {
        this.threadLocks.delete(threadId);
      }
    }
  }
}

export const TerminalManagerLive = Layer.effect(
  TerminalManager,
  Effect.gen(function* () {
    const { terminalLogsDir } = yield* ServerConfig;

    const ptyAdapter = yield* PtyAdapter;
    const executionTargets = yield* ExecutionTargetService;
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new TerminalManagerRuntime({
            logsDir: terminalLogsDir,
            ptyAdapter,
            resolveLaunchSpec: async (targetId) => {
              const target = await Effect.runPromise(executionTargets.getByIdForRuntime(targetId));
              if (target.connection.kind === "local") {
                return { kind: "local" } satisfies TerminalLaunchSpec;
              }
              if (target.connection.kind === "ssh") {
                return {
                  kind: "ssh",
                  host: target.connection.host,
                  ...(target.connection.port !== undefined ? { port: target.connection.port } : {}),
                  ...(target.connection.user !== undefined ? { user: target.connection.user } : {}),
                  ...(target.connection.password !== undefined
                    ? { password: target.connection.password }
                    : {}),
                } satisfies TerminalLaunchSpec;
              }
              throw new Error(
                `Remote terminal runtime is not implemented yet for target '${target.label}' (${target.kind}).`,
              );
            },
          }),
      ),
      (r) => Effect.sync(() => r.dispose()),
    );

    return {
      open: (input) =>
        Effect.tryPromise({
          try: () => runtime.open(input),
          catch: (cause) => new TerminalError({ message: "Failed to open terminal", cause }),
        }),
      write: (input) =>
        Effect.tryPromise({
          try: () => runtime.write(input),
          catch: (cause) => new TerminalError({ message: "Failed to write to terminal", cause }),
        }),
      resize: (input) =>
        Effect.tryPromise({
          try: () => runtime.resize(input),
          catch: (cause) => new TerminalError({ message: "Failed to resize terminal", cause }),
        }),
      clear: (input) =>
        Effect.tryPromise({
          try: () => runtime.clear(input),
          catch: (cause) => new TerminalError({ message: "Failed to clear terminal", cause }),
        }),
      restart: (input) =>
        Effect.tryPromise({
          try: () => runtime.restart(input),
          catch: (cause) => new TerminalError({ message: "Failed to restart terminal", cause }),
        }),
      close: (input) =>
        Effect.tryPromise({
          try: () => runtime.close(input),
          catch: (cause) => new TerminalError({ message: "Failed to close terminal", cause }),
        }),
      subscribe: (listener) =>
        Effect.sync(() => {
          runtime.on("event", listener);
          return () => {
            runtime.off("event", listener);
          };
        }),
      dispose: Effect.sync(() => runtime.dispose()),
    } satisfies TerminalManagerShape;
  }),
);
