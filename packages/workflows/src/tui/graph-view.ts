/**
 * GraphView — orchestrator overlay rendered as a pi-tui Component.
 *
 * Visual contract (DESIGN.md):
 *  - No manual ASCII frame. `pi.ui.custom({ overlay: true })` provides the
 *    popup chrome; this renderer leaves one unpainted row above and below
 *    the panel, then paints content on the canvas (`bg`) with full-width
 *    chrome rows for the header (top) and hints (bottom).
 *  - Section labels use the `  LABEL` pattern: mauve glyph + `textMuted`
 *    bold caps.
 *  - Hints follow `<key> <label>` separated by ` · ` in `dim`, active key
 *    letters in `text`, labels in `textMuted`.
 *  - No decorative progress bar. Counts live in the header pills.
 *
 * cross-ref:
 *   - github.com/bastani-inc/atomic packages/atomic-sdk/src/components/session-graph-panel.tsx
 *   - DESIGN.md §4 (Elevation), §5 (Components)
 */
import type { Component } from "@earendil-works/pi-tui";
import { GraphViewInputController } from "./graph-view-input.js";

export type { GraphViewMode, GraphViewOpts } from "./graph-view-types.js";

/** Public facade preserving the historical `./graph-view.js` import path. */
export class GraphView extends GraphViewInputController implements Component {}
