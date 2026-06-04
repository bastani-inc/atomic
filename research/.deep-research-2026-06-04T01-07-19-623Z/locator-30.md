## 1. Must-read paths

- `packages/workflows/src/extension/index.ts`  
  Main workflow extension composition root; wires lifecycle hooks, MCP gating, intercom, notifications, and runtime adapters. This is the best “what must survive in Rust” map.

- `packages/workflows/src/extension/mcp.ts`  
  Defines `setMcpScope()` / `clearMcpScope()` and the `mcp.scope.set` event contract. This is the workflow→host boundary for per-stage MCP access control.

- `packages/workflows/src/extension/lifecycle-notifications.ts`  
  Implements `installWorkflowLifecycleNotifications()` plus dedupe/state for completed/failed/awaiting-input notices. This is the workflow lifecycle notification pipeline.

- `packages/workflows/src/intercom/intercom-routing.ts`  
  Pure intercom control callback factory: `buildIntercomCallbacks()`. Good candidate for Rust logic because it isolates routing from UI/store plumbing.

- `packages/workflows/src/intercom/result-intercom.ts`  
  Defines the `subagent:control-intercom` / `workflow:result-intercom` bridge and subscription flow. Important for parent/child workflow signaling.

- `packages/workflows/src/intercom/intercom-bridge.ts`  
  Parent-session registration and intercom session naming. This is the “how workflow sessions attach to intercom” contract.

- `packages/intercom/index.ts`  
  Extension entrypoint for the intercom package; handles `session_start` / `session_shutdown` and routes child/supervisor communication.

- `packages/intercom/broker/*`  
  IPC broker/client/framing/spawn layer. If you move to Rust, this is a likely place to replace Node process-based messaging with native IPC.

- `packages/mcp/index.ts`  
  MCP extension entrypoint; registers tools, lifecycle handlers, commands, and server state. Core adapter surface for Rust migration.

- `packages/mcp/server-manager.ts`  
  Server transport and auth lifecycle (stdio, HTTP/SSE, OAuth). High-value if Rust replaces Node MCP runtime.

## 2. Supporting paths

- `packages/workflows/src/extension/runtime.ts`  
  Runtime facade that dispatches workflow tools and connects intercom/result delivery.

- `packages/workflows/src/extension/wiring.ts`  
  Builds stage adapters from the host SDK; important for session lifecycle and stage-local UI/HIL behavior.

- `packages/workflows/src/extension/config-loader.ts`  
  Workflow config shape, including lifecycle notification settings.

- `packages/workflows/src/shared/store.ts` and `packages/workflows/src/shared/store-types.ts`  
  Shared persistence/state model used by lifecycle notices and intercom callbacks.

- `packages/subagents/src/extension/index.ts`  
  Subagent extension entrypoint; shows how parent/child orchestration, async jobs, and lifecycle hooks are tied together.

- `packages/subagents/src/runs/shared/pi-spawn.ts`  
  Process spawning boundary; critical decision point for “Rust in-process vs subprocess” migration strategy.

- `packages/subagents/src/intercom/intercom-bridge.ts` and `packages/subagents/src/intercom/result-intercom.ts`  
  Subagent-side intercom integration; complements workflow intercom routing.

- `packages/coding-agent/src/core/agent-session-runtime.ts`  
  Host session lifecycle sequencing (`session_start`, `session_shutdown`, reload/fork/new/resume). Needed to preserve hook ordering.

- `packages/coding-agent/src/core/extensions/types.ts`  
  Public extension ABI, especially lifecycle event contracts.

- `packages/coding-agent/docs/extensions.md`  
  Canonical lifecycle semantics for `session_start` / `session_shutdown`.

- `test/unit/integrations-mcp.test.ts`  
  Verifies `mcp.scope.set` emission and clearing.

- `test/unit/workflow-lifecycle-notifications.test.ts`  
  Verifies lifecycle notification behavior, dedupe, and suppression.

- `test/unit/intercom-routing.test.ts`  
  Verifies intercom callback routing in isolation.

- `test/unit/mcp-oauth-startup.test.ts`  
  Verifies MCP startup/lifecycle registration behavior.

- `test/unit/extension.test.ts` and `test/unit/agent-session-runtime-events.test.ts`  
  Good coverage for startup/shutdown ordering and extension reload semantics.

- `docs/ci.md` and `packages/coding-agent/package.json`  
  Explain what is built, bundled, and published today; useful for deciding what Rust replaces versus preserves.

## 3. Entry points / symbols

- `packages/workflows/src/extension/index.ts`
  - `installWorkflowLifecycleNotifications(...)`
  - `registerIntercomParentSession(...)`
  - `subscribeIntercomControl(...)`
  - `buildIntercomCallbacks(...)`
  - `setMcpScope(...)` / `clearMcpScope(...)`

- `packages/workflows/src/extension/mcp.ts`
  - `setMcpScope(pi, opts)`
  - `clearMcpScope(pi, stageId)`
  - `isMcpScopeSupported(pi)`

- `packages/workflows/src/extension/lifecycle-notifications.ts`
  - `createWorkflowLifecycleNotificationState()`
  - `installWorkflowLifecycleNotifications(...)`
  - `withWorkflowLifecycleNotificationsSuppressed(...)`
  - `withWorkflowLifecycleNotificationsSuppressedAsync(...)`

- `packages/workflows/src/intercom/intercom-routing.ts`
  - `buildIntercomCallbacks(deps)`

- `packages/intercom/index.ts`
  - `default export function registerIntercomExtension(pi)`
  - `pi.on("session_start", ...)`
  - `pi.on("session_shutdown", ...)`

- `packages/mcp/index.ts`
  - `default export function mcpAdapter(pi)`
  - `pi.on("session_start", ...)`
  - `pi.on("session_shutdown", ...)`
  - `pi.registerTool(...)`
  - `pi.registerCommand("mcp", ...)`
  - `pi.registerCommand("mcp-auth", ...)`

- `packages/coding-agent/src/core/agent-session-runtime.ts`
  - `session_start`
  - `session_shutdown`
  - reload/new/resume/fork sequencing

## 4. Gaps or uncertainty

- I verified the repository is still TypeScript/Bun-first and found **no Rust crate** (`Cargo.toml` / `*.rs`) in the scout artifact.
- The exact Rust migration path is still unclear: **native Rust rewrite vs Rust host + JS plugin bridge**.
- I could verify the existence of lifecycle hook usage, but not a single authoritative “event bus ABI” doc outside the TS source/docs.
- `packages/mcp/server-manager.ts` looks crucial, but I did not inspect its full transport/auth internals here.
- `packages/intercom/broker/*` likely matters a lot for a Rust port, but I only verified the path, not the protocol details.