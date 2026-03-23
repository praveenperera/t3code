import { spawn } from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { runProcess, type ProcessRunResult } from "../processRunner";
import { buildRemoteShellScript, buildSshCommand, shellQuote, type SshConnectionSpec } from "./ssh";

const REMOTE_CLAUDE_RESOLUTION_TIMEOUT_MS = 10_000;
const REMOTE_CLAUDE_RESOLUTION_MAX_BUFFER_BYTES = 32 * 1024;
const COMMON_REMOTE_CLAUDE_PATHS = [
  "$HOME/.npm-global/bin/claude",
  "$HOME/.local/bin/claude",
  "$HOME/.bun/bin/claude",
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  "/usr/bin/claude",
] as const;

function buildRemoteCommand(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function filterRemoteClaudeEnv(env: SpawnOptions["env"]): Record<string, string | undefined> {
  const forwarded: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }

    if (
      key === "ANTHROPIC_API_KEY" ||
      key === "ANTHROPIC_AUTH_TOKEN" ||
      key === "ANTHROPIC_BASE_URL" ||
      key === "ANTHROPIC_MODEL" ||
      key === "CLAUDE_AGENT_SDK_VERSION" ||
      key === "CLAUDE_CODE_ENTRYPOINT" ||
      key === "CLAUDE_CODE_OAUTH_TOKEN" ||
      key === "HTTPS_PROXY" ||
      key === "HTTP_PROXY" ||
      key === "NO_PROXY" ||
      key.startsWith("AWS_") ||
      key.startsWith("GOOGLE_") ||
      key.startsWith("VERTEX_")
    ) {
      forwarded[key] = value;
    }
  }

  return forwarded;
}

function buildRemoteClaudeResolveSnippet(binaryPath?: string): string {
  if (binaryPath && binaryPath.includes("/")) {
    return [
      `if [ -x ${shellQuote(binaryPath)} ]; then`,
      `  printf '%s\\n' ${shellQuote(binaryPath)}`,
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n");
  }

  if (binaryPath) {
    return [
      `if command -v ${shellQuote(binaryPath)} >/dev/null 2>&1; then`,
      `  command -v ${shellQuote(binaryPath)}`,
      "  exit 0",
      "fi",
      "exit 1",
    ].join("\n");
  }

  return [
    "if command -v claude >/dev/null 2>&1; then",
    "  command -v claude",
    "  exit 0",
    "fi",
    ...COMMON_REMOTE_CLAUDE_PATHS.flatMap((candidate) => [
      `if [ -x "${candidate}" ]; then`,
      `  printf '%s\\n' "${candidate}"`,
      "  exit 0",
      "fi",
    ]),
    "exit 1",
  ].join("\n");
}

export function buildRemoteClaudeResolveCommand(binaryPath?: string): string {
  const resolveSnippet = buildRemoteClaudeResolveSnippet(binaryPath);
  const quotedResolveSnippet = shellQuote(resolveSnippet);

  return [
    'for candidate in "${SHELL:-}" "$(command -v zsh 2>/dev/null)" "$(command -v bash 2>/dev/null)" sh; do',
    '  [ -n "$candidate" ] || continue',
    '  case "${candidate##*/}" in',
    "    bash|zsh)",
    `      output="$("$candidate" -ilc ${quotedResolveSnippet} 2>/dev/null)"`,
    "      status=$?",
    '      if [ "$status" -eq 0 ] && [ -n "$output" ]; then',
    '        printf "%s\\n" "$output"',
    "        exit 0",
    "      fi",
    "      ;;",
    "    sh|dash|ash)",
    `      output="$("$candidate" -lc ${quotedResolveSnippet} 2>/dev/null)"`,
    "      status=$?",
    '      if [ "$status" -eq 0 ] && [ -n "$output" ]; then',
    '        printf "%s\\n" "$output"',
    "        exit 0",
    "      fi",
    "      ;;",
    "  esac",
    "done",
    `output="$(sh -lc ${quotedResolveSnippet} 2>/dev/null)"`,
    "status=$?",
    'if [ "$status" -eq 0 ] && [ -n "$output" ]; then',
    '  printf "%s\\n" "$output"',
    "  exit 0",
    "fi",
    "exit 1",
  ].join("\n");
}

export function createRemoteClaudeSpawnProcess(
  connection: SshConnectionSpec,
  options: SpawnOptions,
): SpawnedProcess {
  const sshCommand = buildSshCommand({
    connection,
    remoteScript: buildRemoteShellScript({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: filterRemoteClaudeEnv(options.env),
      command: buildRemoteCommand(options.command, options.args),
    }),
    env: options.env,
  });

  const child = spawn(sshCommand.command, sshCommand.args, {
    env: sshCommand.env,
    stdio: ["pipe", "pipe", "pipe"],
    signal: options.signal,
    windowsHide: true,
  });

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    kill(signal: NodeJS.Signals) {
      return child.kill(signal);
    },
    on(event, listener) {
      child.on(event, listener as never);
    },
    once(event, listener) {
      child.once(event, listener as never);
    },
    off(event, listener) {
      child.off(event, listener as never);
    },
  };
}

function formatRemoteClaudeResolutionError(input: {
  readonly targetLabel: string;
  readonly binaryPath?: string;
  readonly result?: ProcessRunResult;
}): Error {
  if (input.result?.timedOut) {
    return new Error(`Timed out while resolving Claude Code CLI on target '${input.targetLabel}'.`);
  }

  const stderr = input.result?.stderr.trim();
  if (stderr) {
    return new Error(stderr);
  }

  if (input.binaryPath) {
    return new Error(
      `Claude Code CLI (${input.binaryPath}) is not installed or not executable on target '${input.targetLabel}'.`,
    );
  }

  return new Error(
    `Claude Code CLI could not be found on target '${input.targetLabel}'. Install claude there or set the target's Claude binary path in Settings.`,
  );
}

export async function resolveRemoteClaudeLaunchOptions(input: {
  readonly targetLabel: string;
  readonly connection: SshConnectionSpec;
  readonly binaryPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly run?: (
    command: string,
    args: ReadonlyArray<string>,
    options: Parameters<typeof runProcess>[2],
  ) => Promise<ProcessRunResult>;
}): Promise<{
  readonly binaryPath: string;
}> {
  const sshCommand = buildSshCommand({
    connection: input.connection,
    remoteScript: buildRemoteClaudeResolveCommand(input.binaryPath),
    ...(input.env ? { env: input.env } : {}),
  });
  const run = input.run ?? runProcess;
  const result = await run(sshCommand.command, sshCommand.args, {
    env: sshCommand.env,
    timeoutMs: input.timeoutMs ?? REMOTE_CLAUDE_RESOLUTION_TIMEOUT_MS,
    allowNonZeroExit: true,
    maxBufferBytes: REMOTE_CLAUDE_RESOLUTION_MAX_BUFFER_BYTES,
    outputMode: "truncate",
  });

  if (result.code !== 0) {
    throw formatRemoteClaudeResolutionError({
      targetLabel: input.targetLabel,
      ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
      result,
    });
  }

  const resolvedBinaryPath = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!resolvedBinaryPath) {
    throw formatRemoteClaudeResolutionError({
      targetLabel: input.targetLabel,
      ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
      result,
    });
  }

  return {
    binaryPath: resolvedBinaryPath,
  };
}
