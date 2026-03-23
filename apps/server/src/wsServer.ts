/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import http from "node:http";
import os from "node:os";
import nodePath from "node:path";
import type { Duplex } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  ProjectListDirectoryResult,
  CommandId,
  DEFAULT_TERMINAL_ID,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  LOCAL_EXECUTION_TARGET_ID,
  type ClientOrchestrationCommand,
  type ExecutionTarget,
  type OrchestrationCommand,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ThreadId,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  type WsResponse as WsResponseMessage,
  WsResponse,
  type WsPushEnvelopeBase,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  Schema,
  Scope,
  ServiceMap,
  Stream,
  Struct,
} from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { GitManager, type GitManagerShape } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { PortForwardManager } from "./portForward/Services/PortForwardManager.ts";
import { Keybindings } from "./keybindings";
import {
  buildWorkspaceEntriesFromFilePaths,
  listWorkspaceDirectories,
  searchWorkspaceEntries,
  searchWorkspaceEntriesInIndex,
} from "./workspaceEntries";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { clamp } from "effect/Number";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore, type GitCoreShape } from "./git/Services/GitCore.ts";
import { makeGitCore } from "./git/Layers/GitCore.ts";
import { makeGitManager } from "./git/Layers/GitManager.ts";
import { GitService } from "./git/Services/GitService.ts";
import { GitHubCli, type GitHubCliShape } from "./git/Services/GitHubCli.ts";
import { TextGeneration } from "./git/Services/TextGeneration.ts";
import { makeGitHubCliShape, normalizeGitHubCliError } from "./git/makeGitHubCli.ts";
import { makeTargetGitService } from "./git/makeTargetGitService.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";

import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { expandHomePath } from "./os-jank.ts";
import { makeServerPushBus } from "./wsServer/pushBus.ts";
import { makeServerReadiness } from "./wsServer/readiness.ts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";
import { ExecutionTargetService } from "./executionTarget/Services/ExecutionTargetService.ts";
import { runTargetProcess } from "./executionTarget/targetProcess.ts";
import { buildRemoteShellScript, shellQuote } from "./executionTarget/ssh.ts";
import { ThreadNotesRepository } from "./persistence/Services/ThreadNotes.ts";

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError,
    Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<void, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/wsServer/Server") {}

const isServerNotRunningError = (error: Error): boolean => {
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
}

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks: string[] = [];
    for (const chunk of raw) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
        continue;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        continue;
      }
      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(new Uint8Array(chunk)).toString("utf8"));
        continue;
      }
      return null;
    }
    return chunks.join("");
  }
  return null;
}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function posixParentPath(input: string): string | undefined {
  const normalized = nodePath.posix.normalize(input);
  const parent = nodePath.posix.dirname(normalized);
  return parent === normalized ? undefined : parent;
}

function stripRemoteDirectoryPrefix(input: string): string {
  if (input === ".") {
    return "";
  }
  if (input.startsWith("./")) {
    return input.slice(2);
  }
  return input;
}

function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const absolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, absolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    absolutePath,
    relativePath: relativeToRoot,
  });
}

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

const encodeWsResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));
const decodeWebSocketRequest = decodeJsonResult(WebSocketRequest);
const TERMINAL_REQUEST_TAGS = new Set<string>([
  WS_METHODS.terminalOpen,
  WS_METHODS.terminalWrite,
  WS_METHODS.terminalResize,
  WS_METHODS.terminalClear,
  WS_METHODS.terminalRestart,
  WS_METHODS.terminalClose,
]);

function terminalRequestLogContext(body: { _tag: string; [key: string]: unknown }) {
  if (!TERMINAL_REQUEST_TAGS.has(body._tag)) {
    return null;
  }

  return {
    method: body._tag,
    threadId: typeof body.threadId === "string" ? body.threadId : undefined,
    targetId: typeof body.targetId === "string" ? body.targetId : LOCAL_EXECUTION_TARGET_ID,
    terminalId: typeof body.terminalId === "string" ? body.terminalId : DEFAULT_TERMINAL_ID,
    cwd: typeof body.cwd === "string" ? body.cwd : undefined,
  };
}

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | OrchestrationReactor
  | ProviderService
  | ProviderHealth;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | GitManager
  | GitCore
  | TextGeneration
  | TerminalManager
  | PortForwardManager
  | Keybindings
  | Open
  | AnalyticsService
  | ExecutionTargetService
  | ThreadNotesRepository;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
}) {}

export const createServer = Effect.fn(function* (): Effect.fn.Return<
  http.Server,
  ServerLifecycleError,
  Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const {
    port,
    cwd,
    keybindingsConfigPath,
    staticDir,
    devUrl,
    authToken,
    host,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;
  const availableEditors = resolveAvailableEditors();

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const portForwardManager = yield* PortForwardManager;
  const keybindingsManager = yield* Keybindings;
  const providerHealth = yield* ProviderHealth;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const executionTargets = yield* ExecutionTargetService;
  const threadNotesRepository = yield* ThreadNotesRepository;

  yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );

  const providerStatuses = yield* providerHealth.getStatuses;

  const resolveExecutionTarget = (targetId: string | undefined) =>
    executionTargets.getByIdForRuntime(targetId ?? LOCAL_EXECUTION_TARGET_ID).pipe(
      Effect.mapError(
        (cause) =>
          new RouteRequestError({
            message: cause.message,
          }),
      ),
    );

  const resolveWorkspaceDirectory = Effect.fnUntraced(function* (input: {
    readonly targetId?: string;
    readonly cwd?: string;
  }) {
    const target = yield* resolveExecutionTarget(input.targetId);

    if (target.connection.kind === "local") {
      const normalizedWorkspaceRoot = path.resolve(
        yield* expandHomePath(input.cwd?.trim() || os.homedir()),
      );
      const workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!workspaceStat) {
        return yield* new RouteRequestError({
          message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
        });
      }
      if (workspaceStat.type !== "Directory") {
        return yield* new RouteRequestError({
          message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
        });
      }
      return {
        target,
        cwd: normalizedWorkspaceRoot,
      };
    }

    const resolvedPathResult = yield* Effect.tryPromise({
      try: () =>
        runTargetProcess({
          target,
          command: "sh",
          args:
            input.cwd && input.cwd.trim().length > 0
              ? ["-lc", 'cd "$1" && pwd -P', "t3code-path", input.cwd.trim()]
              : ["-lc", 'printf "%s" "$HOME"'],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
          maxBufferBytes: 16 * 1024,
        }),
      catch: (cause) =>
        new RouteRequestError({
          message: `Failed to resolve remote directory: ${String(cause)}`,
        }),
    });
    if (resolvedPathResult.code !== 0) {
      return yield* new RouteRequestError({
        message: `Project directory does not exist on target '${target.label}'.`,
      });
    }

    const resolvedPath = resolvedPathResult.stdout.trim();
    if (resolvedPath.length === 0) {
      return yield* new RouteRequestError({
        message: `Unable to resolve a directory on target '${target.label}'.`,
      });
    }

    return {
      target,
      cwd: resolvedPath,
    };
  });

  const makeTargetGitHubCli = (target: ExecutionTarget): GitHubCliShape => {
    const execute: GitHubCliShape["execute"] = (input) =>
      Effect.tryPromise({
        try: () =>
          runTargetProcess({
            target,
            command: "gh",
            args: input.args,
            cwd: input.cwd,
            ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          }),
        catch: (error) => normalizeGitHubCliError("execute", error),
      });

    return makeGitHubCliShape(execute);
  };

  const targetGitCoreById = new Map<string, GitCoreShape>();
  const targetGitManagerById = new Map<string, GitManagerShape>();

  const getTargetGitCore = (
    target: ExecutionTarget,
  ): Effect.Effect<
    GitCoreShape,
    never,
    GitCore | ServerConfig | FileSystem.FileSystem | Path.Path
  > => {
    if (target.connection.kind === "local") {
      return Effect.gen(function* () {
        return yield* GitCore;
      });
    }

    return Effect.gen(function* () {
      const cached = targetGitCoreById.get(target.id);
      if (cached) {
        return cached;
      }

      const remoteGitCore = yield* makeGitCore.pipe(
        Effect.provideService(GitService, makeTargetGitService(target)),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      targetGitCoreById.set(target.id, remoteGitCore);
      return remoteGitCore;
    });
  };

  const getTargetGitManager = Effect.fnUntraced(function* (target: ExecutionTarget) {
    if (target.connection.kind === "local") {
      return gitManager;
    }

    const cached = targetGitManagerById.get(target.id);
    if (cached) {
      return cached;
    }

    const targetGitCore = yield* getTargetGitCore(target);
    const remoteGitManager = yield* makeGitManager.pipe(
      Effect.provideService(TextGeneration, textGeneration),
      Effect.provideService(GitHubCli, makeTargetGitHubCli(target)),
      Effect.provideService(GitCore, targetGitCore),
    );
    targetGitManagerById.set(target.id, remoteGitManager);
    return remoteGitManager;
  });

  const clients = yield* Ref.make(new Set<WebSocket>());
  const logger = createLogger("ws");
  const readiness = yield* makeServerReadiness;

  function logOutgoingPush(push: WsPushEnvelopeBase, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      sequence: push.sequence,
      recipients,
      payload: push.data,
    });
  }

  const pushBus = yield* makeServerPushBus({
    clients,
    logOutgoingPush,
  });
  yield* readiness.markPushBusReady;
  yield* keybindingsManager.start.pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "keybindingsRuntimeStart", cause }),
    ),
  );
  yield* readiness.markKeybindingsReady;

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
  }) {
    if (input.command.type === "project.create") {
      const resolvedWorkspace = yield* resolveWorkspaceDirectory({
        ...(input.command.targetId ? { targetId: input.command.targetId } : {}),
        cwd: input.command.workspaceRoot,
      });
      return {
        ...input.command,
        workspaceRoot: resolvedWorkspace.cwd,
        targetId: resolvedWorkspace.target.id,
      } satisfies OrchestrationCommand;
    }

    if (input.command.type === "project.meta.update" && input.command.workspaceRoot !== undefined) {
      const resolvedWorkspace = yield* resolveWorkspaceDirectory({
        ...(input.command.targetId ? { targetId: input.command.targetId } : {}),
        cwd: input.command.workspaceRoot,
      });
      return {
        ...input.command,
        workspaceRoot: resolvedWorkspace.cwd,
        targetId: resolvedWorkspace.target.id,
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new RouteRequestError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new RouteRequestError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* new RouteRequestError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new RouteRequestError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

  // HTTP server — serves static files or redirects to Vite dev server
  const httpServer = http.createServer((req, res) => {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body?: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    void Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
          const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
          if (!normalizedRelativePath) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
            return;
          }

          const isIdLookup =
            !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
          const filePath = isIdLookup
            ? resolveAttachmentPathById({
                attachmentsDir: serverConfig.attachmentsDir,
                attachmentId: normalizedRelativePath,
              })
            : resolveAttachmentRelativePath({
                attachmentsDir: serverConfig.attachmentsDir,
                relativePath: normalizedRelativePath,
              });
          if (!filePath) {
            respond(
              isIdLookup ? 404 : 400,
              { "Content-Type": "text/plain" },
              isIdLookup ? "Not Found" : "Invalid attachment path",
            );
            return;
          }

          const fileInfo = yield* fileSystem
            .stat(filePath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }

          const contentType = Mime.getType(filePath) ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          const streamExit = yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
            Effect.sync(() => {
              if (!res.destroyed) {
                res.write(chunk);
              }
            }),
          ).pipe(Effect.exit);
          if (Exit.isFailure(streamExit)) {
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        // In dev mode, reverse proxy Vite so the browser origin stays on the
        // app server port and browser-local state survives reloads.
        if (devUrl) {
          if (req.method && req.method !== "GET" && req.method !== "HEAD") {
            respond(405, { "Content-Type": "text/plain; charset=utf-8" }, "Method Not Allowed");
            return;
          }

          const targetUrl = new URL(req.url ?? "/", devUrl);
          const requestHeaders = new Headers();
          for (const [name, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            if (name.toLowerCase() === "host") {
              requestHeaders.set(name, targetUrl.host);
              continue;
            }
            if (Array.isArray(value)) {
              for (const entry of value) {
                requestHeaders.append(name, entry);
              }
              continue;
            }
            requestHeaders.set(name, value);
          }

          const upstreamResponseExit = yield* Effect.tryPromise({
            try: () =>
              fetch(targetUrl, {
                method: req.method ?? "GET",
                headers: requestHeaders,
                redirect: "manual",
              }),
            catch: (cause) =>
              new RouteRequestError({
                message: `Failed to proxy dev request: ${String(cause)}`,
              }),
          }).pipe(Effect.exit);
          if (Exit.isFailure(upstreamResponseExit)) {
            respond(502, { "Content-Type": "text/plain; charset=utf-8" }, "Bad Gateway");
            return;
          }
          const upstreamResponse = upstreamResponseExit.value;

          const responseHeaders: Record<string, string> = {};
          upstreamResponse.headers.forEach((value: string, key: string) => {
            const normalized = key.toLowerCase();
            if (
              normalized === "connection" ||
              normalized === "keep-alive" ||
              normalized === "transfer-encoding"
            ) {
              return;
            }
            responseHeaders[key] = value;
          });

          if (
            req.method === "HEAD" ||
            upstreamResponse.status === 204 ||
            upstreamResponse.status === 304
          ) {
            respond(upstreamResponse.status, responseHeaders);
            return;
          }

          const responseBodyExit = yield* Effect.tryPromise({
            try: () => upstreamResponse.arrayBuffer(),
            catch: (cause) =>
              new RouteRequestError({
                message: `Failed to read proxied dev response: ${String(cause)}`,
              }),
          }).pipe(Effect.exit);
          if (Exit.isFailure(responseBodyExit)) {
            respond(502, { "Content-Type": "text/plain; charset=utf-8" }, "Bad Gateway");
            return;
          }

          respond(upstreamResponse.status, responseHeaders, new Uint8Array(responseBodyExit.value));
          return;
        }

        // Serve static files from the web app build
        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");
        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
            return;
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
          return;
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
          return;
        }
        respond(200, { "Content-Type": contentType }, data);
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  });

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
    wss.close((error) => {
      if (error && !isServerNotRunningError(error)) {
        resume(
          Effect.fail(
            new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error }),
          ),
        );
      } else {
        resume(Effect.void);
      }
    });
  });

  const closeAllClients = Ref.get(clients).pipe(
    Effect.flatMap(Effect.forEach((client) => Effect.sync(() => client.close()))),
    Effect.flatMap(() => Ref.set(clients, new Set())),
  );

  const listenOptions = host ? { host, port } : { port };

  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const orchestrationReactor = yield* OrchestrationReactor;
  const { openInEditor } = yield* Open;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    pushBus.publishAll(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(keybindingsManager.streamChanges, (event) =>
    pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
      issues: event.issues,
      providers: providerStatuses,
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);
  yield* readiness.markOrchestrationSubscriptionsReady;

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  if (autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const snapshot = yield* projectionReadModelQuery.getSnapshot();
      const existingProject = snapshot.projects.find(
        (project) => project.workspaceRoot === cwd && project.deletedAt === null,
      );
      let bootstrapProjectId: ProjectId;
      let bootstrapProjectDefaultModel: string;

      if (!existingProject) {
        const createdAt = new Date().toISOString();
        bootstrapProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(cwd) || "project";
        bootstrapProjectDefaultModel = "gpt-5-codex";
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: bootstrapProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: cwd,
          defaultModel: bootstrapProjectDefaultModel,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModel = existingProject.defaultModel ?? "gpt-5-codex";
      }

      const existingThread = snapshot.threads.find(
        (thread) => thread.projectId === bootstrapProjectId && thread.deletedAt === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: bootstrapProjectDefaultModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = threadId;
      } else {
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = existingThread.id;
      }
    }).pipe(
      Effect.mapError(
        (cause) => new ServerLifecycleError({ operation: "autoBootstrapProject", cause }),
      ),
    );
  }

  const runtimeServices = yield* Effect.services<
    ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const runPromise = Effect.runPromiseWith(runtimeServices);

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(pushBus.publishAll(WS_CHANNELS.terminalEvent, event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));
  const unsubscribePortForwardEvents = yield* portForwardManager.subscribe(
    (event) => void Effect.runPromise(pushBus.publishAll(WS_CHANNELS.portForwardEvent, event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribePortForwardEvents()));
  yield* readiness.markTerminalSubscriptionsReady;

  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );
  yield* readiness.markHttpListening;

  yield* Effect.addFinalizer(() =>
    Effect.all([closeAllClients, closeWebSocketServer.pipe(Effect.ignoreCause({ log: true }))]),
  );

  const routeRequest = Effect.fnUntraced(function* (request: WebSocketRequest) {
    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        return yield* orchestrationEngine.dispatch(normalizedCommand);
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = request.body;
        return yield* Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((events) => Array.from(events)));
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        if (target.connection.kind === "local") {
          return yield* Effect.tryPromise({
            try: () => searchWorkspaceEntries(body),
            catch: (cause) =>
              new RouteRequestError({
                message: `Failed to search workspace entries: ${String(cause)}`,
              }),
          });
        }

        const listedFiles = yield* Effect.tryPromise({
          try: () =>
            runTargetProcess({
              target,
              command: "git",
              args: ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
              cwd: body.cwd,
              allowNonZeroExit: true,
              timeoutMs: 20_000,
              maxBufferBytes: 16 * 1024 * 1024,
              outputMode: "truncate",
            }),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search remote workspace entries: ${String(cause)}`,
            }),
        });
        if (listedFiles.code !== 0) {
          return yield* new RouteRequestError({
            message: "Remote workspace search currently requires a Git worktree.",
          });
        }

        const filePaths = listedFiles.stdout
          .split("\0")
          .filter((entry) => entry.length > 0)
          .map((entry) => entry.replaceAll("\\", "/"));
        return searchWorkspaceEntriesInIndex({
          entries: buildWorkspaceEntriesFromFilePaths(filePaths),
          query: body.query,
          limit: body.limit,
          truncated: Boolean(listedFiles.stdoutTruncated),
        });
      }

      case WS_METHODS.projectsListDirectory: {
        const body = stripRequestTag(request.body);
        const resolvedDirectory = yield* resolveWorkspaceDirectory({
          ...(body.targetId ? { targetId: body.targetId } : {}),
          ...(body.cwd ? { cwd: body.cwd } : {}),
        });

        if (resolvedDirectory.target.connection.kind === "local") {
          return yield* Effect.tryPromise({
            try: () => listWorkspaceDirectories({ cwd: resolvedDirectory.cwd }),
            catch: (cause) =>
              new RouteRequestError({
                message: `Failed to list workspace directories: ${String(cause)}`,
              }),
          });
        }

        const listedDirectories = yield* Effect.tryPromise({
          try: () =>
            runTargetProcess({
              target: resolvedDirectory.target,
              command: "find",
              args: [".", "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-print0"],
              cwd: resolvedDirectory.cwd,
              allowNonZeroExit: true,
              timeoutMs: 20_000,
              maxBufferBytes: 4 * 1024 * 1024,
            }),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to list remote workspace directories: ${String(cause)}`,
            }),
        });
        if (listedDirectories.code !== 0) {
          return yield* new RouteRequestError({
            message: `Failed to list directories on target '${resolvedDirectory.target.label}'.`,
          });
        }

        const entryNames = listedDirectories.stdout
          .split("\0")
          .map(stripRemoteDirectoryPrefix)
          .filter((entry) => entry.length > 0)
          .toSorted((left, right) => left.localeCompare(right));
        const result: ProjectListDirectoryResult = {
          cwd: resolvedDirectory.cwd,
          ...(posixParentPath(resolvedDirectory.cwd)
            ? { parentCwd: posixParentPath(resolvedDirectory.cwd) }
            : {}),
          entries: entryNames.map((entry) => ({
            name: nodePath.posix.basename(entry),
            path: nodePath.posix.join(resolvedDirectory.cwd, entry),
          })),
        };
        return result;
      }

      case WS_METHODS.projectsWriteFile: {
        const body = stripRequestTag(request.body);
        const executionTarget = yield* resolveExecutionTarget(body.targetId);
        const writeTarget = yield* resolveWorkspaceWritePath({
          workspaceRoot: body.cwd,
          relativePath: body.relativePath,
          path,
        });
        if (executionTarget.connection.kind !== "local") {
          const normalizedRelativePath = writeTarget.relativePath.replaceAll("\\", "/");
          const remoteDirectory = normalizedRelativePath.includes("/")
            ? normalizedRelativePath.slice(0, normalizedRelativePath.lastIndexOf("/"))
            : ".";
          yield* Effect.tryPromise({
            try: () =>
              runTargetProcess({
                target: executionTarget,
                command: "sh",
                args: [
                  "-lc",
                  buildRemoteShellScript({
                    cwd: body.cwd,
                    command: [
                      `mkdir -p ${shellQuote(remoteDirectory === "." ? "." : remoteDirectory)}`,
                      `cat > ${shellQuote(normalizedRelativePath)}`,
                    ].join(" && "),
                  }),
                ],
                stdin: body.contents,
              }),
            catch: (cause) =>
              new RouteRequestError({
                message: `Failed to write remote workspace file: ${String(cause)}`,
              }),
          });
          return { relativePath: writeTarget.relativePath };
        }
        yield* fileSystem
          .makeDirectory(path.dirname(writeTarget.absolutePath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteRequestError({
                  message: `Failed to prepare workspace path: ${String(cause)}`,
                }),
            ),
          );
        yield* fileSystem.writeFileString(writeTarget.absolutePath, body.contents).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to write workspace file: ${String(cause)}`,
              }),
          ),
        );
        return { relativePath: writeTarget.relativePath };
      }

      case WS_METHODS.threadNotesGet: {
        const body = stripRequestTag(request.body);
        return yield* threadNotesRepository.getByThreadId(body).pipe(
          Effect.map((document) =>
            Option.match(document, {
              onNone: () => null,
              onSome: (value) => value,
            }),
          ),
        );
      }

      case WS_METHODS.threadNotesUpsert: {
        const body = stripRequestTag(request.body);
        return yield* threadNotesRepository.upsert(body);
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        const targetGitManager = yield* getTargetGitManager(target);
        return yield* targetGitManager.status(body);
      }

      case WS_METHODS.gitWorkingTreeDiff: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        if (target.connection.kind === "local") {
          return yield* git.readWorkingTreeDiff(body.cwd);
        }
        const targetGitCore = yield* getTargetGitCore(target);
        return yield* targetGitCore.readWorkingTreeDiff(body.cwd);
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        if (target.connection.kind === "local") {
          return yield* git.pullCurrentBranch(body.cwd);
        }
        const targetGitCore = yield* getTargetGitCore(target);
        return yield* targetGitCore.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        const targetGitManager = yield* getTargetGitManager(target);
        return yield* targetGitManager.runStackedAction(body);
      }

      case WS_METHODS.gitResolvePullRequest: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        const targetGitManager = yield* getTargetGitManager(target);
        return yield* targetGitManager.resolvePullRequest(body);
      }

      case WS_METHODS.gitPreparePullRequestThread: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        const targetGitManager = yield* getTargetGitManager(target);
        return yield* targetGitManager.preparePullRequestThread(body);
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        const targetGitCore = yield* getTargetGitCore(target);
        return yield* targetGitCore.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        const targetGitCore = yield* getTargetGitCore(target);
        return yield* targetGitCore.createWorktree(body);
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        const targetGitCore = yield* getTargetGitCore(target);
        return yield* targetGitCore.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        const targetGitCore = yield* getTargetGitCore(target);
        return yield* targetGitCore.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        const targetGitCore = yield* getTargetGitCore(target);
        return yield* Effect.scoped(targetGitCore.checkoutBranch(body));
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveExecutionTarget(body.targetId);
        const targetGitCore = yield* getTargetGitCore(target);
        return yield* targetGitCore.initRepo(body);
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(request.body);
        logger.info("terminal open requested", {
          threadId: body.threadId,
          targetId: body.targetId ?? LOCAL_EXECUTION_TARGET_ID,
          terminalId: body.terminalId,
          cwd: body.cwd,
          cols: body.cols,
          rows: body.rows,
        });
        return yield* terminalManager.open(body).pipe(
          Effect.tap((snapshot) =>
            Effect.sync(() =>
              logger.info("terminal open resolved", {
                threadId: snapshot.threadId,
                targetId: snapshot.targetId ?? LOCAL_EXECUTION_TARGET_ID,
                terminalId: snapshot.terminalId,
                cwd: snapshot.cwd,
                status: snapshot.status,
                pid: snapshot.pid,
              }),
            ),
          ),
        );
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.write(body);
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.restart(body);
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.portForwardOpen: {
        const body = stripRequestTag(request.body);
        return yield* portForwardManager.open(body);
      }

      case WS_METHODS.portForwardList: {
        const body = stripRequestTag(request.body);
        return yield* portForwardManager.list(body);
      }

      case WS_METHODS.portForwardClose: {
        const body = stripRequestTag(request.body);
        return yield* portForwardManager.close(body);
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        return {
          cwd,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: providerStatuses,
          availableEditors,
        };

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
        return { keybindings: keybindingsConfig, issues: [] };
      }

      case WS_METHODS.executionTargetList:
        return yield* executionTargets.list();

      case WS_METHODS.executionTargetUpsert: {
        const body = stripRequestTag(request.body);
        return yield* executionTargets.upsert(body);
      }

      case WS_METHODS.executionTargetRemove: {
        const body = stripRequestTag(request.body);
        return yield* executionTargets.remove(body);
      }

      case WS_METHODS.executionTargetCheckHealth: {
        const body = stripRequestTag(request.body);
        return yield* executionTargets.checkHealth(body);
      }

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    const sendWsResponse = (response: WsResponseMessage) =>
      encodeWsResponse(response).pipe(
        Effect.tap((encodedResponse) => Effect.sync(() => ws.send(encodedResponse))),
        Effect.asVoid,
      );

    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      return yield* sendWsResponse({
        id: "unknown",
        error: { message: "Invalid request format: Failed to read message" },
      });
    }

    const request = decodeWebSocketRequest(messageText);
    if (Result.isFailure(request)) {
      return yield* sendWsResponse({
        id: "unknown",
        error: { message: `Invalid request format: ${formatSchemaError(request.failure)}` },
      });
    }

    const result = yield* Effect.exit(routeRequest(request.success));
    if (Exit.isFailure(result)) {
      const terminalContext = terminalRequestLogContext(request.success.body);
      if (terminalContext) {
        logger.error("terminal request failed", {
          ...terminalContext,
          cause: Cause.pretty(result.cause),
        });
      }
      return yield* sendWsResponse({
        id: request.success.id,
        error: { message: Cause.pretty(result.cause) },
      });
    }

    return yield* sendWsResponse({
      id: request.success.id,
      result: result.value,
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    if (authToken) {
      let providedToken: string | null = null;
      try {
        const url = new URL(request.url ?? "/", `http://localhost:${port}`);
        providedToken = url.searchParams.get("token");
      } catch {
        rejectUpgrade(socket, 400, "Invalid WebSocket URL");
        return;
      }

      if (providedToken !== authToken) {
        rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";

    const welcomeData = {
      cwd,
      projectName,
      ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
      ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
    };
    // Send welcome before adding to broadcast set so publishAll calls
    // cannot reach this client before the welcome arrives.
    void runPromise(
      readiness.awaitServerReady.pipe(
        Effect.flatMap(() => pushBus.publishClient(ws, WS_CHANNELS.serverWelcome, welcomeData)),
        Effect.flatMap((delivered) =>
          delivered ? Ref.update(clients, (clients) => clients.add(ws)) : Effect.void,
        ),
      ),
    );

    ws.on("message", (raw) => {
      void runPromise(handleMessage(ws, raw).pipe(Effect.ignoreCause({ log: true })));
    });

    ws.on("close", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });

    ws.on("error", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
