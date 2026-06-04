## Partition 47: Security and trust model for TS extensions, workflows, MCP subprocesses, web fetching, IPC, and tool permissions

### Locator
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

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is a **trust-boundary map** for a TS-first agent runtime:

- **TS extensions/workflows are trusted local code**. They are loaded with `jiti` and executed in-process:
  - extensions: `packages/coding-agent/src/core/extensions/loader.ts`
  - workflows: `packages/workflows/src/extension/workflow-module-loader.ts`
- **Extensions get a privileged API surface**: register tools/commands/shortcuts/flags/renderers and call runtime actions (`sendMessage`, `exec`, `setModel`, etc.). The loader wraps these through an `ExtensionRuntime` that can be invalidated after session replacement.
- **Workflows are stricter than generic extensions**: the loader accepts only branded definitions (`__piWorkflow === true`, `name`, `normalizedName`, `run()`), rejecting hand-rolled objects.
- **MCP is an external-process trust boundary**:
  - supports stdio subprocesses, Streamable HTTP, SSE, OAuth
  - probes/refreshes tools/resources after connect
  - cleans up on auth failure or connect errors
- **Web fetching is remote-content ingestion, not execution**:
  - content goes through readability / turndown / PDF / GitHub / video extractors
  - it is filtered, bounded, and often serialized as markdown/text
- **Intercom is local IPC with explicit framing and schema checks**:
  - broker validates registration, messages, attachments, session info
  - clients must register before any other message
- **Built-in tools are the main permission layer**:
  - `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `ask_user_question`, `todo`
  - `bash` and file mutation tools are the highest-risk primitives

For Rust migration, this means the key question is not “convert TS syntax,” but **what stays as trusted plugin code vs what becomes a Rust-native ABI/sandbox**.

## 2. Key flows and invariants

### TS extension loading
- `loadExtensions()` creates one shared runtime and loads each module via `jiti`.
- In Bun binary mode, imports are redirected through `virtualModules`; in dev, aliases point at workspace/node_modules equivalents.
- Invariants:
  - extension API methods check `runtime.assertActive()`
  - runtime can be invalidated after session replacement/reload
  - extensions may register tools/providers before full core binding, but action methods are not usable during loading

### Workflow loading
- `loadWorkflowModule()` uses a dedicated `jiti` instance with:
  - `moduleCache: false`
  - `tryNative: false`
  - virtual builtin SDK/module aliases
- Invariants:
  - workflow files are re-evaluated fresh on reload
  - only branded workflow definitions are accepted
  - default export is checked first, then named exports

### MCP
- `McpServerManager.connect()` dedupes concurrent connects and reuses healthy connections.
- For `command` servers:
  - `npx`/`npm` may be resolved to direct binaries to avoid parent wrappers
  - child transport gets env/cwd from config
- For `url` servers:
  - tries Streamable HTTP first, then SSE fallback
  - OAuth/UnauthorizedError triggers “needs-auth” state instead of hard failure
- Invariants:
  - one connection record per server name
  - failed connects close both client and transport
  - tools/resources are fetched only after successful connect

### Web fetching
- `extractContent()` gates by content type and context:
  - can fetch Jina reader fallback
  - supports YouTube/local video frame extraction
  - enforces timeouts, concurrency limit, abort handling
- Invariants:
  - abort returns a clean aborted result
  - unsupported/oversized content is treated as non-recoverable
  - extraction is read-only; no direct code execution in this layer

### Intercom IPC
- Broker requires `register` first.
- It validates session registration and message shape before routing.
- Invariants:
  - invalid messages throw
  - duplicate register is rejected
  - disconnects trigger session removal and shutdown checks
  - message delivery is explicit and typed

### Tool permissions
- `bash`:
  - checks cwd exists
  - streams stdout/stderr
  - supports timeout + abort + process-tree kill
- `edit`:
  - normalizes edits, supports legacy `oldText/newText`
  - uses a file mutation queue to serialize writes
  - checks abort between async steps
- `write`:
  - creates parent dirs automatically
  - also serialized by mutation queue
- Invariants:
  - file mutation queue is the safety net against concurrent edits
  - the tools assume local filesystem/process authority unless overridden by custom ops

## 3. Tests / validation

Evidence from the artifacts suggests **behavior is contract-heavy but security-specific test coverage is incomplete**.

What is visible:
- the modules themselves encode validation logic:
  - workflow branding checks
  - intercom schema guards
  - bash cwd existence and timeout/abort handling
  - edit/write mutation serialization
  - MCP auth/error branching
- the scout notes point to root/unit/integration tests and package tests, but **do not confirm dedicated security tests** for all trust boundaries.

Good validation targets for this partition:
- extension loader rejects invalid factories and stale runtime usage
- workflow loader rejects non-branded or malformed exports
- MCP manager:
  - dedupes connects
  - falls back correctly
  - marks OAuth-needed servers properly
- intercom:
  - register-first enforcement
  - invalid payload rejection
  - delivery failure paths
- tool safety:
  - abort/timeout behavior
  - concurrent mutation serialization
  - path resolution / cwd existence checks

## 4. Risks, unknowns, and verification steps

### Main migration risks
- **Dynamic TS plugins are the biggest blocker**: Rust cannot directly preserve `jiti`-style in-process loading without embedding JS or changing the plugin ABI.
- **Current model assumes trusted local code**. A Rust port must decide whether to:
  1. keep TS plugins via embedded JS,
  2. shell out to plugin workers,
  3. replace plugins with a Rust-native extension format.
- **Tool permission semantics are implicit, not centrally sandboxed**:
  - `bash` can do anything the OS allows
  - `edit/write` are only serialized, not sandboxed
  - MCP servers may be arbitrary subprocesses/remote endpoints
- **Web extraction trusts remote content as data**, but it still depends on many native/process-backed helpers (`ffmpeg`, `yt-dlp`, browser-ish parsers, external APIs).
- **Intercom is local IPC with validation, not isolation**: any local peer that can connect to the socket can participate if it speaks the protocol.

### Unknowns to verify next
- Whether CI has any dedicated tests for trust boundaries vs only general integration coverage.
- Whether extension/workflow plugins are expected to remain user-authored TS after a Rust rewrite.
- Whether MCP/web extraction are intended to stay subprocess-based in Rust or be reimplemented natively.
- Whether session/tool permissions are enforced elsewhere (UI/runtime) beyond the tool implementations shown here.

### Practical verification steps
- Trace the `ExtensionRuntime.bindCore()`/invalidation path to see exactly when plugin actions become live/stale.
- Read the remaining `mcp/server-manager.ts` and `intercom/broker/*` for shutdown, routing, and auth edge cases.
- Search tests for:
  - `loader`, `workflow-module-loader`, `McpServerManager`, `intercom`, `bash`, `edit`, `write`
- Decide the Rust migration contract up front:
  - **compatibility-first** (embed JS, preserve TS plugins)
  - **security-first** (new sandbox/plugin ABI)
  - **hybrid** (Rust core + JS extension host)

### Online Researcher
## 1. Relevant external facts

- **MCP trust model (official SECURITY.md + transports spec)**  
  - MCP clients **trust the servers they connect to**.  
  - For **stdio** transport, the client launches the server as a subprocess; this is **intentional**, not a vulnerability.  
  - For **Streamable HTTP**, servers must validate `Origin`, bind locally when possible, and use auth where needed to avoid DNS rebinding / remote access issues.  
  - MCP explicitly treats **LLM-driven tool invocation**, file access, git ops, database ops, and system commands as expected capabilities when a server is configured to provide them.  
  **Source:** Model Context Protocol `SECURITY.md` and `transports` spec (2025-06-18).

- **Bun runtime behavior**  
  - Bun executes `.ts`/`.tsx` files by **transpiling on the fly**.  
  - Bun supports extensioned TS imports and runtime loaders, so the current repo’s “raw TS” model is closely tied to Bun’s runtime.  
  **Source:** Bun Runtime / TypeScript docs.

## 2. Local implications

- Your repo’s current architecture assumes **trusted local code execution**:
  - TS extensions and workflows are loaded dynamically (`jiti/static` per the locator).
  - MCP servers are spawned as subprocesses.
  - Web fetching ingests remote content into local tools/UI.
  - IPC/intercom and subagent worktrees rely on local process trust boundaries.
- If you migrate the repo to Rust, the main security question is **not just language replacement**; it’s whether you will:
  1. **Preserve trusted plugin execution** (Rust host still loads untrusted/semitrust extensions/workflows), or
  2. **Replace dynamic TS execution with a stricter ABI/sandbox model**.
- If you keep the same trust model, Rust mainly changes implementation safety/performance, not the security boundary.
- If you want stronger isolation, Rust is a good time to:
  - move extensions/workflows/MCP adapters to a **process boundary**,
  - define a **narrow IPC protocol**,
  - and treat fetched web content / tool inputs as untrusted data only.

## 3. Version/API assumptions

- MCP assumptions here are based on the **2025-06-18** transport/security docs.
- Bun assumptions are based on current Bun runtime docs showing **native TS transpilation** and extensioned imports.
- I did **not** verify the exact `jiti/static` semantics beyond the repo locator; treat it as a **dynamic local-code loading boundary** unless the implementation proves otherwise.

## 4. Unverified or unnecessary research

- I did **not** deeply inspect the local loader/spawn code in this pass.
- I did **not** verify whether your repo currently has any sandboxing/allowlist protections beyond the obvious trust boundaries.
- For the migration question, external research on Rust ecosystems is less important than deciding your **target trust model** first.