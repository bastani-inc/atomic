import { sliceByColumn, truncateToWidth } from "@earendil-works/pi-tui";
import {
	MAX_ANCHOR_CONTEXT_WIDTH,
	MAX_VISIBLE_ANCHOR_CONTENT_WIDTH,
	MIN_ANCHOR_CONTEXT_WIDTH,
	MIN_VISIBLE_ANCHOR_CONTENT_WIDTH,
	TREE_GUTTER_WIDTH,
	type HorizontalViewportRow,
} from "./tree-selector-types.ts";

/**
 * Render tree rows into a horizontally clipped viewport.
 *
 * The tree gutter is always kept visible. The row bodies are shifted left only
 * when the selected row's anchor (the start of its entry text after tree
 * indentation/markers) would otherwise be too far right to see useful content.
 */
export function renderHorizontalViewport(rows: HorizontalViewportRow[], width: number): string[] {
	const viewportWidth = Math.max(0, width - TREE_GUTTER_WIDTH);
	const maxBodyWidth = rows.reduce((max, row) => Math.max(max, row.bodyWidth), 0);
	const maxHorizontalScroll = Math.max(0, maxBodyWidth - viewportWidth);
	const selectedRow = rows.find((row) => row.isSelected);

	// Only pan horizontally when needed to keep enough selected-row content visible after its anchor.
	let horizontalScroll = 0;
	if (selectedRow && maxHorizontalScroll > 0) {
		const minVisibleAnchorContentWidth = Math.min(
			MAX_VISIBLE_ANCHOR_CONTENT_WIDTH,
			Math.max(MIN_VISIBLE_ANCHOR_CONTENT_WIDTH, Math.floor(viewportWidth / 3)),
		);
		if (selectedRow.anchorCol > viewportWidth - minVisibleAnchorContentWidth) {
			const anchorContextWidth = Math.min(
				MAX_ANCHOR_CONTEXT_WIDTH,
				Math.max(MIN_ANCHOR_CONTEXT_WIDTH, Math.floor(viewportWidth / 4)),
			);
			horizontalScroll = Math.min(maxHorizontalScroll, selectedRow.anchorCol - anchorContextWidth);
		}
	}

	// Clip only the body; the fixed-width gutter remains visible as navigation context.
	return rows.map((row) => {
		const line =
			horizontalScroll > 0
				? `${row.gutter}${sliceByColumn(row.body, horizontalScroll, viewportWidth, true)}\x1b[0m`
				: row.gutter + row.body;
		return truncateToWidth(line, width, "");
	});
}
