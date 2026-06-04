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