import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";

export const ExecutionTargetId = TrimmedNonEmptyString;
export type ExecutionTargetId = typeof ExecutionTargetId.Type;

export const EXECUTION_TARGET_KINDS = ["local", "ssh", "cloud"] as const;

export const ExecutionTargetKind = Schema.Literals(EXECUTION_TARGET_KINDS);
export type ExecutionTargetKind = typeof ExecutionTargetKind.Type;

export const LOCAL_EXECUTION_TARGET_ID = ExecutionTargetId.makeUnsafe("local");

export const ExecutionTargetCapabilities = Schema.Struct({
  provider: Schema.Boolean,
  terminal: Schema.Boolean,
  git: Schema.Boolean,
  files: Schema.Boolean,
  search: Schema.Boolean,
  attachments: Schema.Boolean,
  portForward: Schema.Boolean,
});
export type ExecutionTargetCapabilities = typeof ExecutionTargetCapabilities.Type;

export const ExecutionTargetHealthStatus = Schema.Literals([
  "unknown",
  "healthy",
  "degraded",
  "unreachable",
]);
export type ExecutionTargetHealthStatus = typeof ExecutionTargetHealthStatus.Type;

export const ExecutionTargetHealth = Schema.Struct({
  status: ExecutionTargetHealthStatus,
  checkedAt: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ExecutionTargetHealth = typeof ExecutionTargetHealth.Type;

const ExecutionTargetSshConnection = Schema.Struct({
  kind: Schema.Literal("ssh"),
  host: TrimmedNonEmptyString,
  port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))),
  user: Schema.optional(TrimmedNonEmptyString),
  password: Schema.optional(Schema.String),
  passwordEnvVar: Schema.optional(TrimmedNonEmptyString),
  claudeBinaryPath: Schema.optional(TrimmedNonEmptyString),
  codexBinaryPath: Schema.optional(TrimmedNonEmptyString),
  codexHomePath: Schema.optional(TrimmedNonEmptyString),
});

const ExecutionTargetCloudConnection = Schema.Struct({
  kind: Schema.Literal("cloud"),
  baseUrl: TrimmedNonEmptyString,
});

export const ExecutionTargetConnection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local") }),
  ExecutionTargetSshConnection,
  ExecutionTargetCloudConnection,
]);
export type ExecutionTargetConnection = typeof ExecutionTargetConnection.Type;

export const ExecutionTarget = Schema.Struct({
  id: ExecutionTargetId,
  kind: ExecutionTargetKind,
  label: TrimmedNonEmptyString,
  connection: ExecutionTargetConnection,
  capabilities: ExecutionTargetCapabilities,
  health: Schema.optional(ExecutionTargetHealth),
});
export type ExecutionTarget = typeof ExecutionTarget.Type;

export const DEFAULT_LOCAL_EXECUTION_TARGET_CAPABILITIES = {
  provider: true,
  terminal: true,
  git: true,
  files: true,
  search: true,
  attachments: true,
  portForward: true,
} as const satisfies ExecutionTargetCapabilities;

export const DEFAULT_SSH_EXECUTION_TARGET_CAPABILITIES = {
  provider: true,
  terminal: true,
  git: true,
  files: true,
  search: true,
  attachments: true,
  portForward: true,
} as const satisfies ExecutionTargetCapabilities;

export const DEFAULT_CLOUD_EXECUTION_TARGET_CAPABILITIES = {
  provider: true,
  terminal: true,
  git: true,
  files: true,
  search: true,
  attachments: true,
  portForward: true,
} as const satisfies ExecutionTargetCapabilities;

export const ExecutionTargetUpsertInput = Schema.Struct({
  id: Schema.optional(ExecutionTargetId),
  label: TrimmedNonEmptyString,
  connection: Schema.Union([ExecutionTargetSshConnection, ExecutionTargetCloudConnection]),
  capabilities: Schema.optional(ExecutionTargetCapabilities),
});
export type ExecutionTargetUpsertInput = typeof ExecutionTargetUpsertInput.Type;

export const ExecutionTargetRemoveInput = Schema.Struct({
  targetId: ExecutionTargetId,
});
export type ExecutionTargetRemoveInput = typeof ExecutionTargetRemoveInput.Type;

export const ExecutionTargetCheckHealthInput = Schema.Struct({
  targetId: ExecutionTargetId,
});
export type ExecutionTargetCheckHealthInput = typeof ExecutionTargetCheckHealthInput.Type;

export const ExecutionTargetListResult = Schema.Array(ExecutionTarget);
export type ExecutionTargetListResult = typeof ExecutionTargetListResult.Type;
