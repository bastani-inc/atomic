## Partition 28: Workflow TUI graph, widget, overlay, and human-in-the-loop UI behavior

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Theme-driven rendering is the norm**
  - Most TUI components consume `GraphTheme` instead of raw colors.
  - Examples: `packages/workflows/src/tui/graph-theme.ts`, `session-picker.ts`, `widget.ts`, `graph-view.ts`, `chat-surface.ts`.
  - Stable convention: `deriveGraphTheme(...)` / `deriveGraphThemeFromPiTheme(...)` feeds all graph UI.

- **Renderers are usually pure; adapters own host wiring**
  - `renderSessionPicker(...)` in `session-picker.ts`
  - `openInputsPicker(...)` in `inputs-overlay.ts`
  - `openSessionPicker(...)`, `openKillConfirm(...)` in `session-overlays.ts`
  - Pattern: render logic is separated from `pi.ui.custom(...)`, subscriptions, and cleanup.

- **Overlay mode is a first-class UI contract**
  - `buildGraphOverlayAdapter(...)` in `overlay-adapter.ts`
  - Uses fullscreen overlay options and preserves the handle for hide/show.
  - Convention: `overlay: true` for graph/HIL UI, `overlay: false` for inline pickers.

- **Refresh is request-based, not remount-based**
  - `tui.requestRender?.()` is the common invalidation hook.
  - Seen in `widget.ts`, `overlay-adapter.ts`, `stage-chat-view.ts`, `inline-form-editor.ts`.
  - This is a repo-wide UI rhythm: mutate state, then request render.

- **Human-in-the-loop state is modeled explicitly**
  - `graph-view.ts` and `workflow-attach-pane.ts` both track prompt resolution and focus readiness.
  - Symbols: `PendingPrompt`, `onPromptResolve`, `wantsFocusForAwaitingInput(...)`.

## 2. Variations / exceptions

- **Inline overlays use a different mount style than fullscreen graph overlays**
  - `inputs-overlay.ts` / `inline-form-overlay.ts` lean on embedded rendering and local editor state.
  - They still follow the same `requestRender` contract, but not the same overlay handle lifecycle.

- **Some UI pieces are intentionally stateful**
  - `widget.ts` and `store-widget-installer.ts` keep timers / refresh cadence.
  - This is not pure render-only code; it’s a controlled exception for live status updates.

- **Theme derivation has fallback behavior**
  - `deriveGraphThemeFromPiTheme(...)` accepts host theme objects but falls back to canonical defaults.
  - That makes the UI resilient to incomplete host theme data.

## 3. Anti-patterns or risks

- **Remounting causes flicker / scroll pollution**
  - `overlay-adapter.ts` explicitly avoids remounting by using `setHidden(true)`.
  - Risk: if Rust port re-creates widgets/overlays instead of preserving handles, UX regresses.

- **Focus drift can break HIL prompts**
  - `overlay-adapter.ts` includes explicit refocus logic for awaiting input.
  - Risk: overlay remains visible but keyboard actions stop working if focus isn’t restored.

- **UI contracts are spread across multiple files**
  - `graph-view.ts`, `overlay-adapter.ts`, `workflow-attach-pane.ts`, `stage-chat-view.ts` all participate in prompt/focus/render flow.
  - Risk: a Rust rewrite can easily split these responsibilities incorrectly.

- **Timer-driven widgets are easy to over-update**
  - `widget.ts` has deliberate throttling / refresh delay logic.
  - Risk: naive reactive loops can cause excessive redraws.

## 4. Evidence index

- `packages/workflows/src/tui/graph-theme.ts`
- `packages/workflows/src/tui/session-picker.ts`
- `packages/workflows/src/tui/inputs-overlay.ts`
- `packages/workflows/src/tui/session-overlays.ts`
- `packages/workflows/src/tui/overlay-adapter.ts`
- `packages/workflows/src/tui/widget.ts`
- `packages/workflows/src/tui/store-widget-installer.ts`
- `packages/workflows/src/tui/graph-view.ts`
- `packages/workflows/src/tui/workflow-attach-pane.ts`
- `packages/workflows/src/tui/stage-chat-view.ts`
- `packages/workflows/src/tui/inline-form-overlay.ts`
- `packages/workflows/src/tui/inline-form-editor.ts`

### Analyzer
# 1. Behavioral model

This partition is the **workflow TUI control surface**: a graph renderer plus two embedding modes:

- **Overlay mode**: full-screen-ish popup that shows the workflow graph, live status, HIL prompt card, switcher, and toasts.
- **Widget mode**: compact below-editor status widget showing background runs.

Core data source is the shared `Store`; the UI is reactive to store snapshots and never owns workflow truth. `GraphView` rebuilds its layout from `StoreSnapshot` changes, then renders from cached layout + current snapshot.

Important behavioral pieces:

- `graph-view.ts`
  - Renders vertical node graph with edges, focused node, scroll, and keyboard navigation.
  - Supports live animation ticks (~10 FPS) for border pulsing and elapsed timers.
  - Handles HIL prompt card UI locally, but resolves via store callback.
  - Handles “attach”, “detach”, “hide”, “kill”, and stage switcher actions.
- `overlay-adapter.ts`
  - Mounts the graph inside Pi/pi overlay primitives.
  - Prefers `setHidden(true)` over unmounting so state/animation survive.
  - Bridges overlay focus, mouse tracking, and stage-chat attachment.
- `store-widget-installer.ts`
  - Installs a long-lived widget component and tool-execution hooks.
  - Converts tool execution events into store mutations, including `ask_user_question` awaiting-input state.
- `widget.ts`
  - Produces compact background-run summaries and refresh timing.

# 2. Key flows and invariants

## Render/data flow

1. Store emits snapshot.
2. `GraphView` subscription updates `currentSnapshot`.
3. `_rebuildLayout()` recomputes expanded graph + node layout.
4. `render()` chooses overlay or widget mode.

## Overlay invariants

- Overlay line count is intentionally **stable** to avoid scrollback/duplicate-row artifacts.
- If viewport rows are available, the overlay scales to terminal height; otherwise it falls back to a fixed rectangle.
- HIL prompt card is shown only when `run.pendingPrompt` exists.
- Switcher and prompt card are mutually prioritized: switcher hides prompt card.

## Input handling invariants

- Prompt input gets first crack, except for a narrow set of graph controls like `Ctrl+D` and wheel scroll.
- `Enter` on a node tries to attach to that stage; otherwise it toggles details in legacy mode.
- `q` kills the active run immediately if a kill callback exists.
- `h` hides without killing; `Ctrl+D` detaches the pane.

## Focus behavior

- Focus can restore to a specific stage on re-entry.
- If a stage is awaiting input, focus auto-jumps to the latest awaiting node once per prompt key.
- Horizontal/vertical scrolling is adjusted to keep the focused node visible.

## Store/tool coupling

`installToolExecutionHooks()` listens to tool events and writes into the store. Special case:

- `ask_user_question` sets stage awaiting-input on start.
- It clears awaiting-input only when the matching active call ends, preventing premature unlock if multiple tool events interleave.

## Widget invariants

- Only top-level workflow runs are shown.
- Widget shows active and recently-ended runs.
- Recently-ended runs persist briefly via a time-based expiry.
- Narrow width collapses to a single-line summary.

# 3. Tests / validation

From this pass, I did **not find a dedicated test file** for this partition in the scanned paths. That means validation is likely indirect via broader workflow/store tests elsewhere.

What is explicitly testable here:

- `decideWidgetAction()` is pure and designed for unit testing.
- `buildThemedWidgetLines()`, `nextWidgetRefreshDelayMs()`, and layout helpers are mostly deterministic with fixed `now`.
- Store mutation paths around pending prompts and awaiting input should be integration-tested against event sequences.

# 4. Risks, unknowns, and verification steps

## Risks

- **Tight coupling to Pi/pi TUI primitives** (`custom`, overlay handles, focus, hidden state, widgets).
- **Graph rendering is stateful**: scroll, focus, prompt state, and switcher state all persist across renders.
- **HIL behavior spans multiple layers**: tool events → store → graph prompt card → overlay input → resolve callbacks.
- **Animation/refresh assumptions** depend on host requestRender timing and viewport row reporting.
- **Overlay stability is deliberate**; a Rust port must preserve fixed-height frame behavior or risk scrollback glitches.

## Unknowns

- Exact coverage of this partition in tests is unclear.
- I didn’t verify all downstream callers of `onPromptResolve`, `onStageAttach`, or `onHide`.
- The attach-pane lifecycle and chat UI interactions need confirmation if you’re replacing the host runtime.

## Verification steps for a Rust migration

1. Identify the **render contract** you must preserve:
   - fixed-height overlay
   - focus retention
   - prompt-card precedence
   - hidden-vs-unmounted semantics
2. Recreate store-driven state transitions first, before rendering.
3. Add snapshot tests for:
   - node graph layout
   - prompt visibility
   - switcher interaction
   - widget collapse/expiry
4. Confirm how the new Rust TUI will handle:
   - overlay focus
   - keybinding routing
   - periodic render ticks
   - terminal-height-based sizing

If you want, I can next turn this into a **Rust migration seam map** for just this partition.

### Online Researcher
## 1. Relevant external facts

No external research was necessary for this partition. The key behavior is defined by the repo’s own workflow TUI/store code, not by an external framework contract.

## 2. Local implications

This area is the **UI/runtime boundary** you’d need to replace in a Rust migration:

- `graph-view.ts` is the main graph renderer and navigation surface.
- `overlay-adapter.ts` and `store-widget-installer.ts` connect workflow state to the TUI surface.
- `widget.ts` provides the compact status line/widget behavior.
- `workflow-attach-pane.ts` and the picker/confirm overlays implement the human-in-the-loop interaction flow.
- `shared/store.ts` + `store-types.ts` are the state source of truth for pending prompts, answers, and overlay visibility.
- Foreground/background execution code (`executor.ts`, `runner.ts`, `status.ts`) drives what the UI must reflect.

For a Rust port, this means you’re not just translating rendering code—you’re also re-implementing:
- state synchronization,
- prompt lifecycle handling,
- overlay routing,
- workflow status refresh,
- foreground/background action plumbing.

## 3. Version/API assumptions

- No external API/version assumptions were needed for this partition.
- The important assumption is **local contract stability**: the Rust version must preserve the same store/event semantics exposed by the workflow runtime.

## 4. Unverified or unnecessary research

Unverified here:
- the exact TUI library on the TS side and its Rust replacement strategy,
- whether any behavior is coupled to terminal rendering quirks or host app APIs,
- how much of the overlay/widget logic is reusable as pure state machines.

If you want, I can next turn this into a **Rust migration map** for this partition: “what to port first, what can stay protocol-compatible, and what should become a shared core crate.”