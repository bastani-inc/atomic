/**
 * String-rendering helper for a connector edge between nodes.
 * cross-ref: spec §5.4.1, v0.x packages/atomic-sdk/src/components/edge.tsx
 */
import type { LayoutNode } from "./layout.js";
import type { GraphTheme } from "./graph-theme.js";
import { buildConnector } from "./connectors.js";
import { NODE_W } from "./layout.js";

export interface EdgeOpts {
  theme: GraphTheme;
}

function hexToAnsi(hex: string): string {
  const h = hex.replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

const RESET = "\x1b[0m";

/**
 * Render an edge between fromNode and toNode.
 * Returns lines of the connector band.
 */
export function renderEdge(from: LayoutNode, to: LayoutNode, opts: EdgeOpts): string[] {
  const ec = hexToAnsi(opts.theme.edgeColor);
  // fromX is the right edge of from node, toX is the left edge of to node
  const fromX = from.x + NODE_W;
  const toX = to.x;
  const result = buildConnector(fromX, toX);
  return result.lines.map((l) => `${ec}${l.chars}${RESET}`);
}
