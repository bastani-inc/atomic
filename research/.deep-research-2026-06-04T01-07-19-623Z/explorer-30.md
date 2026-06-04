## Partition 30: Workflow integrations with intercom, MCP, lifecycle hooks, and notifications

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Everything is wired through a thin, structural `pi` surface, not hard imports.**  
  These modules define minimal interfaces like `PiEventBus`, `PiMcpExtensionAPI`, `PiIntercomExtensionAPI`, then no-op when methods are missing. This is the main compatibility pattern to preserve in Rust.

- **Event-name contracts are the real API.**  
  The workflow layer talks to the host via string events:
  - `mcp.scope.set`
  - `subagent:control-intercom`
  - `subagent:control-intercom:response`
  - `workflow:control-intercom`
  - `workflow:result-intercom`
  - custom message types like `workflows:lifecycle-notice` and `workflows:hil-answer-notice`

- **Install/uninstall lifecycle wrappers are standard.**  
  Each integration exposes an `install...()` function that:
  1. registers listeners/renderers,
  2. seeds state if needed,
  3. returns a cleanup function.

- **Stateful dedupe is used to avoid duplicate notifications.**  
  `workflow-lifecycle-notifications.ts` tracks delivered terminal runs and prompts; HIL answer notifications track delivered prompts. This prevents replay/restoration from re-notifying.

- **Renderer registration is deduped per host object.**  
  Both notification modules use a `WeakSet<object>` to avoid re-registering the same renderer on the same host.

- **Best-effort, failure-isolated delivery is intentional.**  
  Notification sends are wrapped in `try/catch` and `Promise.resolve(...).catch(...)` so failures do not abort sibling store subscribers.

- **Workflow lifecycle notices are “steer” messages; HIL answer notices are display-only.**  
  Lifecycle notices call `sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`.  
  HIL answer notices call `sendMessage(..., { triggerTurn: false, excludeFromContext: true })`.

- **MCP scoping is modeled as stage-local allow/deny scope.**  
  `setMcpScope()` emits allow/deny arrays; `clearMcpScope()` resets both to `null`. This is a clean host-compatibility seam.

- **Intercom is bridged as two directions:**
  - workflow → host: `workflow:control-intercom` / `workflow:result-intercom`
  - host → workflow: `subagent:control-intercom`
  
  `subscribeIntercomControl()` routes incoming subagent escalation into UI/store callbacks.

## 2. Variations / exceptions

- **MCP integration is intentionally one-way and minimal.**  
  It only emits scope events; it does not depend on any MCP package internals.

- **Intercom parent-session naming is a one-off structural helper.**  
  `registerIntercomParentSession()` derives `pi-workflows-parent-<cwd-hash>` and is only used when `setSessionName` exists.

- **Lifecycle notices have a richer state machine than HIL notices.**  
  Lifecycle code seeds from snapshots, supports suppression depth, and handles run- vs stage-level awaiting-input states.

- **HIL answer notifications split responsibility across two sources.**  
  They listen to both store transitions and `StageUiBroker.onStagePromptResolved()`, so the same semantic event can arrive from persistence or UI resolution.

- **`workflowIntercomAvailable()` only checks for `emit`.**  
  Result/control intercom emission is gated by `emit` presence, while parent-session data is optional.

- **Unknown intercom payload types are explicitly tolerated.**  
  `subscribeIntercomControl()` falls back to `onUnknown`, which makes forward compatibility part of the design.

## 3. Anti-patterns or risks

- **Stringly-typed integration contracts are everywhere.**  
  A Rust port will need exact event-name parity or a compatibility shim.

- **Notifications depend on store snapshots staying consistent across restarts/replays.**  
  If Rust changes persistence semantics, dedupe seeding and “already delivered” logic must be preserved carefully.

- **Custom renderer registration is global-ish and not reversible.**  
  The WeakSet dedupe avoids duplicates, but there is no unregister path.

- **`Promise.reject(...)` is used as an async error surfacing trick.**  
  That pattern is runtime-specific and may not map cleanly to Rust event loops.

- **`unknown as Record<string, unknown>` casts hide the real payload shape.**  
  Rust will need explicit structs/enums to avoid losing contract clarity.

- **The workflow system assumes host-side UI and event buses exist, but degrades silently when absent.**  
  Rust migration must decide whether to keep these no-op fallbacks or make them explicit errors.

## 4. Evidence index

- `packages/workflows/src/extension/mcp.ts`
  - `setMcpScope`, `clearMcpScope`, `isMcpScopeSupported`
  - emits `mcp.scope.set`

- `packages/workflows/src/extension/lifecycle-notifications.ts`
  - `installWorkflowLifecycleNotifications`
  - `createWorkflowLifecycleNotificationState`
  - `withWorkflowLifecycleNotificationsSuppressedAsync`
  - `registerLifecycleNoticeRenderer`
  - `LIFECYCLE_NOTICE_CUSTOM_TYPE`

- `packages/workflows/src/extension/hil-answer-notifications.ts`
  - `installWorkflowHilAnswerNotifications`
  - `registerHilAnswerNoticeRenderer`
  - `HIL_ANSWER_NOTICE_CUSTOM_TYPE`

- `packages/workflows/src/intercom/intercom-bridge.ts`
  - `deriveCwdHash`
  - `buildParentSessionName`
  - `registerIntercomParentSession`

- `packages/workflows/src/intercom/intercom-routing.ts`
  - `buildIntercomCallbacks`
  - emits `subagent:control-intercom:response`

- `packages/workflows/src/intercom/result-intercom.ts`
  - `subscribeIntercomControl`
  - `emitWorkflowControlIntercom`
  - `emitWorkflowResultIntercom`
  - `workflow:control-intercom`
  - `workflow:result-intercom`

- `packages/workflows/src/extension/index.ts`
  - installs lifecycle/HIL/intercom integrations
  - wires `setMcpScope` / `clearMcpScope`
  - calls `registerIntercomParentSession`

- Tests:
  - `test/unit/integrations-mcp.test.ts`
  - `test/unit/integrations-intercom.test.ts`
  - `test/unit/workflow-lifecycle-notifications.test.ts`
  - `test/unit/workflow-hil-answer-notifications.test.ts`
  - `test/integration/mcp-entrypoint.test.ts`

### Analyzer
## 1. Behavioral model

This partition is the **workflow-to-host integration layer**:

- **MCP gating**: workflows can narrow visible MCP servers per stage by emitting `mcp.scope.set`; the host MCP adapter listens and applies scoped allow/deny rules.
- **Lifecycle notifications**: workflow run/stage state changes are converted into user-facing notices (completed/failed/awaiting input), with dedupe and restore seeding.
- **Intercom routing**: child/subagent escalations are routed into workflow UI/store state, optionally prompting the user and emitting responses back to the child system.
- **Parent-session wiring**: workflow sessions register a stable parent session name so detached child processes can contact the supervisor.

For a Rust migration, this partition is mostly about preserving **event contracts**, not UI details.

---

## 2. Key flows and invariants

### MCP scope flow
- `setMcpScope(pi, { stageId, allow, deny })` emits `mcp.scope.set`.
- `clearMcpScope(pi, stageId)` emits the same event with `allow: null, deny: null`.
- `isMcpScopeSupported()` is purely structural: if `pi.events` exists, scope gating is considered available.

**Invariant:** no `pi.events` → no-op, not failure.

### Lifecycle notification flow
- `installWorkflowLifecycleNotifications(...)` registers a renderer once per host and subscribes to the store.
- It seeds dedupe state from existing snapshot data unless disabled.
- It emits notices only for top-level workflow runs.
- Terminal notices (`completed` / `failed`) are deduped by run id + status.
- Awaiting-input states are tracked for dedupe, but **do not wake the main chat**.

**Important invariant:** notification failure must not break store subscribers.

### Intercom flow
- `buildIntercomCallbacks()` creates handlers:
  - `need_decision` → record warning notice, show confirm dialog, emit `subagent:control-intercom:response`, ack notice.
  - `notify` → record notice only.
  - unknown type → record warning notice.
- `subscribeIntercomControl()` listens for `subagent:control-intercom`, dispatches safely, and isolates callback failure.

**Invariant:** malformed payloads are ignored defensively; callback errors are surfaced asynchronously so the bus keeps running.

### Parent session flow
- `registerIntercomParentSession()` derives a stable session name from cwd hash.
- If intercom isn’t present, it returns `null` and does nothing.

**Coupling:** this is a hidden dependency for detached child orchestration.

---

## 3. Tests / validation

Strong unit coverage exists for the core behaviors:

- `test/unit/integrations-mcp.test.ts`
  - emits `mcp.scope.set`
  - clears scope correctly
  - no-op without events

- `test/unit/workflow-lifecycle-notifications.test.ts`
  - completion/failure notice emission
  - dedupe behavior
  - awaiting-input suppression
  - restore/seed behavior
  - disabled/filtering behavior

- `test/unit/intercom-routing.test.ts`
  - decision callback flow
  - confirm/ack/response ordering
  - notify vs unknown handling

- `test/unit/mcp-oauth-startup.test.ts`
  - MCP startup lifecycle stays lazy and does not eagerly break session start

This is good migration evidence: these tests define the behavior your Rust port must preserve.

---

## 4. Risks, unknowns, and verification steps

### Risks
- **Event ABI is implicit**: contracts live in TS source, not a formal schema.
- **Host coupling**: these modules assume a `pi`-style event bus, store, and UI surface.
- **Behavioral subtlety**: lifecycle dedupe/suppression rules are easy to regress.
- **Async isolation**: failures are intentionally non-fatal; Rust must preserve that fault model.

### Unknowns
- Whether the Rust target will:
  1. replace the TS host entirely,
  2. embed JS/TS plugins,
  3. or keep these integrations as a compatibility layer.
- Exact shape of downstream MCP/intercom consumers outside this repo.

### Verification steps
- Lock down the event contracts:
  - `mcp.scope.set`
  - `subagent:control-intercom`
  - `subagent:control-intercom:response`
  - workflow lifecycle notice payloads
- Re-run/port the unit tests above first.
- Add one integration test for:
  - stage start → scope set
  - stage end → scope clear
  - run completion → lifecycle notice
  - subagent decision request → confirm/response/ack

If you want, I can turn this into a **Rust migration seam map** for this partition.

### Online Researcher
## 1. Relevant external facts

- **MCP transport is JSON-RPC over stdio or Streamable HTTP.** The spec says stdio servers are launched as subprocesses, and initialization must be the first interaction in the connection lifecycle.  
  Source: *Model Context Protocol — Transports / Lifecycle*.

- **MCP capability negotiation happens during `initialize`.** You can only use features the client/server declared.  
  Source: *MCP TypeScript SDK / protocol docs*.

- **There is an official Rust MCP SDK (`rust-sdk` / `rmcp`).** It supports server/client transport, stdio, streamable HTTP, and auth-related features.  
  Source: *modelcontextprotocol/rust-sdk*, *docs.rs/rmcp*.

- **The official MCP TypeScript SDK already models the same concepts your repo uses:** tools, resources, prompts, transports, auth, and stateful sessions.  
  Source: *MCP TypeScript SDK docs*.

## 2. Local implications

- Your migration is **not just “rewrite TS in Rust”**; the hard part is preserving the **host-extension contract**:
  - workflow lifecycle hooks
  - intercom routing
  - MCP scope gating
  - notification dedupe/state
  - session start/shutdown ordering

- In this repo, `packages/workflows` is mostly **coordination logic**, not heavy business logic. That means a Rust port should probably preserve:
  - `mcp.scope.set` event behavior
  - stage-scoped allow/deny rules
  - parent/child intercom session registration
  - result/control bridge semantics
  - lifecycle notifications suppression/deduping

- `packages/intercom` and `packages/mcp` look like the main **runtime boundaries**:
  - if Rust replaces them, you need a Rust implementation of the broker/transport layers
  - if not, you can keep Node/Bun as the host and move only core orchestration logic to Rust

- The biggest architectural choice is:
  1. **Rust core library + JS host wrapper** (lower risk)
  2. **Full Rust replacement of the extension runtime** (higher risk, more work)

- Because MCP stdio expects subprocess behavior, your current broker/spawn model maps well to Rust **as a subprocess-based adapter**. You do **not** need to invent a new IPC model immediately.

## 3. Version/API assumptions

- Assumed MCP spec behavior from the current official docs:
  - stdio transport is subprocess-based
  - `initialize` is mandatory before normal operation
  - capability negotiation is enforced

- Assumed Rust SDK choice:
  - `modelcontextprotocol/rust-sdk` / `rmcp`
  - use it for MCP server/client parity rather than hand-rolling JSON-RPC

- Assumed local ABI stability requirement:
  - keep event names like `mcp.scope.set`
  - keep session lifecycle semantics from `session_start` / `session_shutdown`
  - keep intercom bridge message contracts stable

## 4. Unverified or unnecessary research

- I did **not** verify a Rust-specific equivalent for your repo’s **custom intercom protocol**; that appears to be internal, not an external standard.
- I did **not** need deeper external research on lifecycle notifications, because those are repository-local UI/state behaviors rather than an established library API.
- I did **not** inspect the full MCP server-manager internals yet; that would matter if you want a concrete Rust migration plan for auth/HTTP/SSE.