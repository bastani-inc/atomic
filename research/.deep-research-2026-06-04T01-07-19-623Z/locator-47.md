## 1. Must-read paths

- `packages/coding-agent/src/core/extensions/loader.ts` — dynamic TS/JS extension loading (`jiti/static`); biggest trust-boundary for arbitrary local code.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI: tools, commands, events, UI, providers, message renderers.
- `packages/workflows/src/extension/workflow-module-loader.ts` — loads user workflow `.ts` modules; same trust problem as extensions.
- `packages/mcp/server-manager.ts` — MCP subprocess/transports/OAuth lifecycle; key for external-process trust and isolation.
- `packages/mcp/index.ts` — MCP tool registration/proxy/direct tools; shows what is exposed to agents.
- `packages/web-access/extract.ts` — web content fetching/extraction entrypoint; important for remote-content trust and sanitization.
- `packages/web-access/github-extract.ts`, `packages/web-access/video-extract.ts` — more external-content ingestion surfaces.
- `packages/intercom/broker/` — IPC framing/broker/client; local process-to-process trust and message integrity.
- `packages/subagents/src/runs/shared/pi-spawn.ts` — child process spawning model for subagents.
- `packages/subagents/src/runs/shared/worktree.ts` — isolation boundary for file-system mutation in subagent runs.
- `packages/coding-agent/src/core/tools/` — built-in tool permission surface (`read`, `bash`, `edit`, `write`, `todo`, etc.).
- `packages/coding-agent/src/core/tools/bash.ts` + `packages/coding-agent/src/core/exec.ts` — shell execution risk surface.
- `packages/coding-agent/src/core/tools/edit.ts` + `write.ts` + `file-mutation-queue.ts` — filesystem mutation safety model.
- `packages/coding-agent/src/core/sdk.ts` — central session/tool/provider boundary; where trust decisions are assembled.
- `packages/coding-agent/docs/extensions.md`, `docs/rpc.md`, `docs/tui.md`, `docs/session-format.md` — canonical contracts that define what must remain trusted vs changed.

## 2. Supporting paths

- `packages/coding-agent/src/core/agent-session.ts` — runtime wrapper for tools, extensions, sessions, events.
- `packages/coding-agent/src/core/session-manager.ts` — session persistence and replay.
- `packages/coding-agent/src/core/model-registry.ts` — provider/auth boundaries.
- `packages/coding-agent/src/core/resource-loader.ts` — discovery of builtin/discovered resources.
- `packages/coding-agent/src/core/package-manager.ts` — package/manifest discovery, compatibility with local app manifests.
- `packages/workflows/src/runs/` — workflow execution paths that may invoke untrusted user-authored code.
- `packages/workflows/builtin/` — builtin workflows; useful to separate trusted orchestration from user-defined flows.
- `packages/subagents/src/agents/` — agent definitions and associated trust assumptions.
- `packages/mcp/config.ts`, `packages/mcp/OAUTH.md` — config/auth trust model for external servers.
- `packages/web-access/curator-server.ts`, `storage.ts` — persistence and review of fetched web content.
- `packages/intercom/ui/`, `packages/intercom/reply-tracker.ts` — IPC UI and reply routing.
- `packages/coding-agent/src/config.ts` — `.atomic` / legacy `.pi` config paths and env-based trust toggles.
- `docs/ci.md`, `.github/workflows/test.yml`, `.github/workflows/publish.yml` — CI gates likely enforce current trust assumptions.

## 3. Entry points / symbols

- `loader.ts`: `loadExtensions`, dynamic import helpers, `jiti` usage.
- `types.ts`: `Extension`, `Tool`, `Provider`, `UI`, `Event` interfaces.
- `workflow-module-loader.ts`: workflow module resolver/loader.
- `server-manager.ts`: MCP server lifecycle, transport setup.
- `index.ts` in `packages/mcp`: tool registration + proxy/direct exposure.
- `pi-spawn.ts`: child process launch and session handoff.
- `bash.ts`: shell command execution tool.
- `edit.ts` / `write.ts`: user-approved file mutation tools.
- `intercom/broker/*`: broker/client/framing protocol symbols.
- `sdk.ts`: `createAgentSession()` and adjacent wiring.
- `session-manager.ts`: JSONL/session branch persistence.

## 4. Gaps or uncertainty

- I could verify the existence of the main trust-boundary files from the scout, but not every subfile in each directory.
- The exact permission model for each tool (`bash`, `edit`, `write`, MCP proxy, web fetch) should be confirmed in the implementation files and tests.
- I could not verify whether any sandboxing/allowlist logic exists beyond the loader/spawn boundaries.
- The Rust migration impact depends on whether you want to **preserve trusted local TS execution** or **replace it with a new plugin ABI/sandbox**; the repo currently appears to assume trusted local code.
- I did not verify whether these trust surfaces are covered by dedicated security tests versus only integration tests.