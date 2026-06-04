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