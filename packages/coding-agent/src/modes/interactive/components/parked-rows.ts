import { savedRowSpan } from "../../../core/tasks/transcript-origin.js";

/** Rows of a task chat a reader parked above the end sees, which a window replacement keeps (`parkedRows`). */
export interface ParkedTaskRows {
	/** Rows of the retired window, kept ahead of the new window as one saved page. */
	readonly rows: readonly object[];
	readonly first: number;
	readonly last: number;
	/** Rows of entries the new window keeps, by saved row key: the new window shows these rows instead of its own. */
	readonly adopted: ReadonlyMap<string, object>;
}

/** What a compaction leaves of the rows a reader parked above the end sees. */
export interface ParkedRun<T> {
	/** Rows of the retired window, widened to every row of the messages the reader sees, in order. */
	readonly retired: readonly T[];
	/** The saved sequences the retired rows show; `first > last` when there are none. */
	readonly first: number;
	readonly last: number;
	/** Rows the reader sees of entries the new window keeps, in order. */
	readonly adopted: readonly T[];
}

/**
 * Split the painted rows `rows[from..to]` at the new window, which starts at saved sequence `current`. A row is placed
 * by the save receipts of the messages it shows; a row without any is unsaved (`message`) or decoration. Undefined when
 * a retired row the reader sees is unsaved and none is placed: it cannot sit among the saved pages around it.
 */
export function parkedRun<T extends object>(
	rows: readonly T[],
	from: number,
	to: number,
	current: number,
	options: { readonly fixed: (row: T) => boolean; readonly message: (row: T) => boolean },
): ParkedRun<T> | undefined {
	let split = from;
	while (split <= to && !((savedRowSpan(rows[split]!)?.first ?? -1) >= current)) split++;
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	let unplaced = false;
	for (let index = from; index < split; index++) {
		const span = savedRowSpan(rows[index]!);
		if (span) {
			first = Math.min(first, span.first);
			last = Math.max(last, span.last);
		} else if (options.message(rows[index]!)) unplaced = true;
	}
	if (first > last) return unplaced ? undefined : { retired: [], first, last, adopted: rows.slice(from, to + 1) };
	// The whole of each message the reader sees: what is not kept here is read again past either edge.
	let start = from;
	for (let index = from - 1; index >= 0; index--) {
		const row = rows[index]!;
		if (options.fixed(row)) break;
		const span = savedRowSpan(row);
		if (span === undefined) {
			if (options.message(row)) break;
			continue;
		}
		if (span.last < first) break;
		first = Math.min(first, span.first);
		start = index;
	}
	let end = split;
	if (split > to) {
		for (let index = split; index < rows.length; index++) {
			const row = rows[index]!;
			if (options.fixed(row)) break;
			const span = savedRowSpan(row);
			if (span === undefined) {
				if (options.message(row)) break;
				continue;
			}
			if (span.first > last || span.first >= current) break;
			last = Math.max(last, span.last);
			end = index + 1;
		}
	}
	return { retired: rows.slice(start, end), first, last, adopted: rows.slice(split, to + 1) };
}
