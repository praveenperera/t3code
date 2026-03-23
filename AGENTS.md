# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

### Upstream Merge Safety

- Prefer creating new files for custom T3 behavior instead of heavily editing upstream/core files.
- Keep edits to upstream/core files as thin integration points whenever possible: import the extracted module and wire it in with a small, obvious change.
- For diff-viewer customizations, prefer extracted modules under `apps/web/src/components/diff/` rather than expanding `apps/web/src/components/DiffPanel.tsx`.
- If a feature can be isolated into a helper, hook, or leaf component, extract it. Reducing future merge conflicts with `main` is an explicit goal.

### UI Change Expectations

- Treat mobile and desktop as first-class targets. Do not ship desktop-only fixes when the affected feature is also used on mobile.
- When adding global UI settings such as sizing, make them actually flow through the app. Avoid one-off component sizing that bypasses the global setting.
- Keep mobile headers compact. If the header starts to crowd the viewport, extract or collapse controls instead of adding more top-level buttons.

### Live Web Deploy Flow

- When the user asks to make a web change live, rebuild `apps/web` first, then rebuild `apps/server`, then restart `t3code-web.service`.
- Do not build `apps/web` and `apps/server` in parallel for a deploy. The server build copies the current web build into `apps/server/dist/client`, so parallel builds can deploy stale frontend assets even when both builds succeed.
- Use this exact order:
  1. `cd apps/web && bun run build`
  2. `cd apps/server && bun run build`
  3. `systemctl --user restart t3code-web.service`
- In this environment, `bun` may not be on `PATH` inside tool-run shells. If `bun: command not found` appears, prefix commands with `export PATH="$HOME/.bun/bin:$PATH" && ...`.
- After restarting, verify the deploy instead of assuming it worked. Check both:
  - service state via `systemctl --user show t3code-web.service -p MainPID -p ExecMainStartTimestamp -p ActiveState -p SubState`
  - rebuilt artifact timestamps for `apps/web/dist/index.html`, `apps/server/dist/index.mjs`, and `apps/server/dist/client/index.html`
- The tool wrapper may report `systemctl --user restart t3code-web.service` as `aborted` even when the restart actually succeeded. Treat `systemctl --user show ...`, artifact timestamps, and the live served asset hash as the source of truth.
- When verifying the live frontend, also check the served asset hash directly, for example:
  - `curl -s "$APP_URL" | rg -o '/assets/index-[^" ]+\\.(js|css)'`

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
