import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

import type { ProviderSessionStartInput } from "@t3tools/contracts";

import { createRemoteClaudeSpawnProcess } from "../../executionTarget/remoteClaude.ts";
import type { SshConnectionSpec } from "../../executionTarget/ssh.ts";

export function createClaudeSshSpawnProcess(
  _runtimeInput: ProviderSessionStartInput,
  ssh: SshConnectionSpec,
): (options: SpawnOptions) => SpawnedProcess {
  return (options) => createRemoteClaudeSpawnProcess(ssh, options);
}
