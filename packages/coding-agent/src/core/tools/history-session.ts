import { setImmediate } from "node:timers";
import type { SessionEntry } from "../session-manager-types.ts";
import type { SessionEntriesPage, SessionSearchCoverage, SessionStore } from "../storage/session/types.js";
import type { LiteralQuery } from "./history-literals.ts";
import { entryLines, timestamp } from "./history-transcript.ts";
import { formatSearchTextLine, type InternalSearchRequest, searchTextLines } from "./resource-selectors.ts";

export interface HistoryBudget {
	readonly bytes: number;
	readonly rows: number;
	readonly timeMs: number;
}

export const DEFAULT_HISTORY_BUDGET: HistoryBudget = { bytes: 40_000, rows: 250_000, timeMs: 3_000 };
export const HISTORY_TEXT_FORMAT = 1;
export const MAX_MATCHES_PER_SESSION = 10;

const SLICE_MS = 4;
const NOTE_RESERVE_BYTES = 600;
const PAGE_SEQS = 256;
const PAGE_CHARS = 64 * 1024;
const CANDIDATE_PAGE = 64;
const EXTRA_COUNT_ROWS = 2_000;
const SKIPPED_TYPES: readonly string[] = ["custom", "worktree_snapshot"];
const PREVIEW_CHARS = 72;

export type BudgetStop = "byte" | "row" | "time";

export function yieldTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export class HistoryCallBudget {
	readonly signal: AbortSignal | undefined;
	private readonly deadline: number;
	private bytesLeft: number;
	private rowsLeft: number;
	private sliceStart = performance.now();

	constructor(budget: HistoryBudget, signal: AbortSignal | undefined) {
		this.signal = signal;
		this.deadline = performance.now() + budget.timeMs;
		this.bytesLeft = Math.max(0, budget.bytes - NOTE_RESERVE_BYTES);
		this.rowsLeft = budget.rows;
		signal?.throwIfAborted();
	}

	async pace(): Promise<void> {
		this.signal?.throwIfAborted();
		if (performance.now() - this.sliceStart < SLICE_MS) return;
		await yieldTurn();
		this.signal?.throwIfAborted();
		this.sliceStart = performance.now();
	}

	spent(): BudgetStop | undefined {
		if (this.rowsLeft <= 0) return "row";
		if (performance.now() >= this.deadline) return "time";
		return undefined;
	}

	rowAllowance(): number {
		return Math.max(1, this.rowsLeft);
	}

	takeRows(rows: number): void {
		this.rowsLeft -= rows;
	}

	fits(bytes: number): boolean {
		return bytes <= this.bytesLeft;
	}

	spend(bytes: number): void {
		this.bytesLeft -= bytes;
	}

	exhaustBytes(): void {
		this.bytesLeft = 0;
	}
}

export function stopText(stop: BudgetStop): string {
	return `the ${stop} budget ran out`;
}

export function lineBytes(line: string): number {
	return Buffer.byteLength(line, "utf8") + 1;
}

interface EntryPager {
	page(fromSeq: number, toSeq: number, signal: AbortSignal | undefined): Promise<SessionEntriesPage>;
}

export function entryPager(store: SessionStore, sessionId: string): EntryPager {
	if (store.readEntryRange !== undefined)
		return {
			page: (fromSeq, toSeq, signal) =>
				store.readEntryRange!(sessionId, {
					fromSeq,
					toSeq,
					maxChars: PAGE_CHARS,
					skipTypes: SKIPPED_TYPES,
					...(signal === undefined ? {} : { signal }),
				}),
		};
	let loaded: Promise<readonly SessionEntry[]> | undefined;
	return {
		page: async (fromSeq, toSeq) => {
			loaded ??= store.load(sessionId).then((snapshot) => snapshot.entries);
			const entries = await loaded;
			const from = Math.max(1, fromSeq);
			const through = Math.min(toSeq, entries.length);
			return {
				lastSeq: entries.length,
				entries: entries
					.slice(from - 1, Math.max(from - 1, through))
					.map((entry, index) => ({ seq: from + index, entry })),
				throughSeq: Math.max(through, from - 1),
			};
		},
	};
}

export function renderedLines(entry: SessionEntry): string[] {
	return entryLines(entry).flatMap((line) => line.split("\n"));
}

export function oneLine(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export interface SeqRange {
	readonly start: number;
	readonly end: number;
}

export interface SeqCursor {
	readonly seq: number;
	readonly line: number;
}

export interface SessionPlace {
	readonly store: SessionStore;
	readonly sessionId: string;
	urlWith(query: { readonly cursor?: string }, ranges?: readonly SeqRange[]): string;
}

export function rangeText(ranges: readonly SeqRange[]): string {
	return ranges.map((range) => `${range.start}-${range.end}`).join(",");
}

export function mergeSeqRanges(ranges: readonly SeqRange[]): SeqRange[] {
	const merged: { start: number; end: number }[] = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const previous = merged.at(-1);
		if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

export async function readSessionRanges(
	place: SessionPlace,
	requested: readonly SeqRange[],
	raw: boolean,
	cursor: SeqCursor | undefined,
	budget: HistoryCallBudget,
): Promise<string> {
	const pager = entryPager(place.store, place.sessionId);
	const out: string[] = [];
	let lastSeq = Number.POSITIVE_INFINITY;
	let emitted = false;
	let progressed = false;
	const ranges = mergeSeqRanges(requested)
		.map((range) => ({ start: Math.max(range.start, cursor?.seq ?? 1), end: range.end }))
		.filter((range) => range.start <= range.end);
	const stopAt = (seq: number, line: number, index: number, end: number, reason: BudgetStop): string => {
		const rest = [{ start: seq, end }, ...ranges.slice(index + 1)].map((range) => ({
			start: range.start,
			end: Math.min(range.end, lastSeq),
		}));
		const url = place.urlWith(line > 0 ? { cursor: `${seq}.${line}` } : {}, rest);
		out.push(`[read up to entry ${seq} of ${lastSeq}; ${stopText(reason)}; continue with ${url}]`);
		return out.join("\n");
	};
	for (const [index, range] of ranges.entries()) {
		let pos = range.start;
		let headed = false;
		while (pos <= Math.min(range.end, lastSeq)) {
			const reason = budget.spent();
			if (reason && progressed) return stopAt(pos, 0, index, range.end, reason);
			const page = await pager.page(
				pos,
				Math.min(range.end, pos + Math.min(PAGE_SEQS, budget.rowAllowance()) - 1),
				budget.signal,
			);
			progressed = true;
			lastSeq = page.lastSeq;
			if (pos > lastSeq) break;
			if (!raw && !headed) {
				const header = `# session ${place.sessionId} entries ${range.start}-${Math.min(range.end, lastSeq)} of ${lastSeq}`;
				out.push(header);
				budget.spend(lineBytes(header));
				headed = true;
			}
			for (const { seq, entry } of page.entries) {
				const lines = renderedLines(entry);
				const skip = cursor !== undefined && seq === cursor.seq ? cursor.line : 0;
				for (let line = skip; line < lines.length; line++) {
					const size = lineBytes(lines[line]!);
					if (!budget.fits(size) && emitted) return stopAt(seq, line, index, range.end, "byte");
					out.push(lines[line]!);
					budget.spend(size);
					emitted = true;
					if (line % 256 === 255) await budget.pace();
				}
				await budget.pace();
			}
			budget.takeRows(page.throughSeq - pos + 1);
			pos = page.throughSeq + 1;
		}
	}
	if (ranges.length > 0 && ranges[0]!.start > lastSeq)
		return `Requested entry ${ranges[0]!.start} is beyond end of session (${lastSeq} entries total).`;
	return out.join("\n");
}

type OutlineKind = "user" | "compaction" | "branch summary";

interface OutlineItem {
	readonly seq: number;
	readonly at: string;
	readonly kind: OutlineKind;
	readonly preview: string;
}

const COUNT_LABELS = [
	["user", "user turn", "user turns"],
	["assistant", "assistant message", "assistant messages"],
	["toolResult", "tool result", "tool results"],
	["bash", "bash run", "bash runs"],
	["compaction", "compaction", "compactions"],
	["branchSummary", "branch summary", "branch summaries"],
	["sessionSummary", "session summary", "session summaries"],
	["customMessage", "custom message", "custom messages"],
	["other", "other entry", "other entries"],
] as const;
type CountKey = (typeof COUNT_LABELS)[number][0];

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: { type?: string; text?: unknown }) =>
			block.type === "text" && typeof block.text === "string" ? [block.text] : [],
		)
		.join(" ");
}

function classify(entry: SessionEntry): { count: CountKey; item?: Omit<OutlineItem, "seq"> } {
	const at = timestamp(entry.timestamp);
	switch (entry.type) {
		case "message":
			switch (entry.message.role) {
				case "user":
					return {
						count: "user",
						item: { at, kind: "user", preview: oneLine(messageText(entry.message.content), PREVIEW_CHARS) },
					};
				case "assistant":
					return { count: "assistant" };
				case "toolResult":
					return { count: "toolResult" };
				case "bashExecution":
					return { count: "bash" };
				case "custom":
					return { count: "customMessage" };
				case "branchSummary":
					return {
						count: "branchSummary",
						item: { at, kind: "branch summary", preview: oneLine(entry.message.summary, PREVIEW_CHARS) },
					};
				default:
					return { count: "other" };
			}
		case "compaction":
			return {
				count: "compaction",
				item: { at, kind: "compaction", preview: oneLine(entry.summary, PREVIEW_CHARS) },
			};
		case "branch_summary":
			return {
				count: "branchSummary",
				item: { at, kind: "branch summary", preview: oneLine(entry.summary, PREVIEW_CHARS) },
			};
		case "session_summary":
			return { count: "sessionSummary" };
		case "custom_message":
			return { count: "customMessage" };
		default:
			return { count: "other" };
	}
}

export async function outlineSession(
	place: SessionPlace,
	headerLines: readonly string[],
	fromSeq: number,
	budget: HistoryCallBudget,
): Promise<string> {
	const pager = entryPager(place.store, place.sessionId);
	const counts = new Map<CountKey, number>();
	const items: OutlineItem[] = [];
	let lastSeq = Number.POSITIVE_INFINITY;
	let pos = fromSeq;
	let stopped: BudgetStop | undefined;
	while (pos <= lastSeq) {
		const reason = budget.spent();
		if (reason && pos > fromSeq) {
			stopped = reason;
			break;
		}
		const page = await pager.page(pos, pos + Math.min(PAGE_SEQS * 4, budget.rowAllowance()) - 1, budget.signal);
		lastSeq = page.lastSeq;
		if (pos > lastSeq) break;
		for (const { seq, entry } of page.entries) {
			const { count, item } = classify(entry);
			counts.set(count, (counts.get(count) ?? 0) + 1);
			if (item) items.push({ seq, ...item });
		}
		const skipped = page.throughSeq - pos + 1 - page.entries.length;
		counts.set("other", (counts.get("other") ?? 0) + skipped);
		budget.takeRows(page.throughSeq - pos + 1);
		pos = page.throughSeq + 1;
		await budget.pace();
	}
	if (fromSeq > lastSeq) return `Requested entry ${fromSeq} is beyond end of session (${lastSeq} entries total).`;
	const covered = pos - 1;
	const out = [
		...(fromSeq === 1
			? [
					`# session ${place.sessionId}: ${lastSeq} entries, too long to read whole; open a part with its :N-M range`,
					...headerLines.slice(1),
				]
			: [`# session ${place.sessionId} outline from entry ${fromSeq} of ${lastSeq}`]),
		`entries ${fromSeq}-${covered}: ${
			COUNT_LABELS.flatMap(([key, one, many]) => {
				const count = counts.get(key) ?? 0;
				return count === 0 ? [] : [`${count} ${count === 1 ? one : many}`];
			}).join(", ") || "nothing"
		}`,
	];
	budget.spend(out.reduce((sum, line) => sum + lineBytes(line), 0));
	for (const [index, item] of items.entries()) {
		const end = (items[index + 1]?.seq ?? covered + 1) - 1;
		const line = `${place.urlWith({}, [{ start: item.seq, end }])} | ${item.at} | ${item.kind}: ${item.preview}`;
		if (!budget.fits(lineBytes(line))) {
			out.push(
				`[outline lists entries ${fromSeq}-${item.seq - 1} of ${lastSeq}; ${stopText("byte")}; continue with ${place.urlWith({ cursor: String(item.seq) })}]`,
			);
			return out.join("\n");
		}
		out.push(line);
		budget.spend(lineBytes(line));
	}
	if (stopped)
		out.push(
			`[outline covers entries ${fromSeq}-${covered} of ${lastSeq}; ${stopText(stopped)}; continue with ${place.urlWith({ cursor: String(covered + 1) })}]`,
		);
	return out.join("\n");
}

export async function readWholeOrOutline(
	place: SessionPlace,
	headerLines: readonly string[],
	budget: HistoryCallBudget,
	wholeLimitSeqs: number,
): Promise<string> {
	const pager = entryPager(place.store, place.sessionId);
	const lines = [...headerLines];
	let bytes = lines.reduce((sum, line) => sum + lineBytes(line), 0);
	let pos = 1;
	for (let lastSeq = Number.POSITIVE_INFINITY; pos <= lastSeq; ) {
		const page = await pager.page(pos, pos + PAGE_SEQS - 1, budget.signal);
		lastSeq = page.lastSeq;
		if (lastSeq > wholeLimitSeqs) return outlineSession(place, headerLines, 1, budget);
		for (const { entry } of page.entries) {
			for (const line of renderedLines(entry)) {
				bytes += lineBytes(line);
				if (!budget.fits(bytes)) return outlineSession(place, headerLines, 1, budget);
				lines.push(line);
			}
			await budget.pace();
		}
		pos = page.throughSeq + 1;
		if (page.throughSeq >= lastSeq) break;
	}
	budget.spend(bytes);
	return lines.join("\n");
}

export interface SessionSearchResult {
	readonly lines: string[];
	readonly lastSeq: number;
	readonly stopped?: { readonly reason: BudgetStop; readonly resumeSeq: number };
}

interface RenderedEntry {
	readonly seq: number;
	readonly lines: readonly string[];
}

function matchesIn(entries: readonly RenderedEntry[], request: InternalSearchRequest): Map<number, number[]> {
	const found = new Map<number, number[]>();
	if (entries.length === 0) return found;
	const starts: number[] = [];
	const text: string[] = [];
	for (const entry of entries) {
		starts.push(text.length + 1);
		text.push(...entry.lines);
	}
	for (const row of searchTextLines(text.join("\n"), request.pattern, request.ignoreCase, request.literal, 0, 0)) {
		if (!row.match) continue;
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if (starts[middle]! <= row.lineNumber) low = middle;
			else high = middle - 1;
		}
		const entry = entries[low]!;
		const index = row.lineNumber - starts[low]!;
		if (index >= entry.lines.length) continue;
		const lines = found.get(entry.seq) ?? [];
		lines.push(index);
		found.set(entry.seq, lines);
	}
	return found;
}

export interface SessionSearchRequest {
	readonly place: SessionPlace;
	readonly label: string;
	readonly request: InternalSearchRequest;
	readonly prefilter: LiteralQuery | undefined;
	readonly fromSeq: number;
	readonly ranges: readonly SeqRange[] | undefined;
	readonly budget: HistoryCallBudget;
}

export async function searchSession(search: SessionSearchRequest): Promise<SessionSearchResult> {
	const { place, label, request, prefilter, budget } = search;
	const pager = entryPager(place.store, place.sessionId);
	const index = place.store.searchIndex;
	let coverage: { indexedSeq: number; lastSeq: number } | undefined;
	if (index !== undefined)
		coverage = await index
			.coverage(place.sessionId, HISTORY_TEXT_FORMAT)
			.then((found: SessionSearchCoverage | undefined) => (found ? { ...found } : undefined))
			.catch(() => undefined);
	let indexing = coverage !== undefined;
	let lastSeq = coverage?.lastSeq ?? (await pager.page(1, 0, budget.signal)).lastSeq;
	const lines: string[] = [];
	let shown = 0;
	let more = 0;
	let firstMore: number | undefined;
	let countedThrough = 0;
	let sinceCap = 0;
	const capLine = (complete: boolean) =>
		`${label}-0- [+${more} more in this session${complete ? "" : ` in entries ${firstMore}-${countedThrough}, maybe more after`}; search ${place.urlWith({ cursor: String(firstMore) })} for them]`;
	const emit = (seq: number, entryLines: readonly string[], matched: readonly number[]): boolean => {
		const visible = matched.slice(0, Math.max(0, MAX_MATCHES_PER_SESSION - shown));
		const shownLines = new Set(visible);
		const wanted = new Set<number>();
		for (const line of visible)
			for (
				let context = Math.max(0, line - request.contextBefore);
				context <= Math.min(entryLines.length - 1, line + request.contextAfter);
				context++
			)
				wanted.add(context);
		const rows = [...wanted]
			.sort((a, b) => a - b)
			.map((line) => formatSearchTextLine(label, seq, entryLines[line]!, shownLines.has(line)));
		const size = rows.reduce((sum, row) => sum + lineBytes(row), 0);
		if (rows.length > 0 && !budget.fits(size)) return false;
		lines.push(...rows);
		budget.spend(size);
		shown += visible.length;
		if (matched.length > visible.length) {
			more += matched.length - visible.length;
			firstMore ??= seq;
		}
		return true;
	};
	const segments = (search.ranges ?? [{ start: 1, end: Number.MAX_SAFE_INTEGER }])
		.map((range) => ({ start: Math.max(range.start, search.fromSeq), end: range.end }))
		.filter((range) => range.start <= range.end);
	const finish = (stopped?: { reason: BudgetStop; resumeSeq: number }): SessionSearchResult => {
		if (more > 0) lines.push(capLine(stopped === undefined && sinceCap < EXTRA_COUNT_ROWS));
		return { lines, lastSeq, ...(stopped ? { stopped } : {}) };
	};
	let started = false;
	for (const segment of mergeSeqRanges(segments)) {
		let pos = segment.start;
		while (pos <= Math.min(segment.end, lastSeq)) {
			const reason = budget.spent();
			if (reason && started) return finish({ reason, resumeSeq: pos });
			if (firstMore !== undefined && sinceCap >= EXTRA_COUNT_ROWS) return finish();
			started = true;
			if (prefilter !== undefined && coverage !== undefined && pos <= coverage.indexedSeq) {
				const through = Math.min(segment.end, coverage.indexedSeq);
				const seqs = await index!
					.candidates(place.sessionId, prefilter, pos, through, CANDIDATE_PAGE)
					.catch(() => undefined);
				budget.takeRows(1);
				if (seqs === undefined) {
					coverage = undefined;
					indexing = false;
					continue;
				}
				for (const seq of seqs) {
					const spent = budget.spent();
					if (spent) return finish({ reason: spent, resumeSeq: seq });
					const page = await pager.page(seq, seq, budget.signal);
					const entry = page.entries[0];
					budget.takeRows(1);
					countedThrough = seq;
					if (firstMore !== undefined) sinceCap++;
					if (entry !== undefined) {
						const rendered = { seq, lines: renderedLines(entry.entry) };
						const matched = matchesIn([rendered], request).get(seq);
						if (matched && !emit(seq, rendered.lines, matched)) return finish({ reason: "byte", resumeSeq: seq });
					}
					pos = seq + 1;
					await budget.pace();
				}
				if (seqs.length < CANDIDATE_PAGE) pos = through + 1;
				continue;
			}
			const page = await pager.page(
				pos,
				Math.min(segment.end, pos + Math.min(PAGE_SEQS, budget.rowAllowance()) - 1),
				budget.signal,
			);
			lastSeq = page.lastSeq;
			const rendered: RenderedEntry[] = [];
			for (const { seq, entry } of page.entries) {
				rendered.push({ seq, lines: renderedLines(entry) });
				await budget.pace();
			}
			if (indexing && coverage !== undefined && pos === coverage.indexedSeq + 1) {
				const texts = rendered.flatMap((entry) =>
					entry.lines.length === 0 ? [] : [{ seq: entry.seq, text: entry.lines.join("\n") }],
				);
				const extended = await index!
					.extend(place.sessionId, HISTORY_TEXT_FORMAT, coverage.indexedSeq, page.throughSeq, texts)
					.catch(() => false);
				if (extended) coverage.indexedSeq = page.throughSeq;
				else indexing = false;
			}
			const matches = matchesIn(rendered, request);
			for (const entry of rendered) {
				const matched = matches.get(entry.seq);
				if (matched && !emit(entry.seq, entry.lines, matched))
					return finish({ reason: "byte", resumeSeq: entry.seq });
			}
			const span = page.throughSeq - pos + 1;
			budget.takeRows(span);
			countedThrough = page.throughSeq;
			if (firstMore !== undefined) sinceCap += span;
			pos = page.throughSeq + 1;
			await budget.pace();
		}
	}
	return finish();
}
