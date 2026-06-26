I can’t write the file directly from this toolset, but here’s the markdown content to save as:

`research/docs/2026-06-26-issue-1517-subagent-ui-locator.md`

```md
# Issue #1517 — Atomic subagent UI/render lifecycle locator

## Implementation files

### Main chat / interactive mode
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-rendering.ts` — chat body/status/working/editor/footer render paths; transcript entry keys and streaming-windowed assistant rendering (`renderChatSessionBody`, `renderChatSessionWorkingStatus`, `renderChatSessionEditor`, `renderChatSessionEntry`, cache-key helpers).
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-events.ts` — agent event → UI-state transitions (`agent_start`, `agent_end`, `turn_start/end`, compaction, retry, tool events).
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-state.ts` — state fields that drive row/panel visibility and render invalidation (`transcript`, `statusMessage`, `workingMessage`, `animationTimer`, `renderThrottleTimer`, `liveChat`, `requestRender`).
- `packages/coding-agent/src/modes/interactive/components/chat-session-host.ts` — host composition / wiring entry point for the interactive chat surface.
- `packages/coding-agent/src/modes/interactive/interactive-render-chat.ts` — initial chat population, message rendering, history rebuilds, and status lines.
- `packages/coding-agent/src/modes/interactive/components/chat-message-renderer.ts` — live transcript entry rendering, tool/result rows, and per-entry component selection.
- `packages/coding-agent/src/modes/interactive/components/working-status.ts` — “working…” spinner/status component used by the main chat surface.
- `packages/coding-agent/src/modes/interactive/components/footer.ts` — footer render content that can shift layout under chat/widgets.

### Subagent background/foreground runner lifecycle
- `packages/subagents/src/runs/background/subagent-runner.ts` — async runner process entry point; step dispatch, signal handling, start/completion event writes.
- `packages/subagents/src/runs/background/subagent-runner-state.ts` — status payload construction, step status updates, activity timer, interrupt pause, status JSON writes.
- `packages/subagents/src/runs/background/subagent-runner-streaming.ts` — child process streaming, tool/message event parsing, final-drain timing, stdout/stderr event emission.
- `packages/subagents/src/runs/background/subagent-runner-finalize.ts` — terminal state assignment, result/status file finalization.
- `packages/subagents/src/runs/background/subagent-runner-output.ts` — share/export/log output paths used after completion.
- `packages/subagents/src/runs/background/subagent-runner-dynamic.ts` / `...parallel.ts` / `...sequential.ts` / `...step.ts` — step execution modes that affect visible status transitions.
- `packages/subagents/src/runs/background/run-status.ts` — async status inspection/output formatting, step rows, nested status text.
- `packages/subagents/src/runs/background/async-job-tracker.ts` — polling/hydration of async jobs into widget state, control-event subscription, in-place widget refresh.
- `packages/subagents/src/runs/background/async-status.ts` — async run summarization used by status rows and widgets.
- `packages/subagents/src/runs/background/stale-run-reconciler.ts` — reconciliation path that can change visible async step/job state.
- `packages/subagents/src/runs/shared/nested-events.ts` — nested async projection updates and nested child attachment.
- `packages/subagents/src/runs/shared/nested-render.ts` — nested run row formatting used by status/widget rendering.
- `packages/subagents/src/runs/shared/workflow-graph.ts` — workflow graph data carried through subagent status/result payloads.

### Subagent TUI/render layer
- `packages/subagents/src/tui/render.ts` — public render facade for subagent result/widget rendering.
- `packages/subagents/src/tui/render-widget.ts` — async widget mount/unmount policy, below-editor placement, requestRender vs setWidget, live singleton state.
- `packages/subagents/src/tui/render-widget-graph.ts` — multi-job and nested step row rendering for the async widget.
- `packages/subagents/src/tui/render-result.ts` — foreground result render path; compact vs expanded, running/partial/live states.
- `packages/subagents/src/tui/render-result-compact.ts` — compact row rendering for single/multi results.
- `packages/subagents/src/tui/render-result-animation.ts` — spinner/ticker lifecycle for foreground subagent results.
- `packages/subagents/src/tui/render-layout.ts` — shared spinner cadence, frame timing, truncation and width helpers.
- `packages/subagents/src/tui/render-status-progress.ts` — live status/elapsed-time text and progress labels.
- `packages/subagents/src/tui/render-event-formatting.ts` — model/step/activity formatting and widget glyph helpers.
- `packages/subagents/src/tui/render-stable-output.ts` — render keys that gate remounts/re-renders (`widgetRenderKey`, `subagentResultRenderKey`, `progressRenderKey`).
- `packages/subagents/src/tui/render-chain-graph.ts` — chain/parallel row labels and placeholder rows for transient status changes.

### Workflow chat integration / overlay UI
- `packages/workflows/src/tui/stage-chat-view.ts` — workflow stage chat surface composition; conditional rendering of header/body/pending/working/editor/footer and custom UI.
- `packages/workflows/src/tui/stage-chat-view-state.ts` — stage chat state, invalidation/disposal, prompt/body state.
- `packages/workflows/src/tui/stage-chat-view-render-helpers.ts` — row/layout helpers used by the embedded stage chat frame.
- `packages/workflows/src/tui/stage-chat-view-custom-ui.ts` — custom UI mount area that can hide the normal chat chrome.
- `packages/workflows/src/tui/stage-chat-view-footer-status.ts` — header/footer/status line rendering for workflow chat.
- `packages/workflows/src/tui/stage-chat-view-archive-history.ts` — blocked/paused/read-only archive body rendering.
- `packages/workflows/src/tui/stage-chat-layout.ts` — viewport/height planning, editor reservation, and bottom-anchoring.
- `packages/workflows/src/tui/widget.ts` — workflow run widget row generation, refresh timing, nested run visibility.
- `packages/workflows/src/tui/store-widget-installer.ts` — widget mount/unmount/update policy and event-hook wiring.
- `packages/workflows/src/tui/workflow-status.ts` — shared workflow status slot used by the workflow/status surfaces.
- `packages/workflows/src/tui/chat-surface.ts` / `chat-surface-message.ts` — shared workflow chat surface components and message rows.

### Extension / registration entry points
- `packages/subagents/src/extension/index.ts` — extension registration, result watcher start/stop, async job tracker hookup, renderers, widget cleanup.
- `packages/workflows/src/extension/index.ts` — workflow extension entry point; installs UI surfaces/widgets and event hooks.
- `packages/subagents/src/extension/notify.ts` — subagent notification surface that can reflect completed/paused/failed run states.
- `packages/coding-agent/src/modes/interactive/interactive-extension-widgets.ts` — host widget container swapping and footer/header insertion logic.

## Test files

### Async widget lifecycle / flicker stability
- `test/unit/subagents-async-widget-visibility.test.ts` — widget hydration, belowEditor mounting, in-place updates, context rebinding.
- `test/unit/subagents-render-stability.test.ts` — core render-stability coverage.
- `test/unit/subagents-render-stability-widget-lifecycle.ts` — mount/unmount/remount and visible→visible update behavior.
- `test/unit/subagents-render-stability-running-widget.ts` — widget row animation and captured-time stability.
- `test/unit/subagents-render-stability-running-spinner.ts` — spinner cadence, row height stability, and timer behavior.
- `test/unit/subagents-render-stability-fast-mode.ts` — fast-mode labels in both foreground and widget views.
- `test/unit/subagents-render-stability-invariants.ts` — invariants for render keys / output stability.
- `test/unit/subagents-render-stability-helpers.ts` — shared test fixtures for render timing and mock state.

### Async / nested / workflow status tests
- `test/unit/subagents-nested-render.test.ts` — nested status formatting and command hints.
- `test/unit/subagents-nested-events.test.ts` — nested event projection / update path.
- `test/unit/subagents-workflow-graph.test.ts` — workflow graph status propagation in subagent payloads.
- `test/unit/subagents-async-status-fast-mode.test.ts` — async status rows with fast-mode metadata.
- `test/unit/subagents-final-drain.test.ts` — final-drain timing around completion.
- `test/unit/subagents-foreground-fallback-updates.test.ts` — foreground status updates.
- `test/unit/subagents-foreground-structured-output-retry.test.ts` — foreground lifecycle around structured output retries.
- `test/unit/subagents-result-intercom.test.ts` — result receipts / intercom emission on completion.
- `test/unit/subagents-acceptance.test.ts` — acceptance-level subagent flows.
- `test/unit/subagents-render-stability-fast-mode.ts` — fast-mode row text stability.

### Workflow UI tests
- `test/unit/workflow-attach-pane-01.test.ts` … `test/unit/workflow-attach-pane-10.test.ts` — workflow attach pane lifecycle and render behaviors.
- `test/unit/workflow-attach-pane.test.ts` — attach-pane integration coverage.
- `test/unit/stage-chat-view.test.ts` and `test/unit/stage-chat-view-01.test.ts` … `-13.test.ts` — stage chat rendering/layout behaviors.
- `test/unit/workflow-list-render.test.ts` — workflow list rendering.
- `test/unit/workflow-lifecycle-notifications.test.ts` and `-01/-02` — workflow lifecycle notification surfaces.

### Main chat / renderer tests
- `test/unit/chat-session-host.test.ts` and `test/unit/chat-session-host-01.test.ts` / `-02.test.ts` — host render/state behavior.
- `test/unit/chat-message-renderer.test.ts` — message row rendering.
- `test/unit/chat-surface.test.ts` — chat surface integration.
- `test/unit/stage-chat-view-*.test.ts` — workflow stage chat render coverage.

### Integration / runtime tests
- `test/integration/runtime-wiring.test.ts` — extension/runtime wiring.
- `test/integration/mock-extension-api-rendering.test.ts` — extension API rendering surface.
- `test/integration/mock-extension-api-workflow-actions.test.ts` — workflow action plumbing.
- `test/integration/overlay-entrypoints-*.test.ts` — overlay entrypoint behavior affecting visible widget/panel transitions.
- `packages/coding-agent/test/changelog.test.ts` — changelog/docs surface validation that can mention subagent behavior.

## Configuration / docs / changelog

### Docs
- `packages/coding-agent/docs/subagents.md` — subagent feature docs, background/foreground modes, widget behavior, and usage.
- `packages/coding-agent/docs/workflows.md` — workflow docs that reference workflow UI/runtime surfaces.
- `packages/coding-agent/docs/tui.md` — TUI behavior docs (rendering and live UI conventions).
- `packages/coding-agent/docs/changelog.mdx` — user-facing changelog entry point.
- `packages/coding-agent/README.md` — top-level product/feature docs including interactive mode and extensions.
- `packages/coding-agent/examples/extensions/subagent/README.md` — example extension docs and widget behavior notes.
- `packages/coding-agent/examples/extensions/subagent/prompts/*.md` — sample workflow prompts used by subagent examples.

### Existing research/specs related to this issue
- `research/docs/2026-02-05-subagent-ui-opentui-independent-context.md`
- `research/docs/2026-02-14-subagent-output-propagation-issue.md`
- `research/docs/2026-02-15-subagent-event-flow-diagram.md`
- `research/docs/2026-02-15-subagent-premature-completion-investigation.md`
- `research/docs/2026-02-23-gh-issue-258-background-agents-ui.md`
- `research/docs/2026-03-01-opencode-delegation-streaming-parity.md`
- `specs/2026-02-05-subagent-ui-independent-context.md`
- `specs/2026-02-14-subagent-output-propagation-fix.md`
- `specs/2026-03-05-claude-at-subagent-streaming-done-state-ordering-fix.md`
- `specs/2026-05-14-workflow-sdk-pi-subagents-api-parity.md`

## High-value line ranges to inspect first

### Main chat / interactive
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-rendering.ts:1-220` — render branches, transcript/body/editor, streaming-windowed rows, cache keys.
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-events.ts:1-220` — status/working/compaction transitions and live chat event handling.
- `packages/coding-agent/src/modes/interactive/components/chat-session-host-state.ts:1-120` — state fields and render timers.
- `packages/coding-agent/src/modes/interactive/interactive-render-chat.ts:1-220` — transcript rebuild and status line injection.
- `packages/coding-agent/src/modes/interactive/interactive-extension-widgets.ts:1-120` — widget/footer/header swapping and blank-line spacing.

### Subagent render/widget
- `packages/subagents/src/tui/render-widget.ts:1-280` — singleton widget mount/unmount/update logic, belowEditor placement, requestRender vs setWidget.
- `packages/subagents/src/tui/render-result.ts:1-240` — partial vs final result rendering, running result branch, compact/expanded branch selection.
- `packages/subagents/src/tui/render-result-animation.ts:1-120` — spinner timer lifecycle.
- `packages/subagents/src/tui/render-layout.ts:1-140` — frame cadence and captured-now behavior.
- `packages/subagents/src/tui/render-stable-output.ts:1-80` — render keys that can trigger remounts or transient row changes.

### Background runner / tracker
- `packages/subagents/src/runs/background/subagent-runner-state.ts:1-260` and `261-420` — initial status, per-step updates, activity state, pause handling.
- `packages/subagents/src/runs/background/subagent-runner-streaming.ts:1-260` — child event stream parsing, final drain, completion timing.
- `packages/subagents/src/runs/background/subagent-runner-finalize.ts:1-140` — terminal state write-out.
- `packages/subagents/src/runs/background/async-job-tracker.ts:1-260` and `261-420` — hydration, polling, visible job updates, cleanup, control-event subscription.
- `packages/subagents/src/runs/background/run-status.ts:1-260` and `261-360` — status output rows and nested visibility text.

### Workflow chat / overlay
- `packages/workflows/src/tui/stage-chat-view.ts:1-220` — conditional render ordering and frame assembly.
- `packages/workflows/src/tui/stage-chat-layout.ts:1-120` — viewport measurement and row budgeting.
- `packages/workflows/src/tui/store-widget-installer.ts:1-240` — belowEditor widget mount/update policy and requestRender-only refreshes.
- `packages/workflows/src/tui/widget.ts:1-220` — workflow widget row generation and clock-driven refresh timing.

## Notes
- The most flicker-sensitive call sites are the ones that switch between `setWidget(...)` and `requestRender()`, or that use render keys / cached timestamps to decide whether a panel row is remounted vs updated in place.
- For this issue, the main areas to inspect are:
  1. widget mount/unmount transitions,
  2. streaming → running → completed status transitions,
  3. row key changes / cache keys,
  4. layout height / viewport budgeting,
  5. event subscriptions that rehydrate or refresh state,
  6. workflow stage chat embedded frame sizing and visibility.
```

If you want, I can also turn this into a shorter issue-focused locator that only lists the top 15–20 files.