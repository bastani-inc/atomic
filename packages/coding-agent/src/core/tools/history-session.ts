import { setImmediate } from "node:timers";
import { asyncScope } from "../async-scope.ts";
import type { SessionEntry } from "../session-manager-types.ts";
import {
	MAX_INDEXED_ENTRY_CHARS,
	SEARCH_PART_CHARS,
	SEARCH_PART_OVERLAP,
	splitSearchTextParts,
} from "../storage/session/session-search-index.js";
import type {
	SessionEntriesPage,
	SessionEntryAt,
	SessionSearchIndex,
	SessionSearchText,
	SessionStore,
} from "../storage/session/types.js";
import { isMultilineSearchPattern, type LiteralQuery } from "./history-literals.js";
import {
	type MultilineSpan,
	matchLinesInWorker,
	matchMultilineInWorker,
	renderRawEntryInWorker,
	type WorkerOutlineInfo,
} from "./history-regex-worker.js";
import { entryLines, timestamp } from "./history-transcript.js";
import { formatSearchTextLine, type InternalSearchRequest, normalizeSearchPattern } from "./resource-selectors.ts";
import { loadNativeSearchBinding } from "./search-native.ts";

export interface HistoryBudget {
	readonly bytes: number;
	readonly rows: number;
	readonly timeMs: number;
}

export const DEFAULT_HISTORY_BUDGET: HistoryBudget = { bytes: 40_000, rows: 250_000, timeMs: 3_000 };
/**
 * The time budget of the history calls a background history task makes, in place of the router's own:
 * `Number.POSITIVE_INFINITY`, as such a task has no time limit.
 */
export const historyTaskTimeBudget = asyncScope<number>();
export const HISTORY_TEXT_FORMAT = 2;
export const MAX_MATCHES_PER_SESSION = 10;

const SLICE_MS = 2;
const PROGRESS_FLOOR_MS = 250;
const STORE_WAIT_MIN_MS = 15;
const NOTE_RESERVE_BYTES = 600;
const PAGE_SEQS = 256;
const OUTLINE_PAGE_SEQS = 32;
const LOOKAHEAD_PAGE_SEQS = 32;
const WINDOW_MAX_SEQS = PAGE_SEQS;
const PAGE_CHARS = 64 * 1024;
const LARGE_ENTRY_BYTES = 256 * 1024;
const UTF8_SCAN_SLICE_BYTES = 256 * 1024;
const REGEX_BATCH_CHARS = 64 * 1024;
export const MATCH_SPAN_CHARS = 16 * 1024;
const CONTEXT_SPAN_SEQS = 64;
const ENTRY_CACHE_SEQS = 2 * WINDOW_MAX_SEQS + 2 * CONTEXT_SPAN_SEQS;
const LOOKBEHIND_SYNTAX = /\(\?<[=!]/;
const LOOKAHEAD_SYNTAX = /\(\?[=!]/;
const MULTILINE_MODIFIER_SYNTAX = /\(\?[a-ln-zA-Z]*m[a-zA-Z]*(?:-[a-zA-Z]*)?:/;
const CANDIDATE_PAGE = 64;
const EXTRA_COUNT_SEQS = 500;
const SKIPPED_TYPES: readonly string[] = ["custom", "worktree_snapshot"];
const PREVIEW_CHARS = 72;

export const MULTILINE_WINDOW_NOTE = `multi-line matches are searched up to ${MATCH_SPAN_CHARS / 1024} KB of text or ${WINDOW_MAX_SEQS} entries past where they start, so a longer match is not shown`;
const WINDOW_CUT_LINE = "\u0001";

const utf8Decoder = new TextDecoder();

export type BudgetStop = "byte" | "row" | "time";

export class HistoryDeadlineError extends Error {
	constructor() {
		super("History call time budget exceeded");
		this.name = "HistoryDeadlineError";
	}
}

export function isHistoryDeadlineError<T>(error: T): boolean {
	return error instanceof HistoryDeadlineError;
}

export function yieldTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** A signal that aborts after `ms`, or never for an unlimited (infinite) time budget. */
function timeoutSignal(ms: number): AbortSignal {
	return Number.isFinite(ms) ? AbortSignal.timeout(ms) : new AbortController().signal;
}

export class HistoryCallBudget {
	readonly signal: AbortSignal | undefined;
	private reservedBytes: number;
	private readonly callSignal: AbortSignal;
	private readonly timeMs: number;
	private readonly deadline: number;
	private floor: { readonly until: number; readonly signal: AbortSignal } | undefined;
	private bytesLeft: number;
	private rowsLeft: number;
	private sliceStart = performance.now();

	constructor(budget: HistoryBudget, signal: AbortSignal | undefined, noteBytes = NOTE_RESERVE_BYTES) {
		this.signal = signal;
		this.timeMs = Math.max(STORE_WAIT_MIN_MS, budget.timeMs);
		this.deadline = performance.now() + budget.timeMs;
		this.callSignal = this.withCaller(timeoutSignal(this.timeMs));
		const reserve = Math.max(
			Math.min(NOTE_RESERVE_BYTES, Math.floor(budget.bytes * 0.25)) + Math.max(0, noteBytes - NOTE_RESERVE_BYTES),
			budget.bytes < NOTE_RESERVE_BYTES ? Math.min(noteBytes, Math.floor(budget.bytes / 2)) : 0,
		);
		this.bytesLeft = Math.max(1, budget.bytes - reserve);
		this.reservedBytes = budget.bytes - this.bytesLeft;
		this.rowsLeft = budget.rows;
		signal?.throwIfAborted();
	}

	get storeSignal(): AbortSignal {
		return this.floor?.signal ?? this.callSignal;
	}

	holdProgressFloor(): void {
		const floorMs = Math.max(PROGRESS_FLOOR_MS, this.timeMs);
		const until = performance.now() + floorMs;
		this.floor = { until, signal: this.withCaller(timeoutSignal(floorMs)) };
	}

	markProgress(): void {
		this.floor = undefined;
	}

	private withCaller(timeout: AbortSignal): AbortSignal {
		return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
	}

	private effectiveDeadline(): number {
		return this.floor === undefined ? this.deadline : Math.max(this.deadline, this.floor.until);
	}

	async pace(): Promise<void> {
		this.signal?.throwIfAborted();
		if (performance.now() - this.sliceStart < SLICE_MS) return;
		await yieldTurn();
		this.signal?.throwIfAborted();
		this.sliceStart = performance.now();
	}

	race<T>(work: Promise<T>): Promise<T> {
		work.catch(() => {});
		if (this.signal?.aborted) {
			return Promise.reject(this.signal.reason ?? new Error("Operation aborted"));
		}
		if (this.storeSignal.aborted) {
			return Promise.reject(new HistoryDeadlineError());
		}
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				if (this.signal?.aborted) {
					reject(this.signal.reason ?? new Error("Operation aborted"));
				} else {
					reject(new HistoryDeadlineError());
				}
			};
			this.storeSignal.addEventListener("abort", onAbort, { once: true });
			work.then(
				(value) => {
					this.storeSignal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error) => {
					this.storeSignal.removeEventListener("abort", onAbort);
					if (!this.signal?.aborted && this.storeSignal.aborted) {
						reject(new HistoryDeadlineError());
					} else {
						reject(error);
					}
				},
			);
		});
	}

	remainingMs(): number {
		return Math.max(0, this.effectiveDeadline() - performance.now());
	}

	spent(): BudgetStop | undefined {
		if (this.rowsLeft <= 0) return "row";
		if (performance.now() >= this.deadline || (!this.signal?.aborted && this.storeSignal.aborted)) return "time";
		return undefined;
	}

	rowAllowance(defaultMax = PAGE_SEQS): number {
		if (this.spent() !== undefined) return 1;
		return Math.max(1, Math.min(defaultMax, this.rowsLeft));
	}

	takeRows(rows: number): void {
		this.rowsLeft -= rows;
	}

	releaseReserve(): void {
		this.bytesLeft += this.reservedBytes;
		this.reservedBytes = 0;
	}

	bytesAvailable(): number {
		return this.bytesLeft;
	}

	fits(bytes: number): boolean {
		return bytes <= this.bytesLeft;
	}

	spend(bytes: number): void {
		this.bytesLeft -= bytes;
	}
}

export function stopText(stop: BudgetStop): string {
	return `the ${stop} budget ran out`;
}

export function lineBytes(line: string): number {
	return Buffer.byteLength(line, "utf8") + 1;
}

function isSplitSurrogatePair(text: string, end: number): boolean {
	if (end <= 0 || end >= text.length) return false;
	const high = text.charCodeAt(end - 1);
	const low = text.charCodeAt(end);
	return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

export function cutTextToUtf8Bytes(text: string, maxBytes: number): string {
	if (text.length === 0 || maxBytes <= 0) return "";
	let low = 0;
	let high = Math.min(text.length, maxBytes);
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
		else high = mid - 1;
	}
	let end = low;
	if (isSplitSurrogatePair(text, end)) end--;
	return text.slice(0, end);
}

interface EntryPager {
	page(fromSeq: number, toSeq: number, budget: HistoryCallBudget, maxChars?: number): Promise<SessionEntriesPage>;
}

export function entryPager(store: SessionStore, sessionId: string): EntryPager {
	if (store.readEntryRange === undefined) {
		throw new Error(
			`history:// cannot read session ${sessionId}: its session store (${store.descriptor.adapter}) does not implement SessionStore.readEntryRange`,
		);
	}
	return {
		page: (fromSeq, toSeq, budget, maxChars = PAGE_CHARS) =>
			budget.race(
				store.readEntryRange!(sessionId, {
					fromSeq,
					toSeq,
					maxChars,
					largeEntryBytes: LARGE_ENTRY_BYTES,
					skipTypes: SKIPPED_TYPES,
					signal: budget.storeSignal,
				}),
			),
	};
}

export function renderedLines(entry: SessionEntry): string[] {
	return entryLines(entry).flatMap((line) => line.split("\n"));
}

function sliceCodePoints(text: string, limit: number): string {
	if (limit <= 0 || text.length === 0) return "";
	if (text.length <= limit) return text;
	let end = limit;
	if (isSplitSurrogatePair(text, end)) end--;
	return text.slice(0, end);
}

export function oneLine(text: string, limit: number): string {
	const source = String(text ?? "");
	let flat = "";
	let pendingSpace = false;
	for (let i = 0; i < source.length && flat.length <= limit; i++) {
		const ch = source[i]!;
		if (/\s/.test(ch)) {
			if (flat.length > 0) pendingSpace = true;
			continue;
		}
		if (pendingSpace) {
			flat += " ";
			pendingSpace = false;
			if (flat.length > limit) break;
		}
		flat += ch;
	}
	return flat.length > limit ? `${sliceCodePoints(flat, limit)}…` : flat;
}

export interface RenderedEntry {
	readonly seq: number;
	readonly lineCount: number;
	readonly oversized: boolean;
	lineAt(index: number): string;
	sliceLines(startLine: number, endLine: number): string[];
	searchParts(budget: HistoryCallBudget): Promise<string[]>;
}

function smallRenderedEntry(seq: number, lines: readonly string[]): RenderedEntry {
	const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0);
	return {
		seq,
		lineCount: lines.length,
		oversized: totalChars > MAX_INDEXED_ENTRY_CHARS,
		lineAt: (index) => lines[index] ?? "",
		sliceLines: (startLine, endLine) => lines.slice(startLine, endLine + 1),
		searchParts: async () => (lines.length === 0 ? [] : splitSearchTextParts(lines.join("\n"))),
	};
}

function utf8BoundaryBackward(bytes: Uint8Array, pos: number): number {
	let at = Math.min(pos, bytes.byteLength);
	while (at > 0 && at > pos - 4 && (bytes[at]! & 0xc0) === 0x80) at--;
	return at;
}

async function largeRenderedEntry(seq: number, utf8: Uint8Array, budget: HistoryCallBudget): Promise<RenderedEntry> {
	if (utf8.byteLength === 0) return smallRenderedEntry(seq, []);
	const starts: number[] = [0];
	for (let offset = 0; offset < utf8.byteLength; offset += UTF8_SCAN_SLICE_BYTES) {
		const end = Math.min(utf8.byteLength, offset + UTF8_SCAN_SLICE_BYTES);
		const sub = utf8.subarray(0, end);
		for (let nl = sub.indexOf(10, offset); nl !== -1; nl = sub.indexOf(10, nl + 1)) {
			starts.push(nl + 1);
		}
		await budget.pace();
	}
	const lineStarts = Uint32Array.from(starts);
	const lineEndByte = (index: number): number =>
		index + 1 < lineStarts.length ? lineStarts[index + 1]! - 1 : utf8.byteLength;
	const lineAt = (index: number): string => {
		if (index < 0 || index >= lineStarts.length) return "";
		return utf8Decoder.decode(utf8.subarray(lineStarts[index]!, lineEndByte(index)));
	};
	return {
		seq,
		lineCount: lineStarts.length,
		oversized: utf8.byteLength > MAX_INDEXED_ENTRY_CHARS,
		lineAt,
		sliceLines(startLine, endLine) {
			const clampedStart = Math.max(0, startLine);
			const clampedEnd = Math.min(lineStarts.length - 1, endLine);
			if (clampedStart > clampedEnd) return [];
			const out: string[] = [];
			for (let i = clampedStart; i <= clampedEnd; i++) out.push(lineAt(i));
			return out;
		},
		async searchParts(callBudget) {
			const stepBytes = SEARCH_PART_CHARS * 3;
			const overlapBytes = SEARCH_PART_OVERLAP * 3;
			const parts: string[] = [];
			for (let start = 0; start < utf8.byteLength; ) {
				const rawEnd = Math.min(utf8.byteLength, start + stepBytes + overlapBytes);
				const end = rawEnd < utf8.byteLength ? utf8BoundaryBackward(utf8, rawEnd) : rawEnd;
				parts.push(...splitSearchTextParts(utf8Decoder.decode(utf8.subarray(start, end))));
				if (end >= utf8.byteLength) break;
				const nextStart = utf8BoundaryBackward(utf8, start + stepBytes);
				start = nextStart > start ? nextStart : end;
				await callBudget.pace();
			}
			return parts;
		},
	};
}

async function materializeEntry(
	item: SessionEntryAt,
	budget: HistoryCallBudget,
): Promise<{ readonly entry: RenderedEntry } | { readonly timedOut: true }> {
	if (item.rawChunks === undefined) {
		const lines = renderedLines(item.entry);
		await budget.pace();
		return { entry: smallRenderedEntry(item.seq, lines) };
	}
	const workerResult = await renderRawEntryInWorker(
		item.rawChunks,
		PREVIEW_CHARS,
		budget.remainingMs(),
		budget.signal,
		item.rawFormatVersion,
	);
	if ("timedOut" in workerResult) return workerResult;
	return { entry: await largeRenderedEntry(item.seq, workerResult.renderedUtf8, budget) };
}

export interface SeqRange {
	readonly start: number;
	readonly end: number;
}

export interface SeqCursor {
	readonly seq: number;
	readonly line: number;
	readonly char: number;
}

export interface SessionPlace {
	readonly store: SessionStore;
	readonly sessionId: string;
	urlWith(query: { readonly cursor?: string }, ranges?: readonly SeqRange[]): string;
}

export function rangeText(ranges: readonly SeqRange[]): string {
	return ranges.map((range) => `${range.start}-${range.end}`).join(",");
}

export function formatReadCursor(seq: number, line: number, char: number): string | undefined {
	if (char > 0) return `${seq}.${line}.${char}`;
	if (line > 0) return `${seq}.${line}`;
	return undefined;
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

interface EntryStop {
	readonly seq: number;
	readonly line: number;
	readonly char: number;
	readonly reason: BudgetStop;
}

class RangeReader {
	private readonly place: SessionPlace;
	private readonly raw: boolean;
	private readonly cursor: SeqCursor | undefined;
	private readonly budget: HistoryCallBudget;
	private readonly pager: EntryPager;
	private readonly ranges: SeqRange[];
	private readonly out: string[] = [];
	private lastSeq = Number.POSITIVE_INFINITY;
	private emitted = false;
	private progressed = false;

	constructor(
		place: SessionPlace,
		requested: readonly SeqRange[],
		raw: boolean,
		cursor: SeqCursor | undefined,
		budget: HistoryCallBudget,
	) {
		this.place = place;
		this.raw = raw;
		this.cursor = cursor;
		this.budget = budget;
		this.pager = entryPager(place.store, place.sessionId);
		this.ranges = mergeSeqRanges(requested)
			.map((range) => ({ start: Math.max(range.start, cursor?.seq ?? 1), end: range.end }))
			.filter((range) => range.start <= range.end);
	}

	async run(): Promise<string> {
		this.budget.holdProgressFloor();
		for (const [index, range] of this.ranges.entries()) {
			const stopped = await this.readRange(index, range);
			if (stopped !== undefined) return stopped;
		}
		const first = this.ranges[0];
		if (first !== undefined && first.start > this.lastSeq)
			return `Requested entry ${first.start} is beyond end of session (${this.lastSeq} entries total).`;
		return this.out.join("\n");
	}

	private async readRange(index: number, range: SeqRange): Promise<string | undefined> {
		let headed = false;
		for (let pos = range.start; pos <= Math.min(range.end, this.lastSeq); ) {
			const reason = this.budget.spent();
			if (reason && this.progressed) return this.stopAt({ ...this.resumeAt(pos), reason }, index, range.end);
			let page: SessionEntriesPage;
			try {
				page = await this.pager.page(
					pos,
					Math.min(range.end, pos + this.budget.rowAllowance(PAGE_SEQS) - 1),
					this.budget,
				);
			} catch (error) {
				if (isHistoryDeadlineError(error)) {
					return this.stopAt({ ...this.resumeAt(pos), reason: "time" }, index, range.end);
				}
				throw error;
			}
			this.progressed = true;
			this.budget.markProgress();
			this.lastSeq = page.lastSeq;
			if (pos > this.lastSeq) return undefined;
			if (!this.raw && !headed) {
				const end = Math.min(range.end, this.lastSeq);
				const selected = end < Number.MAX_SAFE_INTEGER ? `${range.start}-${end}` : `${range.start} onward`;
				const total = Number.isFinite(this.lastSeq) ? ` of ${this.lastSeq}` : "";
				this.write(`# session ${this.place.sessionId} entries ${selected}${total}`);
				headed = true;
			}
			for (const item of page.entries) {
				const stopped = await this.writeEntry(item);
				if (stopped !== undefined) {
					if (stopped.seq > Math.min(range.end, this.lastSeq) && index + 1 >= this.ranges.length) return undefined;
					return this.stopAt(stopped, index, range.end);
				}
			}
			this.budget.takeRows(page.throughSeq - pos + 1);
			pos = page.throughSeq + 1;
		}
		return undefined;
	}

	private async writeEntry(item: SessionEntryAt): Promise<EntryStop | undefined> {
		const { seq } = item;
		const startLine = this.cursor !== undefined && seq === this.cursor.seq ? this.cursor.line : 0;
		const startChar = this.cursor !== undefined && seq === this.cursor.seq ? this.cursor.char : 0;
		const materialized = await materializeEntry(item, this.budget);
		if ("timedOut" in materialized) return { seq, line: startLine, char: startChar, reason: "time" };
		const rendered = materialized.entry;
		for (let line = startLine; line < rendered.lineCount; line++) {
			const charOffset = line === startLine ? startChar : 0;
			const full = rendered.lineAt(line);
			const text = charOffset > 0 ? full.slice(charOffset) : full;
			const size = lineBytes(text);
			if (!this.budget.fits(size)) {
				if (this.emitted) return { seq, line, char: charOffset, reason: "byte" };
				const piece = cutTextToUtf8Bytes(text, this.budget.bytesAvailable() - 1);
				if (piece.length === 0) return { seq, line, char: charOffset, reason: "byte" };
				this.write(piece);
				this.emitted = true;
				const nextChar = charOffset + piece.length;
				if (nextChar < full.length) return { seq, line, char: nextChar, reason: "byte" };
				if (line + 1 < rendered.lineCount) return { seq, line: line + 1, char: 0, reason: "byte" };
				return { seq: seq + 1, line: 0, char: 0, reason: "byte" };
			}
			this.write(text);
			this.emitted = true;
			if (line % 256 === 255) await this.budget.pace();
		}
		await this.budget.pace();
		return undefined;
	}

	private resumeAt(seq: number): SeqCursor {
		if (this.cursor !== undefined && seq === this.cursor.seq)
			return { seq, line: this.cursor.line, char: this.cursor.char };
		return { seq, line: 0, char: 0 };
	}

	private write(line: string): void {
		this.out.push(line);
		this.budget.spend(lineBytes(line));
	}

	private stopAt(stop: EntryStop, index: number, end: number): string {
		const rest = [{ start: stop.seq, end }, ...this.ranges.slice(index + 1)]
			.map((range) => ({
				start: range.start,
				end: Math.min(range.end, this.lastSeq),
			}))
			.filter((range) => range.start <= range.end);
		const cursor = formatReadCursor(stop.seq, stop.line, stop.char);
		const url = `${this.place.urlWith(cursor === undefined ? {} : { cursor }, rest)}${this.raw ? ":raw" : ""}`;
		const totalText = Number.isFinite(this.lastSeq) ? ` of ${this.lastSeq}` : "";
		const coveredSeq = Number.isFinite(this.lastSeq) ? Math.min(stop.seq, this.lastSeq) : stop.seq;
		this.out.push(`[read up to entry ${coveredSeq}${totalText}; ${stopText(stop.reason)}; continue with ${url}]`);
		return this.out.join("\n");
	}
}

export function readSessionRanges(
	place: SessionPlace,
	requested: readonly SeqRange[],
	raw: boolean,
	cursor: SeqCursor | undefined,
	budget: HistoryCallBudget,
): Promise<string> {
	return new RangeReader(place, requested, raw, cursor, budget).run();
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

function messageText(content: string | readonly { readonly type?: string; readonly text?: string }[]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
		.join(" ");
}

function classify(entry: SessionEntry): WorkerOutlineInfo {
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

async function classifyEntryAt(
	item: SessionEntryAt,
	budget: HistoryCallBudget,
): Promise<WorkerOutlineInfo | { readonly timedOut: true }> {
	if (item.rawChunks === undefined) return classify(item.entry);
	const res = await renderRawEntryInWorker(
		item.rawChunks,
		PREVIEW_CHARS,
		budget.remainingMs(),
		budget.signal,
		item.rawFormatVersion,
	);
	if ("timedOut" in res) return res;
	return res.outline;
}

function formatCountsLine(fromSeq: number, covered: number, counts: ReadonlyMap<CountKey, number>): string {
	return `entries ${fromSeq}-${covered}: ${
		COUNT_LABELS.flatMap(([key, one, many]) => {
			const count = counts.get(key) ?? 0;
			return count === 0 ? [] : [`${count} ${count === 1 ? one : many}`];
		}).join(", ") || "nothing"
	}`;
}

function formatOutlineCursor(resumeSeq: number, pendingSeq?: number): string {
	if (pendingSeq !== undefined && pendingSeq > 0 && pendingSeq < resumeSeq) {
		return `${resumeSeq}.0.0.${pendingSeq}`;
	}
	return String(resumeSeq);
}

export async function outlineSession(
	place: SessionPlace,
	headerLines: readonly string[],
	fromSeq: number,
	budget: HistoryCallBudget,
	pendingSeq?: number,
): Promise<string> {
	const pager = entryPager(place.store, place.sessionId);
	const counts = new Map<CountKey, number>();
	let countsBeforePending = new Map<CountKey, number>();
	let pending: OutlineItem | undefined;
	const itemLines: string[] = [];
	let itemBytes = 0;
	let lastSeq = Number.POSITIVE_INFINITY;
	let pos = fromSeq;
	let stopped:
		| {
				reason: BudgetStop;
				coveredSeq: number;
				resumeSeq: number;
				resumePendingSeq?: number;
				usedCounts: ReadonlyMap<CountKey, number>;
		  }
		| undefined;
	const headingReserve = 300;
	const formatItem = (item: OutlineItem, endSeq: number): string =>
		`${place.urlWith({}, [{ start: item.seq, end: endSeq }])} | ${item.at} | ${item.kind}: ${item.preview}`;
	const stopAt = (reason: BudgetStop, stopSeq: number): void => {
		if (pending !== undefined && pending.seq > fromSeq) {
			stopped = {
				reason,
				coveredSeq: pending.seq - 1,
				resumeSeq: pending.seq,
				usedCounts: countsBeforePending,
			};
			pending = undefined;
			return;
		}
		const resumePendingSeq = pending !== undefined ? pending.seq : undefined;
		pending = undefined;
		stopped = {
			reason,
			coveredSeq: stopSeq - 1,
			resumeSeq: stopSeq,
			...(resumePendingSeq !== undefined && resumePendingSeq < stopSeq ? { resumePendingSeq } : {}),
			usedCounts: counts,
		};
	};

	let pendingLoaded = !(pendingSeq !== undefined && pendingSeq > 0 && pendingSeq < fromSeq);
	budget.holdProgressFloor();
	while (pos <= lastSeq && stopped === undefined) {
		const reason = budget.spent();
		if (reason && pos > fromSeq) {
			stopAt(reason, pos);
			break;
		}
		let page: SessionEntriesPage;
		try {
			page = await pager.page(pos, pos + budget.rowAllowance(OUTLINE_PAGE_SEQS) - 1, budget);
		} catch (error) {
			if (isHistoryDeadlineError(error)) {
				if (!pendingLoaded && pendingSeq !== undefined) {
					pending = { seq: pendingSeq, at: "", kind: "user", preview: "" };
				}
				stopAt("time", pos);
				break;
			}
			throw error;
		}
		if (!pendingLoaded && pendingSeq !== undefined && pos <= page.lastSeq) {
			pendingLoaded = true;
			budget.holdProgressFloor();
			let pendingPage: SessionEntriesPage | undefined;
			try {
				pendingPage = await pager.page(pendingSeq, pendingSeq, budget);
			} catch (error) {
				if (isHistoryDeadlineError(error)) {
					pending = { seq: pendingSeq, at: "", kind: "user", preview: "" };
					stopAt("time", fromSeq);
					break;
				}
				throw error;
			}
			const pendingEntry = pendingPage.entries.find((item) => item.seq === pendingSeq);
			if (pendingEntry !== undefined) {
				const info = await classifyEntryAt(pendingEntry, budget);
				if ("timedOut" in info) {
					pending = { seq: pendingSeq, at: "", kind: "user", preview: "" };
					stopAt("time", fromSeq);
					break;
				}
				if (info.item !== undefined) {
					pending = { seq: pendingSeq, ...info.item };
				}
			}
		}
		lastSeq = page.lastSeq;
		if (pos > lastSeq) break;
		let prevSeq = pos - 1;
		for (const entryAt of page.entries) {
			if (entryAt.seq > prevSeq + 1) {
				counts.set("other", (counts.get("other") ?? 0) + (entryAt.seq - prevSeq - 1));
			}
			prevSeq = entryAt.seq;
			const info = await classifyEntryAt(entryAt, budget);
			if ("timedOut" in info) {
				stopAt("time", entryAt.seq);
				break;
			}
			if (info.item !== undefined) {
				if (pending !== undefined) {
					const line = formatItem(pending, entryAt.seq - 1);
					if (
						!budget.fits(headingReserve + itemBytes + lineBytes(line)) &&
						itemLines.length > 0 &&
						pending.seq > fromSeq
					) {
						stopAt("byte", entryAt.seq);
						break;
					}
					itemLines.push(line);
					itemBytes += lineBytes(line);
				}
				countsBeforePending = new Map(counts);
				pending = { seq: entryAt.seq, ...info.item };
			}
			counts.set(info.count, (counts.get(info.count) ?? 0) + 1);
		}
		if (stopped !== undefined) break;
		if (page.throughSeq > prevSeq) {
			counts.set("other", (counts.get("other") ?? 0) + (page.throughSeq - prevSeq));
		}
		budget.takeRows(page.throughSeq - pos + 1);
		budget.markProgress();
		pos = page.throughSeq + 1;
		await budget.pace();
	}
	if (fromSeq > lastSeq) return `Requested entry ${fromSeq} is beyond end of session (${lastSeq} entries total).`;
	if (stopped === undefined && pending !== undefined) {
		const line = formatItem(pending, pos - 1);
		if (!budget.fits(headingReserve + itemBytes + lineBytes(line)) && itemLines.length > 0 && pending.seq > fromSeq) {
			stopAt("byte", pos);
		} else {
			itemLines.push(line);
			itemBytes += lineBytes(line);
		}
	}
	const covered = stopped ? stopped.coveredSeq : pos - 1;
	const activeCounts = stopped ? stopped.usedCounts : counts;
	const totalText = Number.isFinite(lastSeq) ? `${lastSeq} entries, ` : "";
	const ofTotal = Number.isFinite(lastSeq) ? ` of ${lastSeq}` : "";
	const out = [
		...(fromSeq === 1
			? [
					`# session ${place.sessionId}: ${totalText}too long to read whole; open a part with its :N-M range`,
					...headerLines.slice(1),
				]
			: [`# session ${place.sessionId} outline from entry ${fromSeq}${ofTotal}`]),
		...(covered >= fromSeq ? [formatCountsLine(fromSeq, covered, activeCounts)] : []),
		...itemLines,
	];
	if (stopped !== undefined) {
		const verb = stopped.reason === "byte" ? "lists" : "covers";
		const cursor = formatOutlineCursor(stopped.resumeSeq, stopped.resumePendingSeq);
		const progressText =
			covered >= fromSeq
				? `outline ${verb} entries ${fromSeq}-${covered}${ofTotal}`
				: `outline up to entry ${fromSeq}${ofTotal}`;
		out.push(`[${progressText}; ${stopText(stopped.reason)}; continue with ${place.urlWith({ cursor })}]`);
	}
	budget.spend(out.reduce((sum, line) => sum + lineBytes(line), 0));
	return out.join("\n");
}

export async function readWholeOrOutline(
	place: SessionPlace,
	headerLines: readonly string[],
	budget: HistoryCallBudget,
	wholeLimitSeqs: number,
): Promise<string> {
	const pager = entryPager(place.store, place.sessionId);
	let lastSeq: number;
	budget.holdProgressFloor();
	try {
		const probe = await pager.page(1, 0, budget);
		lastSeq = probe.lastSeq;
	} catch (error) {
		if (isHistoryDeadlineError(error)) {
			return [
				...headerLines,
				`[read up to entry 1; ${stopText("time")}; continue with ${place.urlWith({ cursor: "1" })}]`,
			].join("\n");
		}
		throw error;
	}
	if (lastSeq > wholeLimitSeqs) return outlineSession(place, headerLines, 1, budget);
	const lines = [...headerLines];
	let bytes = lines.reduce((sum, line) => sum + lineBytes(line), 0);
	let pos = 1;
	let progressed = false;
	while (pos <= lastSeq) {
		const reason = budget.spent();
		if (reason && progressed) {
			lines.push(
				`[read up to entry ${pos} of ${lastSeq}; ${stopText(reason)}; continue with ${place.urlWith({}, [{ start: pos, end: lastSeq }])}]`,
			);
			budget.spend(bytes);
			return lines.join("\n");
		}
		let page: SessionEntriesPage;
		try {
			page = await pager.page(pos, Math.min(lastSeq, pos + budget.rowAllowance(PAGE_SEQS) - 1), budget);
		} catch (error) {
			if (isHistoryDeadlineError(error)) {
				lines.push(
					`[read up to entry ${pos} of ${lastSeq}; ${stopText("time")}; continue with ${place.urlWith({}, [{ start: pos, end: lastSeq }])}]`,
				);
				budget.spend(bytes);
				return lines.join("\n");
			}
			throw error;
		}
		progressed = true;
		budget.markProgress();
		for (const item of page.entries) {
			if (item.rawChunks !== undefined) {
				return outlineSession(place, headerLines, 1, budget);
			}
			for (const line of renderedLines(item.entry)) {
				bytes += lineBytes(line);
				if (!budget.fits(bytes)) {
					return outlineSession(place, headerLines, 1, budget);
				}
				lines.push(line);
			}
			await budget.pace();
		}
		budget.takeRows(page.throughSeq - pos + 1);
		pos = page.throughSeq + 1;
	}
	budget.spend(bytes);
	return lines.join("\n");
}

export interface SearchResume {
	readonly seq: number;
	readonly matchIndex: number;
	readonly lineOffset?: number;
}

export type RegexEngine = "literal" | "native-only" | "both";

export function selectRegexEngine(
	normalized: { readonly pattern: string; readonly flags: string },
	literal: boolean,
	multiline: boolean,
): RegexEngine {
	if (literal) return "literal";
	try {
		new RegExp(normalized.pattern, normalized.flags);
		return "both";
	} catch (error) {
		try {
			const flagPrefix = multiline
				? `(?${normalized.flags.includes("s") ? "s" : ""}${normalized.flags.includes("m") ? "m" : "-m"})`
				: normalized.flags.includes("s")
					? "(?s)"
					: "";
			const native = loadNativeSearchBinding()?.search?.("", {
				pattern: `${flagPrefix}${normalized.pattern}`,
				ignoreCase: normalized.flags.includes("i"),
				multiline,
				contextBefore: 0,
				contextAfter: 0,
			});
			if (native && !native.error) return "native-only";
		} catch {}
		throw error;
	}
}

function scanCharacterClass(pattern: string, start: number): number {
	let j = start + 1;
	while (j < pattern.length) {
		const c = pattern[j]!;
		if (c === "\\") {
			j += 2;
			continue;
		}
		if (c === "]") return j + 1;
		j++;
	}
	return j;
}

function lineNumberAt(newlines: readonly number[], index: number): number {
	let low = 0;
	let high = newlines.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (newlines[mid]! < index) low = mid + 1;
		else high = mid;
	}
	return low;
}

const START_OF_TEXT = "(?:(?<![\\s\\S]))";
const NEVER = "(?:(?!))";

function startAt(offset: number): string {
	return offset === 0 ? START_OF_TEXT : offset < 0 ? NEVER : `(?:(?<=(?<![\\s\\S])[\\s\\S]{${offset}}))`;
}

function workerWindowPattern(
	pattern: string,
	caret: boolean,
	start: { readonly inside: string; readonly outside: string },
): { readonly pattern: string; readonly anchored: boolean } {
	const lookbehinds = [false];
	let anchored = false;
	let out = "";
	for (let i = 0; i < pattern.length; ) {
		const ch = pattern[i]!;
		const inside = lookbehinds[lookbehinds.length - 1]!;
		if (ch === "\\" && i + 1 < pattern.length) {
			const next = pattern[i + 1]!;
			if (next === "Q") {
				const endQuote = pattern.indexOf("\\E", i + 2);
				const end = endQuote === -1 ? pattern.length : endQuote + 2;
				out += pattern.slice(i, end);
				i = end;
				continue;
			}
			if (next === "A") {
				out += inside ? start.inside : start.outside;
				anchored ||= !inside;
			} else out += next === "z" ? "(?![\\s\\S])" : ch + next;
			i += 2;
			continue;
		}
		if (ch === "[") {
			const end = scanCharacterClass(pattern, i);
			out += pattern.slice(i, end);
			i = end;
			continue;
		}
		if (ch === "^" && caret) {
			out += inside ? start.inside : start.outside;
			anchored ||= !inside;
			i++;
			continue;
		}
		if (ch === "(") lookbehinds.push(inside || pattern.startsWith("(?<=", i) || pattern.startsWith("(?<!", i));
		else if (ch === ")" && lookbehinds.length > 1) lookbehinds.pop();
		out += ch;
		i++;
	}
	return { pattern: out, anchored };
}

function matchMultilineNative(
	text: string,
	firstEntryChars: number,
	normalized: { readonly pattern: string; readonly flags: string },
	ignoreCase: boolean,
	maxCount: number,
): MultilineSpan[] {
	const newlines: number[] = [];
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) newlines.push(i);
	const maxStartLine = lineNumberAt(newlines, Math.max(0, firstEntryChars - 1));
	const multiline = normalized.flags.includes("m");
	const flagPrefix = `(?${normalized.flags.includes("s") ? "s" : ""}${multiline ? "m" : "-m"})`;
	const native = loadNativeSearchBinding()?.search?.(text.replaceAll("\0", "\ufffd"), {
		pattern: `${flagPrefix}${normalized.pattern}`,
		ignoreCase,
		multiline: true,
		contextBefore: 0,
		contextAfter: 0,
		maxCount: Math.max(1, maxCount),
	});
	if (!native || native.error) return [];
	const spans: MultilineSpan[] = [];
	for (const match of native.matches) {
		const startLine = match.lineNumber - 1;
		if (startLine > maxStartLine) break;
		let lineSpan = 0;
		for (let i = match.line.indexOf("\n"); i !== -1; i = match.line.indexOf("\n", i + 1)) lineSpan++;
		spans.push({ startLine, endLine: startLine + lineSpan });
	}
	return spans;
}

export interface MultilineWindow {
	readonly text: string;
	readonly lineCount: number;
	readonly ownedFrom: number;
	readonly ownedTo: number;
	readonly cut: boolean;
	readonly entryStart?: number;
}

export async function matchMultilineWindow(
	window: MultilineWindow,
	normalized: { readonly pattern: string; readonly flags: string },
	ignoreCase: boolean,
	literal: boolean,
	engine: RegexEngine,
	budget: HistoryCallBudget,
): Promise<readonly MultilineSpan[] | "timedOut"> {
	const text = window.cut ? `${window.text}\n${WINDOW_CUT_LINE}` : window.text;
	if (engine === "native-only")
		return matchMultilineNative(text, window.ownedTo, normalized, ignoreCase, window.lineCount + 1).filter(
			(span) => span.endLine < window.lineCount,
		);
	const entryStart = window.entryStart ?? 0;
	const caret =
		entryStart !== 0 && !normalized.flags.includes("m") && !MULTILINE_MODIFIER_SYNTAX.test(normalized.pattern);
	const inside = startAt(entryStart);
	const main = literal
		? { pattern: normalized.pattern, anchored: false }
		: workerWindowPattern(normalized.pattern, caret, { inside, outside: entryStart > 0 ? NEVER : inside });
	const startPattern =
		main.anchored && entryStart > 0 && entryStart === window.ownedFrom
			? workerWindowPattern(normalized.pattern, caret, { inside, outside: inside }).pattern
			: undefined;
	const search = (searched: string) =>
		matchMultilineInWorker(
			searched,
			window.ownedFrom,
			window.ownedTo,
			main.pattern,
			normalized.flags,
			ignoreCase,
			literal,
			budget.remainingMs(),
			budget.signal,
			startPattern,
		);
	const res = await search(text);
	if (res.timedOut) return "timedOut";
	const spans = res.matches.filter((span) => span.endLine < window.lineCount);
	if (!window.cut || literal || !LOOKAHEAD_SYNTAX.test(normalized.pattern)) return spans;
	const ended = await search(`${window.text}\n`);
	if (ended.timedOut) return "timedOut";
	const kept = new Set(
		ended.matches
			.filter((span) => span.endLine < window.lineCount)
			.map((span) => `${span.startLine}:${span.endLine}`),
	);
	return spans.filter((span) => kept.has(`${span.startLine}:${span.endLine}`));
}

export interface SearchCheckpoint {
	readonly lines: number;
	readonly match: number;
	readonly next: SearchResume;
}

export interface SessionSearchResult {
	readonly lines: string[];
	readonly checkpoints: readonly SearchCheckpoint[];
	readonly lastSeq: number;
	readonly coveredFromSeq: number;
	readonly coveredThroughSeq: number;
	readonly windowCut: boolean;
	readonly skipped?: number;
	readonly stopped?: { readonly reason: BudgetStop; readonly resume: SearchResume };
}

export interface SessionSearchRequest {
	readonly place: SessionPlace;
	readonly label: string;
	readonly request: InternalSearchRequest;
	readonly prefilter: LiteralQuery | undefined;
	readonly fromSeq: number;
	readonly fromMatchIndex?: number;
	readonly fromLineOffset?: number;
	readonly ranges: readonly SeqRange[] | undefined;
	readonly budget: HistoryCallBudget;
	readonly emittedBefore?: boolean;
	readonly deferCut?: boolean;
}

interface EntryMatchUnit {
	readonly startLine: number;
	readonly endSeq: number;
	readonly endLine: number;
}

interface WindowPart {
	readonly seq: number;
	readonly lines: readonly string[];
	readonly lineOffset: number;
}

type SearchStep =
	| { readonly next: number }
	| { readonly stop: { readonly reason: BudgetStop; readonly resume: SearchResume } };

class SessionSearcher {
	private readonly search: SessionSearchRequest;
	private readonly pager: EntryPager;
	private readonly index: SessionSearchIndex | undefined;
	private readonly normalized: { readonly pattern: string; readonly flags: string };
	private readonly ignoreCase: boolean;
	private readonly multiline: boolean;
	private readonly engine: RegexEngine;
	private readonly lookbehind: boolean;
	private examined = false;
	private coverage: { indexedSeq: number; lastSeq: number; generation?: string; revision?: string } | undefined;
	private indexing = false;
	private lastSeq = 0;
	private startTimedOut = false;
	private readonly lines: string[] = [];
	private readonly entryCache = new Map<number, RenderedEntry | null>();
	private shown = 0;
	private more = 0;
	private firstMore: SearchResume | undefined;
	private countedThrough = 0;
	private coveredFromSeq = 1;
	private coveredThroughSeq = 0;
	private lastEmitted = { seq: 0, line: -1 };
	private emittedAny: boolean;
	private skipped: number | undefined;
	private readonly checkpoints: SearchCheckpoint[] = [];
	private windowCut = false;
	private windowRowsLeft = WINDOW_MAX_SEQS + 2 * CONTEXT_SPAN_SEQS;

	constructor(search: SessionSearchRequest) {
		this.search = search;
		this.emittedAny = search.emittedBefore === true;
		this.pager = entryPager(search.place.store, search.place.sessionId);
		this.index = search.place.store.searchIndex;
		this.normalized = normalizeSearchPattern(search.request.pattern, search.request.ignoreCase);
		this.ignoreCase = this.normalized.flags.includes("i");
		this.multiline = isMultilineSearchPattern(
			search.request.pattern,
			search.request.ignoreCase,
			search.request.literal,
		);
		this.engine = selectRegexEngine(this.normalized, search.request.literal, this.multiline);
		this.lookbehind = this.engine === "both" && LOOKBEHIND_SYNTAX.test(this.normalized.pattern);
	}

	async run(): Promise<SessionSearchResult> {
		const segments = this.segments();
		this.coveredFromSeq = segments[0]?.start ?? this.search.fromSeq;
		await this.search.budget.pace();
		this.search.budget.holdProgressFloor();
		await this.start();
		await this.search.budget.pace();
		if (this.startTimedOut) {
			return this.finish({
				reason: "time",
				resume: {
					seq: this.coveredFromSeq,
					matchIndex: this.search.fromMatchIndex ?? 0,
					...(this.search.fromLineOffset ? { lineOffset: this.search.fromLineOffset } : {}),
				},
			});
		}
		const { budget } = this.search;
		let started = false;
		for (const segment of segments) {
			for (let pos = segment.start; pos <= Math.min(segment.end, this.lastSeq); ) {
				const reason = budget.spent();
				if (reason && started) return this.finish({ reason, resume: { seq: pos, matchIndex: 0 } });
				if (this.firstMore !== undefined && pos > this.firstMore.seq + EXTRA_COUNT_SEQS)
					return this.finish(undefined, false);
				started = true;
				const step = this.indexCovers(pos)
					? await this.searchIndexed(pos, segment.end)
					: await this.scanPage(pos, segment.end);
				if ("stop" in step) return this.finish(step.stop);
				pos = step.next;
			}
		}
		return this.finish(undefined, true);
	}

	private async start(): Promise<void> {
		const { place, budget } = this.search;
		if (this.index !== undefined) {
			try {
				const found = await budget.race(this.index.coverage(place.sessionId, HISTORY_TEXT_FORMAT));
				this.coverage = found
					? {
							indexedSeq: found.indexedSeq,
							lastSeq: found.lastSeq,
							generation: found.generation,
							revision: found.revision,
						}
					: undefined;
			} catch (error) {
				if (isHistoryDeadlineError(error)) {
					this.startTimedOut = true;
					return;
				}
				if (budget.signal?.aborted) throw error;
				this.coverage = undefined;
			}
		}
		this.indexing = this.coverage !== undefined;
		if (this.coverage !== undefined) {
			this.lastSeq = this.coverage.lastSeq;
			return;
		}
		try {
			this.lastSeq = (await this.pager.page(1, 0, budget)).lastSeq;
		} catch (error) {
			if (isHistoryDeadlineError(error)) {
				this.startTimedOut = true;
				return;
			}
			throw error;
		}
	}

	private segments(): SeqRange[] {
		return mergeSeqRanges(
			(this.search.ranges ?? [{ start: 1, end: Number.MAX_SAFE_INTEGER }])
				.map((range) => ({ start: Math.max(range.start, this.search.fromSeq), end: range.end }))
				.filter((range) => range.start <= range.end),
		);
	}

	private remainingRangesFrom(seq: number): SeqRange[] | undefined {
		if (this.search.ranges === undefined) return undefined;
		return mergeSeqRanges(this.search.ranges)
			.filter((range) => range.end >= seq)
			.map((range) => ({ start: Math.max(range.start, seq), end: Math.min(range.end, this.lastSeq) }))
			.filter((range) => range.start <= range.end);
	}

	private indexCovers(pos: number): boolean {
		return (
			!this.multiline &&
			this.search.prefilter !== undefined &&
			this.coverage !== undefined &&
			pos <= this.coverage.indexedSeq
		);
	}

	private markExamined(): void {
		this.examined = true;
		this.search.budget.markProgress();
	}

	private rememberEntry(seq: number, entry: RenderedEntry | null): void {
		this.entryCache.delete(seq);
		this.entryCache.set(seq, entry);
		while (this.entryCache.size > ENTRY_CACHE_SEQS) {
			const oldest = this.entryCache.keys().next().value;
			if (oldest === undefined) break;
			this.entryCache.delete(oldest);
		}
	}

	private async getRenderedEntry(
		seq: number,
		pageFrom = seq,
		pageTo = seq,
	): Promise<RenderedEntry | null | "timedOut"> {
		if (seq < 1 || seq > this.lastSeq) return null;
		if (!this.entryCache.has(seq) && pageFrom < seq && (await this.cacheEntryPage(pageFrom, seq)) === "timedOut")
			return "timedOut";
		if (!this.entryCache.has(seq) && (await this.cacheEntryPage(seq, pageTo)) === "timedOut") return "timedOut";
		return this.entryCache.get(seq) ?? null;
	}

	private async cacheEntryPage(fromSeq: number, toSeq: number): Promise<"ok" | "timedOut"> {
		const from = Math.max(1, fromSeq);
		const { budget } = this.search;
		const rowsLeft = !this.multiline && budget.spent() === undefined ? budget.rowAllowance(PAGE_SEQS) : PAGE_SEQS;
		const to = Math.min(this.lastSeq, toSeq, from + rowsLeft - 1);
		if (from > to) return "ok";
		let page: SessionEntriesPage;
		try {
			page = await this.pager.page(from, to, budget);
		} catch (error) {
			if (isHistoryDeadlineError(error)) return "timedOut";
			throw error;
		}
		const span = page.throughSeq - from + 1;
		if (this.multiline) {
			const coveredByWindow = Math.min(this.windowRowsLeft, span);
			this.windowRowsLeft -= coveredByWindow;
			if (span > coveredByWindow) budget.takeRows(span - coveredByWindow);
		} else {
			budget.takeRows(span);
		}
		let prev = from - 1;
		for (const item of page.entries) {
			for (let s = prev + 1; s < item.seq; s++) this.rememberEntry(s, null);
			prev = item.seq;
			const materialized = await materializeEntry(item, budget);
			if ("timedOut" in materialized) return "timedOut";
			this.rememberEntry(item.seq, materialized.entry.lineCount > 0 ? materialized.entry : null);
		}
		for (let s = prev + 1; s <= page.throughSeq; s++) this.rememberEntry(s, null);
		return "ok";
	}

	private async searchIndexed(pos: number, end: number): Promise<SearchStep> {
		const { place, prefilter, budget } = this.search;
		const capEnd = this.firstMore !== undefined ? Math.min(end, this.firstMore.seq + EXTRA_COUNT_SEQS) : end;
		const through = Math.min(capEnd, this.coverage!.indexedSeq);
		if (pos > through) return { next: Math.min(end, this.coverage!.indexedSeq) + 1 };
		let seqs: readonly number[] | undefined;
		try {
			seqs = await budget.race(
				this.index!.candidates(
					place.sessionId,
					prefilter!,
					pos,
					through,
					CANDIDATE_PAGE,
					this.coverage!.generation,
					budget.storeSignal,
				),
			);
		} catch (error) {
			if (isHistoryDeadlineError(error)) {
				return { stop: { reason: "time", resume: { seq: pos, matchIndex: 0 } } };
			}
			if (budget.signal?.aborted) throw error;
			seqs = undefined;
		}
		budget.takeRows(1);
		await budget.pace();
		if (seqs === undefined) {
			this.coverage = undefined;
			this.indexing = false;
			return { next: pos };
		}
		for (const seq of seqs) {
			const reason = budget.spent();
			if (reason && this.examined) return { stop: { reason, resume: { seq, matchIndex: 0 } } };
			const loaded = await this.getRenderedEntry(seq);
			if (loaded === "timedOut") return { stop: { reason: "time", resume: { seq, matchIndex: 0 } } };
			this.coveredThroughSeq = seq;
			this.countedThrough = seq;
			if (loaded !== null) {
				const matched = await this.matchSingleEntryLines(loaded);
				if (matched === "timedOut") return this.timeoutOnEntry(seq);
				if (matched.length > 0) {
					const units: EntryMatchUnit[] = matched.map((line) => ({
						startLine: line,
						endSeq: seq,
						endLine: line,
					}));
					const stop = await this.emitUnits(loaded, units);
					if (stop !== undefined) return { stop };
				}
			}
			this.markExamined();
			await budget.pace();
		}
		this.markExamined();
		if (seqs.length < CANDIDATE_PAGE) {
			this.coveredThroughSeq = Math.max(this.coveredThroughSeq, through);
			this.countedThrough = Math.max(this.countedThrough, through);
			return { next: through + 1 };
		}
		return { next: seqs.at(-1)! + 1 };
	}

	private timeoutOnEntry(seq: number, completedMatches = 0): SearchStep {
		if (!this.emittedAny && seq === this.coveredFromSeq) {
			this.skipped = seq;
			this.emittedAny = true;
			this.coveredThroughSeq = seq;
			return { stop: { reason: "time", resume: { seq: seq + 1, matchIndex: 0 } } };
		}
		const matchIndex = Math.max(
			completedMatches,
			seq === this.search.fromSeq ? (this.search.fromMatchIndex ?? 0) : 0,
		);
		return { stop: { reason: "time", resume: { seq, matchIndex } } };
	}

	private async scanPage(pos: number, end: number): Promise<SearchStep> {
		const { budget } = this.search;
		const capEnd = this.firstMore !== undefined ? Math.min(end, this.firstMore.seq + EXTRA_COUNT_SEQS) : end;
		if (pos > capEnd) return { next: end + 1 };
		let page: SessionEntriesPage;
		try {
			page = await this.pager.page(pos, Math.min(capEnd, pos + budget.rowAllowance(PAGE_SEQS) - 1), budget);
		} catch (error) {
			if (isHistoryDeadlineError(error)) {
				return { stop: { reason: "time", resume: { seq: pos, matchIndex: 0 } } };
			}
			throw error;
		}
		this.lastSeq = page.lastSeq;
		const rendered: RenderedEntry[] = [];
		let prevSeq = pos - 1;
		for (const item of page.entries) {
			for (let s = prevSeq + 1; s < item.seq; s++) this.rememberEntry(s, null);
			prevSeq = item.seq;
			const materialized = await materializeEntry(item, budget);
			if ("timedOut" in materialized) return this.timeoutOnEntry(item.seq);
			const entry = materialized.entry;
			this.rememberEntry(item.seq, entry.lineCount > 0 ? entry : null);
			if (entry.lineCount > 0) rendered.push(entry);
		}
		for (let s = prevSeq + 1; s <= page.throughSeq; s++) this.rememberEntry(s, null);
		if ((await this.extendIndex(pos, page.throughSeq, rendered)) === "timedOut") {
			if (this.emittedAny || this.coveredThroughSeq >= this.coveredFromSeq) {
				return { stop: { reason: "time", resume: { seq: pos, matchIndex: 0 } } };
			}
		}
		if (this.multiline) {
			let chargedThrough = pos - 1;
			for (const entry of rendered) {
				if (entry.seq - 1 > chargedThrough) {
					budget.takeRows(entry.seq - 1 - chargedThrough);
					chargedThrough = entry.seq - 1;
					this.coveredThroughSeq = chargedThrough;
					this.countedThrough = chargedThrough;
				}
				const reason = budget.spent();
				if (reason && (this.emittedAny || this.coveredThroughSeq >= this.coveredFromSeq))
					return { stop: { reason, resume: { seq: entry.seq, matchIndex: 0 } } };
				const step = await this.scanMultilineEntry(entry);
				budget.takeRows(1);
				chargedThrough = entry.seq;
				if (step !== undefined) return { stop: step };
				this.coveredThroughSeq = entry.seq;
				this.countedThrough = entry.seq;
				this.markExamined();
				await budget.pace();
			}
			if (page.throughSeq > chargedThrough) {
				budget.takeRows(page.throughSeq - chargedThrough);
			}
		} else {
			budget.takeRows(page.throughSeq - pos + 1);
			const pageMatches = await this.matchBatchEntries(rendered);
			for (const entry of rendered) {
				const matched = pageMatches.bySeq.get(entry.seq);
				if (matched !== undefined && matched.length > 0) {
					const units: EntryMatchUnit[] = matched.map((line) => ({
						startLine: line,
						endSeq: entry.seq,
						endLine: line,
					}));
					const stop = await this.emitUnits(entry, units);
					if (stop !== undefined) return { stop };
				}
				if (pageMatches.timedOutAtSeq === entry.seq) {
					return this.timeoutOnEntry(entry.seq, matched?.length ?? 0);
				}
				this.coveredThroughSeq = entry.seq;
				this.countedThrough = entry.seq;
			}
		}
		this.coveredThroughSeq = page.throughSeq;
		this.countedThrough = page.throughSeq;
		this.markExamined();
		await budget.pace();
		return { next: page.throughSeq + 1 };
	}

	private async extendIndex(
		pos: number,
		throughSeq: number,
		rendered: readonly RenderedEntry[],
	): Promise<"ok" | "timedOut"> {
		if (!this.indexing || this.coverage === undefined || pos !== this.coverage.indexedSeq + 1) return "ok";
		const texts: SessionSearchText[] = [];
		for (const entry of rendered) {
			if (entry.lineCount === 0) continue;
			if (entry.oversized) {
				texts.push({ seq: entry.seq, oversized: true });
			} else {
				texts.push({ seq: entry.seq, parts: await entry.searchParts(this.search.budget) });
			}
		}
		if (this.lastSeq <= 1 && texts.every((item) => !item.oversized && (item.parts?.length ?? 0) <= 1)) return "ok";
		let timedOut = false;
		const extended = await this.search.budget
			.race(
				this.index!.extend(
					this.search.place.sessionId,
					HISTORY_TEXT_FORMAT,
					this.coverage.indexedSeq,
					throughSeq,
					texts,
					{
						generation: this.coverage.generation,
						revision: this.coverage.revision,
						signal: this.search.budget.storeSignal,
					},
				),
			)
			.catch((error) => {
				if (this.search.budget.signal?.aborted) throw error;
				if (isHistoryDeadlineError(error)) timedOut = true;
				return false;
			});
		if (extended) {
			this.coverage.indexedSeq = throughSeq;
			return "ok";
		}
		this.indexing = false;
		return timedOut ? "timedOut" : "ok";
	}

	private async matchSingleEntryLines(entry: RenderedEntry): Promise<number[] | "timedOut"> {
		const res = await this.matchBatchEntries([entry]);
		if (res.timedOutAtSeq !== undefined) return "timedOut";
		return res.bySeq.get(entry.seq) ?? [];
	}

	private async matchBatchEntries(
		entries: readonly RenderedEntry[],
	): Promise<{ readonly bySeq: Map<number, number[]>; readonly timedOutAtSeq?: number }> {
		const bySeq = new Map<number, number[]>();
		let batchLines: string[] = [];
		let batchMeta: { seq: number; line: number }[] = [];
		let batchChars = 0;

		const flush = async (): Promise<number | undefined> => {
			if (batchLines.length === 0) return undefined;
			const lines = batchLines;
			const meta = batchMeta;
			batchLines = [];
			batchMeta = [];
			batchChars = 0;
			const hits = await this.evaluateLineBatch(lines);
			if (hits === "timedOut") return meta[0]!.seq;
			for (const idx of hits) {
				const item = meta[idx]!;
				const list = bySeq.get(item.seq) ?? [];
				list.push(item.line);
				bySeq.set(item.seq, list);
			}
			await this.search.budget.pace();
			return undefined;
		};

		for (const entry of entries) {
			for (let line = 0; line < entry.lineCount; line++) {
				const text = entry.lineAt(line);
				if (batchLines.length > 0 && batchChars + text.length > REGEX_BATCH_CHARS) {
					const timedOutSeq = await flush();
					if (timedOutSeq !== undefined) return { bySeq, timedOutAtSeq: timedOutSeq };
				}
				batchLines.push(text);
				batchMeta.push({ seq: entry.seq, line });
				batchChars += text.length + 1;
			}
		}
		const timedOutSeq = await flush();
		return { bySeq, ...(timedOutSeq === undefined ? {} : { timedOutAtSeq: timedOutSeq }) };
	}

	private async evaluateLineBatch(lines: readonly string[]): Promise<readonly number[] | "timedOut"> {
		const { request, budget } = this.search;
		if (!request.literal) {
			const joined = lines.join("\n");
			const safeText = this.engine === "native-only" ? joined.replaceAll("\0", "\ufffd") : joined;
			if (!safeText.includes("\0")) {
				try {
					const native = loadNativeSearchBinding()?.search?.(safeText, {
						pattern: this.normalized.pattern,
						ignoreCase: this.ignoreCase,
						multiline: false,
						contextBefore: 0,
						contextAfter: 0,
					});
					if (native && !native.error) {
						return native.matches.map((match) => match.lineNumber - 1);
					}
				} catch {}
			}
			if (this.engine === "native-only") return [];
		}
		const workerResult = await matchLinesInWorker(
			lines,
			this.normalized.pattern,
			this.normalized.flags,
			this.ignoreCase,
			request.literal,
			budget.remainingMs(),
			budget.signal,
		);
		if (workerResult.timedOut) return "timedOut";
		return workerResult.matchedIndices;
	}

	private async scanMultilineEntry(
		entry: RenderedEntry,
	): Promise<{ readonly reason: BudgetStop; readonly resume: SearchResume } | undefined> {
		const { request, budget } = this.search;
		const isResumeEntry = entry.seq === this.search.fromSeq;
		const startSlice = isResumeEntry ? (this.search.fromLineOffset ?? 0) : 0;
		let sliceStart = startSlice;
		let skipRemaining = isResumeEntry ? (this.search.fromMatchIndex ?? 0) : 0;
		const seenStart = new Set<number>();

		while (sliceStart < entry.lineCount) {
			const reason = budget.spent();
			if (reason && (this.emittedAny || sliceStart > startSlice || entry.seq > this.coveredFromSeq)) {
				return {
					reason,
					resume: {
						seq: entry.seq,
						matchIndex: skipRemaining,
						...(sliceStart > 0 ? { lineOffset: sliceStart } : {}),
					},
				};
			}

			let sliceEnd = sliceStart;
			let ownedChars = entry.lineAt(sliceStart).length + 1;
			while (sliceEnd + 1 < entry.lineCount) {
				const nextLen = entry.lineAt(sliceEnd + 1).length + 1;
				if (ownedChars + nextLen > REGEX_BATCH_CHARS) break;
				ownedChars += nextLen;
				sliceEnd++;
			}

			const sliceStop = (stop: BudgetStop) => ({
				reason: stop,
				resume: {
					seq: entry.seq,
					matchIndex: skipRemaining,
					...(sliceStart > 0 ? { lineOffset: sliceStart } : {}),
				},
			});
			const left = this.lookbehind
				? await this.leftContext(entry, sliceStart)
				: sliceStart > 0
					? [
							{
								seq: entry.seq,
								lines: entry.sliceLines(sliceStart - 1, sliceStart - 1),
								lineOffset: sliceStart - 1,
							},
						]
					: [];
			if (typeof left === "string") return sliceStop(left);
			const ahead = await this.lookahead(entry, sliceEnd);
			if (typeof ahead === "string") return sliceStop(ahead);
			if (ahead.cut) this.windowCut = true;
			const ownedLines = entry.sliceLines(sliceStart, sliceEnd);
			const windowParts: WindowPart[] = [
				...left,
				{ seq: entry.seq, lines: ownedLines, lineOffset: sliceStart },
				...ahead.parts,
			];
			const partStarts: number[] = [];
			let totalLines = 0;
			for (const part of windowParts) {
				partStarts.push(totalLines);
				totalLines += part.lines.length;
			}
			const ownedStartLine = partStarts[left.length]!;
			const ownedFrom = left.reduce(
				(sum, part) => part.lines.reduce((chars, line) => chars + line.length + 1, sum),
				0,
			);
			const ownedTo = ownedFrom + ownedLines.join("\n").length + 1;
			const entryPart = windowParts.findIndex((part) => part.seq === entry.seq && part.lineOffset === 0);
			const entryStart =
				entryPart === -1
					? -1
					: windowParts
							.slice(0, entryPart)
							.reduce((sum, part) => part.lines.reduce((chars, line) => chars + line.length + 1, sum), 0);
			const windowText = windowParts.flatMap((part) => part.lines).join("\n");
			const matchedSpans = await matchMultilineWindow(
				{ text: windowText, lineCount: totalLines, ownedFrom, ownedTo, cut: ahead.cut, entryStart },
				this.normalized,
				this.ignoreCase,
				request.literal,
				this.engine,
				budget,
			);
			if (matchedSpans === "timedOut") {
				if (!this.emittedAny && sliceStart === startSlice && entry.seq === this.coveredFromSeq) {
					const skipped = this.timeoutOnEntry(entry.seq);
					if ("stop" in skipped) return skipped.stop;
				}
				return sliceStop("time");
			}

			const resolveGlobalLine = (globalLine: number): { seq: number; line: number } => {
				for (let i = windowParts.length - 1; i >= 0; i--) {
					const part = windowParts[i]!;
					if (globalLine >= partStarts[i]!) {
						const localIdx = Math.min(part.lines.length - 1, globalLine - partStarts[i]!);
						return { seq: part.seq, line: part.lineOffset + localIdx };
					}
				}
				return { seq: entry.seq, line: sliceStart };
			};

			const sliceUnits: EntryMatchUnit[] = [];
			for (const span of matchedSpans) {
				if (span.startLine < ownedStartLine) continue;
				const start = resolveGlobalLine(span.startLine);
				if (start.seq !== entry.seq || seenStart.has(start.line)) continue;
				seenStart.add(start.line);
				const end = resolveGlobalLine(span.endLine);
				sliceUnits.push({ startLine: start.line, endSeq: end.seq, endLine: end.line });
			}

			if (sliceUnits.length > 0) {
				if (skipRemaining >= sliceUnits.length) {
					skipRemaining -= sliceUnits.length;
				} else {
					const skipInSlice = skipRemaining;
					skipRemaining = 0;
					const nextSliceStart = sliceEnd + 1 < entry.lineCount ? sliceEnd + 1 : undefined;
					const stop = await this.emitUnits(entry, sliceUnits, {
						skipUnits: skipInSlice,
						sliceLineOffset: sliceStart,
						nextSliceStart,
					});
					if (stop !== undefined) return stop;
				}
			}
			sliceStart = sliceEnd + 1;
			await budget.pace();
		}
		return undefined;
	}

	private async leftContext(entry: RenderedEntry, sliceStart: number): Promise<WindowPart[] | BudgetStop> {
		const parts: WindowPart[] = [];
		let chars = 0;
		let first = sliceStart;
		while (first > 0 && chars < MATCH_SPAN_CHARS) {
			first--;
			chars += entry.lineAt(first).length + 1;
		}
		if (first < sliceStart)
			parts.push({ seq: entry.seq, lines: entry.sliceLines(first, sliceStart - 1), lineOffset: first });
		const windowStart = Math.max(1, entry.seq - WINDOW_MAX_SEQS);
		let span = 1;
		for (let prevSeq = entry.seq - 1; prevSeq >= windowStart && chars < MATCH_SPAN_CHARS; prevSeq--) {
			const prev = await this.getRenderedEntry(prevSeq, Math.max(windowStart, prevSeq - span + 1));
			if (prev === "timedOut") return "time";
			const reason = this.search.budget.spent();
			if (reason && this.examined) return reason;
			if (prev === null) {
				span = LOOKAHEAD_PAGE_SEQS;
				continue;
			}
			let start = prev.lineCount;
			while (start > 0 && chars < MATCH_SPAN_CHARS) {
				start--;
				chars += prev.lineAt(start).length + 1;
			}
			parts.unshift({ seq: prevSeq, lines: prev.sliceLines(start, prev.lineCount - 1), lineOffset: start });
		}
		return parts;
	}

	private async lookahead(
		entry: RenderedEntry,
		sliceEnd: number,
	): Promise<{ readonly parts: WindowPart[]; readonly cut: boolean } | BudgetStop> {
		const parts: WindowPart[] = [];
		let chars = 0;
		let cut = false;
		if (sliceEnd + 1 < entry.lineCount) {
			let end = sliceEnd;
			while (end + 1 < entry.lineCount && chars < MATCH_SPAN_CHARS) {
				end++;
				chars += entry.lineAt(end).length + 1;
			}
			parts.push({ seq: entry.seq, lines: entry.sliceLines(sliceEnd + 1, end), lineOffset: sliceEnd + 1 });
			if (end + 1 < entry.lineCount) cut = true;
		}
		const windowEnd = Math.min(this.lastSeq, entry.seq + WINDOW_MAX_SEQS);
		let nextSeq = entry.seq + 1;
		for (; nextSeq <= windowEnd && chars < MATCH_SPAN_CHARS; nextSeq++) {
			const next = await this.getRenderedEntry(
				nextSeq,
				nextSeq,
				Math.min(windowEnd, nextSeq + LOOKAHEAD_PAGE_SEQS - 1),
			);
			if (next === "timedOut") return "time";
			const reason = this.search.budget.spent();
			if (reason && this.examined) return reason;
			if (next === null) continue;
			let end = -1;
			while (end + 1 < next.lineCount && chars < MATCH_SPAN_CHARS) {
				end++;
				chars += next.lineAt(end).length + 1;
			}
			parts.push({ seq: nextSeq, lines: next.sliceLines(0, end), lineOffset: 0 });
			if (end + 1 < next.lineCount) cut = true;
		}
		return { parts, cut: cut || nextSeq <= this.lastSeq };
	}

	private async emitUnits(
		entry: RenderedEntry,
		units: readonly EntryMatchUnit[],
		sliceContext?: {
			readonly skipUnits: number;
			readonly sliceLineOffset: number;
			readonly nextSliceStart: number | undefined;
		},
	): Promise<{ readonly reason: BudgetStop; readonly resume: SearchResume } | undefined> {
		const { seq } = entry;
		const { label, budget } = this.search;
		const skipUnits =
			sliceContext !== undefined
				? sliceContext.skipUnits
				: seq === this.search.fromSeq
					? (this.search.fromMatchIndex ?? 0)
					: 0;
		const lineOffsetPart =
			sliceContext !== undefined && sliceContext.sliceLineOffset > 0
				? { lineOffset: sliceContext.sliceLineOffset }
				: {};
		const resumeAtUnit = (unitIndex: number): SearchResume => ({
			seq,
			matchIndex: unitIndex,
			...lineOffsetPart,
		});
		const afterUnit = (unitIndex: number): SearchResume =>
			unitIndex + 1 < units.length
				? resumeAtUnit(unitIndex + 1)
				: sliceContext?.nextSliceStart !== undefined
					? { seq, matchIndex: 0, lineOffset: sliceContext.nextSliceStart }
					: { seq: seq + 1, matchIndex: 0 };
		const matchStartLinesInEntry = new Set(units.slice(skipUnits).map((u) => u.startLine));

		for (let unitIdx = skipUnits; unitIdx < units.length; unitIdx++) {
			const unit = units[unitIdx]!;
			if (this.shown >= MAX_MATCHES_PER_SESSION) {
				this.firstMore ??= resumeAtUnit(unitIdx);
				this.more++;
				continue;
			}
			const noteReserve = this.shown === MAX_MATCHES_PER_SESSION - 1 ? this.moreNoteReserveBytes() : 0;
			const beforeRows = await this.collectContextBefore(entry, unit.startLine, matchStartLinesInEntry);
			if (beforeRows === "timedOut") return { reason: "time", resume: resumeAtUnit(unitIdx) };
			const matchRow = formatSearchTextLine(label, seq, entry.lineAt(unit.startLine), true);
			const spanRows = await this.collectSpanAndContextAfter(entry, unit, matchStartLinesInEntry);
			if (spanRows === "timedOut") return { reason: "time", resume: resumeAtUnit(unitIdx) };

			const allRows = [...beforeRows, { seq, line: unit.startLine, text: matchRow }, ...spanRows];
			const totalBytes = allRows.reduce((sum, r) => sum + lineBytes(r.text), 0);

			if (budget.fits(totalBytes + noteReserve)) {
				const match = this.lines.length + beforeRows.length;
				for (const r of allRows) {
					this.lines.push(r.text);
					budget.spend(lineBytes(r.text));
					this.advanceWatermark(r.seq, r.line);
				}
				this.checkpoints.push({ lines: this.lines.length, match, next: afterUnit(unitIdx) });
				this.shown++;
				this.emittedAny = true;
				continue;
			}

			const matchBytes = lineBytes(matchRow);
			if (budget.fits(matchBytes + noteReserve)) {
				const match = this.lines.length;
				this.lines.push(matchRow);
				budget.spend(matchBytes);
				this.advanceWatermark(seq, unit.startLine);
				for (const r of spanRows) {
					if (!budget.fits(lineBytes(r.text) + noteReserve)) break;
					this.lines.push(r.text);
					budget.spend(lineBytes(r.text));
					this.advanceWatermark(r.seq, r.line);
				}
				this.checkpoints.push({ lines: this.lines.length, match, next: afterUnit(unitIdx) });
				this.shown++;
				this.emittedAny = true;
				continue;
			}

			if (!this.emittedAny) {
				const cut = this.search.deferCut
					? matchRow
					: cutTextToUtf8Bytes(matchRow, Math.max(32, budget.bytesAvailable()));
				const match = this.lines.length;
				this.lines.push(cut);
				budget.spend(lineBytes(cut));
				this.advanceWatermark(seq, unit.startLine);
				const nextResume = afterUnit(unitIdx);
				this.checkpoints.push({ lines: this.lines.length, match, next: nextResume });
				this.shown++;
				this.emittedAny = true;
				return { reason: "byte", resume: nextResume };
			}

			return { reason: "byte", resume: resumeAtUnit(unitIdx) };
		}
		return undefined;
	}

	private isAfterWatermark(seq: number, line: number): boolean {
		return seq > this.lastEmitted.seq || (seq === this.lastEmitted.seq && line > this.lastEmitted.line);
	}

	private advanceWatermark(seq: number, line: number): void {
		if (this.isAfterWatermark(seq, line)) this.lastEmitted = { seq, line };
	}

	private async collectContextBefore(
		entry: RenderedEntry,
		startLine: number,
		matchStartLinesInEntry: ReadonlySet<number>,
	): Promise<{ seq: number; line: number; text: string }[] | "timedOut"> {
		const { label, request } = this.search;
		let needed = request.contextBefore;
		if (needed <= 0) return [];
		const rows: { seq: number; line: number; text: string }[] = [];
		for (let line = startLine - 1; line >= 0 && needed > 0; line--) {
			if (matchStartLinesInEntry.has(line) || !this.isAfterWatermark(entry.seq, line)) break;
			rows.unshift({
				seq: entry.seq,
				line,
				text: formatSearchTextLine(label, entry.seq, entry.lineAt(line), false),
			});
			needed--;
		}
		const contextStart = Math.max(1, entry.seq - CONTEXT_SPAN_SEQS);
		let span = 1;
		for (let prevSeq = entry.seq - 1; needed > 0 && prevSeq >= contextStart; prevSeq--) {
			if (prevSeq < this.lastEmitted.seq || this.search.budget.spent() !== undefined) break;
			const prevEntry = await this.getRenderedEntry(
				prevSeq,
				Math.max(contextStart, this.lastEmitted.seq, prevSeq - span + 1),
			);
			if (prevEntry === "timedOut") return "timedOut";
			if (prevEntry === null) {
				span = LOOKAHEAD_PAGE_SEQS;
				continue;
			}
			for (let line = prevEntry.lineCount - 1; line >= 0 && needed > 0; line--) {
				if (!this.isAfterWatermark(prevSeq, line)) {
					needed = 0;
					break;
				}
				rows.unshift({
					seq: prevSeq,
					line,
					text: formatSearchTextLine(label, prevSeq, prevEntry.lineAt(line), false),
				});
				needed--;
			}
		}
		return rows;
	}

	private async collectSpanAndContextAfter(
		entry: RenderedEntry,
		unit: EntryMatchUnit,
		matchStartLinesInEntry: ReadonlySet<number>,
	): Promise<{ seq: number; line: number; text: string }[] | "timedOut"> {
		const { label, request } = this.search;
		const rows: { seq: number; line: number; text: string }[] = [];
		let endEntry = entry;

		if (unit.endSeq > entry.seq || unit.endLine > unit.startLine) {
			const firstEnd = unit.endSeq === entry.seq ? unit.endLine : entry.lineCount - 1;
			for (let line = unit.startLine + 1; line <= firstEnd; line++) {
				rows.push({
					seq: entry.seq,
					line,
					text: formatSearchTextLine(label, entry.seq, entry.lineAt(line), false),
				});
			}
			for (let s = entry.seq + 1; s <= unit.endSeq; s++) {
				const next = await this.getRenderedEntry(s, s, Math.min(unit.endSeq, s + LOOKAHEAD_PAGE_SEQS - 1));
				if (next === "timedOut") return "timedOut";
				if (next === null) continue;
				endEntry = next;
				const last = s === unit.endSeq ? unit.endLine : next.lineCount - 1;
				for (let line = 0; line <= last; line++) {
					rows.push({
						seq: s,
						line,
						text: formatSearchTextLine(label, s, next.lineAt(line), false),
					});
				}
			}
		}

		let needed = request.contextAfter;
		if (needed <= 0) return rows;

		for (let line = unit.endLine + 1; line < endEntry.lineCount && needed > 0; line++) {
			if (endEntry.seq === entry.seq && matchStartLinesInEntry.has(line)) return rows;
			rows.push({
				seq: endEntry.seq,
				line,
				text: formatSearchTextLine(label, endEntry.seq, endEntry.lineAt(line), false),
			});
			needed--;
		}

		const contextEnd = Math.min(this.lastSeq, endEntry.seq + CONTEXT_SPAN_SEQS);
		let span = 1;
		for (let nextSeq = endEntry.seq + 1; needed > 0 && nextSeq <= contextEnd; nextSeq++) {
			if (this.search.budget.spent() !== undefined) break;
			const nextEntry = await this.getRenderedEntry(nextSeq, nextSeq, Math.min(contextEnd, nextSeq + span - 1));
			if (nextEntry === "timedOut") return "timedOut";
			if (nextEntry === null) {
				span = LOOKAHEAD_PAGE_SEQS;
				continue;
			}
			for (let line = 0; line < nextEntry.lineCount && needed > 0; line++) {
				rows.push({
					seq: nextSeq,
					line,
					text: formatSearchTextLine(label, nextSeq, nextEntry.lineAt(line), false),
				});
				needed--;
			}
		}
		return rows;
	}

	private finish(
		stopped?: { readonly reason: BudgetStop; readonly resume: SearchResume },
		complete = false,
	): SessionSearchResult {
		if (this.more > 0 && this.firstMore !== undefined) {
			const isComplete = stopped === undefined && complete;
			const note = this.moreNote(
				this.more,
				this.firstMore,
				isComplete ? undefined : this.countedThrough,
				this.remainingRangesFrom(this.firstMore.seq),
			);
			this.lines.push(note);
			this.search.budget.spend(lineBytes(note));
		}
		return {
			lines: this.lines,
			checkpoints: this.checkpoints,
			lastSeq: this.lastSeq,
			coveredFromSeq: this.coveredFromSeq,
			coveredThroughSeq: Math.max(this.coveredFromSeq, this.coveredThroughSeq),
			windowCut: this.windowCut,
			...(this.skipped === undefined ? {} : { skipped: this.skipped }),
			...(stopped ? { stopped } : {}),
		};
	}

	private moreNote(
		more: number,
		firstMore: SearchResume,
		countedThrough: number | undefined,
		remainingRanges: readonly SeqRange[] | undefined,
	): string {
		const where =
			countedThrough === undefined ? "" : ` in entries ${firstMore.seq}-${countedThrough}, maybe more after`;
		const cursor = formatSearchCursor(firstMore);
		return `${this.search.label}-0- [+${more} more in this session${where}; search ${this.search.place.urlWith({ cursor }, remainingRanges)} for them]`;
	}

	private moreNoteReserveBytes(): number {
		const widest = Number.MAX_SAFE_INTEGER;
		const ranges = this.search.ranges === undefined ? undefined : mergeSeqRanges(this.search.ranges);
		return lineBytes(this.moreNote(widest, { seq: widest, matchIndex: widest, lineOffset: widest }, widest, ranges));
	}
}

export function formatSearchCursor(resume: SearchResume): string {
	if (resume.lineOffset !== undefined && resume.lineOffset > 0) {
		return `${resume.seq}.${resume.matchIndex}.${resume.lineOffset}`;
	}
	return resume.matchIndex > 0 ? `${resume.seq}.${resume.matchIndex}` : String(resume.seq);
}

export function searchSession(search: SessionSearchRequest): Promise<SessionSearchResult> {
	return new SessionSearcher(search).run();
}
