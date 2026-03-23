import { describe, expect, it } from "vitest";

import { buildRemoteClaudeResolveCommand, resolveRemoteClaudeLaunchOptions } from "./remoteClaude";

describe("remoteClaude", () => {
  it("builds a login-shell resolver with common claude fallbacks", () => {
    const command = buildRemoteClaudeResolveCommand();

    expect(command).toContain('for candidate in "${SHELL:-}"');
    expect(command).toContain('output="$("$candidate" -ilc');
    expect(command).toContain('output="$("$candidate" -lc');
    expect(command).toContain("/opt/homebrew/bin/claude");
    expect(command).toContain("/usr/local/bin/claude");
    expect(command).toContain('printf "%s\\n" "$output"');
  });

  it("resolves an explicit remote claude path from ssh output", async () => {
    const result = await resolveRemoteClaudeLaunchOptions({
      targetLabel: "macbook",
      connection: {
        host: "example.com",
        user: "nick",
      },
      binaryPath: "/opt/homebrew/bin/claude",
      run: async () => ({
        code: 0,
        stdout: "/opt/homebrew/bin/claude\n",
        stderr: "",
        signal: null,
        timedOut: false,
      }),
    });

    expect(result).toEqual({
      binaryPath: "/opt/homebrew/bin/claude",
    });
  });

  it("surfaces a helpful error when claude cannot be resolved remotely", async () => {
    await expect(
      resolveRemoteClaudeLaunchOptions({
        targetLabel: "macbook",
        connection: {
          host: "example.com",
        },
        run: async () => ({
          code: 1,
          stdout: "",
          stderr: "",
          signal: null,
          timedOut: false,
        }),
      }),
    ).rejects.toThrow(
      "Claude Code CLI could not be found on target 'macbook'. Install claude there or set the target's Claude binary path in Settings.",
    );
  });
});
