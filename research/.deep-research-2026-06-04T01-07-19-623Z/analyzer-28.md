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