I found these existing patterns/tests:

## Pattern Examples: Stable widget ownership / no-remount lifecycle

### Pattern 1: Reactive widget installs once, updates in place, unmounts once
**Found in**: `packages/workflows/src/tui/store-widget-installer.ts:1-120`  
**Tests**: `test/unit/reactive-widget.test.ts:1-260`, `test/unit/store-widget-installer-01.test.ts:1-260`

```ts
// store-widget-installer.ts
// 1. mount once on hidden→visible, unmount once on visible→hidden
// 2. other refreshes call requestRender only
// 3. component reads latest snapshot via live getter
```

**Test shape** (`reactive-widget.test.ts`):
- mount once
- visible→visible does not remount
- hidden→visible→hidden calls `setWidget(undefined)` once
- timer-driven refresh uses same factory/component
- `requestRender` fallback is used when available

### Pattern 2: Widget state survives context churn via owner rebinding
**Found in**: `test/unit/subagents-render-stability-widget-lifecycle.ts:1-220`  
**Relevant lines**:
- visible update in place: `1-110`
- UI context switch remounts on fresh context: `112-176`
- empty updates don’t re-clear: `178-220`

```ts
renderWidget(first.ctx, [runningJob()]);
renderWidget(second.ctx, [runningJob()]);
assert.equal(first.widgetCalls[1]?.content, undefined);
assert.equal(second.widgetCalls.length, 1);
```

**What it covers**:
- stable ownership across fresh wrapper contexts
- remount on new context
- no stale-context render reuse

---

## Pattern Examples: Comparing UI owners, not ExtensionContext identity

### Pattern 3: Track “live scope” by run/stage IDs and prune stale calls
**Found in**: `packages/workflows/src/tui/store-widget-installer.ts:120-260`

```ts
function hasLiveStageScope(scope: StageScope, snap: StoreSnapshot): boolean {
  const run = snap.runs.find((candidate) => candidate.id === scope.runId);
  if (!run || run.endedAt !== undefined || terminalRunStatuses.has(run.status)) return false;
  const stage = run.stages.find((candidate) => candidate.id === scope.stageId);
  return stage !== undefined && !terminalStageStatuses.has(stage.status);
}
```

**Why this is relevant**:
- ownership is determined by logical UI owner (run/stage scope)
- not by object identity of the context wrapper

### Pattern 4: Async widget hydration uses session/cwd ownership, not raw context identity
**Found in**: `test/unit/subagents-async-widget-visibility.test.ts:1-260` and `:401-520`

Key tests:
- `hydrates an active status-visible run and renders the widget belowEditor`
- `visible active-run hydration updates the mounted widget with one in-place render`
- `does not hydrate active runs from unrelated sessions or directories`
- `uses cwd fallback for active runs that do not have a session id`

This is the closest pattern to “compare UI owners rather than ExtensionContext object identity”.

---

## Pattern Examples: Context rebinding / stale context tests

### Pattern 5: Stale context is handled as cancellation, not failure
**Found in**: `test/unit/mcp-stale-context-init.test.ts:1-140`

```ts
let stale = false;
const assertActive = () => { if (stale) throw new Error(STALE_CTX_MESSAGE); };

const ctx = {
  get cwd() { assertActive(); return tempDir; },
  get signal() { assertActive(); return undefined; },
};

await sessionStart({ type: "session_start", reason: "startup" }, ctx);
stale = true;
await new Promise((resolve) => setTimeout(resolve, 75));
assert.equal(consoleErrors.some((line) => line.includes("MCP initialization failed")), false);
```

**Regression idea**:
- mount/init with `ctx1`
- replace with `ctx2`
- ensure deferred init does not log failure when `ctx1` becomes stale

---

## Pattern Examples: Mock ExtensionContext construction

### Pattern 6: Minimal mock ExtensionContext with UI hooks + session/mode fields
**Found in**:
- `test/unit/subagents-async-widget-visibility.test.ts:1-120`
- `test/unit/subagents-render-stability-widget-lifecycle.ts:1-70`
- `test/unit/workflow-attach-pane-01.test.ts:1-240`

Common mock shape:

```ts
const ctx = {
  hasUI: true,
  cwd,
  ui: {
    setWidget: (...args) => widgetCalls.push(...),
    requestRender: () => renders++,
    getToolsExpanded: () => false,
  },
  sessionManager: { getSessionId: () => sessionId, ... },
} as unknown as ExtensionContext;
```

**Useful helper conventions**:
- `makeUiContext(...)`
- `makeMockPi()`
- `makeFakeTimers()`
- `makeClock()`

---

## Pattern Examples: Workflow widget behavior

### Pattern 7: Workflow widget mounts belowEditor and updates in place
**Found in**: `packages/workflows/src/tui/store-widget-installer.ts:1-80`  
**Tests**:
- `test/unit/store-widget-installer-01.test.ts:1-260`
- `test/unit/subagents-render-stability-widget-lifecycle.ts:1-220`

Relevant assertions:
- `placement: "belowEditor"`
- no remount on content changes
- requestRender used for updates
- fresh snapshot read at render time

### Pattern 8: Workflow attach pane swaps internals without remounting popup
**Found in**: `test/unit/workflow-attach-pane-01.test.ts:240-330`  
**Related**: `test/unit/workflow-attach-pane-02.test.ts:221-340`

Key tests:
- `Enter on a graph node swaps to stage-chat mode`
- `slash switcher selection swaps directly to selected stage chat`
- `stays in graph mode when a stage becomes awaiting-input until Enter attaches`
- `Ctrl+D in chat mode swaps back to graph` (documented in file header / adjacent tests)

This is the strongest workflow-side “no-remount widget lifecycle” pattern.

### Pattern 9: Workflow lifecycle notifications are seeded / replay-safe
**Found in**: `test/unit/workflow-lifecycle-notifications-01.test.ts:1-240`  
**Related**: `test/unit/workflow-lifecycle-notifications-02.test.ts:1-220`

Useful patterns:
- `seedExisting: true`
- `state.deliveredInputPrompts`
- suppression wrappers for async flows
- terminal notices emitted once

---

## Suggested regression test shapes for `ctx1 mounted -> resetJobs(ctx2) -> hydrateActiveJobs(ctx3)` without blank

Use the existing async-widget visibility test pattern as the template:

1. **Mount active widget with ctx1**
   - `hydrateActiveJobs(ctx1)`
   - assert one `setWidget(..., factory, { placement: "belowEditor" })`

2. **Reset with ctx2**
   - `resetJobs(ctx2)`
   - assert **no** `setWidget(..., undefined)` blank frame
   - assert no extra remount

3. **Hydrate with ctx3**
   - `hydrateActiveJobs(ctx3)`
   - assert either:
     - same mounted widget is updated in place, or
     - a fresh owner context gets a single mount, but never an intermediate blank

4. **Assertions to include**
   - `widgetCalls.filter(c => c.content === undefined).length === 0` between reset/hydrate
   - `widgetCalls.filter(c => c.options?.placement === "belowEditor").length === 1`
   - `renderCount() === 1` after final hydrate
   - if ctx3 is fresh owner, assert stale ctx1 does not receive requests

Best matching references:
- `test/unit/subagents-async-widget-visibility.test.ts:401-520`
- `test/unit/subagents-render-stability-widget-lifecycle.ts:112-176`
- `test/unit/reactive-widget.test.ts:80-220`
- `test/unit/mcp-stale-context-init.test.ts:1-140`

If you want, I can also turn this into the exact markdown content for `research/docs/2026-06-26-issue-1517-context-owner-patterns.md`.