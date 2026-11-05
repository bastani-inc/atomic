import { open as fsOpen } from "fs/promises";
import { TextDecoder } from "util";
import { FileToolAbortedError } from "./file-tool-errors.ts";
import { mergeReadRanges, type ReadLineRange } from "./read-selectors.ts";

/** The lines a plain-text read selects: line ranges from a selector such as `:5-16,40`, or every line from one on. */
export type ReadLinePlan =
	| {
			readonly ranges: readonly ReadLineRange[];
			/** `:raw` selects the ranges exactly; formatted reads widen each bounded range. */
			readonly exact: boolean;
	  }
	| { readonly firstLine: number };

/**
 * The selected lines of a text read and the counts the read reports. Line counts follow `text.split("\n")` with
 * the same line-ending rules the read applies.
 */
export interface SelectedReadLines {
	/** Lines in the file. */
	readonly totalLines: number;
	/** Selected lines. */
	readonly count: number;
	/** Selected lines up to and including the last one that is not empty. */
	readonly countBeforeTrailingEmpty: number;
	/** Length of the selected lines joined with `\n`. */
	readonly chars: number;
	/** Number of the first selected line, or 1 when nothing is selected. */
	readonly firstLineNumber: number;
	/** UTF-8 bytes of the first selected line. */
	readonly firstLineBytes: number;
	/** The selected lines and their numbers: all of them when `chars` is at most the limit, otherwise a prefix. */
	readonly lines: readonly string[];
	readonly lineNumbers: readonly number[];
}

export interface ReadLineStreamOptions {
	/** Keep CRLF line endings and the empty line after a final newline, as `:raw` reads do. */
	readonly raw: boolean;
	/** Selections longer than this are only counted; their lines are not all kept. */
	readonly maxChars: number;
	readonly signal?: AbortSignal;
}

interface SelectionTotals {
	count: number;
	chars: number;
	countBeforeTrailingEmpty: number;
	firstLineNumber: number;
	firstLineBytes: number;
}

const CARRIAGE_RETURN = 0x0d;

function emptyTotals(): SelectionTotals {
	return { count: 0, chars: 0, countBeforeTrailingEmpty: 0, firstLineNumber: 1, firstLineBytes: 0 };
}

function planRanges(plan: ReadLinePlan, totalLines: number): Required<ReadLineRange>[] {
	return "ranges" in plan
		? mergeReadRanges(plan.ranges, totalLines, !plan.exact)
		: [{ start: plan.firstLine, end: totalLines }];
}

/**
 * Collects the selected lines of a text one piece at a time, before the number of lines is known. Lines past the
 * character limit are counted, never kept, so memory does not grow with the text.
 */
class LineSelection {
	private readonly plan: ReadLinePlan;
	private readonly maxChars: number;
	private readonly ranges: readonly Required<ReadLineRange>[];
	private readonly lines: string[] = [];
	private readonly lineNumbers: number[] = [];
	private readonly totals = emptyTotals();
	private readonly totalsBeforeLastSelected = emptyTotals();
	private storedBeforeLastSelected = 0;
	private lastSelectedLine = 0;
	private rangeIndex = 0;
	private lineNumber = 0;
	private selected!: boolean;
	private lineChars!: number;
	private lineBytes!: number;
	private storageLeft!: number;
	private pieces: string[] | undefined;

	constructor(plan: ReadLinePlan, maxChars: number) {
		this.plan = plan;
		this.maxChars = maxChars;
		this.ranges = planRanges(plan, Number.POSITIVE_INFINITY);
		this.startLine();
	}

	private startLine(): void {
		this.lineNumber++;
		while (this.rangeIndex < this.ranges.length && this.ranges[this.rangeIndex].end < this.lineNumber) {
			this.rangeIndex++;
		}
		const range = this.ranges[this.rangeIndex];
		this.selected = range !== undefined && range.start <= this.lineNumber;
		this.lineChars = 0;
		this.lineBytes = 0;
		this.storageLeft = this.maxChars - this.totals.chars - (this.totals.count > 0 ? 1 : 0);
		this.pieces = this.selected && this.storageLeft >= 0 ? [] : undefined;
	}

	append(text: string, start: number, end: number): void {
		if (!this.selected) return;
		this.lineChars += end - start;
		if (this.lineChars > this.storageLeft) this.pieces = undefined;
		const measuresBytes = this.totals.count === 0;
		if (!this.pieces && !measuresBytes) return;
		const piece = text.slice(start, end);
		this.pieces?.push(piece);
		if (measuresBytes) this.lineBytes += Buffer.byteLength(piece);
	}

	endLine(): void {
		if (this.selected) this.commitLine();
		this.startLine();
	}

	private commitLine(): void {
		Object.assign(this.totalsBeforeLastSelected, this.totals);
		this.storedBeforeLastSelected = this.lines.length;
		const totals = this.totals;
		if (totals.count === 0) {
			totals.firstLineNumber = this.lineNumber;
			totals.firstLineBytes = this.lineBytes;
		}
		totals.chars += (totals.count > 0 ? 1 : 0) + this.lineChars;
		totals.count++;
		if (this.lineChars > 0) totals.countBeforeTrailingEmpty = totals.count;
		if (this.pieces) {
			this.lines.push(this.pieces.join(""));
			this.lineNumbers.push(this.lineNumber);
		}
		this.lastSelectedLine = this.lineNumber;
	}

	finish(): SelectedReadLines {
		const totalLines = this.lineNumber - 1;
		// The last line was selected before the line count was known. A range widened to start one line early keeps
		// that line only when the range's own first line exists.
		if (this.lastSelectedLine === totalLines && planRanges(this.plan, totalLines).at(-1)?.end !== totalLines) {
			Object.assign(this.totals, this.totalsBeforeLastSelected);
			this.lines.length = this.storedBeforeLastSelected;
			this.lineNumbers.length = this.storedBeforeLastSelected;
		}
		return { totalLines, ...this.totals, lines: this.lines, lineNumbers: this.lineNumbers };
	}
}

/** Select lines from text already split into lines, such as a conflict view or a notebook's cells. */
export function selectReadLinesFromList(
	lines: readonly string[],
	plan: ReadLinePlan,
	maxChars: number,
): SelectedReadLines {
	const selection = new LineSelection(plan, maxChars);
	for (const line of lines) {
		selection.append(line, 0, line.length);
		selection.endLine();
	}
	return selection.finish();
}

/**
 * Select lines from a file read in chunks. The chunks are decoded like `Buffer.toString("utf-8")`, including invalid
 * bytes and a byte order mark. Formatted reads drop the CR of each CRLF and the empty line after a final newline.
 * Stops reading when the signal aborts.
 */
export async function selectReadLinesFromChunks(
	chunks: AsyncIterable<Uint8Array>,
	plan: ReadLinePlan,
	{ raw, maxChars, signal }: ReadLineStreamOptions,
): Promise<SelectedReadLines> {
	const selection = new LineSelection(plan, maxChars);
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	let afterLineBreak = false;
	// A CR at the end of a decoded piece: dropped if the next piece starts with LF, otherwise text.
	let carriageReturnHeld = false;
	const appendText = (text: string, start: number, end: number): void => {
		afterLineBreak = false;
		selection.append(text, start, end);
	};
	const split = (text: string): void => {
		let position = 0;
		for (;;) {
			const newline = text.indexOf("\n", position);
			let end = newline === -1 ? text.length : newline;
			if (carriageReturnHeld && (end > position || newline !== -1)) {
				carriageReturnHeld = false;
				if (end > position) appendText("\r", 0, 1);
			}
			if (!raw && text.charCodeAt(end - 1) === CARRIAGE_RETURN) {
				end--;
				carriageReturnHeld = newline === -1;
			}
			if (end > position) appendText(text, position, end);
			if (newline === -1) return;
			selection.endLine();
			afterLineBreak = true;
			position = newline + 1;
		}
	};
	for await (const chunk of chunks) {
		// Leaving the loop closes the stream.
		if (signal?.aborted) throw new FileToolAbortedError(signal.reason);
		split(decoder.decode(chunk, { stream: true }));
	}
	split(decoder.decode());
	if (carriageReturnHeld) appendText("\r", 0, 1);
	if (raw || !afterLineBreak) selection.endLine();
	return selection.finish();
}

function keepCleanupFailure(primary: unknown, cleanupCause: unknown): void {
	if (primary instanceof Error)
		Object.defineProperty(primary, "cleanupCause", { value: cleanupCause, configurable: true });
}

/**
 * Stream a local file the way `fs.readFile` reads it: a regular file up to its size when opened, so text appended
 * during the read is not counted and a growing file still ends; a file that reports size 0 (such as /proc files)
 * and other file types until EOF. If closing the file fails after another failure, the first failure is thrown
 * with the close failure as its `cleanupCause`.
 */
export async function* readLocalFileChunks(
	path: string,
	{ signal }: { signal?: AbortSignal },
	open: typeof fsOpen = fsOpen,
): AsyncGenerator<Uint8Array> {
	const handle = await open(path, "r");
	let closed = false;
	try {
		const stats = await handle.stat();
		// Node's file stream reports an already aborted signal as an uncaught error, so stop before creating it.
		if (signal?.aborted) throw new FileToolAbortedError(signal.reason);
		const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
		yield* handle.createReadStream({ end, signal, autoClose: false });
	} catch (error) {
		closed = true;
		await handle.close().catch((closeError: unknown) => keepCleanupFailure(error, closeError));
		throw error;
	} finally {
		if (!closed) await handle.close();
	}
}
