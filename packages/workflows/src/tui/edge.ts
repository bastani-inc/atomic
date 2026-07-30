/**
 * String-rendering helper for a connector edge between nodes.
 *
 * Edges are rendered in the dim border role so they recede behind the
 * status-coloured node cards (DESIGN.md "Status-Is-Truth" — saturated
 * colour belongs to nodes, not connectors).
 */

import { hexToAnsi, RESET } from "./color-utils.js";
import { buildConnector } from "./connectors.js";
import type { GraphTheme } from "./graph-theme.js";
import type { LayoutNode } from "./layout.js";
import { NODE_W } from "./layout.js";

export interface EdgeOpts {
	theme: GraphTheme;
}

export function renderEdge(from: LayoutNode, to: LayoutNode, opts: EdgeOpts): string[] {
	const ec = hexToAnsi(opts.theme.borderDim);
	const fromX = from.x + NODE_W;
	const toX = to.x;
	const result = buildConnector(fromX, toX);
	return result.lines.map((l) => `${ec}${l.chars}${RESET}`);
}
