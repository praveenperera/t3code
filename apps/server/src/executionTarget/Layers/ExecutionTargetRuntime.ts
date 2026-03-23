import { LOCAL_EXECUTION_TARGET_ID } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { resolveRemoteClaudeLaunchOptions } from "../remoteClaude.ts";
import { resolveRemoteCodexLaunchOptions } from "../remoteCodex.ts";
import { ExecutionTargetService } from "../Services/ExecutionTargetService.ts";
import {
  ExecutionTargetRuntime,
  ExecutionTargetRuntimeError,
  type ExecutionTargetRuntimeShape,
} from "../Services/ExecutionTargetRuntime.ts";

const makeExecutionTargetRuntime = Effect.gen(function* () {
  const executionTargets = yield* ExecutionTargetService;

  const prepareProviderStartInput = Effect.fnUntraced(function* (
    input: Parameters<ExecutionTargetRuntimeShape["startProviderSession"]>[0],
  ) {
    const target = yield* executionTargets
      .getByIdForRuntime(input.targetId ?? LOCAL_EXECUTION_TARGET_ID)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ExecutionTargetRuntimeError({
              message: `Unable to resolve execution target ${input.targetId ?? LOCAL_EXECUTION_TARGET_ID}.`,
              cause,
            }),
        ),
      );

    const connection = target.connection;
    if (connection.kind !== "ssh") {
      return { target, input } as const;
    }

    const sshConnection = {
      host: connection.host,
      ...(connection.port !== undefined ? { port: connection.port } : {}),
      ...(connection.user !== undefined ? { user: connection.user } : {}),
      ...(connection.password !== undefined ? { password: connection.password } : {}),
    };
    const requestedCodexOptions = input.providerOptions?.codex;
    const requestedCodexBinaryPath =
      requestedCodexOptions?.binaryPath ?? connection.codexBinaryPath;
    const requestedHomePath = requestedCodexOptions?.homePath ?? connection.codexHomePath;
    const resolvedCodexOptions =
      input.provider === "codex"
        ? yield* Effect.tryPromise({
            try: () =>
              resolveRemoteCodexLaunchOptions({
                targetLabel: target.label,
                connection: sshConnection,
                ...(requestedCodexBinaryPath !== undefined
                  ? { binaryPath: requestedCodexBinaryPath }
                  : {}),
                ...(requestedHomePath !== undefined ? { homePath: requestedHomePath } : {}),
              }),
            catch: (cause) =>
              new ExecutionTargetRuntimeError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : `Failed to resolve Codex CLI on target '${target.label}'.`,
                cause,
              }),
          })
        : undefined;
    const requestedClaudeBinaryPath =
      input.providerOptions?.claudeAgent?.binaryPath ?? connection.claudeBinaryPath;
    const resolvedClaudeOptions =
      input.provider === "claudeAgent"
        ? yield* Effect.tryPromise({
            try: () =>
              resolveRemoteClaudeLaunchOptions({
                targetLabel: target.label,
                connection: sshConnection,
                ...(requestedClaudeBinaryPath !== undefined
                  ? { binaryPath: requestedClaudeBinaryPath }
                  : {}),
              }),
            catch: (cause) =>
              new ExecutionTargetRuntimeError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : `Failed to resolve Claude Code CLI on target '${target.label}'.`,
                cause,
              }),
          })
        : undefined;

    return {
      target,
      input: {
        ...input,
        targetId: target.id,
        providerOptions: {
          ...input.providerOptions,
          ...(resolvedCodexOptions
            ? {
                codex: {
                  binaryPath: resolvedCodexOptions.binaryPath,
                  ...(resolvedCodexOptions.homePath
                    ? { homePath: resolvedCodexOptions.homePath }
                    : {}),
                },
              }
            : {}),
          ...(resolvedClaudeOptions
            ? {
                claudeAgent: {
                  ...input.providerOptions?.claudeAgent,
                  binaryPath: resolvedClaudeOptions.binaryPath,
                },
              }
            : {}),
        },
      },
    } as const;
  });

  const startProviderSession: ExecutionTargetRuntimeShape["startProviderSession"] = (
    input,
    handlers,
  ) =>
    Effect.gen(function* () {
      const prepared = yield* prepareProviderStartInput(input);
      const target = prepared.target;
      const runtimeInput = prepared.input;

      if (target.kind === "local") {
        return yield* Effect.tryPromise({
          try: () => handlers.startLocal(runtimeInput),
          catch: (cause) =>
            new ExecutionTargetRuntimeError({
              message: "Local provider session startup failed.",
              cause,
            }),
        });
      }

      const connection = target.connection;
      if (connection.kind === "ssh") {
        return yield* Effect.tryPromise({
          try: () =>
            handlers.startSsh(runtimeInput, {
              kind: "ssh",
              host: connection.host,
              ...(connection.port !== undefined ? { port: connection.port } : {}),
              ...(connection.user !== undefined ? { user: connection.user } : {}),
              ...(connection.password !== undefined ? { password: connection.password } : {}),
            }),
          catch: (cause) =>
            new ExecutionTargetRuntimeError({
              message: `SSH provider session startup failed for target '${target.label}'.`,
              cause,
            }),
        });
      }

      return yield* new ExecutionTargetRuntimeError({
        message: `Remote provider runtime is not implemented yet for target '${target.label}' (${target.kind}).`,
      });
    });

  return {
    startProviderSession,
  } satisfies ExecutionTargetRuntimeShape;
});

export const ExecutionTargetRuntimeLive = Layer.effect(
  ExecutionTargetRuntime,
  makeExecutionTargetRuntime,
);
