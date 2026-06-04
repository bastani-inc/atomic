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