/**
 * Re-exports / integration point for extension renderers.
 * cross-ref: spec §5.6
 */

export { hexBg, hexToAnsi, lerpColor, RESET } from "./color-utils.js";
export { renderEdge } from "./edge.js";
export { deriveGraphTheme } from "./graph-theme.js";
export { GraphView } from "./graph-view.js";
// Re-export render helpers for use by the extension's registerMessageRenderer calls.
export { renderHeader } from "./header.js";
export { computeLayout, NODE_H, NODE_W } from "./layout.js";
export { renderNodeCard } from "./node-card.js";
export { fmtDuration, statusColor, statusIcon } from "./status-helpers.js";
