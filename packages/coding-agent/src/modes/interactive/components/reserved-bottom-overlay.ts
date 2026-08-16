import { type Component, CURSOR_MARKER, type OverlayMargin, type SizeValue } from "@earendil-works/pi-tui";
import { type ExtensionCustomComponent, OVERLAY_ACTIVE_ROW_MARKER } from "../../../core/extensions/ui-types.ts";
import { theme } from "../theme/theme.ts";

/**
 * What {@link ReservedBottomOverlay} needs from the component it wraps: the
 * documented `ctx.ui.custom()` contract, plus the internal-UI-action flag the
 * host reads off whichever component holds focus.
 */
export type WrappedOverlayComponent = ExtensionCustomComponent & {
	handlesInternalUiAction?: boolean;
};

/**
 * Transcript rows that must stay visible above a reserving bottom overlay.
 *
 * A bottom-anchored overlay is composited over the transcript rather than
 * measured into the layout, so nothing stops it covering the whole screen. Six
 * rows is the floor at which the transcript is still legible while paging, and
 * it is what makes the reserve arithmetic below total-occlusion-proof:
 * `visibleStrip === terminalRows - overlayHeight`, so bounding the overlay to
 * `terminalRows - MIN_TRANSCRIPT_STRIP_ROWS` guarantees the strip.
 */
export const MIN_TRANSCRIPT_STRIP_ROWS = 6;

interface VerticalOverlayMargin {
	top: number;
	bottom: number;
}

function verticalOverlayMargin(margin: OverlayMargin | number | undefined): VerticalOverlayMargin {
	if (typeof margin === "number") {
		const value = Math.max(0, margin);
		return { top: value, bottom: value };
	}
	return {
		top: Math.max(0, margin?.top ?? 0),
		bottom: Math.max(0, margin?.bottom ?? 0),
	};
}

/** Resolve pi-tui's terminal-relative max-height rule for valid SizeValue input. */
export function resolveOverlayMaxHeight(
	maxHeight: SizeValue | undefined,
	terminalRows: number,
	margin?: OverlayMargin | number,
): number | undefined {
	if (maxHeight === undefined) return undefined;
	let parsed: number | undefined;
	if (typeof maxHeight === "number") {
		parsed = maxHeight;
	} else {
		const match = /^(\d+(?:\.\d+)?)%$/.exec(maxHeight);
		if (match?.[1] !== undefined) parsed = Math.floor((terminalRows * Number.parseFloat(match[1])) / 100);
	}
	if (parsed === undefined) return undefined;
	const normalized = verticalOverlayMargin(margin);
	const availableHeight = Math.max(1, terminalRows - normalized.top - normalized.bottom);
	return Math.trunc(Math.max(1, Math.min(parsed, availableHeight)));
}

/**
 * Rows kept from the bottom of an over-tall overlay. The dialog's closing
 * border and its key hints live there, and they are the interaction
 * affordances; a plain bottom slice would drop exactly those.
 */
const OVERLAY_TAIL_KEEP_ROWS = 3;

function trimTrailingBlankRows(lines: readonly string[]): readonly string[] {
	let end = lines.length;
	while (end > 0 && (lines[end - 1] ?? "").trim() === "") end -= 1;
	return end === lines.length ? lines : lines.slice(0, end);
}

/**
 * Pull {@link OVERLAY_ACTIVE_ROW_MARKER} out of the rendered frame, reporting the
 * row that carried it. Stripping is unconditional so the mark never reaches the
 * terminal, whether or not the frame ends up cropped.
 */
function takeActiveRow(lines: readonly string[]): { rows: string[]; activeRow: number | undefined } {
	let activeRow: number | undefined;
	const rows = lines.map((line, index) => {
		const at = line.indexOf(OVERLAY_ACTIVE_ROW_MARKER);
		if (activeRow === undefined && (at !== -1 || line.includes(CURSOR_MARKER))) activeRow = index;
		if (at === -1) return line;
		return line.slice(0, at) + line.slice(at + OVERLAY_ACTIVE_ROW_MARKER.length);
	});
	return { rows, activeRow };
}

/**
 * Fit `lines` into `budget` rows.
 *
 * Trailing blank rows go first — a bottom-anchored overlay pays for them in
 * occlusion and they carry nothing. The last {@link OVERLAY_TAIL_KEEP_ROWS} rows
 * are always kept, because the closing border and the key hints live there.
 *
 * What survives in between is a single window of the frame, and it is placed so
 * that it still contains the row the component marked as active. Keeping a fixed
 * head instead — which is what this did first — drops the selected option on a
 * short terminal: at 80 columns the marker sits at row `6 + 2 * optionIndex`, so
 * option 4 disappeared below 24 rows and option 1 below 18, and the dialog looked
 * frozen under the arrow keys. The window is the earliest one that still holds
 * the active row, so a frame whose active row is already near the top crops
 * exactly as it did before.
 */
export function boundOverlayLines(lines: readonly string[], budget: number): string[] {
	const { rows, activeRow } = takeActiveRow(lines);
	const trimmed = trimTrailingBlankRows(rows);
	if (budget <= 0) return [];
	if (trimmed.length <= budget) return [...trimmed];
	if (activeRow !== undefined && budget === 1) return [trimmed[activeRow] ?? trimmed[0] ?? ""];
	const tail = Math.min(OVERLAY_TAIL_KEEP_ROWS, Math.max(0, budget - (activeRow === undefined ? 1 : 2)));
	const window = budget - tail - 1;
	if (window <= 0) return [...trimmed.slice(0, budget)];
	const tailStart = trimmed.length - tail;
	const start =
		activeRow !== undefined && activeRow >= window && activeRow < tailStart
			? Math.min(activeRow - window + 1, tailStart - window)
			: 0;
	const kept = trimmed.slice(start, start + window);
	const hidden = trimmed.length - kept.length - tail;
	const notice = theme.fg("muted", `⋮ ${hidden} more rows hidden — answer or cancel to see them`);
	const tailRows = trimmed.slice(tailStart);
	return start === 0 ? [...kept, notice, ...tailRows] : [notice, ...kept, ...tailRows];
}

/**
 * A blocking overlay that leaves room for the transcript.
 *
 * Wraps the component an extension mounted with `reserveTranscriptRows`, bounds
 * its height so it can never cover the whole screen, and records the height it
 * actually painted so {@link TranscriptOverlayReserve} can extend the
 * transcript's scroll extent by exactly the rows this overlay hides.
 */
export class ReservedBottomOverlay implements Component {
	readonly wantsKeyRelease: boolean;
	readonly handlesInternalUiAction: boolean;

	private readonly inner: WrappedOverlayComponent;
	private readonly getTerminalRows: () => number;
	private readonly margin: OverlayMargin | number | undefined;
	private readonly maxHeight: SizeValue | undefined;
	private readonly shouldPassViewportInput: (data: string) => boolean;
	private readonly onHeightChange: () => void;
	private height = 0;

	constructor(
		inner: WrappedOverlayComponent,
		getTerminalRows: () => number,
		margin?: OverlayMargin | number,
		maxHeight?: SizeValue,
		shouldPassViewportInput: (data: string) => boolean = () => false,
		onHeightChange: () => void = () => {},
	) {
		this.inner = inner;
		this.getTerminalRows = getTerminalRows;
		this.margin = margin;
		this.maxHeight = maxHeight;
		this.shouldPassViewportInput = shouldPassViewportInput;
		this.onHeightChange = onHeightChange;
		this.wantsKeyRelease = inner.wantsKeyRelease === true;
		this.handlesInternalUiAction = inner.handlesInternalUiAction === true;
	}

	/** Rows painted by the last `render`. Zero before the first frame. */
	get renderedHeight(): number {
		return this.height;
	}

	render(width: number): string[] {
		const terminalRows = this.getTerminalRows();
		const { top, bottom } = verticalOverlayMargin(this.margin);
		const availableHeight = Math.max(1, Math.floor(terminalRows - top - bottom));
		const transcriptStripBudget = Math.max(1, Math.floor(terminalRows - bottom - MIN_TRANSCRIPT_STRIP_ROWS));
		const resolvedMaxHeight = resolveOverlayMaxHeight(this.maxHeight, terminalRows, this.margin);
		const budget = Math.min(availableHeight, transcriptStripBudget, resolvedMaxHeight ?? Number.POSITIVE_INFINITY);
		const lines = boundOverlayLines(this.inner.render(width), budget);
		const previousHeight = this.height;
		this.height = lines.length;
		if (this.height !== previousHeight) this.onHeightChange();
		return lines;
	}

	handleInput(data: string): boolean | undefined | Promise<boolean | undefined> {
		if (this.shouldPassViewportInput(data)) return false;
		const handler = this.inner.handleInput;
		if (typeof handler !== "function") return undefined;
		return handler.call(this.inner, data);
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	dispose(): void {
		this.inner.dispose?.();
	}
}

export interface TranscriptOverlayIntersection {
	top: number;
	bottom: number;
}

/** Return the terminal-row interval where a bottom overlay covers the transcript. */
export function transcriptOverlayIntersection(
	overlayHeight: number,
	terminalRows: number,
	transcriptViewportHeight: number,
	margin?: OverlayMargin | number,
): TranscriptOverlayIntersection | undefined {
	if (overlayHeight <= 0 || terminalRows <= 0 || transcriptViewportHeight <= 0) return undefined;
	const normalized = verticalOverlayMargin(margin);
	const overlayTop = Math.max(normalized.top, terminalRows - normalized.bottom - overlayHeight);
	const overlayBottom = Math.min(terminalRows, overlayTop + overlayHeight);
	const top = Math.max(0, Math.min(transcriptViewportHeight, overlayTop));
	const bottom = Math.max(0, Math.min(transcriptViewportHeight, overlayBottom));
	return bottom > top ? { top, bottom } : undefined;
}

/**
 * One host-owned blank-row coordinator appended to the transcript document.
 *
 * Each visible bottom overlay supplies its real transcript intersection. The
 * blank tail equals only the connected covered suffix at the transcript bottom:
 * floating overlays need no tail, while overlapping intervals are unioned once.
 */
export class TranscriptOverlayReserve implements Component {
	private readonly getTranscriptViewportHeight: () => number;
	private readonly reservations = new Map<symbol, () => TranscriptOverlayIntersection | undefined>();

	constructor(getTranscriptViewportHeight: () => number) {
		this.getTranscriptViewportHeight = getTranscriptViewportHeight;
	}

	get empty(): boolean {
		return this.reservations.size === 0;
	}

	register(getIntersection: () => TranscriptOverlayIntersection | undefined): () => void {
		const token = Symbol();
		this.reservations.set(token, getIntersection);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.reservations.delete(token);
		};
	}

	handleInput(_data: string): void {}

	invalidate(): void {}

	render(_width: number): string[] {
		const viewportHeight = Math.max(0, Math.trunc(this.getTranscriptViewportHeight()));
		const intersections = [...this.reservations.values()]
			.map((getIntersection) => getIntersection())
			.filter((intersection): intersection is TranscriptOverlayIntersection => intersection !== undefined);
		let coveredFrom = viewportHeight;
		let extended = true;
		while (extended) {
			extended = false;
			for (const intersection of intersections) {
				const top = Math.max(0, Math.min(viewportHeight, intersection.top));
				const bottom = Math.max(0, Math.min(viewportHeight, intersection.bottom));
				if (top < coveredFrom && bottom >= coveredFrom) {
					coveredFrom = top;
					extended = true;
				}
			}
		}
		const rows = Math.max(0, Math.trunc(viewportHeight - coveredFrom));
		return Array<string>(rows).fill("");
	}
}

/**
 * Zero-margin compatibility helper for callers that only need the covered
 * transcript-bottom suffix length.
 */
export function occludedTranscriptRows(
	overlayHeight: number,
	terminalRows: number,
	transcriptViewportHeight: number,
): number {
	const intersection = transcriptOverlayIntersection(overlayHeight, terminalRows, transcriptViewportHeight);
	return intersection?.bottom === transcriptViewportHeight ? transcriptViewportHeight - intersection.top : 0;
}
