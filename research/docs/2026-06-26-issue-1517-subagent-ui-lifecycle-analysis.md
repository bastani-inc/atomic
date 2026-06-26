I’m unable to write `research/docs/2026-06-26-issue-1517-subagent-ui-lifecycle-analysis.md` because this session exposes only read/find/list/todo tools and no file write/edit tool.

## Analysis: Subagent UI Lifecycle / Flicker

### Overview
The subagent TUI has two live rendering paths: foreground tool-result rendering in chat scrollback and background async rendering via a singleton `belowEditor` widget. Background jobs are stored in `state.asyncJobs`, updated by event handlers plus a polling reconciler, then rendered by `renderWidget()` using module-level singleton state read by an Ink/pi-tui `Component`.

### Entry Points
- `packages/subagents/src/extension/index.ts:333-336` - Tool `renderResult()` delegates foreground rendering to `renderLiveSubagentResult()`.
- `packages/subagents/src/extension/index.ts:382-386` - subscribes to `SUBAGENT_ASYNC_STARTED_EVENT`, `SUBAGENT_ASYNC_COMPLETE_EVENT`, and control events.
- `packages/subagents/src/extension/index.ts:388-394` - on `tool_result`, stores `lastUiContext`, hydrates active async jobs, and ensures poller.
- `packages/subagents/src/runs/background/async-job-tracker.ts:89-296` - central async job tracker, event handlers, poller, cleanup timers.
- `packages/subagents/src/tui/render-widget.ts:18-43` - `LiveWidgetComponent` renders current async jobs.
- `packages/subagents/src/tui/render-widget.ts:189-232` - `renderWidget()` mounts/updates/unmounts singleton widget.

### Core Implementation

#### 1. Background job state creation
- `createAsyncJobTracker()` stores active jobs in `state.asyncJobs` and renders via `renderWidget(ctx, jobs)` (`async-job-tracker.ts:89-94`).
- `handleStarted()` builds an initial `AsyncJobState` from event data with:
  - `status: "queued"`
  - `agents` inferred from `info.agents`, `info.chain`, or `info.agent`
  - `stepsTotal`
  - `parallelGroups`
  - timestamps (`async-job-tracker.ts:238-278`)
- After setting the job, it starts polling and immediately rerenders using `state.lastUiContext` if present (`async-job-tracker.ts:279-283`).

#### 2. Polling and status reconciliation
- The poller runs every `POLL_INTERVAL_MS` by default (`async-job-tracker.ts:100-101`, `async-job-tracker.ts:133-235`).
- It stops itself when `state.asyncJobs.size === 0`; before stopping, it rerenders the widget with `[]` if a UI context exists (`async-job-tracker.ts:135-143`).
- For each job, it snapshots `widgetRenderKey(job)` before mutations (`async-job-tracker.ts:148`).
- It reconciles nested descendants and async status, then reads `status.json` via `reconcileAsyncRun()` / `readStatus()` (`async-job-tracker.ts:169-180`).
- If status exists, fields are copied into the existing job:
  - top-level `status`, activity, tools, counts, mode, current step, timestamps (`async-job-tracker.ts:182-199`)
  - visible steps derived from active parallel group or all steps (`async-job-tracker.ts:200-218`)
  - totals and counts (`async-job-tracker.ts:219-222`)
  - output/session/token fields (`async-job-tracker.ts:224-227`)
- A rerender happens only if `widgetRenderKey(job)` changed (`async-job-tracker.ts:229-234`).

#### 3. Completion/failure/pause lifecycle
- `handleComplete()` updates an existing job status to `"complete"` or `"failed"`, updates timestamp/dir, refreshes nested projection, rerenders, then schedules cleanup (`async-job-tracker.ts:286-313`).
- Polling also schedules cleanup when job status is `"complete"`, `"failed"`, or `"paused"`, nested refresh succeeded, and no live nested descendants remain (`async-job-tracker.ts:228-230`).
- Cleanup deletes the job after `completionRetentionMs` (default 10s) and rerenders with remaining jobs (`async-job-tracker.ts:102-116`).

#### 4. Runner status writes
- Background runner creates `status.json` immediately with all steps as `"pending"` and run state `"running"` (`subagent-runner-state.ts:45-115`).
- `writeStatusPayload()` atomically writes status and emits nested self-events (`subagent-runner-state.ts:152-156`).
- Child events update tool state, recent tools/output, token counts, activity state, and timestamps before writing status (`subagent-runner-state.ts:260-340`).
- Activity timer updates `needs_attention` / `active_long_running` every second and writes status if changed (`subagent-runner-state.ts:342-394`).
- Interrupt changes run state to `"paused"` and running steps to `"paused"` before writing status (`subagent-runner-state.ts:404-424`).
- Finalization sets run state to `"paused"`, `"complete"`, or `"failed"`, clears activity state, writes final status, writes result file, and appends completion event (`subagent-runner-finalize.ts:48-86`).

#### 5. Async status summary conversion
- `listAsyncRuns()` reads async run directories, optionally reconciles stale runs, parses status, and sorts runs (`async-status.ts:178-222`).
- `statusToSummary()` derives visible summary fields and maps each status step to an `AsyncRunStepSummary`, preserving activity, tool, recent output, model, token, error, and nested children fields (`async-status.ts:94-172`).
- Sorting prioritizes running, queued, failed/paused, then complete (`async-status.ts:160-176`).

### React/Ink/pi-tui Component Lifecycle

#### Singleton widget component
- `renderWidget()` is intentionally singleton-based:
  - module-level `latestWidgetCtx`
  - `latestWidgetJobs`
  - `latestWidgetFrameNow`
  - `mountedWidgetCtx`
  - `widgetMounted`
  - `widgetTimer` (`render-widget.ts:55-62`)
- `LiveWidgetComponent` does not receive jobs as props; it calls `getLatestWidgetJobs()` during each render (`render-widget.ts:18-31`).
- On visible-to-visible updates, the widget is not remounted. `latestWidgetJobs` is replaced and `ctx.ui.requestRender?.()` is called (`render-widget.ts:214-224`).
- The widget is mounted only once via `ctx.ui.setWidget(WIDGET_KEY, componentFactory, { placement: "belowEditor" })` (`render-widget.ts:209-220`).
- If context changes, the previous widget is best-effort unmounted before mounting on the new context (`render-widget.ts:203-208`).

#### Empty job handling
- If `renderWidget(ctx, [])` is called with the same mounted context, it calls `stopWidgetAnimation()`, which clears ticker, unsets the widget, and clears singleton state (`render-widget.ts:189-198`, `render-widget.ts:124-130`).
- If an empty update comes from a stale context while another context owns the widget, it returns early and does not clear the active widget (`render-widget.ts:190-195`).

### Conditional Rendering Branches

#### Widget line construction
- `LiveWidgetComponent.render()` builds lines, clears its internal container, adds each fitted line as `Text`, then returns `container.render(width)` (`render-widget.ts:25-31`).
- Expanded mode uses full `buildWidgetLines()` (`render-widget.ts:34-38`).
- Collapsed single job uses `compactSingleWidgetLines()` (`render-widget.ts:35-36`).
- Collapsed multi-job uses `buildWidgetLines(..., expanded=false)` (`render-widget.ts:36-38`).

#### Multi-job widget
- `buildWidgetLines()` returns `[]` if no jobs (`render-widget.ts:137`).
- Jobs are partitioned into running, queued, and finished (`render-widget.ts:138-140`).
- Header glyph is animated when running, solid when queued-only, hollow when inactive (`render-widget.ts:144`).
- Running jobs render first, queued summary second, finished jobs last (`render-widget.ts:150-176`).
- Rows are bounded by `MAX_WIDGET_JOBS`; hidden counts are summarized (`render-widget.ts:147-185`).

#### Single-job widget
- `buildSingleWidgetLines()` renders title, status row, and foreground-style detail rows (`render-widget-graph.ts:116-128`).
- If there are no steps, `foregroundStyleWidgetDetails()` falls back to job activity and nested children (`render-widget-graph.ts:89-94`).
- For chain/parallel jobs, step rows are rendered via `foregroundStyleWidgetStepLines()` (`render-widget-graph.ts:95-111`).
- Running steps show:
  - “Press ctrl+o for live detail” when collapsed
  - output path
  - expanded live status, recent tools, and recent output (`render-widget-graph.ts:72-87`).

#### Status glyphs and activity
- Job glyphs:
  - running: animated spinner
  - queued: `◦`
  - complete: `✓`
  - paused: `■`
  - failed: `✗` (`render-event-formatting.ts:70-76`)
- Step glyphs use the same mapping (`render-event-formatting.ts:78-84`).
- Activity text derives from current tool/path/turns/tools/live status; fallback text is “thinking…”, “queued…”, “Paused”, “Failed”, or “Done” (`render-event-formatting.ts:23-44`).

### Foreground Tool Result Rendering

- `renderLiveSubagentResult()` computes a stable render key with `subagentResultRenderKey()` (`render-result.ts:22-31`).
- It stores snapshot timestamps in `context.state` so semantic text remains stable between updates while spinner frames can animate independently (`render-result.ts:22-43`).
- If the result is partial and running, it starts an animation timer; otherwise it clears it (`render-result.ts:37-41`).
- `renderSubagentResult()` branches:
  - no details/results: render plain text (`render-result.ts:56-63`)
  - single result compact/expanded (`render-result.ts:68-174`)
  - multi result compact/expanded (`render-result.ts:177-390`)
- Multi expanded rendering builds render entries from chain/progress state, including placeholders for pending workflow graph nodes (`render-result.ts:261-290`).
- Missing result entries render a dim pending row instead of disappearing (`render-result.ts:294-300`).

### Refresh / Polling / Subscription Behavior

- Async start/complete events come from `pi.events` subscriptions (`extension/index.ts:382-386`).
- Result files are watched via `fs.watch`; failure falls back to polling every 3000ms (`result-watcher.ts:182-237`).
- Result handling emits `SUBAGENT_ASYNC_COMPLETE_EVENT`, then deletes the result JSON (`result-watcher.ts:150-168`).
- Active async widget state is refreshed by the tracker poller, not by direct file subscriptions (`async-job-tracker.ts:133-235`).
- Widget animation ticker runs every 80ms while any job or nested step is running (`render-layout.ts:78-91`, `render-widget.ts:107-122`).
- Timer only calls `requestRender()` and updates `latestWidgetFrameNow`; job data itself changes only on tracker events/polls (`render-widget.ts:98-105`).

### Layout Decisions

- Widget placement is `belowEditor` to avoid full screen/scrollback clears when animated lines sit above the viewport fold (`render-widget.ts:209-220`).
- `fitWidgetLineBudget()` caps widget height based on terminal rows:
  - expanded: 12–24 lines or 55% rows
  - collapsed: 10–14 lines or 35% rows (`render-widget-graph.ts:143-153`)
- Overflow is summarized with either “live-detail lines hidden” or “ctrl+o expands” (`render-widget-graph.ts:150-153`).
- All widget lines are truncated with ANSI-preserving `truncLine()` (`render-layout.ts:14-58`).

### Mechanisms That Can Produce Transient Blank/Missing Rows

1. **Empty async job set unmounts the widget**
   - Poller explicitly calls `rerenderWidget(lastUiContext, [])` when `state.asyncJobs.size === 0`, then clears poller (`async-job-tracker.ts:135-143`).
   - `renderWidget(ctx, [])` calls `stopWidgetAnimation()` and unsets widget for the mounted context (`render-widget.ts:189-198`).
   - Any momentary empty `state.asyncJobs` produces full widget disappearance.

2. **Session reset clears jobs before hydration repopulates**
   - `resetSessionState()` calls `resetJobs(ctx)` then `hydrateActiveJobs(ctx)` (`extension/index.ts:420-428`).
   - `resetJobs(ctx)` clears `state.asyncJobs` and rerenders `[]` immediately (`async-job-tracker.ts:315-328`).
   - Hydration then scans active runs and rerenders again (`async-job-tracker.ts:333-369`).
   - This creates an intentional clear-then-repopulate sequence.

3. **Cleanup timer removes completed/failed/paused jobs**
   - Completion schedules job deletion after retention (`async-job-tracker.ts:102-116`, `async-job-tracker.ts:309-313`).
   - Deletion rerenders current jobs. If it was the last job, widget is unmounted.

4. **Initial started event may have no steps**
   - `handleStarted()` creates a queued job from event metadata only; full `steps` appear after status polling reads `status.json` (`async-job-tracker.ts:238-278`, `async-job-tracker.ts:200-218`).
   - Single-job rendering without steps falls back to generic activity lines (`render-widget-graph.ts:89-94`), so step rows can appear later.

5. **Active parallel group slicing changes visible row set**
   - Both hydration and polling replace `steps` with only the active parallel group when `currentStep` falls inside a normalized group (`async-job-tracker.ts:40-47`, `async-job-tracker.ts:207-213`).
   - When active group changes, previous group rows are replaced by the new group’s rows.

6. **Widget container clears all child lines every render**
   - `LiveWidgetComponent.render()` calls `this.container.clear()` before adding new `Text` children (`render-widget.ts:27-30`).
   - The component relies on host diffing and immediate re-addition; any render with `buildLines()` returning fewer/zero lines changes the visible row set.

7. **Context rebinding unmounts old widget before new mount**
   - If the mounted widget context differs from the latest render context, `renderWidget()` best-effort unmounts old context and sets `widgetMounted = false` before mounting on the new context (`render-widget.ts:203-208`).

### Implementation-Guidance Implications for Minimal Fix / Tests

- Minimal fixes should preserve:
  - `belowEditor` placement (`render-widget.ts:209-220`)
  - singleton live widget model (`render-widget.ts:55-62`, `render-widget.ts:214-224`)
  - real-time `requestRender()` ticker behavior (`render-widget.ts:107-122`)
  - start/complete event visibility (`extension/index.ts:382-386`)
  - poller-driven status reconciliation (`async-job-tracker.ts:133-235`)
- Tests should exercise public behavior through tracker/widget render outputs rather than internal component fields:
  - active job remains visible across queued → running → complete transitions
  - reset/hydrate does not produce an observable empty widget if active jobs exist on disk
  - completed/failed/paused jobs remain visible until retention cleanup
  - active parallel group changes replace rows deterministically
  - `needs_attention` and `active_long_running` activity states appear through status-derived activity text
- The highest-impact flicker surface is the clear-then-repopulate path in `resetJobs()` followed by `hydrateActiveJobs()`, because it explicitly renders an empty widget before reading active jobs.