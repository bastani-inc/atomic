/**
 * Placing a viewed subagent's transcript frame in a transcript area of another height.
 *
 * The engine draws the transcript for the rows the host asks for, and the host paints the frame it has until the one
 * for the new height arrives. A frame is the scrolled transcript (its body) with the page's notes and question form
 * below it. With the frame's layout the host puts every row it has where the engine's frame for the new height will
 * put it: rows the reader follows at the end stay at the bottom and earlier rows open above them, a reader scrolled up
 * keeps the rows they read at the top, and the notes and form stay at the bottom. Rows the frame does not have stay
 * blank until that frame is here; nothing painted moves when it arrives.
 */

/** How a transcript frame laid out its rows, sent with each frame the engine draws for a viewed subagent. */
export interface TranscriptFrameLayout {
	/** The width the frame was drawn for. */
	readonly width: number;
	/** Rows at the top of the frame that show the scrolled transcript; the rows after them are notes and the form. */
	readonly bodyRows: number;
	/** The transcript row the body shows first. */
	readonly firstRow: number;
	/** Rows the whole transcript has. */
	readonly totalRows: number;
	/** Rows at the top of the body that are not transcript rows: the pinned prompt of a reader scrolled up. */
	readonly headRows: number;
	/** Rows at the bottom of the body that are not transcript rows: the jump to the latest row. */
	readonly footRows: number;
}

export interface PlacedTranscriptFrame {
	readonly lines: string[];
	/**
	 * The frame row each row shows when the frame was placed by its layout, undefined where the frame has no row for
	 * it. Without it, row `r` shows frame row `r + hidden`.
	 */
	readonly frameRows?: readonly (number | undefined)[];
	/** Rows of the frame above the first one shown, when it was not placed by its layout. */
	readonly hidden: number;
}

const LAYOUT_FIELDS = ["width", "bodyRows", "firstRow", "totalRows", "headRows", "footRows"] as const;

/** The layout in `value`, when it is one: whole, non-negative numbers whose rows fit the body. */
export function parseTranscriptFrameLayout(value: unknown): TranscriptFrameLayout | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	for (const field of LAYOUT_FIELDS) {
		const entry = record[field];
		if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) return undefined;
	}
	const layout = record as unknown as TranscriptFrameLayout;
	if (layout.headRows + layout.footRows > layout.bodyRows) return undefined;
	return {
		width: layout.width,
		bodyRows: layout.bodyRows,
		firstRow: layout.firstRow,
		totalRows: layout.totalRows,
		headRows: layout.headRows,
		footRows: layout.footRows,
	};
}

/**
 * `lines`, a frame laid out as `layout` says, in `height` rows of `width`. A frame drawn for this height is shown as
 * it is. One drawn for another height is placed as the engine's frame for this height places the same rows; without a
 * layout that says how, its last rows are shown and blank rows follow.
 */
export function placeTranscriptFrame(
	lines: string[],
	layout: TranscriptFrameLayout | undefined,
	width: number,
	height: number,
): PlacedTranscriptFrame {
	const rows = Math.max(0, height);
	if (lines.length !== rows && layout !== undefined && layout.width === width) {
		const placed = placeByLayout(lines, layout, rows);
		if (placed !== undefined) return placed;
	}
	// A frame drawn for another height until the next one is here: keep its last rows, where the latest are.
	const hidden = Math.max(0, lines.length - rows);
	const shown = hidden > 0 ? lines.slice(hidden) : lines;
	const placed = shown.length < rows ? [...shown, ...Array.from({ length: rows - shown.length }, () => "")] : shown;
	return { lines: placed, hidden };
}

/**
 * The rows the engine's frame for `height` puts where, after `ScrollableComponentViewport.render`: a reader at the
 * end stays at the end, a reader scrolled up keeps their first row until the end comes into view, and the notes and
 * form keep their rows below. Undefined when the frame cannot say: the area leaves the body no row, or a small frame
 * left out a pinned prompt or a jump row that the taller one draws.
 */
function placeByLayout(
	lines: string[],
	layout: TranscriptFrameLayout,
	height: number,
): PlacedTranscriptFrame | undefined {
	const { bodyRows, firstRow, totalRows, headRows, footRows } = layout;
	const bandRows = lines.length - bodyRows;
	const nextBody = height - bandRows;
	if (bandRows < 0 || nextBody < 1) return undefined;
	const following = firstRow + bodyRows >= totalRows;
	const lastStart = Math.max(0, totalRows - nextBody);
	const nextFirst = following ? lastStart : Math.min(firstRow, lastStart);
	// Scrolled up, and still short of the end: the body keeps its pinned prompt and jump row where the rows allow them.
	const scrolled = !following && nextFirst < lastStart;
	if (scrolled && bodyRows <= 1 && nextBody > 1) return undefined;
	const nextFoot = scrolled && footRows > 0 && nextBody > 1 ? footRows : 0;
	if (scrolled && headRows === 0 && firstRow > 0 && bodyRows - footRows <= 2 && nextBody - nextFoot > 2)
		return undefined;
	const nextHead = scrolled && headRows > 0 && nextBody - nextFoot > 2 ? headRows : 0;
	const transcriptRows = bodyRows - headRows - footRows;
	const frameRows: (number | undefined)[] = [];
	for (let row = 0; row < nextBody; row++) {
		if (row < nextHead) frameRows.push(row);
		else if (row >= nextBody - nextFoot) frameRows.push(bodyRows - (nextBody - row));
		else {
			const transcriptRow = nextFirst + (row - nextHead) - firstRow;
			frameRows.push(transcriptRow >= 0 && transcriptRow < transcriptRows ? headRows + transcriptRow : undefined);
		}
	}
	for (let row = 0; row < bandRows; row++) frameRows.push(bodyRows + row);
	return { lines: frameRows.map((row) => (row === undefined ? "" : (lines[row] ?? ""))), frameRows, hidden: 0 };
}

/** A component that reports how it laid out the transcript frame it rendered last. */
export interface TranscriptLayoutSource {
	transcriptLayout?(): TranscriptFrameLayout | undefined;
}

/** How `component` laid out the frame it rendered last, when it says. */
export function transcriptLayoutOf(component: object): TranscriptFrameLayout | undefined {
	return (component as TranscriptLayoutSource).transcriptLayout?.();
}
