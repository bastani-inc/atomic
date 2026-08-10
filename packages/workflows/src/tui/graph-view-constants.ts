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
 * Animation tick period. Overlay re-renders fire on this cadence so
 * duration counters tick from active elapsed time (freezing while paused)
 * and the running-stage border lerps between `borderDim` and
 * `warning` without a key press. The host-supplied `requestRender`
 * gate prevents work while the overlay is hidden or unfocused.
 * GraphView also skips ticks when nothing is animating — no running or
 * awaiting_input stage and no prompt caret — so large idle graphs do not
 * burn ~10 full paints/sec (#2100).
 */
export const ANIMATION_TICK_MS = 100;

/**
 * Full lerp period of `pulseT` for running-stage borders, in ms.
 * `pulsePhase ∈ [0, 1)` cycles every `PULSE_PERIOD_MS` so the sine
 * eased lerp inside `pickBorder` traces one full breath per cycle.
 */
export const PULSE_PERIOD_MS = 2000;
export const GRAPH_SCROLL_STEP_COLS = 4;
