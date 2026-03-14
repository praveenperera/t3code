import crypto from "node:crypto";

import {
  DEFAULT_CLOUD_EXECUTION_TARGET_CAPABILITIES,
  DEFAULT_LOCAL_EXECUTION_TARGET_CAPABILITIES,
  DEFAULT_SSH_EXECUTION_TARGET_CAPABILITIES,
  type ExecutionTarget,
  type ExecutionTargetHealth,
  type ExecutionTargetCapabilities,
  type ExecutionTargetConnection,
  type ExecutionTargetId,
  LOCAL_EXECUTION_TARGET_ID,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config";
import { runProcess } from "../../processRunner";
import { ExecutionTargetRepository } from "../../persistence/Services/ExecutionTargets.ts";
import { buildSshCommand } from "../ssh.ts";
import { resolveRemoteCodexLaunchOptions } from "../remoteCodex.ts";
import { deleteSshPasswordSecret, resolveSshPasswordSecret } from "../sshSecrets.ts";
import {
  ExecutionTargetService,
  ExecutionTargetServiceError,
  type ExecutionTargetServiceShape,
} from "../Services/ExecutionTargetService.ts";

const nowIso = () => new Date().toISOString();

function defaultCapabilitiesForConnection(
  connection: ExecutionTargetConnection,
): ExecutionTargetCapabilities {
  switch (connection.kind) {
    case "local":
      return { ...DEFAULT_LOCAL_EXECUTION_TARGET_CAPABILITIES };
    case "ssh":
      return { ...DEFAULT_SSH_EXECUTION_TARGET_CAPABILITIES };
    case "cloud":
      return { ...DEFAULT_CLOUD_EXECUTION_TARGET_CAPABILITIES };
  }
}

function buildSyntheticLocalTarget(): ExecutionTarget {
  return {
    id: LOCAL_EXECUTION_TARGET_ID,
    kind: "local",
    label: "Local Machine",
    connection: { kind: "local" },
    capabilities: { ...DEFAULT_LOCAL_EXECUTION_TARGET_CAPABILITIES },
    health: {
      status: "healthy",
      checkedAt: nowIso(),
    },
  };
}

function targetIdFromLabel(label: string): ExecutionTargetId {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = crypto.randomUUID().slice(0, 8);
  const value = `${normalized || "target"}-${suffix}`;
  return value as ExecutionTargetId;
}

async function checkSshHealth(
  connection: Extract<ExecutionTargetConnection, { kind: "ssh" }>,
): Promise<ExecutionTargetHealth> {
  const sshCommand = buildSshCommand({
    connection: {
      host: connection.host,
      ...(connection.port !== undefined ? { port: connection.port } : {}),
      ...(connection.user !== undefined ? { user: connection.user } : {}),
      ...(connection.password !== undefined ? { password: connection.password } : {}),
    },
    remoteScript: "exit",
    env: process.env,
  });
  try {
    const result = await runProcess(sshCommand.command, sshCommand.args, {
      env: sshCommand.env,
      timeoutMs: 7_000,
      allowNonZeroExit: true,
      maxBufferBytes: 64 * 1024,
      outputMode: "truncate",
    });
    if (result.code === 0) {
      return {
        status: "healthy" as const,
        checkedAt: nowIso(),
      };
    }
    const detail = result.stderr.trim() || `ssh exited with code ${result.code ?? "null"}.`;
    return {
      status: result.timedOut ? ("unreachable" as const) : ("degraded" as const),
      checkedAt: nowIso(),
      detail,
    };
  } catch (error) {
    return {
      status: "unreachable" as const,
      checkedAt: nowIso(),
      detail: error instanceof Error ? error.message : "SSH health check failed.",
    };
  }
}

function sanitizeConnectionForClient(
  connection: ExecutionTargetConnection,
): ExecutionTargetConnection {
  if (connection.kind !== "ssh") {
    return connection;
  }
  const { password: _password, passwordEnvVar: _passwordEnvVar, ...rest } = connection;
  return rest;
}

function sanitizeTargetForClient(target: ExecutionTarget): ExecutionTarget {
  return {
    ...target,
    connection: sanitizeConnectionForClient(target.connection),
  };
}

function resolveTargetForRuntime(input: {
  readonly stateDir: string;
  readonly target: ExecutionTarget;
}): ExecutionTarget {
  if (input.target.connection.kind !== "ssh") {
    return input.target;
  }

  const password = resolveSshPasswordSecret({
    stateDir: input.stateDir,
    connection: input.target.connection,
    targetId: input.target.id,
  });
  return {
    ...input.target,
    connection: {
      ...input.target.connection,
      ...(password !== undefined ? { password } : {}),
    },
  };
}

const makeExecutionTargetService = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const repository = yield* ExecutionTargetRepository;

  const getPersistedById = (targetId: ExecutionTargetId) =>
    repository.getById({ targetId }).pipe(
      Effect.mapError(
        (cause) =>
          new ExecutionTargetServiceError({
            message: `Unable to load execution target ${targetId}.`,
            cause,
          }),
      ),
      Effect.flatMap((targetOption) =>
        Option.match(targetOption, {
          onNone: () =>
            Effect.fail(
              new ExecutionTargetServiceError({
                message: `Execution target not found: ${targetId}`,
              }),
            ),
          onSome: (target) =>
            Effect.succeed({
              id: target.id,
              kind: target.kind,
              label: target.label,
              connection: target.connection,
              capabilities: target.capabilities,
              ...(target.health !== null ? { health: target.health } : {}),
            } satisfies ExecutionTarget),
        }),
      ),
    );

  const getPersistedExisting = (targetId: ExecutionTargetId) =>
    repository.getById({ targetId }).pipe(
      Effect.mapError(
        (cause) =>
          new ExecutionTargetServiceError({
            message: `Unable to load execution target ${targetId}.`,
            cause,
          }),
      ),
    );

  const list: ExecutionTargetServiceShape["list"] = () =>
    repository.listAll().pipe(
      Effect.mapError(
        (cause) =>
          new ExecutionTargetServiceError({
            message: "Unable to list execution targets.",
            cause,
          }),
      ),
      Effect.map((targets) => [
        buildSyntheticLocalTarget(),
        ...targets.map((target) =>
          sanitizeTargetForClient({
            id: target.id,
            kind: target.kind,
            label: target.label,
            connection: target.connection,
            capabilities: target.capabilities,
            ...(target.health !== null ? { health: target.health } : {}),
          } satisfies ExecutionTarget),
        ),
      ]),
    );

  const getById: ExecutionTargetServiceShape["getById"] = (targetId) => {
    if (targetId === LOCAL_EXECUTION_TARGET_ID) {
      return Effect.succeed(buildSyntheticLocalTarget());
    }
    return getPersistedById(targetId).pipe(Effect.map(sanitizeTargetForClient));
  };

  const getByIdForRuntime: ExecutionTargetServiceShape["getByIdForRuntime"] = (targetId) => {
    if (targetId === LOCAL_EXECUTION_TARGET_ID) {
      return Effect.succeed(buildSyntheticLocalTarget());
    }
    return getPersistedById(targetId).pipe(
      Effect.map((target) =>
        resolveTargetForRuntime({
          stateDir,
          target,
        }),
      ),
    );
  };

  const upsert: ExecutionTargetServiceShape["upsert"] = (input) =>
    Effect.gen(function* () {
      const existing =
        input.id !== undefined && input.id !== LOCAL_EXECUTION_TARGET_ID
          ? yield* getPersistedExisting(input.id)
          : Option.none();

      if (input.id === LOCAL_EXECUTION_TARGET_ID) {
        return yield* new ExecutionTargetServiceError({
          message: "The built-in local target cannot be modified.",
        });
      }

      const targetId = input.id ?? targetIdFromLabel(input.label);
      const existingConnection =
        Option.isSome(existing) && existing.value.connection.kind === "ssh"
          ? existing.value.connection
          : undefined;
      const persistedConnection =
        input.connection.kind === "ssh"
          ? (() => {
              const incomingPassword = input.connection.password?.trim();
              const existingPassword =
                existingConnection?.password ??
                (existingConnection
                  ? resolveSshPasswordSecret({
                      stateDir,
                      connection: existingConnection,
                      targetId,
                    })
                  : undefined);
              const nextPassword =
                incomingPassword && incomingPassword.length > 0
                  ? incomingPassword
                  : existingPassword;
              return {
                ...input.connection,
                ...(nextPassword !== undefined ? { password: nextPassword } : {}),
              };
            })()
          : input.connection;

      if (
        Option.isSome(existing) &&
        existing.value.connection.kind === "ssh" &&
        input.connection.kind !== "ssh"
      ) {
        deleteSshPasswordSecret({
          stateDir,
          envVarName: existing.value.connection.passwordEnvVar,
        });
      }

      const target: ExecutionTarget = {
        id: targetId,
        kind: persistedConnection.kind,
        label: input.label,
        connection: persistedConnection,
        capabilities: input.capabilities ?? defaultCapabilitiesForConnection(persistedConnection),
        ...(Option.isSome(existing) && existing.value.health !== null
          ? { health: existing.value.health }
          : {}),
      };
      const timestamp = nowIso();
      yield* repository
        .upsert({
          ...target,
          health: target.health ?? null,
          createdAt: Option.isSome(existing) ? existing.value.createdAt : timestamp,
          updatedAt: timestamp,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ExecutionTargetServiceError({
                message: `Unable to save execution target ${target.id}.`,
                cause,
              }),
          ),
        );
      return sanitizeTargetForClient(target);
    });

  const remove: ExecutionTargetServiceShape["remove"] = (input) =>
    Effect.gen(function* () {
      if (input.targetId === LOCAL_EXECUTION_TARGET_ID) {
        return yield* new ExecutionTargetServiceError({
          message: "The built-in local target cannot be removed.",
        });
      }

      const existing = yield* getPersistedExisting(input.targetId);
      if (Option.isSome(existing) && existing.value.connection.kind === "ssh") {
        deleteSshPasswordSecret({
          stateDir,
          envVarName: existing.value.connection.passwordEnvVar,
        });
      }

      return yield* repository.deleteById({ targetId: input.targetId }).pipe(
        Effect.mapError(
          (cause) =>
            new ExecutionTargetServiceError({
              message: `Unable to remove execution target ${input.targetId}.`,
              cause,
            }),
        ),
      );
    });

  const checkHealth: ExecutionTargetServiceShape["checkHealth"] = (input) =>
    Effect.gen(function* () {
      const target =
        input.targetId === LOCAL_EXECUTION_TARGET_ID
          ? buildSyntheticLocalTarget()
          : yield* getPersistedById(input.targetId);
      const runtimeTarget = resolveTargetForRuntime({
        stateDir,
        target,
      });
      const existingPersisted =
        target.id === LOCAL_EXECUTION_TARGET_ID
          ? Option.none()
          : yield* getPersistedExisting(target.id);
      let health: ExecutionTargetHealth;
      if (target.kind === "local") {
        health = {
          status: "healthy",
          checkedAt: nowIso(),
        };
      } else if (runtimeTarget.connection.kind === "ssh") {
        const sshConnection = runtimeTarget.connection;
        health = yield* Effect.promise(() => checkSshHealth(sshConnection)).pipe(
          Effect.mapError(
            (cause) =>
              new ExecutionTargetServiceError({
                message: `Unable to check health for ${target.id}.`,
                cause,
              }),
          ),
        );
        if (health.status === "healthy") {
          const codexHealth = yield* Effect.promise(async () => {
            try {
              const launch = await resolveRemoteCodexLaunchOptions({
                targetLabel: target.label,
                connection: {
                  host: sshConnection.host,
                  ...(sshConnection.port !== undefined ? { port: sshConnection.port } : {}),
                  ...(sshConnection.user !== undefined ? { user: sshConnection.user } : {}),
                  ...(sshConnection.password !== undefined
                    ? { password: sshConnection.password }
                    : {}),
                },
                ...(sshConnection.codexBinaryPath
                  ? { binaryPath: sshConnection.codexBinaryPath }
                  : {}),
                ...(sshConnection.codexHomePath ? { homePath: sshConnection.codexHomePath } : {}),
              });
              return {
                status: "healthy" as const,
                checkedAt: nowIso(),
                detail: `Codex CLI: ${launch.binaryPath}`,
              };
            } catch (cause) {
              return {
                status: "degraded" as const,
                checkedAt: nowIso(),
                detail:
                  cause instanceof Error
                    ? cause.message
                    : `Unable to resolve Codex CLI on target '${target.label}'.`,
              };
            }
          });
          health = codexHealth;
        }
      } else {
        health = {
          status: "unknown",
          checkedAt: nowIso(),
          detail: "Cloud target health checks are not implemented yet.",
        };
      }

      const nextTarget: ExecutionTarget = {
        ...target,
        health,
      };
      if (nextTarget.id !== LOCAL_EXECUTION_TARGET_ID) {
        yield* repository
          .upsert({
            ...nextTarget,
            health: nextTarget.health ?? null,
            createdAt: Option.isSome(existingPersisted)
              ? existingPersisted.value.createdAt
              : nowIso(),
            updatedAt: nowIso(),
          })
          .pipe(Effect.ignore);
      }
      return sanitizeTargetForClient(nextTarget);
    });

  return {
    list,
    upsert,
    remove,
    checkHealth,
    getById,
    getByIdForRuntime,
  } satisfies ExecutionTargetServiceShape;
});

export const ExecutionTargetServiceLive = Layer.effect(
  ExecutionTargetService,
  makeExecutionTargetService,
);
