export const HINT_KEYS: Array<{ key: string; label: string }> = [
  { key: "ctrl+x", label: "return to main chat" },
  { key: "↵", label: "open stage chat" },
  { key: "↑↓←→", label: "navigate" },
  { key: "/", label: "stages" },
];

export const COMPACT_HINT_KEYS: Array<{ key: string; label: string }> = [
  { key: "ctrl+x", label: "return to main chat" },
  { key: "↵", label: "stage chat" },
];

/**
 * Bottom mode pill. The status bar mirrors the top header band: a
 * three-row chrome strip with an outlined pill flush-left and hints
 * flowing right of it on the centre row.
 */
export const MODE_PILL_LABEL = "GRAPH";

/**
 * Fixed line count emitted by `_renderOverlay`. pi-tui paints the
 * overlay in the same buffer as the chat, so a *variable* line count
 * causes the chat to scroll every time the focused-stage section grows
 * or shrinks — that's exactly the duplicate-rows bug we hit when
 * navigating with j/k. Padding to a constant height keeps the overlay
 * a stable rectangle that pi-tui can diff cell-by-cell.
 *
 * Mirrors the doom-overlay reference extension, which always emits the
 * same number of lines per frame regardless of game state.
 */
export const OVERLAY_LINE_COUNT = 32;
export const OVERLAY_VERTICAL_MARGIN_ROWS = 1;

/**
 * Animation tick period. Overlay re-renders fire on this cadence so
 * duration counters tick from active elapsed time (freezing while paused)
 * and the running-stage border lerps between `borderDim` and
 * `warning` without a key press. The host-supplied `requestRender`
 * gate prevents work while the overlay is hidden or unfocused.
 */
export const ANIMATION_TICK_MS = 100;

/**
 * Full lerp period of `pulseT` for running-stage borders, in ms.
 * `pulsePhase ∈ [0, 1)` cycles every `PULSE_PERIOD_MS` so the sine
 * eased lerp inside `pickBorder` traces one full breath per cycle.
 */
export const PULSE_PERIOD_MS = 2000;
export const GRAPH_SCROLL_STEP_COLS = 4;
export const GRAPH_SCROLL_STEP_ROWS = 4;
