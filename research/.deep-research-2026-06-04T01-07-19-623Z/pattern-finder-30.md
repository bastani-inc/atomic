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