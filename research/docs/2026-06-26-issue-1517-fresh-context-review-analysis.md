I’m unable to write the requested file because this session exposes no file write/edit tool. Below is the exact content to save at:

`/Users/tonystark/Documents/projects/atomic-1517-subagent-ui-flicker/research/docs/2026-06-26-issue-1517-fresh-context-review-analysis.md`

```md
# Issue 1517 Fresh Context Review Analysis

## Analysis: Async Widget Fresh ExtensionContext Remount

### Overview
Reviewer-b’s finding still applies to the current working tree. `renderWidget()` treats a new `ExtensionContext` wrapper object as a UI ownership change because it compares `mountedWidgetCtx !== ctx` by object identity, so active-job renders from fresh wrappers can clear and remount the async widget even when the observable UI owner is the same.

### Entry Points
- `packages/subagents/src/extension/index.ts:423-429` - `tool_result` stores `state.lastUiContext = ctx`, then calls `hydrateActiveJobs(ctx)`.
- `packages/subagents/src/extension/index.ts:435-444` - `session_start` calls `resetJobs(ctx)` followed immediately by `hydrateActiveJobs(ctx)`.
- `packages/subagents/src/runs/background/async-job-tracker.ts:236-267` - `hydrateActiveJobs(ctx)` updates `state.lastUiContext`, loads active jobs, then calls `renderWidget(renderCtx)`.
- `packages/subagents/src/runs/background/async-job-tracker.ts:316-327` - `resetJobs(ctx)` clears `state.asyncJobs` and replaces `state.lastUiContext`.
- `packages/subagents/src/tui/render-widget.ts:189-232` - `renderWidget()` owns mount/update/unmount behavior.

### Core Implementation

#### 1. Context capture in extension lifecycle
- On `tool_result`, the extension requires UI, assigns `state.lastUiContext = ctx`, hydrates active jobs, and ensures the poller if jobs exist (`packages/subagents/src/extension/index.ts:423-429`).
- On `session_start`, `resetSessionState(ctx)` sets `state.lastUiContext = ctx`, calls `resetJobs(ctx)`, then calls `hydrateActiveJobs(ctx)` (`packages/subagents/src/extension/index.ts:435-444`).
- These handlers can receive fresh `ExtensionContext` wrapper objects for the same visible UI session.

#### 2. Reset does not unmount, but does replace context
- `resetJobs(ctx)` clears timers, `state.asyncJobs`, foreground controls, and coalescer state (`packages/subagents/src/runs/background/async-job-tracker.ts:316-326`).
- If `ctx?.hasUI`, it assigns `state.lastUiContext = ctx` (`packages/subagents/src/runs/background/async-job-tracker.ts:324`).
- `resetJobs()` does not call `renderWidget(ctx, [])`, so an already-mounted widget remains mounted in `render-widget.ts` module state.

#### 3. Hydration renders active jobs with the latest wrapper
- `hydrateActiveJobs(ctx)` assigns `state.lastUiContext = ctx` when UI is present (`packages/subagents/src/runs/background/async-job-tracker.ts:236-237`).
- It chooses `renderCtx` from `state.lastUiContext` (`packages/subagents/src/runs/background/async-job-tracker.ts:238`).
- It loads active queued/running summaries via `listAsyncRuns()` (`packages/subagents/src/runs/background/async-job-tracker.ts:242-247`).
- For matching summaries, it inserts/updates `state.asyncJobs` with `asyncRunSummaryToJobState()` (`packages/subagents/src/runs/background/async-job-tracker.ts:257-261`).
- If any jobs exist, it ensures the poller, then calls `rerenderWidget(renderCtx)` (`packages/subagents/src/runs/background/async-job-tracker.ts:264-265`).

#### 4. Widget mount ownership uses object identity
- `renderWidget()` stores singleton UI state in module variables:
  - `latestWidgetCtx`
  - `latestWidgetJobs`
  - `mountedWidgetCtx`
  - `widgetMounted`
  (`packages/subagents/src/tui/render-widget.ts:55-62`)
- For non-empty jobs, it updates `latestWidgetCtx`, `latestWidgetJobs`, and `latestWidgetFrameNow` (`packages/subagents/src/tui/render-widget.ts:200-202`).
- If `widgetMounted && mountedWidgetCtx !== ctx`, it calls `unmountWidgetBestEffort(mountedWidgetCtx)`, clears `mountedWidgetCtx`, and sets `widgetMounted = false` (`packages/subagents/src/tui/render-widget.ts:203-208`).
- Because the comparison is object identity, a fresh wrapper for the same UI owner is treated as a context switch.
- It then mounts again via `ctx.ui.setWidget(WIDGET_KEY, ..., { placement: "belowEditor" })` (`packages/subagents/src/tui/render-widget.ts:209-220`).

### Exact Reviewer-B Code Path

1. Widget is already mounted from an earlier context wrapper:
   - `renderWidget(ctx1, [activeJob])`
   - stores `mountedWidgetCtx = ctx1`
   - sets `widgetMounted = true`
   (`packages/subagents/src/tui/render-widget.ts:209-220`)

2. A later lifecycle event receives a fresh wrapper:
   - `resetSessionState(ctx2)` sets `state.lastUiContext = ctx2`
   - `resetJobs(ctx2)` clears `state.asyncJobs` but does not unmount the widget
   (`packages/subagents/src/extension/index.ts:435-444`, `packages/subagents/src/runs/background/async-job-tracker.ts:316-327`)

3. Hydration receives another fresh wrapper or same fresh lifecycle wrapper:
   - `hydrateActiveJobs(ctx3)` sets `state.lastUiContext = ctx3`
   - active summaries are converted back into `state.asyncJobs`
   - `rerenderWidget(ctx3)` calls `renderWidget(ctx3, jobs)`
   (`packages/subagents/src/runs/background/async-job-tracker.ts:236-265`)

4. `renderWidget()` sees active jobs but different wrapper identity:
   - `widgetMounted === true`
   - `mountedWidgetCtx !== ctx3`
   - calls `ctx1.ui.setWidget(WIDGET_KEY, undefined)`
   - then calls `ctx3.ui.setWidget(WIDGET_KEY, factory, { placement: "belowEditor" })`
   (`packages/subagents/src/tui/render-widget.ts:203-220`)

This matches reviewer-b’s described sequence: active jobs remain, but the widget is cleared and remounted because the wrapper object changed.

### Tests Covering Current Behavior

- `test/unit/subagents-render-stability-widget-lifecycle.ts:48-94` verifies visible-to-visible updates on the same context object do not remount.
- `test/unit/subagents-render-stability-widget-lifecycle.ts:126-166` explicitly expects remount when the UI context object changes.
- `test/unit/subagents-render-stability-widget-lifecycle.ts:168-190` verifies empty updates unmount once.
- `test/unit/subagents-render-stability-widget-lifecycle.ts:192-220` verifies mount → unmount → remount preserves `belowEditor`.

The current tests cover object-identity context changes as real owner changes, but they do not distinguish fresh wrappers for the same UI/session from actual UI owner changes.

### Does the Finding Still Apply?
Yes. The working tree still remounts on fresh `ExtensionContext` wrapper identity changes while active jobs remain. The behavior is implemented directly by `mountedWidgetCtx !== ctx` in `renderWidget()` and can be reached through `resetJobs(ctx)` followed by `hydrateActiveJobs(ctx)`.

### Minimal Implementation Change Options

#### Option A: Track a stable UI owner key
Add a stable owner identity separate from the wrapper object, then compare owner identity instead of `ExtensionContext` object identity.

Candidate owner inputs already present in current code:
- `ctx.sessionManager.getSessionFile()` is used during session cleanup (`packages/subagents/src/extension/index.ts:430-434`).
- `state.currentSessionId` is resolved from `ctx.sessionManager` during reset (`packages/subagents/src/extension/index.ts:437`).
- `ctx.cwd` is already stored as `state.baseCwd` (`packages/subagents/src/extension/index.ts:436`).

Minimal shape:
- Store `mountedWidgetOwnerKey` next to `mountedWidgetCtx`.
- Compute owner key from session identity/session file plus cwd, or another stable host-provided UI/session identifier if available.
- Only unmount/remount when the owner key changes.
- For same owner but fresh wrapper, update `latestWidgetCtx = ctx` and request render through the latest wrapper without clearing the mounted widget.

#### Option B: Avoid unmount while active jobs remain
Change the non-empty `renderWidget()` context-change branch so active jobs update singleton state and request render instead of clearing/remounting when the previous widget is already mounted.

Minimal behavior:
- Preserve `latestWidgetJobs = [...jobs]`.
- Preserve the existing mounted widget.
- Update `latestWidgetCtx = ctx` for future ticker renders.
- Call `requestWidgetRender(ctx)` or the mounted/active render context.
- Only call `unmountWidgetBestEffort()` when jobs are empty, session shutdown occurs, or a confirmed different UI owner is detected.

This avoids the active-job flicker path while preserving public widget placement and rendering content.

### Public Behavior Constraint
Existing observable behavior to preserve:
- First active render mounts a `belowEditor` widget (`packages/subagents/src/tui/render-widget.ts:209-220`).
- Same-context visible updates request in-place render, not remount (`packages/subagents/src/tui/render-widget.ts:221-224`).
- Empty same-owner render unmounts (`packages/subagents/src/tui/render-widget.ts:189-198`).
- Running jobs drive the ticker; finished jobs stop the ticker (`packages/subagents/src/tui/render-widget.ts:227-231`).
```