I’m unable to write the requested file because this session only exposes read/find/list/todo tools and no write/edit tool.

Please save the following content to:

`research/docs/2026-06-26-issue-1517-followup-local-research-analysis.md`

```md
# Issue #1517 Follow-up Local Research Analysis

## Analysis of: research/2026-06-26-implement-github-issue-1517-remove-visible-flicker-from-the-subagent-ui-during-u.md

### Document Context
- **Date**: 2026-06-26
- **Purpose**: Prior implementation research for GitHub issue #1517: remove visible flicker from the subagent UI during updates.
- **Status**: Still relevant, but incomplete after reviewer-b’s fresh-context finding.

### Key Decisions
1. **Primary flicker source identified as reset → hydrate blank frame**
   - `resetSessionState()` previously called `resetJobs(ctx)` then `hydrateActiveJobs(ctx)`.
   - `resetJobs(ctx)` cleared async jobs and rendered `[]`.
   - `renderWidget(ctx, [])` unmounted the below-editor widget.
   - Hydration then repopulated active runs, causing visible clear-then-remount flicker.
   - Impact: The original minimal fix correctly targeted suppressing the empty widget publish during reset when hydration immediately follows.

2. **Preserve real empty teardown**
   - The prior research correctly distinguished transient reset emptiness from real no-active-runs state.
   - Impact: The widget should still unmount when hydration confirms no active queued/running jobs remain.

### Critical Constraints
- **No breaking changes**: `breaking_changes_allowed=false`; behavior must remain compatible with existing subagent widget lifecycle.
- **Keep belowEditor widget model**: Research consistently points to preserving the singleton below-editor widget and using in-place updates where possible.
- **Do not suppress legitimate teardown**: Completed/failed/paused terminal history should not remain mounted indefinitely after active hydration finds no active jobs.

### Technical Specifications
- Current implementation now has `resetJobs(ctx)` clear state without directly rerendering an empty widget.
- Existing regression coverage includes:
  - `keeps a mounted active widget visible across reset and hydration`
  - `unmounts a mounted widget after reset and hydration finds no active jobs`
- These tests validate same-context reset/hydrate behavior.

### Actionable Insights
- The prior fix is directionally correct for same-context reset/hydrate flicker.
- The remaining risk is not generic async job clearing; it is widget ownership/context rebinding during active hydration.
- Follow-up tests should simulate reset/hydrate across a fresh `ExtensionContext`, not only the original mounted context.

### Still Open/Unclear
- Whether the production reset path commonly passes a new/fresh `ExtensionContext` after chat/session lifecycle changes.
- Whether preserving the previous widget during fresh-context handoff is possible without violating host UI ownership assumptions.

### Relevance Assessment
- **Document age**: Recent ≤30d.
- Still applicable as the root-cause analysis for the original same-context blank-frame flicker.
- Superseded only in scope: reviewer-b found an additional fresh-context remount path not fully covered by the original artifact.

---

## Analysis of: research/docs/2026-06-26-issue-1517-subagent-ui-lifecycle-analysis.md

### Document Context
- **Date**: 2026-06-26
- **Purpose**: Detailed local lifecycle analysis of subagent async widget state, rendering, polling, hydration, and cleanup.
- **Status**: Highly relevant and still the best local technical map for #1517.

### Key Decisions
1. **Widget rendering is singleton-based**
   - `render-widget.ts` uses module-level widget state:
     - `latestWidgetCtx`
     - `latestWidgetJobs`
     - `mountedWidgetCtx`
     - `widgetMounted`
     - `widgetTimer`
   - Visible-to-visible updates reuse the mounted widget and call `ctx.ui.requestRender?.()`.
   - Impact: Flicker prevention should prefer updating singleton state over remounting.

2. **Empty job list means teardown**
   - `renderWidget(ctx, [])` stops animation and unsets the widget for the mounted context.
   - Stale-context empty updates are ignored to avoid clearing the active widget.
   - Impact: Empty rendering is intentionally destructive and must be avoided for transient reset states.

3. **Context rebinding explicitly unmounts old widget**
   - If `widgetMounted && mountedWidgetCtx !== ctx`, `renderWidget()` unmounts the old context before mounting on the new context.
   - Impact: This is the reviewer-b fresh-context flicker path.

### Critical Constraints
- **Widget ownership is context-sensitive**: The current renderer treats a different `ExtensionContext` as requiring teardown of the old widget.
- **Hydration filters active runs**: Only queued/running states hydrate into the widget; terminal complete/failed/paused history is excluded from active hydration.
- **Polling cleanup must remain intact**: Completed/failed/paused jobs are removed after retention and may legitimately unmount the widget when last job disappears.

### Technical Specifications
- `hydrateActiveJobs(ctx)`:
  - reads active async runs from disk,
  - filters by session/cwd,
  - projects summaries into `state.asyncJobs`,
  - calls `ensurePoller()` if jobs exist,
  - rerenders if a render context exists.
- `resetJobs(ctx)` currently clears async state and records `state.lastUiContext` but no longer renders `[]`.
- `renderWidget(ctx, jobs)`:
  - unmounts on `jobs.length === 0`;
  - updates in place when same context and widget already mounted;
  - unmounts old context then mounts new when context identity changes.

### Actionable Insights
- Same-context fix is insufficient if reset/hydrate is invoked with a fresh context while an active widget is still mounted on the previous context.
- The remaining flicker signature is:
  1. widget mounted on old context,
  2. reset clears tracker state but leaves widget mounted,
  3. hydration with new context finds active jobs,
  4. `renderWidget(newCtx, jobs)` unmounts old widget and mounts new widget,
  5. host may show a visible gap/remount.
- A high-value regression test should assert no blank/unset call during active hydration with a fresh context, if product behavior expects continuity.

### Still Open/Unclear
- Whether a new context can safely take ownership without first unsetting the old context.
- Whether host widget APIs support atomic transfer/rebind semantics.
- Whether the best fix belongs in `renderWidget()` context rebinding or higher-level reset/hydrate orchestration.

### Relevance Assessment
- **Document age**: Recent ≤30d.
- Still directly applicable. Reviewer-b’s finding narrows the unresolved surface to context rebinding rather than reset clearing alone.

---

## Analysis of: research/docs/2026-06-26-issue-1517-rendering-tests-patterns.md

### Document Context
- **Date**: 2026-06-26
- **Purpose**: Inventory of existing render-stability, widget lifecycle, spinner, and TUI testing patterns.
- **Status**: Still relevant for follow-up validation.

### Key Decisions
1. **Use direct widget lifecycle assertions**
   - Existing tests inspect `setWidget` calls and `requestRender` counts.
   - This is the right pattern for detecting blank-frame regressions.

2. **Assert visible-to-visible updates do not remount**
   - Existing lifecycle tests already assert one mount plus in-place render for same-context updates.
   - Impact: New tests should extend this pattern to fresh-context reset/hydrate behavior.

### Critical Constraints
- Tests should avoid relying on private component internals when public call behavior is enough.
- Frame/flicker tests should explicitly check for `setWidget(..., undefined)` because that is the observable blank/unmount signal.

### Technical Specifications
Useful existing test surfaces:
- `test/unit/subagents-async-widget-visibility.test.ts`
- `test/unit/subagents-render-stability-widget-lifecycle.ts`
- `test/unit/subagents-render-stability-running-widget.ts`
- `test/unit/subagents-render-stability-running-spinner.ts`

Recommended fresh-context regression shape:
- Mount active widget with `ctxA`.
- Call `resetJobs(ctxB)` or simulate reset with fresh context.
- Hydrate active jobs with `ctxB`.
- Assert no intermediate `content === undefined` call if continuity is expected.
- Assert active job remains visible and update is either in-place or otherwise non-blank.

### Actionable Insights
- Existing #1517 test coverage validates same-context reset/hydrate only.
- Add a fresh-context variant to cover reviewer-b’s finding.
- Also consider a negative test confirming real empty hydration still unmounts when no active jobs remain.

### Still Open/Unclear
- Expected behavior when old and new contexts are both live is not explicitly documented.
- If host requires old context cleanup, tests may need to assert no user-visible blank frame rather than no unmount call at all.

### Relevance Assessment
- **Document age**: Recent ≤30d.
- Fully applicable for test planning.

---

## Analysis of: research/docs/2026-06-26-issue-1517-online-tui-rendering-best-practices.md

### Document Context
- **Date**: 2026-06-26
- **Purpose**: Online best-practice research for stable React/Ink/TUI rendering.
- **Status**: Applicable as design guidance, not as proof of a specific fix.

### Key Decisions
1. **Stable identity prevents flicker**
   - React/Ink guidance emphasizes preserving component identity and avoiding unmount/remount during live updates.
   - Impact: Supports treating fresh-context remount as a high-risk flicker mechanism.

2. **Reserve layout and avoid transient collapse**
   - Terminal UIs flicker when panels temporarily emit zero lines or collapse.
   - Impact: A widget unset/remount is worse than ordinary row updates because it removes the entire below-editor region.

3. **Test actual frames or observable mount/unmount calls**
   - Best practice is to capture frames or lifecycle calls and assert no blank/collapsed intermediate state.
   - Impact: Existing `setWidget(undefined)` assertions are aligned with this guidance.

### Critical Constraints
- Online Ink guidance is renderer-level and must be adapted to this repo’s OpenTUI/pi-tui widget host.
- `incrementalRendering`/`maxFps` are not substitutes for fixing unmount/remount identity loss.

### Technical Specifications
- Use stable keys/IDs for rows.
- Keep live widgets mounted while content changes.
- Treat empty/loading states as variants inside a stable shell when continuity is required.
- Use throttling/batching only after preserving identity and layout.

### Actionable Insights
- The correct fix class is lifecycle/identity preservation, not merely render throttling.
- Fresh-context remount is precisely the kind of component identity reset that React/Ink docs warn causes state loss and flicker.
- Validation should check every intermediate frame or every widget host mutation for blank/unset states.

### Still Open/Unclear
- Whether the host API can support a true atomic widget ownership transfer.
- Whether a short-lived dual-context state is acceptable.

### Relevance Assessment
- **Document age**: Recent ≤30d.
- Applicable as supporting rationale for avoiding widget unmounts during active-run continuity.

---

## Reviewer-b Fresh-Context Finding: Updated Implications

### Finding
Reviewer-b’s fresh-context review changes the follow-up scope:

The current #1517 fix prevents the reset step itself from publishing `renderWidget(ctx, [])`, but a fresh `ExtensionContext` can still cause a visible remount. `renderWidget()` intentionally unmounts the old widget when `mountedWidgetCtx !== ctx` before mounting the widget on the new context.

### Why This Matters
The original bug was framed as “reset publishes empty state before hydration.” That is only one flicker path.

The remaining path is:

1. Active subagent widget is mounted on context A.
2. Session/UI reset occurs.
3. Tracker state is cleared without rendering empty state.
4. Hydration runs with context B.
5. Active jobs are found.
6. `renderWidget(contextB, jobs)` sees a different mounted context.
7. It unmounts context A, then mounts context B.
8. User may still observe a blank/remount frame.

### Updated Implementation Implications
- Do not consider #1517 complete based only on same-context reset/hydrate tests.
- Investigate whether widget ownership can be transferred or deferred without an observable `setWidget(undefined)` gap.
- Any fix must preserve:
  - real unmount when no active jobs remain;
  - stale-context empty update protection;
  - belowEditor placement;
  - singleton widget state;
  - context safety when old UI context is actually dead.

### Updated Test Implications
Add a regression test specifically for active hydration with a fresh context.

Minimum valuable assertions:
- No blank widget publish during reset itself.
- Active run remains projected after hydration.
- Fresh-context hydration does not produce an observable blank frame if active jobs exist.
- Real no-active hydration still unmounts.

If the implementation must unmount old context for correctness, test should instead capture the accepted contract explicitly: e.g. no blank frame on the new active context and no duplicate active widgets.

### Updated Docs/Changelog Implications
If behavior changes are user-visible:
- Update `packages/subagents/CHANGELOG.md`.
- Update `packages/coding-agent/docs/subagents.md` only if documented background-widget behavior changes.
- Keep wording narrow: “Fixed subagent background widget flicker during session reset/hydration, including active-run context refresh.”

---

## Current Source-of-Truth Summary

### Still-Relevant Root Cause
The major flicker class is any path that turns active background jobs into an empty/unmounted widget between live states.

### Still-Relevant Minimal Fix Principle
Never publish an empty widget state as an intermediate reset/hydrate frame when active jobs still exist.

### Newly-Relevant Follow-up Principle
Never remount the widget solely because hydration happens through a fresh context, unless the host requires that remount and the transition is not user-visible.

### Highest-Value Next Validation
A fresh-context reset/hydrate unit test in `test/unit/subagents-async-widget-visibility.test.ts` or adjacent widget lifecycle tests.

### Risk Assessment
- Same-context flicker appears addressed by current tests and current `resetJobs()` behavior.
- Fresh-context flicker remains the most important unresolved issue from reviewer-b’s finding.
```