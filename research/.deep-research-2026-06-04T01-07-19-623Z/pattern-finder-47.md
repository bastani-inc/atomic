## 1. Established patterns

- **“Trusted local TS” is the default security model.**  
  Extensions/workflows are loaded as executable TS/JS, not data. Examples:
  - `packages/coding-agent/src/core/extensions/loader.ts` uses `jiti/static` plus `virtualModules`.
  - `packages/workflows/src/extension/workflow-module-loader.ts` loads user workflow files through a shared `jiti` instance.
  - The workflow loader explicitly preserves ESM/CJS/TS semantics and accepts authored exports.

- **Compatibility-first trust boundaries are encoded in loaders, not a sandbox.**  
  The extension loader whitelists in-memory modules for TS extensions:
  - `@bastani/atomic`, `@earendil-works/pi-*`, `@sinclair/typebox` are injected via `VIRTUAL_MODULES`.
  - Dev/runtime aliasing is mirrored in `getAliases()` so extensions can import stable package names.

- **Subprocess-based isolation is used where native boundaries already exist.**
  - `packages/subagents/src/runs/shared/pi-spawn.ts` resolves the CLI script and falls back to spawning `APP_NAME`.
  - `packages/mcp/server-manager.ts` supports `stdio`, `streamableHttp`, and `sse` transports rather than in-process execution.
  - This suggests the repo already treats some integrations as “external processes we talk to,” not libraries to embed.

- **Network/tool access is capability-shaped, not globally sandboxed.**
  - `packages/web-access/index.ts` gates behavior on provider availability (`exa`, `perplexity`, `gemini`) and user config.
  - It persists config under `.atomic` and has explicit workflow/timeout/shortcut settings.
  - The extension API exposes rich UI and tool operations, implying trust in local code with broad application control.

- **IPC uses a lightweight framed protocol with structural validation.**
  - `packages/intercom/broker/broker.ts` validates `register`, `send`, `list`, `unregister` messages with type guards.
  - Sessions are tracked by `sessionId`, and the broker broadcasts join/leave events.
  - This is a “validated local socket” model, not authenticated remote IPC.

- **Tooling is permissioned by registration and runtime context, not per-call policy objects.**
  - `packages/coding-agent/src/core/extensions/types.ts` gives extensions access to UI, session, model, and tool APIs.
  - `createExtensionRuntime()` in `loader.ts` starts with throwing stubs, then binds real capabilities later.
  - The main control is “what gets registered into the runtime,” not capability tokens.

## 2. Variations / exceptions

- **Workflow loading is stricter than extension loading in shape, but not in trust.**
  - `validateWorkflowDefinitionShape()` requires `__piWorkflow`, `name`, `normalizedName`, and `run`.
  - But it still executes authored modules through `jiti`; validation is structural, not sandboxing.

- **MCP has stronger transport-level distinctions than other subsystems.**
  - `server-manager.ts` differentiates command-based stdio servers from URL-based HTTP servers.
  - OAuth/Unauthorized handling is special-cased; `needs-auth` is a separate server state.
  - This is a more formal trust boundary than web-access or extensions.

- **Some features are explicitly user-configurable, not hardcoded.**
  - `web-access` reads `web-search.json` for provider/workflow/timeout/shortcuts.
  - That means security/trust behavior can change per-user without code changes.

- **Legacy compatibility is part of the contract.**
  - The loader aliases both `@earendil-works/*` and `@mariozechner/*`.
  - `pi-spawn.ts` resolves both `APP_NAME` and legacy `pi` bin fields.
  - Rust migration will need to preserve these compatibility seams or break older extensions/scripts.

## 3. Anti-patterns or risks

- **No sandbox around arbitrary TS execution.**  
  `jiti`-loaded extensions/workflows run with full local process privileges. For a Rust migration, replacing TS with Rust without a plugin sandbox would preserve this risk; adding a sandbox would be a breaking security-model change.

- **Runtime capability surface is very broad.**  
  The extension API includes UI mutation, session/model control, tool registration, and event hooks in one place (`types.ts`). That makes least-privilege separation hard.

- **Process boundary assumptions are implicit.**  
  `pi-spawn.ts` and MCP transports rely on external binaries and Node-style execution semantics. A Rust rewrite must decide whether these remain subprocesses, become FFI, or move to native Rust services.

- **Local IPC is only structurally validated.**  
  `intercom/broker/broker.ts` checks shape, but not authentication or authorization. Any local process that can reach the socket can participate.

- **Web fetching/tooling mixes config, runtime detection, and execution.**  
  `web-access/index.ts` combines provider selection, browser availability checks, config I/O, and curator logic in one subsystem, which increases migration coupling.

- **Rust migration pressure point: dynamic module loading.**  
  `jiti`-based loading is the main incompatibility with a pure-Rust host. You either keep JS execution, redesign plugins, or abandon compatibility.

## 4. Evidence index

- `packages/coding-agent/src/core/extensions/loader.ts` — `jiti`, `virtualModules`, aliasing, runtime stubs.
- `packages/coding-agent/src/core/extensions/types.ts` — extension API surface and tool/UI/session permissions.
- `packages/workflows/src/extension/workflow-module-loader.ts` — workflow TS loading, module normalization, structural validation.
- `packages/subagents/src/runs/shared/pi-spawn.ts` — CLI subprocess resolution and fallback behavior.
- `packages/mcp/server-manager.ts` — stdio/HTTP/SSE transports, OAuth/Unauthorized handling, connection lifecycle.
- `packages/web-access/index.ts` — provider selection, config persistence, runtime web tool behavior.
- `packages/intercom/broker/broker.ts` — socket IPC framing, message validation, session routing.