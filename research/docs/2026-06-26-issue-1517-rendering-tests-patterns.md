I couldn’t write the file directly from this tool set, but here are the findings in the requested Markdown format, ready to save as:

`research/docs/2026-06-26-issue-1517-rendering-tests-patterns.md`

```md
# Issue 1517 Rendering/Testing Patterns

## Pattern Examples: Subagent TUI row/panel rendering

### Pattern 1: Nested subagent run summaries
**Found in**: `test/unit/subagents-nested-render.test.ts:1-49`  
**Used for**: recursive nested-run counting and status-line formatting

```ts
assert.deepEqual(countNestedRuns(children), {
  total: 4,
  running: 1,
  paused: 0,
  complete: 1,
  failed: 1,
  queued: 1,
});
assert.equal(formatNestedAggregate(children), "+4 nested runs (1 running, 1 failed, 1 complete, 1 queued)");

const lines = formatNestedRunStatusLines([run("parent", "running", [run("child", "complete")])], {
  indent: "",
  maxDepth: 0,
  maxLines: 4,
  commandHints: true,
});

assert.equal(lines[0]?.startsWith("↳ parent [parent] running"), true);
assert.equal(lines[1], "  Status: subagent({ action: \"status\", id: \"parent\" })");
assert.equal(lines[2], "  ↳ +1 nested run (1 complete)");
```

**Key aspects**:
- Recursive aggregation across direct and step children
- Command hint rows included in output
- Line-prefix checks rather than snapshot files

### Pattern 2: Stable subagent result rendering with captured time
**Found in**: `test/unit/subagents-render-stability-running-spinner.ts:1-210, 261-360`  
**Used for**: preserving output while updates stream; spinner-only diffs; byte-stable re-renders

```ts
const first = withMockedNow(10_000, () =>
  renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n"),
);
const second = withMockedNow(10_000 + RUNNING_ANIMATION_MS, () =>
  renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n"),
);

assert.notEqual(second, first);
```

```ts
assert.equal(
  stripSpinnerChars(firstLines[i]!),
  stripSpinnerChars(secondLines[i]!),
  `line ${i} changed in non-spinner content between animation frames`,
);
```

```ts
assert.equal(
  stableB,
  stableA,
  "a captured opts.now should keep chatbox rows byte-stable across host re-renders",
);
```

**Key aspects**:
- `withMockedNow()` freezes `Date.now()`
- Asserts same-frame determinism and next-frame progression
- Verifies only spinner glyphs change across ticks

### Pattern 3: Async widget row stability and mount lifecycle
**Found in**: `test/unit/subagents-render-stability-running-widget.ts:1-160`  
**Used for**: keeping widget rows stable across host re-renders

```ts
const first = withMockedNow(10_000, () => buildWidgetLines([job], theme, 120).join("\n"));
const second = withMockedNow(10_000 + RUNNING_ANIMATION_MS, () => buildWidgetLines([job], theme, 120).join("\n"));

assert.notEqual(second, first);
...
assert.equal(stableB, stableA, "captured now should keep widget lines byte-stable across unrelated host re-renders");
```

**Found in**: `test/unit/subagents-render-stability-widget-lifecycle.ts:1-220`  
**Used for**: widget remount/update behavior and render timing

```ts
renderWidget(ctx, [runningJob()]);
renderWidget(ctx, [{ ...runningJob(), status: "complete" }]);

assert.equal(widgetCalls.length, 1, "visible->visible updates must not call setWidget/remount again");
assert.equal(renders(), 1, "visible->visible updates should request an in-place render");
```

```ts
assert.equal(
  widgetCalls[1]?.content,
  undefined,
  "context switch should unmount the widget from the stale context",
);
```

**Key aspects**:
- In-place updates vs remounts
- Context-switch teardown
- Ticker stops when jobs finish

### Pattern 4: Render-key stability
**Found in**: `test/unit/subagents-render-stability-invariants.ts:1-40`  
**Used for**: stable keys that ignore wall-clock drift

```ts
const first = withMockedNow(10_000, () => widgetRenderKey(job));
const second = withMockedNow(10_080, () => widgetRenderKey(job));

assert.equal(second, first);
```

**Found in**: `packages/subagents/src/tui/render-stable-output.ts:1-47`  
**Used for**: stable render keys for widget and result surfaces

```ts
export function widgetRenderKey(job: AsyncJobState): string {
  return JSON.stringify({
    asyncDir: job.asyncDir,
    status: job.status,
    activityState: job.activityState,
    lastActivityAt: job.lastActivityAt,
    currentTool: job.currentTool,
    currentToolStartedAt: job.currentToolStartedAt,
    currentPath: job.currentPath,
    turnCount: job.turnCount,
    toolCount: job.toolCount,
    mode: job.mode,
    agents: job.agents,
    currentStep: job.currentStep,
    chainStepCount: job.chainStepCount,
    parallelGroups: job.parallelGroups,
    steps: job.steps,
    nestedChildren: job.nestedChildren,
    stepsTotal: job.stepsTotal,
    runningSteps: job.runningSteps,
    completedSteps: job.completedSteps,
    activeParallelGroup: job.activeParallelGroup,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    totalTokens: job.totalTokens,
  });
}
```

---

## Pattern Examples: Ink/react terminal component testing

### Pattern 1: Component rendering through `.render(width).join("\n")`
**Found in**: `test/unit/subagents-render-stability-running-spinner.ts:1-210`  
**Used for**: terminal output assertions

```ts
renderSubagentResult(result, { expanded: false }, theme).render(120).join("\n")
```

### Pattern 2: Component factories and render-count assertions
**Found in**: `test/unit/subagents-render-stability-widget-lifecycle.ts:1-220`  
**Used for**: mounted component behavior

```ts
const component = (factory as WidgetFactory)(undefined, theme);
assert.match(component.render(120).join("\n"), /worker/);
```

### Pattern 3: Viewport/windowed rendering
**Found in**: `test/unit/chat-message-renderer.test.ts:1-140`  
**Used for**: terminal component windowing and caching

```ts
const viewport = new ScrollableComponentViewport();
viewport.setVisibleRows(2);
viewport.setComponents([windowedComponent]);

assert.deepEqual(viewport.render(20), ["line-3", "line-4"]);
assert.deepEqual(renderedWindows, [[3, 5]]);
```

```ts
const transcript = new ChatTranscriptComponent(
  entries,
  (entry) => ({
    render: () => [entry.text],
    invalidate: () => {},
  }),
  (entry) => entry.text,
);

assert.deepEqual(viewport.render(20), ["third"]);
assert.equal(renderCount, 3);
assert.deepEqual(viewport.render(20), ["third"]);
assert.equal(renderCount, 3);
```

### Pattern 4: Cursor/input-driven TUI component tests
**Found in**: `test/unit/ask-user-question-tui.test.ts:1-220`  
**Used for**: interactive TUI state and inline editing behavior

```ts
session.component.handleInput(DOWN);
session.component.handleInput(DOWN);
for (const ch of "custom") session.component.handleInput(ch);

const rendered = stripAnsi(session.component.render(100).join("\n"));
assert.match(rendered, /custom/);
```

**Key aspects**:
- `bun:test` + `node:assert/strict`
- Direct component method calls
- ANSI stripping helper for plain-text assertions

---

## Pattern Examples: Debounce/throttle/refresh behavior

### Pattern 1: Animation ticker with periodic invalidation
**Found in**: `packages/subagents/src/tui/render-result-animation.ts:1-35`  
**Used for**: subagent spinner refresh loop

```ts
export function ensureResultAnimation(context: ResultAnimationContext): void {
  if (context.state.subagentResultAnimationTimer) return;
  const timer = setInterval(() => {
    context.state.subagentResultSpinnerFrameNow = Date.now();
    try {
      context.invalidate();
    } catch {
      clearResultAnimationTimer(context);
    }
  }, RUNNING_ANIMATION_MS);
  timer.unref?.();
  context.state.subagentResultAnimationTimer = timer;
}
```

### Pattern 2: Widget refresh delay calculation
**Found in**: `packages/workflows/src/tui/widget.ts:70-125`  
**Used for**: refresh timing based on live clock and recent-ended expiry

```ts
function msUntilNextClockTick(now: number): number {
  const remainder = now % WIDGET_CLOCK_REFRESH_MS;
  return remainder === 0 ? WIDGET_CLOCK_REFRESH_MS : WIDGET_CLOCK_REFRESH_MS - remainder;
}

export function nextWidgetRefreshDelayMs(
  snap: StoreSnapshot,
  now = Date.now(),
): number | undefined {
  const display = selectDisplayRuns(snap, now);
  if (display.length === 0) return undefined;

  const hasLiveClock = display.some((run) => run.endedAt === undefined && run.status !== "paused");
  const clockDelay = hasLiveClock ? msUntilNextClockTick(now) : undefined;
  const expiryDelays = display
    .filter((run) => run.endedAt !== undefined)
    .map((run) => Math.max(1, run.endedAt! + RECENT_ENDED_WINDOW_MS - now + 1));
  const delays = [clockDelay, ...expiryDelays].filter((delay): delay is number => delay !== undefined);
  return delays.length === 0 ? undefined : Math.min(...delays);
}
```

### Pattern 3: Widget ticker lifecycle and stop conditions
**Found in**: `packages/subagents/src/tui/render-widget.ts:70-170`  
**Used for**: periodic re-renders while running, stop when idle

```ts
function ensureWidgetAnimation(): void {
  if (widgetTimer) return;
  widgetTimer = setInterval(() => {
    if (!hasAnimatedWidgetJobs(latestWidgetJobs)) {
      stopWidgetAnimation();
      return;
    }
    refreshAnimatedWidget();
  }, RUNNING_ANIMATION_MS);
  widgetTimer.unref?.();
}
```

```ts
function refreshAnimatedWidget(): void {
  if (!latestWidgetCtx?.hasUI) return;
  try {
    latestWidgetFrameNow = Date.now();
    requestWidgetRender(latestWidgetCtx);
  } catch {
    stopWidgetAnimation();
  }
}
```

### Related tests
- `test/unit/subagents-render-stability-running-spinner.ts`
- `test/unit/subagents-render-stability-running-widget.ts`
- `test/unit/subagents-render-stability-widget-lifecycle.ts`
- `test/unit/workflow-list-render.test.ts`
- `test/unit/status-list-render.test.ts`

---

## Pattern Examples: Preserving last known state while updates stream

### Pattern 1: Captured `now` passed through render options
**Found in**: `test/unit/subagents-render-stability-running-spinner.ts:70-170`  
**Used for**: preserving display time across unrelated host re-renders

```ts
const stableA = withMockedNow(20_000, () =>
  renderLiveSubagentResult(result, { expanded: false, isPartial: true }, theme, context).render(120),
);
const stableB = withMockedNow(30_000, () =>
  renderLiveSubagentResult(result, { expanded: false, isPartial: true }, theme, context).render(120),
);
assert.equal(stableB, stableA);
```

### Pattern 2: Mounted widget reads latest snapshot, not constructor-captured jobs
**Found in**: `test/unit/subagents-render-stability-widget-lifecycle.ts:1-120`  

```ts
renderWidget(ctx, [runningJob()]);
renderWidget(ctx, [
  {
    ...runningJob(),
    status: "complete",
    agents: ["reviewer"],
    toolCount: 3,
    turnCount: 4,
  },
]);

const updated = component.render(120).join("\n");
assert.match(updated, /reviewer/);
assert.doesNotMatch(updated, /worker/);
```

### Pattern 3: Live subagent result rendering uses stable key + partial/final state
**Found in**: `packages/subagents/src/tui/render-stable-output.ts:20-47`  

```ts
export function subagentResultRenderKey(
  result: AgentToolResult<Details>,
  options: { expanded: boolean; isPartial: boolean },
): string {
  const details = result.details;
  if (!details) return `${options.isPartial ? "partial" : "final"}:${result.content.length}`;
  ...
  return [
    options.isPartial ? "partial" : "final",
    options.expanded ? "expanded" : "compact",
    details.mode,
    details.currentStepIndex ?? "",
    details.totalSteps ?? "",
    progressRenderKey(details.progressSummary),
    progressKeys.join("|"),
  ].join("|");
}
```

**Key aspects**:
- Preserves semantic state separately from animation state
- Distinguishes partial vs final rendering
- Supports stable row identity during streaming updates

---

## Pattern Examples: Docs/changelog conventions

### Pattern 1: Changelog parser tests use temporary files and round-trip assertions
**Found in**: `test/unit/changelog.test.ts:1-92`  
**Used for**: changelog parsing/ordering conventions

```ts
const changelogPath = writeChangelog(`# Changelog

## [0.8.24-alpha.2] - 2026-06-09

### Fixed

- Second prerelease fix.
`);

const entries = parseChangelog(changelogPath);
assert.deepEqual(entries.map((entry) => entry.version), ["0.8.24", "0.8.24-alpha.2", "0.8.24-alpha.1"]);
assert.equal(entries[1]?.prerelease, 2);
assert.equal(compareVersions(stable, alpha2), 1);
```

### Pattern 2: Release and docs workflow naming in repo docs
**Found in**:
- `docs/ci.md`
- `docs/workflow-playbook.md`
- `packages/*/CHANGELOG.md`
- `specs/2026-*.md`
- `research/docs/2026-*.md`

**Used for**: dated, issue-linked documentation and changelog organization

### Pattern 3: Release-doc workflow test
**Found in**: `test/unit/release-docs-workflow.test.ts`  
**Used for**: docs/release automation conventions

---

## Validation commands

- `bun test test/unit/subagents-nested-render.test.ts`
- `bun test test/unit/subagents-render-stability.test.ts`
- `bun test test/unit/subagents-render-stability-running-spinner.ts`
- `bun test test/unit/subagents-render-stability-running-widget.ts`
- `bun test test/unit/subagents-render-stability-widget-lifecycle.ts`
- `bun test test/unit/subagents-render-stability-invariants.ts`
- `bun test test/unit/chat-message-renderer.test.ts`
- `bun test test/unit/ask-user-question-tui.test.ts`
- `bun test test/unit/status-list-render.test.ts`
- `bun test test/unit/run-detail-render.test.ts`
- `bun test test/unit/widget-rendering.test.ts`
- `bun test test/unit/changelog.test.ts`

Repo-wide:
- `bun run test:unit`
- `bun run typecheck`
```

If you want, I can also condense this into a shorter research note format or add more exact file-by-file references for the workflow TUI render tests.