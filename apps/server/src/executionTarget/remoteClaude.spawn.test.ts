import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

describe("createRemoteClaudeSpawnProcess", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue({
      stdin: null,
      stdout: null,
      killed: false,
      exitCode: null,
      kill: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    });
  });

  it("does not pass the remote cwd into the local ssh spawn", async () => {
    const { createRemoteClaudeSpawnProcess } = await import("./remoteClaude");

    createRemoteClaudeSpawnProcess(
      {
        host: "example.com",
        user: "nick",
      },
      {
        command: "/Users/nick/.local/bin/claude",
        args: ["--output-format", "stream-json"],
        cwd: "/Users/nick/project",
        env: {},
        signal: new AbortController().signal,
      } satisfies SpawnOptions,
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      env: expect.any(Object),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    expect(spawnMock.mock.calls[0]?.[2]).not.toHaveProperty("cwd");
  });
});
