## 1. Must-read paths

- `packages/workflows/src/tui/graph-view.ts` — core graph visualization component; likely the main place to understand node/edge rendering, focus, keyboard navigation, and state transitions.
- `packages/workflows/src/tui/overlay-adapter.ts` — bridge from workflow state into the TUI overlay surface; key for how the graph is embedded and shown/hidden.
- `packages/workflows/src/tui/store-widget-installer.ts` — installs the workflow widget and tool-execution hooks; central to human-in-the-loop (HIL) UI updates.
- `packages/workflows/src/tui/widget.ts` — renders the status/widget lines; useful for understanding compact workflow status presentation.
- `packages/workflows/src/tui/workflow-attach-pane.ts` — attach/retarget pane for interactive workflow control.
- `packages/workflows/src/shared/store.ts` — shared store for prompt lifecycle and UI state; likely the source of truth for HIL behavior.
- `packages/workflows/src/shared/store-types.ts` — types for `PendingPrompt`, overlay adapter, and prompt answer state.
- `packages/workflows/src/runs/foreground/executor.ts` — foreground workflow execution and readiness-gate flow; drives what the TUI needs to show.
- `packages/workflows/src/runs/background/runner.ts` — detached/background execution path; relevant for UI state when workflows are not foregrounded.
- `packages/workflows/src/runs/background/status.ts` — pause/resume/kill/inspect actions that surface in the UI.
- `packages/workflows/src/extension/index.ts` — extension entrypoint wiring the TUI, overlays, notifications, and commands.

## 2. Supporting paths

- `packages/workflows/src/tui/inputs-overlay.ts` — input picker entrypoint for interactive prompts.
- `packages/workflows/src/tui/session-overlays.ts` — session picker / kill confirm overlays.
- `packages/workflows/src/tui/inline-form-overlay.ts` — inline form rendering for prompt input.
- `packages/workflows/src/tui/prompt-card.ts` — prompt card render/input handling.
- `packages/workflows/src/tui/inputs-picker.ts` — picker UI logic.
- `packages/workflows/src/tui/session-picker.ts` — session selection UI logic.
- `packages/workflows/src/tui/session-confirm.ts` — kill/confirm overlay behavior.
- `packages/workflows/src/extension/background-ui-adapter.ts` — background UI bridge; important for HIL prompts in detached runs.
- `packages/workflows/src/extension/hil-answer-notifications.ts` — answer notifications for HIL prompts.
- `packages/workflows/src/extension/lifecycle-notifications.ts` — lifecycle notices shown in the UI.
- `packages/workflows/src/shared/expanded-workflow-graph.ts` — graph expansion helpers used by the overlay/widget.
- `packages/workflows/README.md` — user-facing explanation of TUI/HIL behavior.
- `packages/workflows/CHANGELOG.md` — history of graph/widget/overlay fixes and regressions.
- `packages/workflows/package.json` — package entrypoints, extension registration, and export wiring.
- `specs/2026-03-02-workflow-tui-rendering-unification.md` — design intent for the TUI rendering model.
- `research/docs/2026-02-27-workflow-tui-rendering-unification.md` — background research on the same area.

## 3. Entry points / symbols

- `GraphView` — `packages/workflows/src/tui/graph-view.ts`
- `GraphViewMode` — `packages/workflows/src/tui/graph-view.ts`
- `GraphViewOpts` — `packages/workflows/src/tui/graph-view.ts`
- `buildGraphOverlayAdapter` — `packages/workflows/src/tui/overlay-adapter.ts`
- `installStoreWidget` — `packages/workflows/src/tui/store-widget-installer.ts`
- `installToolExecutionHooks` — `packages/workflows/src/tui/store-widget-installer.ts`
- `decideWidgetAction` — `packages/workflows/src/tui/store-widget-installer.ts`
- `renderWidgetLines` — `packages/workflows/src/tui/widget.ts`
- `buildThemedWidgetLines` — `packages/workflows/src/tui/widget.ts`
- `nextWidgetRefreshDelayMs` — `packages/workflows/src/tui/widget.ts`
- `WorkflowAttachPane` — `packages/workflows/src/tui/workflow-attach-pane.ts`
- `createStageContext` — `packages/workflows/src/runs/foreground/stage-runner.ts`
- `run`, `runTask`, `runParallel`, `runChain` — `packages/workflows/src/runs/foreground/executor.ts`
- `runDetached` — `packages/workflows/src/runs/background/runner.ts`
- `statusRuns`, `killRun`, `pauseRun`, `resumeRun`, `inspectRun` — `packages/workflows/src/runs/background/status.ts`

## 4. Gaps or uncertainty

- `packages/workflows/src/tui/background-ui-adapter.ts` was mentioned as legacy/adjacent; the verified active path appears to be `packages/workflows/src/extension/background-ui-adapter.ts`.
- `packages/workflows/README.md` and `CHANGELOG.md` likely describe intended behavior, but they were not fully cross-checked against runtime code in this pass.
- Manual fixtures like `.atomic/workflows/hil-dummy.ts` and `.atomic/workflows/contract-child.ts` look relevant for HIL validation, but their exact role wasn’t verified here.
- If you want Rust migration guidance, this partition mainly identifies the UI surface area that would need a replacement TUI/rendering stack and prompt/state bridge.