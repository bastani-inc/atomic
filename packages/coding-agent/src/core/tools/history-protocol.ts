/**
 * history:// resolution: the session and workflow history of the current project, read through the configured
 * `SessionStore` and the registered workflow run control rather than through any backend's own files.
 *
 *   history://                     what is available
 *   history://sessions             recent sessions, newest first
 *   history://sessions/<id>        one session: its transcript, or an outline when it is too long to read whole
 *   history://sessions/<id>:N-M    entries N to M of one session
 *   history://workflows            recent workflow runs, newest first
 *   history://workflows/<runId>    one run: inputs, stages with their sessions, result
 *
 * Query parameters: `limit=N` (at most 200) and `offset=N` page a listing or a multi-record search, so every record is
 * reachable; `project=all|<path>` on sessions widens the scope beyond the current project; `cursor=` continues a read
 * or search where an earlier one stopped.
 *
 * Every read and search has a byte, row and time budget. One that runs out stops cleanly and says what it covered and
 * which URL continues it.
 */

import { createSessionCwdMatcher } from "../../utils/canonical-path.ts";
import { resolvePath } from "../../utils/paths.ts";
import type {
	WorkflowRunControl,
	WorkflowRunDetail,
	WorkflowRunJsonObject,
	WorkflowRunJsonValue,
	WorkflowRunSummary,
} from "../extensions/workflow-run-control.js";
import type { SessionEntry } from "../session-manager-types.ts";
import type { SessionRecordHeader, SessionStore, SessionSummary } from "../storage/session/types.js";
import { indexLiterals, isMultilineSearchPattern, type LiteralQuery } from "./history-literals.ts";
import { type MultilineSpan, matchLinesInWorker, matchMultilineInWorker } from "./history-regex-worker.ts";
import {
	type BudgetStop,
	cutTextToUtf8Bytes,
	DEFAULT_HISTORY_BUDGET,
	formatSearchCursor,
	type HistoryBudget,
	HistoryCallBudget,
	isHistoryDeadlineError,
	lineBytes,
	MATCH_SPAN_CHARS,
	MULTILINE_WINDOW_NOTE,
	matchMultilineNative,
	mergeSeqRanges,
	oneLine,
	outlineSession,
	rangeText,
	readSessionRanges,
	readWholeOrOutline,
	type SeqCursor,
	type SeqRange,
	type SessionPlace,
	searchSession,
	selectRegexEngine,
	stopText,
} from "./history-session.ts";
import { entryLines, timestamp, transcriptHeaderLines, wrapLine } from "./history-transcript.ts";
import { mergeReadRanges, splitReadLineSelector } from "./read-selectors.ts";
import {
	formatSearchTextLine,
	type InternalReadSelection,
	type InternalResourceRouter,
	type InternalSearchRequest,
	normalizeSearchPattern,
} from "./resource-selectors.ts";
import { splitLineRangeSelector } from "./search-line-ranges.ts";
import { loadNativeSearchBinding } from "./search-native.ts";

export type { HistoryBudget } from "./history-session.ts";

function charged(budget: HistoryCallBudget, line: string): string {
	budget.spend(lineBytes(line));
	return line;
}

/** The part of a workflow run control that history:// reads; it can list and read runs, never manage them. */
export type WorkflowRunHistory = Pick<WorkflowRunControl, "listRuns" | "listProjectRuns" | "getRun">;

/**
 * Where a session reads its project's history: the project's sessions and its workflow runs. A workflow stage or a
 * subagent gets the history of the session that launched it, since neither holds the project's run control and a
 * subagent keeps its own transcript apart from the project's sessions.
 */
export interface ProjectHistory {
	readonly sessionStore: () => SessionStore | undefined;
	readonly workflows: () => WorkflowRunHistory | undefined;
}

export interface HistorySources {
	/** The project whose history is visible by default. */
	readonly cwd: string;
	readonly currentSessionId?: string;
	/** The store that holds the current session. */
	readonly sessionStore: () => SessionStore | undefined;
	/** The store that holds the project's other sessions, when it is not the current session's. */
	readonly projectSessionStore?: () => SessionStore | undefined;
	readonly workflows: () => WorkflowRunHistory | undefined;
	readonly budget?: Partial<HistoryBudget>;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const LABEL_LIMIT = 120;
const WHOLE_SESSION_ENTRY_LIMIT = 2_000;
const DISCOVERY_TTL_MS = 60_000;
const MAX_PARKED_DISCOVERIES = 16;
const QUERY_KEYS: Readonly<Record<"sessions" | "workflows" | "root", readonly string[]>> = {
	sessions: ["limit", "offset", "project", "cursor", "session"],
	workflows: ["limit", "offset", "cursor"],
	root: ["limit", "offset", "project", "cursor"],
};
const CURSOR = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?$/;

type Domain = "sessions" | "workflows";
interface HistoryTarget {
	readonly domain?: Domain;
	readonly id?: string;
	readonly limit: number;
	readonly offset: number;
	/** `undefined` selects the current project, `"all"` every project, anything else is a project directory. */
	readonly project?: string;
	readonly session?: string;
	readonly cursor?: {
		readonly first: number;
		readonly second: number;
		readonly third: number;
		readonly fourth: number;
	};
}

interface ParkedDiscovery {
	readonly iterator: AsyncIterator<SessionSummary>;
	readonly controller: AbortController;
	readonly items: { readonly summary: SessionSummary; readonly modifiedMs: number }[];
	pending?: Promise<IteratorResult<SessionSummary>>;
	timer?: ReturnType<typeof setTimeout>;
}

function closeDiscovery(discovery: ParkedDiscovery): void {
	clearTimeout(discovery.timer);
	discovery.controller.abort();
	void (async () => discovery.iterator.return?.())().catch(() => {});
}

const parkedDiscoveries = new WeakMap<SessionStore, Map<string, ParkedDiscovery>>();

const HISTORY_URL = /^history:\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?$/;

export const HISTORY_HELP = [
	"history:// reads and searches this project's past sessions and workflow runs, whatever storage backs them.",
	"  history://sessions                  recent sessions, newest first (?limit=N up to 200, ?offset=N to page)",
	"  history://sessions/<id>             one session's transcript, or an outline of a long one",
	"  history://sessions/<id>:N-M         entries N to M of one session",
	"  history://workflows                 recent workflow runs, newest first (?limit=N, ?offset=N)",
	"  history://workflows/<runId>[:N-M]   one run: inputs, stages with their sessions, result",
	'Search any of them with the search tool, e.g. paths "history://sessions" or "history://" (both); a session match',
	"is labelled with its URL and entry number, which reads back with :N-N, and context lines may cross neighbouring",
	"entries. A search of workflow runs also searches their stages' transcripts. A search covers one page of records",
	"(25 by default) and shows at most 10 matches per session; a read or search that stops early says what it covered",
	"and the ?cursor= URL that continues it.",
	"Sessions of other projects appear only with ?project=all or ?project=<dir>; use that only when the user asks.",
].join("\n");

function parseTarget(url: string): HistoryTarget {
	const match = HISTORY_URL.exec(url);
	if (!match) throw new Error(`Invalid history URL: ${url}`);
	const [, domainText = "", idText, queryText] = match;
	if (domainText !== "" && domainText !== "sessions" && domainText !== "workflows")
		throw new Error(`Unknown history resource: ${domainText}; use history://sessions or history://workflows`);
	const domain: Domain | undefined = domainText === "" ? undefined : domainText;
	if (domain === undefined && idText) throw new Error(`Unknown history resource: ${idText}`);
	const params = new URLSearchParams(queryText ?? "");
	const allowed = QUERY_KEYS[domain ?? "root"];
	for (const key of params.keys())
		if (!allowed.includes(key))
			throw new Error(`Unsupported history query parameter: ${key}; supported: ${allowed.join(", ")}`);
	const limitText = params.get("limit");
	const limit = limitText === null ? DEFAULT_LIMIT : Number.parseInt(limitText, 10);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
		throw new Error(`history limit must be between 1 and ${MAX_LIMIT}: ${limitText}; page further with ?offset=N`);
	const offsetText = params.get("offset");
	const offset = offsetText === null ? 0 : Number.parseInt(offsetText, 10);
	if (!Number.isInteger(offset) || offset < 0) throw new Error(`history offset must be 0 or more: ${offsetText}`);
	const project = params.get("project") ?? undefined;
	if (project === "") throw new Error("history project must be 'all' or a directory");
	const session = params.get("session") ?? undefined;
	if (session === "") throw new Error("history session must be a session id");
	const cursorText = params.get("cursor");
	const cursorMatch = cursorText === null ? undefined : CURSOR.exec(cursorText);
	if (cursorText !== null && !cursorMatch)
		throw new Error(
			`history cursor must be N, N.M, N.M.K or N.M.K.L, as a read or search that stopped early gave it: ${cursorText}`,
		);
	return {
		domain,
		...(idText ? { id: decodeURIComponent(idText) } : {}),
		limit,
		offset,
		...(project === undefined ? {} : { project }),
		...(session === undefined ? {} : { session }),
		...(cursorMatch
			? {
					cursor: {
						first: Number(cursorMatch[1]),
						second: Number(cursorMatch[2] ?? 0),
						third: Number(cursorMatch[3] ?? 0),
						fourth: Number(cursorMatch[4] ?? 0),
					},
				}
			: {}),
	};
}

/** The lines `history://sessions/<id>` shows for `entries`, in the form a transcript search returns them. */
export function transcriptEntryLines(entries: readonly SessionEntry[]): string[] {
	return entries.flatMap(entryLines);
}

function sessionLabel(summary: SessionSummary): string {
	return summary.name ? oneLine(summary.name, LABEL_LIMIT) : oneLine(summary.firstMessage, LABEL_LIMIT);
}

function withQuery(base: string, parts: readonly (string | undefined)[], ranges?: readonly SeqRange[]): string {
	const query = parts.filter((part) => part !== undefined).join("&");
	return `${base}${query ? `?${query}` : ""}${ranges && ranges.length > 0 ? `:${rangeText(ranges)}` : ""}`;
}

/** A link that reads back in the same scope as the view it came from. */
function sessionUrl(id: string, target: HistoryTarget, cursor?: string, ranges?: readonly SeqRange[]): string {
	return withQuery(
		`history://sessions/${id}`,
		[
			target.project === undefined ? undefined : `project=${encodeURIComponent(target.project)}`,
			cursor === undefined ? undefined : `cursor=${cursor}`,
		],
		ranges,
	);
}

function pageUrl(
	domain: Domain,
	target: HistoryTarget,
	offset: number,
	cursor?: string,
	ranges?: readonly SeqRange[],
	session?: string,
): string {
	const params = new URLSearchParams();
	if (offset > 0) params.set("offset", String(offset));
	if (target.limit !== DEFAULT_LIMIT) params.set("limit", String(target.limit));
	if (domain === "sessions" && target.project !== undefined) params.set("project", target.project);
	if (session !== undefined) params.set("session", session);
	if (cursor !== undefined) params.set("cursor", cursor);
	const query = params.toString();
	return `history://${domain}${query ? `?${query}` : ""}${ranges && ranges.length > 0 ? `:${rangeText(ranges)}` : ""}`;
}

function windowText(total: number, offset: number, shown: number): string {
	return shown === 0 ? `none of ${total}` : `${offset + 1}-${offset + shown} of ${total}`;
}

function urlWithCursor(url: string, cursor: string | undefined): string {
	const match = HISTORY_URL.exec(url);
	if (!match) return url;
	const [, domainText = "", idText, queryText] = match;
	const params = new URLSearchParams(queryText ?? "");
	if (cursor === undefined) params.delete("cursor");
	else params.set("cursor", cursor);
	const query = params.toString();
	return `history://${domainText}${idText ? `/${idText}` : ""}${query ? `?${query}` : ""}`;
}

type LineSource = Iterable<string> | AsyncIterable<string>;

interface LineStop {
	readonly reason: BudgetStop;
	readonly kind: "before" | "inside" | "after";
	readonly line: number;
	readonly char: number;
}

const LINE_PACE_EVERY = 256;

async function selectLines(
	url: string,
	lines: LineSource,
	selection: InternalReadSelection,
	cursor: { readonly line: number; readonly char: number } | undefined,
	budget: HistoryCallBudget,
): Promise<string> {
	const exact = selection.raw === true || cursor !== undefined;
	const ranges =
		selection.ranges !== undefined && selection.ranges.length > 0
			? mergeReadRanges(selection.ranges, Number.POSITIVE_INFINITY, !exact)
			: undefined;
	const start = Math.max(1, cursor?.line ?? selection.offset ?? 1);
	const selectionEnd =
		ranges !== undefined
			? (ranges.at(-1)?.end ?? 0)
			: selection.limit === undefined
				? Number.POSITIVE_INFINITY
				: start + selection.limit - 1;
	let rangeIndex = 0;
	const picks = (lineNum: number): boolean => {
		if (ranges === undefined) return lineNum >= start && lineNum <= selectionEnd;
		while (rangeIndex < ranges.length && ranges[rangeIndex]!.end < lineNum) rangeIndex++;
		const range = ranges[rangeIndex];
		return range !== undefined && lineNum >= range.start;
	};
	const timeUp = () => budget.remainingMs() <= 0;
	const out: string[] = [];
	let total = 0;
	let counted = true;
	let firstNumber: number | undefined;
	let lastNumber: number | undefined;
	let lastEmittedNumber: number | undefined;
	let stop: LineStop | undefined;
	for await (const fullLine of lines) {
		total++;
		if (total % LINE_PACE_EVERY === 0) await budget.pace();
		if (stop !== undefined && stop.reason === "time") {
			counted = false;
			break;
		}
		if (stop !== undefined && timeUp()) {
			counted = false;
			break;
		}
		if (!picks(total)) {
			if (stop === undefined && lastNumber !== undefined && total > selectionEnd) break;
			continue;
		}
		lastNumber = total;
		if (stop !== undefined) continue;
		if (cursor !== undefined && total < cursor.line) continue;
		if (out.length > 0 && timeUp()) {
			stop = { reason: "time", kind: "before", line: total, char: 0 };
			continue;
		}
		firstNumber ??= total;
		const charOffset = cursor !== undefined && total === cursor.line ? cursor.char : 0;
		const text = charOffset > 0 ? fullLine.slice(charOffset) : fullLine;
		const size = lineBytes(text);
		if (budget.fits(size)) {
			out.push(text);
			lastEmittedNumber = total;
			budget.spend(size);
			continue;
		}
		if (out.length > 0) {
			stop = { reason: "byte", kind: "before", line: total, char: 0 };
			continue;
		}
		const piece = cutTextToUtf8Bytes(text, Math.max(1, budget.bytesAvailable()));
		out.push(piece);
		lastEmittedNumber = total;
		budget.spend(lineBytes(piece));
		const nextChar = charOffset + piece.length;
		stop =
			nextChar < fullLine.length
				? { reason: "byte", kind: "inside", line: total, char: nextChar }
				: { reason: "byte", kind: "after", line: total, char: 0 };
	}
	if (lastNumber === undefined) {
		if (ranges !== undefined)
			return `Requested line ${selection.ranges![0]!.start} is beyond end of resource (${total} lines total).`;
		if (start > total && (selection.offset !== undefined || cursor !== undefined))
			return `Requested line ${start} is beyond end of resource (${total} lines total).`;
	}
	if (stop === undefined) return out.join("\n");
	const first = firstNumber ?? stop.line;
	const of = counted ? ` of ${total}` : "";
	const lastKnown = counted || total >= selectionEnd ? (lastNumber ?? total) : undefined;
	const reason = stopText(stop.reason);
	const resumeFrom = stop.kind === "after" ? stop.line + 1 : stop.line;
	const activeRanges = (ranges ?? [{ start, end: selectionEnd }])
		.filter((range) => range.end >= resumeFrom)
		.map((range) => ({
			start: Math.max(range.start, resumeFrom),
			end: lastKnown === undefined ? range.end : Math.min(range.end, lastKnown),
		}))
		.filter((range) => range.start <= range.end);
	const rangeSuffix = activeRanges
		.map((range) => `${range.start}-${Number.isFinite(range.end) ? range.end : ""}`)
		.join(",");
	const nextLine = activeRanges[0]?.start ?? resumeFrom;
	if (stop.kind === "before")
		out.push(
			`[read lines ${first}-${lastEmittedNumber ?? Math.max(first, stop.line - 1)}${of}; ${reason}; continue with ${urlWithCursor(url, String(nextLine))}:${rangeSuffix}]`,
		);
	else if (stop.kind === "inside")
		out.push(
			`[read line ${stop.line}${of}; ${reason}; continue with ${urlWithCursor(url, `${stop.line}.${stop.char}`)}:${rangeSuffix}]`,
		);
	else if (rangeSuffix !== "" && (lastKnown === undefined || stop.line < lastKnown))
		out.push(
			`[read lines ${first}-${stop.line}${of}; ${reason}; continue with ${urlWithCursor(url, String(nextLine))}:${rangeSuffix}]`,
		);
	return out.join("\n");
}

const RUN_TEXT_WINDOW = 64 * 1024;
const RUN_NATIVE_NODES = 256;
const TEXT_PACE_EVERY = 256;
const MAX_PARKED_RUN_STREAMS = 16;

interface PaceBox {
	budget: HistoryCallBudget;
}

interface ParkedRunStream {
	readonly pacer: PaceBox;
	readonly iterator: AsyncIterator<string>;
	readonly buffer: string[];
	readonly baseLine: number;
	readonly totalRead: number;
	readonly eof: boolean;
	readonly timer: ReturnType<typeof setTimeout>;
}

type RunJsonValue = WorkflowRunJsonValue | undefined;

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function* jsonStringPieces(text: string): Generator<string> {
	if (text.length <= RUN_TEXT_WINDOW) {
		yield JSON.stringify(text);
		return;
	}
	yield '"';
	for (let from = 0; from < text.length; ) {
		let to = Math.min(text.length, from + RUN_TEXT_WINDOW);
		if (to < text.length && isHighSurrogate(text.charCodeAt(to - 1))) to--;
		yield JSON.stringify(text.slice(from, to)).slice(1, -1);
		from = to;
	}
	yield '"';
}

function isJsonArray(value: object): value is readonly RunJsonValue[] {
	return Array.isArray(value);
}

function isPlainJson(value: object): boolean {
	if (isJsonArray(value)) return true;
	const prototype: object | null = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		typeof (value as { readonly toJSON?: (key: string) => RunJsonValue }).toJSON !== "function"
	);
}

function smallJson(value: RunJsonValue): boolean {
	const pending: RunJsonValue[] = [value];
	let nodes = 0;
	let chars = 0;
	while (pending.length > 0) {
		const next = pending.pop();
		if (++nodes > RUN_NATIVE_NODES) return false;
		if (typeof next === "string") {
			chars += next.length;
			if (chars > RUN_TEXT_WINDOW) return false;
		} else if (next !== null && typeof next === "object") {
			if (!isPlainJson(next)) return false;
			const children: readonly RunJsonValue[] = isJsonArray(next) ? next : Object.values(next);
			if (children.length > RUN_NATIVE_NODES) return false;
			for (const child of children) pending.push(child);
		}
	}
	return true;
}

type JsonFrame =
	| { readonly kind: "array"; readonly value: readonly RunJsonValue[]; index: number }
	| {
			readonly kind: "object";
			readonly value: WorkflowRunJsonObject;
			readonly keys: readonly string[];
			index: number;
			wrote: boolean;
	  };

function* jsonPieces(root: RunJsonValue): Generator<string> {
	const stack: JsonFrame[] = [];
	const ancestors = new Set<object>();
	let buffer = "";
	let next: { readonly value: RunJsonValue; readonly item: boolean } | undefined = { value: root, item: false };
	for (;;) {
		if (next !== undefined) {
			const { value, item } = next;
			next = undefined;
			if (typeof value === "string" && value.length > RUN_TEXT_WINDOW) {
				if (buffer !== "") yield buffer;
				buffer = "";
				yield* jsonStringPieces(value);
			} else if (value === null || typeof value !== "object" || smallJson(value) || !isPlainJson(value)) {
				buffer += JSON.stringify(value) ?? (item ? "null" : "undefined");
			} else {
				if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
				ancestors.add(value);
				if (isJsonArray(value)) {
					buffer += "[";
					stack.push({ kind: "array", value, index: 0 });
				} else {
					buffer += "{";
					stack.push({ kind: "object", value, keys: Object.keys(value), index: 0, wrote: false });
				}
			}
		}
		if (buffer.length >= RUN_TEXT_WINDOW) {
			yield buffer;
			buffer = "";
		}
		const frame = stack.at(-1);
		if (frame === undefined) break;
		if (frame.kind === "array") {
			if (frame.index < frame.value.length) {
				if (frame.index > 0) buffer += ",";
				next = { value: frame.value[frame.index], item: true };
				frame.index++;
				continue;
			}
			buffer += "]";
		} else {
			while (frame.index < frame.keys.length && next === undefined) {
				const key = frame.keys[frame.index]!;
				frame.index++;
				const value = frame.value[key];
				if (value === undefined || typeof value === "function" || typeof value === "symbol") continue;
				buffer += `${frame.wrote ? "," : ""}${JSON.stringify(key)}:`;
				frame.wrote = true;
				next = { value, item: true };
			}
			if (next !== undefined) continue;
			buffer += "}";
		}
		ancestors.delete(frame.value);
		stack.pop();
	}
	if (buffer !== "") yield buffer;
}

async function* wrappedPieces(pieces: Iterable<string>, pacer: PaceBox): AsyncGenerator<string> {
	let pending = "";
	for (const piece of pieces) {
		pending += piece;
		while (pending.length > RUN_TEXT_WINDOW) {
			const parts = wrapLine(pending.slice(0, RUN_TEXT_WINDOW));
			parts.pop();
			let used = 0;
			for (const part of parts) {
				used += part.length;
				yield part;
			}
			pending = pending.slice(used);
			await pacer.budget.pace();
		}
	}
	yield* wrapLine(pending);
}

function* segmentPieces(text: string, from: number, end: { at: number }): Generator<string> {
	for (let scan = from; scan < text.length; scan += RUN_TEXT_WINDOW) {
		const window = text.slice(scan, Math.min(text.length, scan + RUN_TEXT_WINDOW));
		const newline = window.indexOf("\n");
		if (newline !== -1) {
			end.at = scan + newline;
			yield window.slice(0, newline);
			return;
		}
		yield window;
	}
	end.at = -1;
}

async function* textLineStream(text: string, pacer: PaceBox): AsyncGenerator<string> {
	const end = { at: -1 };
	for (let from = 0, segments = 1; ; segments++) {
		yield* wrappedPieces(segmentPieces(text, from, end), pacer);
		if (end.at === -1) return;
		from = end.at + 1;
		if (segments % TEXT_PACE_EVERY === 0) await pacer.budget.pace();
	}
}

function* prefixedPieces(prefix: string, pieces: Iterable<string>): Generator<string> {
	yield prefix;
	yield* pieces;
}

function normalizeInlineReadSelection(
	url: string,
	selection: InternalReadSelection,
): { readonly url: string; readonly selection: InternalReadSelection } {
	if (selection.ranges !== undefined || selection.offset !== undefined || selection.raw) return { url, selection };
	const split = splitReadLineSelector(url);
	if (split.path === url && !split.raw) return { url, selection };
	return {
		url: split.path,
		selection: {
			...selection,
			...(split.ranges === undefined ? {} : { ranges: split.ranges }),
			...(split.offset === undefined ? {} : { offset: split.offset }),
			...(split.limit === undefined ? {} : { limit: split.limit }),
			...(split.raw ? { raw: true } : {}),
		},
	};
}

function normalizeInlineSearchRequest(
	url: string,
	request: InternalSearchRequest,
): { readonly url: string; readonly request: InternalSearchRequest } {
	if (request.ranges !== undefined) return { url, request };
	const split = splitLineRangeSelector(url);
	if (split.lineRanges === undefined) return { url, request };
	return { url: split.path, request: { ...request, ranges: split.lineRanges } };
}

const NATIVE_BATCH_CHARS = 64 * 1024;

interface RunSearchStart {
	readonly fromLine: number;
	readonly emittedThrough: number;
}

function formatStageZeroCursor(fromLine: number, emittedThrough: number): string {
	return emittedThrough > 0 ? `0.${fromLine}.${emittedThrough}` : `0.${fromLine}`;
}

async function evaluateRunLineBatch(
	lines: readonly string[],
	normalized: { readonly pattern: string; readonly flags: string },
	ignoreCase: boolean,
	literal: boolean,
	engine: "literal" | "native-only" | "both",
	budget: HistoryCallBudget,
): Promise<readonly number[] | "timedOut"> {
	if (!literal) {
		const joined = lines.join("\n");
		const safeText = engine === "native-only" ? joined.replaceAll("\0", "\ufffd") : joined;
		if (!safeText.includes("\0")) {
			try {
				const native = loadNativeSearchBinding()?.search?.(safeText, {
					pattern: normalized.pattern,
					ignoreCase,
					multiline: false,
					contextBefore: 0,
					contextAfter: 0,
				});
				if (native && !native.error) {
					return native.matches.map((match) => match.lineNumber - 1);
				}
			} catch {}
		}
		if (engine === "native-only") return [];
	}
	const workerResult = await matchLinesInWorker(
		lines,
		normalized.pattern,
		normalized.flags,
		ignoreCase,
		literal,
		budget.remainingMs(),
		budget.signal,
	);
	if (workerResult.timedOut) return "timedOut";
	return workerResult.matchedIndices;
}

async function searchRunLinesBounded(
	runId: string,
	label: string,
	createSource: (pacer: PaceBox) => AsyncIterable<string>,
	parkedStreams: Map<string, ParkedRunStream>,
	request: InternalSearchRequest,
	start: RunSearchStart,
	hasMoreStages: boolean,
	alreadyEmitted: boolean,
	onWindowCut: () => void,
	budget: HistoryCallBudget,
): Promise<{
	readonly lines: string[];
	readonly stopped?: { readonly reason: BudgetStop; readonly cursor: string };
}> {
	const normalized = normalizeSearchPattern(request.pattern, request.ignoreCase);
	const ignoreCase = normalized.flags.includes("i");
	const multiline = isMultilineSearchPattern(request.pattern, request.ignoreCase, request.literal);
	const engine = selectRegexEngine(normalized, request.literal, multiline);
	const shown =
		engine === "native-only" && !request.literal && !multiline
			? (line: string) => line.replaceAll("\0", "\ufffd")
			: (line: string) => line;

	const ranges = request.ranges && request.ranges.length > 0 ? mergeSeqRanges(request.ranges) : undefined;
	const maxRangeEnd = ranges?.at(-1)?.end;
	const inRange = (line: number): boolean =>
		ranges === undefined || ranges.some((range) => line >= range.start && line <= range.end);
	const nextSelectedLine = (from: number): number | undefined => {
		if (ranges === undefined) return from;
		for (const range of ranges) if (range.end >= from) return Math.max(from, range.start);
		return undefined;
	};

	const parkKey = (cursor: string): string =>
		JSON.stringify([
			runId,
			cursor,
			request.pattern,
			request.ignoreCase,
			request.literal,
			request.contextBefore,
			request.contextAfter,
			ranges ?? null,
		]);
	const startKey = parkKey(formatStageZeroCursor(start.fromLine, start.emittedThrough));
	const resumed = start.fromLine > 1 || start.emittedThrough > 0 ? parkedStreams.get(startKey) : undefined;
	if (resumed) {
		clearTimeout(resumed.timer);
		parkedStreams.delete(startKey);
	}

	const pacer: PaceBox = resumed ? resumed.pacer : { budget };
	pacer.budget = budget;
	const iterator = resumed ? resumed.iterator : createSource(pacer)[Symbol.asyncIterator]();
	const buffer = resumed ? resumed.buffer : [];
	let baseLine = resumed ? resumed.baseLine : 1;
	let totalRead = resumed ? resumed.totalRead : 0;
	let eof = resumed ? resumed.eof : false;
	const initialTotalRead = totalRead;
	let parked = false;

	const dropParked = (key: string, closeIterator: boolean): void => {
		const existing = parkedStreams.get(key);
		if (!existing) return;
		clearTimeout(existing.timer);
		parkedStreams.delete(key);
		if (closeIterator && existing.iterator !== iterator) void existing.iterator.return?.();
	};

	const parkAt = (cursor: string): void => {
		if (eof || !cursor.startsWith("0.")) return;
		const key = parkKey(cursor);
		dropParked(key, true);
		while (parkedStreams.size >= MAX_PARKED_RUN_STREAMS) {
			const oldestKey = parkedStreams.keys().next().value;
			if (oldestKey === undefined) break;
			dropParked(oldestKey, true);
		}
		const timer = setTimeout(() => {
			const expired = parkedStreams.get(key);
			if (!expired) return;
			parkedStreams.delete(key);
			void expired.iterator.return?.();
		}, DISCOVERY_TTL_MS);
		timer.unref?.();
		parkedStreams.set(key, {
			pacer,
			iterator,
			buffer,
			baseLine,
			totalRead,
			eof,
			timer,
		});
		parked = true;
	};

	const stopWith = (
		reason: BudgetStop,
		cursor: string,
	): { readonly lines: string[]; readonly stopped: { readonly reason: BudgetStop; readonly cursor: string } } => {
		parkAt(cursor);
		return { lines, stopped: { reason, cursor } };
	};

	const lineAt = (line: number): string => buffer[line - baseLine] ?? "";
	const sliceLines = (from: number, to: number): string[] =>
		buffer.slice(Math.max(0, from - baseLine), Math.max(0, to - baseLine + 1));

	const pullOne = async (): Promise<boolean> => {
		if (eof) return false;
		const next = await iterator.next();
		if (next.done) {
			eof = true;
			return false;
		}
		totalRead++;
		buffer.push(next.value);
		if (totalRead % LINE_PACE_EVERY === 0) await budget.pace();
		return true;
	};

	const ensureLine = async (targetLine: number): Promise<boolean> => {
		while (!eof && totalRead < targetLine) {
			await pullOne();
		}
		return totalRead >= targetLine;
	};

	const pendingSpans: { start: number; end: number }[] = [];
	const pushSpan = (startLine: number, endLine: number): void => {
		const prev = pendingSpans.at(-1);
		if (prev && prev.start === startLine) {
			prev.end = Math.max(prev.end, endLine);
		} else if (!prev || startLine > prev.start) {
			pendingSpans.push({ start: startLine, end: endLine });
		}
	};

	const trimBefore = (currentSliceStart: number): void => {
		const earliestMatch = pendingSpans[0]?.start ?? currentSliceStart;
		let keepFrom = Math.max(1, earliestMatch - request.contextBefore);
		if (multiline) {
			let lookbehindLine = currentSliceStart;
			let chars = 0;
			while (lookbehindLine > baseLine && chars < MATCH_SPAN_CHARS) {
				lookbehindLine--;
				chars += lineAt(lookbehindLine).length + 1;
			}
			keepFrom = Math.min(keepFrom, lookbehindLine);
		}
		if (keepFrom > baseLine) {
			const drop = Math.min(buffer.length, keepFrom - baseLine);
			if (drop >= 64) {
				buffer.splice(0, drop);
				baseLine += drop;
			}
		}
	};

	const lines: string[] = [];
	let emittedThrough = start.emittedThrough;
	let hasEmitted = alreadyEmitted;
	let scannedThrough = start.fromLine - 1;

	const advanceToLineBounded = async (targetLine: number): Promise<BudgetStop | undefined> => {
		while (!eof && totalRead < targetLine) {
			if (totalRead - initialTotalRead >= LINE_PACE_EVERY && budget.remainingMs() <= 0) {
				return "time";
			}
			await pullOne();
			trimBefore(Math.min(targetLine, totalRead + 1));
		}
		return undefined;
	};

	const flushReadySpans = async (
		flushAll: boolean,
	): Promise<{ readonly reason: BudgetStop; readonly cursor: string } | undefined> => {
		while (pendingSpans.length > 0) {
			const span = pendingSpans[0]!;
			const neededThrough = span.end + request.contextAfter;
			if (!flushAll && !eof && scannedThrough < neededThrough) break;
			await ensureLine(neededThrough);
			const nextSpan = pendingSpans[1];
			if (nextSpan !== undefined && nextSpan.start <= neededThrough) {
				nextSpan.end = Math.max(nextSpan.end, span.end);
			}
			const beforeStart = Math.max(1, span.start - request.contextBefore, emittedThrough + 1);
			const afterEnd =
				nextSpan !== undefined
					? Math.min(totalRead, neededThrough, nextSpan.start - 1)
					: Math.min(totalRead, neededThrough);
			const unitRows: { readonly line: number; readonly text: string; readonly isMatch: boolean }[] = [];
			for (let line = beforeStart; line < span.start; line++) {
				unitRows.push({
					line,
					text: formatSearchTextLine(label, line, shown(lineAt(line)), false),
					isMatch: false,
				});
			}
			if (span.start > emittedThrough) {
				unitRows.push({
					line: span.start,
					text: formatSearchTextLine(label, span.start, shown(lineAt(span.start)), true),
					isMatch: true,
				});
			}
			for (let line = Math.max(span.start + 1, emittedThrough + 1); line <= afterEnd; line++) {
				unitRows.push({
					line,
					text: formatSearchTextLine(label, line, shown(lineAt(line)), false),
					isMatch: false,
				});
			}
			const unitBytes = unitRows.reduce((sum, row) => sum + lineBytes(row.text), 0);
			if (budget.fits(unitBytes)) {
				for (const row of unitRows) {
					lines.push(row.text);
					budget.spend(lineBytes(row.text));
					emittedThrough = Math.max(emittedThrough, row.line);
					hasEmitted = true;
				}
				pendingSpans.shift();
				continue;
			}
			if (hasEmitted) {
				return { reason: "byte", cursor: formatStageZeroCursor(span.start, emittedThrough) };
			}
			const matchRow =
				unitRows.find((row) => row.isMatch)?.text ??
				formatSearchTextLine(label, span.start, shown(lineAt(span.start)), true);
			const matchBytes = lineBytes(matchRow);
			if (budget.fits(matchBytes)) {
				lines.push(matchRow);
				budget.spend(matchBytes);
				emittedThrough = Math.max(emittedThrough, span.start);
				hasEmitted = true;
				for (const row of unitRows) {
					if (row.line <= span.start) continue;
					if (!budget.fits(lineBytes(row.text))) break;
					lines.push(row.text);
					budget.spend(lineBytes(row.text));
					emittedThrough = Math.max(emittedThrough, row.line);
				}
				pendingSpans.shift();
			} else {
				const cut = cutTextToUtf8Bytes(matchRow, Math.max(32, budget.bytesAvailable()));
				lines.push(cut);
				budget.spend(lineBytes(cut));
				emittedThrough = Math.max(emittedThrough, span.start);
				hasEmitted = true;
				pendingSpans.shift();
			}
			if (pendingSpans.length > 0) {
				return { reason: "byte", cursor: formatStageZeroCursor(pendingSpans[0]!.start, emittedThrough) };
			}
			const moreLinesInRange = nextSelectedLine(span.start + 1) !== undefined && (await ensureLine(span.start + 1));
			if (moreLinesInRange) {
				return { reason: "byte", cursor: formatStageZeroCursor(span.start + 1, emittedThrough) };
			}
			if (hasMoreStages) {
				return { reason: "byte", cursor: "1.1" };
			}
			return undefined;
		}
		return undefined;
	};

	try {
		let sliceStart = Math.max(1, start.fromLine);
		const skipStop = await advanceToLineBounded(sliceStart);
		if (skipStop !== undefined) {
			return stopWith(skipStop, formatStageZeroCursor(sliceStart, emittedThrough));
		}
		let progressed = false;
		for (;;) {
			const nextStart = nextSelectedLine(sliceStart);
			if (nextStart === undefined) {
				scannedThrough = Number.POSITIVE_INFINITY;
				break;
			}
			if (nextStart > sliceStart) {
				sliceStart = nextStart;
				const gapStop = await advanceToLineBounded(sliceStart);
				if (gapStop !== undefined) {
					const resumeLine = pendingSpans[0]?.start ?? Math.max(start.fromLine, totalRead + 1);
					return stopWith(gapStop, formatStageZeroCursor(resumeLine, emittedThrough));
				}
			}
			if (!(await ensureLine(sliceStart))) {
				scannedThrough = totalRead;
				break;
			}
			if (budget.remainingMs() <= 0 && (progressed || totalRead - initialTotalRead >= LINE_PACE_EVERY)) {
				const resumeLine = pendingSpans[0]?.start ?? sliceStart;
				return stopWith("time", formatStageZeroCursor(resumeLine, emittedThrough));
			}

			let sliceEnd = sliceStart;
			let ownedChars = lineAt(sliceStart).length + 1;
			const batchLimitLine = maxRangeEnd ?? Number.POSITIVE_INFINITY;
			while (sliceEnd < batchLimitLine && budget.remainingMs() > 0 && (await ensureLine(sliceEnd + 1))) {
				const nextLen = lineAt(sliceEnd + 1).length + 1;
				if (ownedChars + nextLen > NATIVE_BATCH_CHARS) break;
				sliceEnd++;
				ownedChars += nextLen;
			}

			if (multiline) {
				let first = sliceStart;
				let leftChars = 0;
				while (first > baseLine && leftChars < MATCH_SPAN_CHARS) {
					first--;
					leftChars += lineAt(first).length + 1;
				}
				let last = sliceEnd;
				let aheadChars = 0;
				while (aheadChars < MATCH_SPAN_CHARS && (await ensureLine(last + 1))) {
					last++;
					aheadChars += lineAt(last).length + 1;
				}
				if (await ensureLine(last + 1)) onWindowCut();
				const windowLines = sliceLines(first, last);
				const text = windowLines.join("\n");
				const ownedTo = leftChars + ownedChars;
				let spans: readonly MultilineSpan[];
				if (engine === "native-only") {
					spans = matchMultilineNative(text, ownedTo, normalized, ignoreCase, windowLines.length + 1);
				} else {
					const res = await matchMultilineInWorker(
						text,
						leftChars,
						ownedTo,
						normalized.pattern,
						normalized.flags,
						ignoreCase,
						request.literal,
						budget.remainingMs(),
						budget.signal,
					);
					if (res.timedOut) {
						const resumeLine = pendingSpans[0]?.start ?? sliceStart;
						return stopWith("time", formatStageZeroCursor(resumeLine, emittedThrough));
					}
					spans = res.matches;
				}
				for (const span of spans) {
					const startLine = first + span.startLine;
					if (startLine < sliceStart || startLine > sliceEnd || !inRange(startLine)) continue;
					pushSpan(startLine, first + span.endLine);
				}
			} else {
				const batchLines = sliceLines(sliceStart, sliceEnd);
				const hits = await evaluateRunLineBatch(
					batchLines,
					normalized,
					ignoreCase,
					request.literal,
					engine,
					budget,
				);
				if (hits === "timedOut") {
					const resumeLine = pendingSpans[0]?.start ?? sliceStart;
					return stopWith("time", formatStageZeroCursor(resumeLine, emittedThrough));
				}
				for (const index of hits) {
					const startLine = sliceStart + index;
					if (!inRange(startLine)) continue;
					pushSpan(startLine, startLine);
				}
			}

			scannedThrough = sliceEnd;
			progressed = true;
			sliceStart = sliceEnd + 1;
			const stopped = await flushReadySpans(false);
			if (stopped !== undefined) return stopWith(stopped.reason, stopped.cursor);
			trimBefore(sliceStart);
			await budget.pace();
		}

		const stopped = await flushReadySpans(true);
		if (stopped !== undefined) return stopWith(stopped.reason, stopped.cursor);
		return { lines };
	} finally {
		if (!parked) await iterator.return?.();
	}
}

export function createHistoryRouter(sources: HistorySources): InternalResourceRouter {
	const limits: HistoryBudget = { ...DEFAULT_HISTORY_BUDGET, ...sources.budget };
	const newBudget = (signal: AbortSignal | undefined, noteBytes?: number) =>
		new HistoryCallBudget(limits, signal, noteBytes);
	const noteBytes = (
		url: string,
		target: HistoryTarget,
		ranges: readonly { readonly start: number; readonly end?: number }[] | undefined,
		searchLabels = 0,
		multiline = false,
	): number => {
		const widest = Number.MAX_SAFE_INTEGER;
		const selected = ranges?.map((range) => ({ start: range.start, end: range.end ?? widest })) ?? [
			{ start: widest, end: widest },
		];
		const cursor = `${widest}.${widest}.${widest}.${widest}`;
		const sessionId = target.domain === "sessions" ? target.id : undefined;
		const continuation =
			sessionId === undefined
				? `${urlWithCursor(url, cursor)}:${rangeText(selected)}`
				: sessionUrl(sessionId, target, cursor, selected);
		const label = sessionId === undefined ? urlWithCursor(url, undefined) : sessionUrl(sessionId, target);
		return (
			lineBytes(
				`[read up to entry ${widest} of ${widest}; the byte budget ran out; continue with ${continuation}]`,
			) +
			(searchLabels > 0 ? lineBytes(label) : 0) +
			(searchLabels > 1 ? lineBytes(sessionUrl(target.session ?? "", target)) : 0) +
			(multiline ? lineBytes(`${label}:0: [${MULTILINE_WINDOW_NOTE}]`) : 0)
		);
	};
	const bounded = (text: string): string => {
		if (Buffer.byteLength(text, "utf8") <= limits.bytes) return text;
		const diagnostic =
			"[History response cannot fit its byte budget; retry the same URL with a larger byte budget or a shorter URL.]";
		return Buffer.byteLength(diagnostic, "utf8") <= limits.bytes ? diagnostic : limits.bytes >= 1 ? "!" : "";
	};
	const parkedRunStreams = new Map<string, ParkedRunStream>();

	const projectScope = (target: HistoryTarget): { cwd?: string } =>
		target.project === "all"
			? {}
			: { cwd: target.project === undefined ? sources.cwd : resolvePath(target.project, sources.cwd) };

	const projectStore = (): SessionStore | undefined => sources.projectSessionStore?.() ?? sources.sessionStore();

	/** The store that holds session `id`, or the project's sessions without one. */
	const requireStore = (id?: string): SessionStore => {
		const store = id !== undefined && id === sources.currentSessionId ? sources.sessionStore() : projectStore();
		if (!store) throw new Error("Session history is unavailable: this session has no session store.");
		return store;
	};

	const requireWorkflows = (): WorkflowRunHistory => {
		const control = sources.workflows();
		if (!control)
			throw new Error("Workflow history is unavailable: no workflow run control is registered for this session.");
		return control;
	};

	const placeOf = (id: string, store: SessionStore, target: HistoryTarget): SessionPlace => ({
		store,
		sessionId: id,
		urlWith: (query, ranges) => sessionUrl(id, target, query.cursor, ranges),
	});

	async function discoverSessions(
		target: HistoryTarget,
		budget: HistoryCallBudget,
	): Promise<
		| { readonly sessions: SessionSummary[]; readonly stopped?: undefined }
		| { readonly sessions?: undefined; readonly stopped: { readonly reason: BudgetStop; readonly scanned: number } }
	> {
		const store = requireStore();
		const scope = projectScope(target);
		const scopeKey = JSON.stringify([scope.cwd ?? null]);
		let byScope = parkedDiscoveries.get(store);
		if (!byScope) {
			byScope = new Map<string, ParkedDiscovery>();
			parkedDiscoveries.set(store, byScope);
		}
		const isContinuation = target.cursor !== undefined && target.cursor.first === 0;
		let parked = isContinuation ? byScope.get(scopeKey) : undefined;
		const previous = byScope.get(scopeKey);
		if (previous) {
			clearTimeout(previous.timer);
			byScope.delete(scopeKey);
			if (previous !== parked) closeDiscovery(previous);
		}
		if (!parked) {
			const controller = new AbortController();
			const iterable = store.list({ ...scope, withoutSearchText: true, signal: controller.signal });
			parked = { iterator: iterable[Symbol.asyncIterator](), controller, items: [] };
		}
		const active = parked;
		const park = () => {
			const replaced = byScope.get(scopeKey);
			if (replaced && replaced !== active) closeDiscovery(replaced);
			byScope.delete(scopeKey);
			while (byScope.size >= MAX_PARKED_DISCOVERIES) {
				const oldestKey = byScope.keys().next().value;
				if (oldestKey === undefined) break;
				const oldest = byScope.get(oldestKey)!;
				byScope.delete(oldestKey);
				closeDiscovery(oldest);
			}
			active.timer = setTimeout(() => {
				if (byScope.get(scopeKey) !== active) return;
				byScope.delete(scopeKey);
				closeDiscovery(active);
			}, DISCOVERY_TTL_MS);
			active.timer.unref?.();
			byScope.set(scopeKey, active);
		};
		let progressed = false;
		try {
			for (;;) {
				const reason = budget.spent();
				if (reason && progressed) {
					park();
					return { stopped: { reason, scanned: parked.items.length } };
				}
				parked.pending ??= parked.iterator.next();
				const next = await budget.race(parked.pending);
				parked.pending = undefined;
				progressed = true;
				if (next.done) break;
				const summary = next.value;
				const modifiedMs = Date.parse(summary.modifiedAt);
				parked.items.push({ summary, modifiedMs: Number.isNaN(modifiedMs) ? 0 : modifiedMs });
				budget.takeRows(1);
				if (parked.items.length % 64 === 0) await budget.pace();
			}
		} catch (error) {
			if (isHistoryDeadlineError(error)) {
				park();
				return { stopped: { reason: "time", scanned: parked.items.length } };
			}
			closeDiscovery(parked);
			throw error;
		}
		await budget.pace();
		parked.items.sort(
			(a, b) => b.modifiedMs - a.modifiedMs || b.summary.createdAt.localeCompare(a.summary.createdAt),
		);
		return { sessions: parked.items.map((item) => item.summary) };
	}

	async function recentRuns(budget: HistoryCallBudget): Promise<WorkflowRunSummary[]> {
		const control = requireWorkflows();
		const runs = await budget.race(control.listProjectRuns?.() ?? control.listRuns({ includeDurable: true }));
		return [...runs].sort((a, b) => b.startedAt - a.startedAt);
	}

	async function belongsToProjectRun(runId: string, budget: HistoryCallBudget): Promise<boolean> {
		try {
			return (await recentRuns(budget)).some((run) => run.runId === runId);
		} catch (error) {
			if (budget.signal?.aborted) throw error;
			return false;
		}
	}

	async function authorizedSession(
		target: HistoryTarget,
		budget: HistoryCallBudget,
	): Promise<{ id: string; header: SessionRecordHeader }> {
		const id = target.id ?? "";
		const header = await budget.race(requireStore(id).readHeader(id));
		if (!header) throw new Error(`Session not found: ${id}`);
		if (id === sources.currentSessionId) return { id, header };
		const { cwd } = projectScope(target);
		if (cwd === undefined || createSessionCwdMatcher(cwd)(header.cwd)) return { id, header };
		// A stage session can run in its own directory or worktree; the project's run vouches for it.
		if (target.project === undefined && header.workflow && (await belongsToProjectRun(header.workflow.runId, budget)))
			return { id, header };
		throw new Error(
			`Session ${id} belongs to another project. History is limited to the current project unless the user asks for other projects.`,
		);
	}

	async function listSessions(
		target: HistoryTarget,
		budget: HistoryCallBudget,
	): Promise<{ readonly text: string; readonly preselected?: true }> {
		const scope =
			target.project === "all" ? "all projects" : target.project === undefined ? "this project" : target.project;
		const discovered = await discoverSessions(target, budget);
		if (discovered.stopped !== undefined) {
			const contUrl = pageUrl("sessions", target, target.offset, `0.${discovered.stopped.scanned}`);
			return {
				text: `# sessions in ${scope}\n[scanned ${discovered.stopped.scanned} sessions so far; ${stopText(discovered.stopped.reason)}; continue with ${contUrl}]`,
				preselected: true,
			};
		}
		const sessions = discovered.sessions;
		const shown = sessions.slice(target.offset, target.offset + target.limit);
		const next = target.offset + shown.length;
		return {
			text: [
				`# sessions ${windowText(sessions.length, target.offset, shown.length)} in ${scope}, newest first${next < sessions.length ? `; next page: ${pageUrl("sessions", target, next)}` : ""}`,
				...shown.map((summary) =>
					[
						sessionUrl(summary.id, target),
						timestamp(summary.modifiedAt),
						`${summary.messageCount} messages`,
						...(summary.id === sources.currentSessionId ? ["current session"] : []),
						...(summary.workflow
							? [`workflow stage ${summary.workflow.stageName} (run ${summary.workflow.runId})`]
							: []),
						...(target.project === undefined ? [] : [summary.cwd]),
						sessionLabel(summary),
					].join(" | "),
				),
			].join("\n"),
		};
	}

	async function listWorkflows(target: HistoryTarget, budget: HistoryCallBudget): Promise<string> {
		const runs = await recentRuns(budget);
		const shown = runs.slice(target.offset, target.offset + budget.rowAllowance(target.limit));
		budget.takeRows(shown.length);
		const next = target.offset + shown.length;
		return [
			`# workflow runs ${windowText(runs.length, target.offset, shown.length)} in this project, newest first${next < runs.length ? `; next page: ${pageUrl("workflows", target, next)}` : ""}`,
			...shown.map((run) =>
				[
					`history://workflows/${run.runId}`,
					timestamp(run.startedAt),
					run.status,
					run.name,
					...(run.identity && run.identity !== run.name ? [oneLine(run.identity, LABEL_LIMIT)] : []),
					...(run.summary ? [oneLine(run.summary, LABEL_LIMIT)] : []),
				].join(" | "),
			),
		].join("\n");
	}

	async function* runLines(detail: WorkflowRunDetail, pacer: PaceBox): AsyncGenerator<string> {
		yield `# workflow run ${detail.runId}`;
		yield `name: ${detail.name}`;
		yield `status: ${detail.status}`;
		yield `started: ${timestamp(detail.startedAt)}`;
		if (detail.endedAt !== undefined) yield `ended: ${timestamp(detail.endedAt)}`;
		if (detail.identity) yield* textLineStream(`label: ${detail.identity}`, pacer);
		if (detail.summary) yield* textLineStream(`summary: ${detail.summary}`, pacer);
		yield* wrappedPieces(prefixedPieces("inputs: ", jsonPieces(detail.inputs)), pacer);
		yield "stages:";
		for (const [index, stage] of detail.stages.entries()) {
			yield [
				`- ${stage.name} [${stage.status}]`,
				...(stage.sessionId ? [`transcript history://sessions/${stage.sessionId}`] : []),
			].join(" ");
			if (stage.error) yield* textLineStream(`  error: ${stage.error}`, pacer);
			if ((index + 1) % TEXT_PACE_EVERY === 0) await pacer.budget.pace();
		}
		if (detail.result !== undefined)
			yield* wrappedPieces(prefixedPieces("result: ", jsonPieces(detail.result)), pacer);
		if (detail.error) yield* textLineStream(`error: ${detail.error}`, pacer);
	}

	async function authorizedRunId(id: string, budget: HistoryCallBudget): Promise<string> {
		const runs = await recentRuns(budget);
		const exact = runs.find((run) => run.runId === id);
		if (exact) return exact.runId;
		const prefixed = runs.filter((run) => run.runId.startsWith(id));
		if (prefixed.length === 1) return prefixed[0]!.runId;
		throw new Error(
			prefixed.length > 1
				? `Workflow run id is ambiguous: ${id}`
				: `Workflow run not found in this project's history: ${id}`,
		);
	}

	async function readRun(id: string, budget: HistoryCallBudget): Promise<AsyncIterable<string>> {
		const runId = await authorizedRunId(id, budget);
		const detail = await budget.race(requireWorkflows().getRun(runId));
		budget.takeRows(1);
		return runLines(detail, { budget });
	}

	async function readSession(
		target: HistoryTarget,
		selection: InternalReadSelection,
		budget: HistoryCallBudget,
	): Promise<string> {
		const { id, header } = await authorizedSession(target, budget);
		const place = placeOf(id, requireStore(id), target);
		const headerLines = transcriptHeaderLines(header, target.project === undefined);
		const cursor: SeqCursor | undefined =
			target.cursor === undefined
				? undefined
				: {
						seq: Math.max(1, target.cursor.first),
						line: target.cursor.second,
						char: target.cursor.third,
					};
		const ranges: SeqRange[] | undefined =
			selection.ranges !== undefined && selection.ranges.length > 0
				? selection.ranges.map((range) => ({ start: range.start, end: range.end ?? Number.MAX_SAFE_INTEGER }))
				: selection.offset !== undefined
					? [
							{
								start: selection.offset,
								end:
									selection.limit === undefined
										? Number.MAX_SAFE_INTEGER
										: selection.offset + selection.limit - 1,
							},
						]
					: undefined;
		if (ranges !== undefined) return readSessionRanges(place, ranges, selection.raw === true, cursor, budget);
		if (cursor !== undefined) {
			if (cursor.line > 0 || cursor.char > 0) {
				return readSessionRanges(
					place,
					[{ start: cursor.seq, end: Number.MAX_SAFE_INTEGER }],
					selection.raw === true,
					cursor,
					budget,
				);
			}
			return outlineSession(place, headerLines, cursor.seq, budget);
		}
		return readWholeOrOutline(place, headerLines, budget, WHOLE_SESSION_ENTRY_LIMIT);
	}

	/** The first line of a windowed search, labelled so the search tool keeps it beside matches. */
	function coverage(
		domain: Domain,
		target: HistoryTarget,
		total: number,
		shown: number,
		unreadable: number,
		ranges?: readonly SeqRange[],
	): string[] {
		const end = target.offset + shown;
		if (target.offset === 0 && end >= total && unreadable === 0) return [];
		return [
			`${pageUrl(domain, target, target.offset)}:0: [searched ${domain} ${windowText(total, target.offset, shown)}${unreadable > 0 ? `, ${unreadable} unreadable` : ""}${end < total ? `; continue with ${pageUrl(domain, target, end, undefined, ranges)}` : ""}]`,
		];
	}

	function stoppedCoverage(
		domain: Domain,
		label: string,
		target: HistoryTarget,
		total: number,
		searched: number,
		unreadable: number,
		reason: BudgetStop,
		continuation: string,
		where: string,
	): string {
		return `${pageUrl(domain, target, target.offset)}:0: [searched ${label} ${windowText(total, target.offset, searched)}${unreadable > 0 ? `, ${unreadable} unreadable` : ""}; ${stopText(reason)}${where}; continue with ${continuation}]`;
	}

	const rethrowAbort = (budget: HistoryCallBudget, error: unknown): void => {
		if (budget.signal?.aborted) throw error;
	};

	async function searchOneSession(
		id: string,
		target: HistoryTarget,
		request: InternalSearchRequest,
		prefilter: LiteralQuery | undefined,
		fromSeq: number,
		fromMatchIndex: number,
		fromLineOffset: number,
		budget: HistoryCallBudget,
		store = requireStore(id),
	) {
		const place = placeOf(id, store, target);
		return searchSession({
			place,
			label: sessionUrl(id, target),
			request,
			prefilter,
			fromSeq,
			fromMatchIndex,
			fromLineOffset,
			ranges: request.ranges,
			budget,
		});
	}

	async function searchSessions(
		target: HistoryTarget,
		request: InternalSearchRequest,
		prefilter: LiteralQuery | undefined,
		budget: HistoryCallBudget,
	): Promise<string[]> {
		if (target.id !== undefined) {
			const fromSeq = Math.max(1, target.cursor?.first ?? 1);
			const fromMatchIndex = target.cursor?.second ?? 0;
			const fromLineOffset = target.cursor?.third ?? 0;
			let id: string;
			try {
				id = (await authorizedSession(target, budget)).id;
			} catch (error) {
				if (isHistoryDeadlineError(error)) {
					const rawId = target.id;
					const cursor = formatSearchCursor({
						seq: fromSeq,
						matchIndex: fromMatchIndex,
						...(fromLineOffset > 0 ? { lineOffset: fromLineOffset } : {}),
					});
					const label = sessionUrl(rawId, target);
					return [
						charged(
							budget,
							`${label}:0: [the time budget ran out waiting for the store; continue with ${sessionUrl(rawId, target, target.cursor ? cursor : undefined, request.ranges)}]`,
						),
					];
				}
				throw error;
			}
			const result = await searchOneSession(
				id,
				target,
				request,
				prefilter,
				fromSeq,
				fromMatchIndex,
				fromLineOffset,
				budget,
			);
			const label = sessionUrl(id, target);
			const windowNote = result.windowCut ? [charged(budget, `${label}:0: [${MULTILINE_WINDOW_NOTE}]`)] : [];
			if (!result.stopped) return [...windowNote, ...result.lines];
			const resume = result.stopped.resume;
			const coveredEnd = Math.max(
				result.coveredFromSeq,
				resume.matchIndex > 0 || (resume.lineOffset ?? 0) > 0
					? resume.seq
					: Math.min(result.lastSeq || resume.seq, resume.seq - 1),
			);
			const remainingRanges =
				request.ranges === undefined
					? undefined
					: mergeSeqRanges(request.ranges)
							.filter((range) => range.end >= resume.seq)
							.map((range) => ({
								start: Math.max(range.start, resume.seq),
								end:
									Number.isFinite(result.lastSeq) && result.lastSeq > 0
										? Math.min(range.end, result.lastSeq)
										: range.end,
							}))
							.filter((range) => range.start <= range.end);
			const cursor = formatSearchCursor(resume);
			const totalText = Number.isFinite(result.lastSeq) && result.lastSeq > 0 ? ` of ${result.lastSeq}` : "";
			return [
				charged(
					budget,
					`${label}:0: [searched entries ${result.coveredFromSeq}-${coveredEnd}${totalText}; ${stopText(result.stopped.reason)}; continue with ${sessionUrl(id, target, cursor, remainingRanges)}]`,
				),
				...windowNote,
				...result.lines,
			];
		}
		const discovered = await discoverSessions(target, budget);
		if (discovered.stopped !== undefined) {
			const contUrl = pageUrl("sessions", target, target.offset, `0.${discovered.stopped.scanned}`, request.ranges);
			return [
				charged(
					budget,
					`${pageUrl("sessions", target, target.offset)}:0: [searched sessions 0 of ${discovered.stopped.scanned}+; ${stopText(discovered.stopped.reason)} after scanning ${discovered.stopped.scanned} sessions; continue with ${contUrl}]`,
				),
			];
		}
		const store = requireStore();
		const candidates = discovered.sessions.filter((summary) => summary.id !== sources.currentSessionId);
		const resuming = target.cursor !== undefined && target.cursor.first > 0;
		const pinned =
			resuming && target.session !== undefined
				? candidates.find((summary) => summary.id === target.session)
				: undefined;
		const pinnedGone = resuming && target.session !== undefined && pinned === undefined;
		const window =
			pinned === undefined
				? candidates.slice(target.offset, target.offset + target.limit)
				: [
						pinned,
						...candidates
							.slice(target.offset + 1, target.offset + target.limit)
							.filter((summary) => summary.id !== pinned.id),
					];
		const out: string[] = [];
		const notes: string[] = pinnedGone
			? [
					charged(
						budget,
						`${pageUrl("sessions", target, target.offset)}:0: [session ${target.session} is no longer listed, so the search could not resume in it; it continued with the sessions after it]`,
					),
				]
			: [];
		let windowCut = false;
		let unreadable = 0;
		const finished = (lines: readonly string[]) => [
			...lines,
			...notes,
			...(windowCut
				? [charged(budget, `${pageUrl("sessions", target, target.offset)}:0: [${MULTILINE_WINDOW_NOTE}]`)]
				: []),
			...out,
		];
		for (const [index, summary] of window.entries()) {
			const spent = budget.spent();
			if (spent && index > 0)
				return finished([
					charged(
						budget,
						stoppedCoverage(
							"sessions",
							"sessions",
							target,
							candidates.length,
							index,
							unreadable,
							spent,
							pageUrl("sessions", target, target.offset + index, undefined, request.ranges),
							"",
						),
					),
				]);
			const resumesHere = index === 0 && resuming && !pinnedGone;
			const fromSeq = resumesHere ? target.cursor!.first : 1;
			const fromMatchIndex = resumesHere ? target.cursor!.second : 0;
			const fromLineOffset = resumesHere ? target.cursor!.third : 0;
			try {
				const result = await searchOneSession(
					summary.id,
					target,
					request,
					prefilter,
					fromSeq,
					fromMatchIndex,
					fromLineOffset,
					budget,
					store,
				);
				out.push(...result.lines);
				windowCut ||= result.windowCut;
				if (result.stopped) {
					const cursor = formatSearchCursor(result.stopped.resume);
					const totalText = Number.isFinite(result.lastSeq) && result.lastSeq > 0 ? ` of ${result.lastSeq}` : "";
					return finished([
						charged(
							budget,
							stoppedCoverage(
								"sessions",
								"sessions",
								target,
								candidates.length,
								index + 1,
								unreadable,
								result.stopped.reason,
								pageUrl("sessions", target, target.offset + index, cursor, request.ranges, summary.id),
								` at entry ${result.stopped.resume.seq}${totalText} in ${sessionUrl(summary.id, target)}`,
							),
						),
					]);
				}
			} catch (error) {
				if (isHistoryDeadlineError(error)) {
					const cursor = formatSearchCursor({
						seq: fromSeq,
						matchIndex: fromMatchIndex,
						...(fromLineOffset > 0 ? { lineOffset: fromLineOffset } : {}),
					});
					return finished([
						charged(
							budget,
							stoppedCoverage(
								"sessions",
								"sessions",
								target,
								candidates.length,
								index + 1,
								unreadable,
								"time",
								pageUrl("sessions", target, target.offset + index, cursor, request.ranges, summary.id),
								` in ${sessionUrl(summary.id, target)}`,
							),
						),
					]);
				}
				rethrowAbort(budget, error);
				unreadable++;
			}
		}
		return finished(
			coverage("sessions", target, candidates.length, window.length, unreadable, request.ranges).map((line) =>
				charged(budget, line),
			),
		);
	}

	/**
	 * Matches in one run and in its stages' transcripts. Stage sessions are internal, so session listings and session
	 * searches leave them out; the run reaches them. A stage that never saved a session has nothing to search.
	 */
	async function searchRun(
		runId: string,
		request: InternalSearchRequest,
		prefilter: LiteralQuery | undefined,
		start:
			| { readonly stage: number; readonly seq: number; readonly matchIndex: number; readonly lineOffset: number }
			| undefined,
		budget: HistoryCallBudget,
		alreadyEmitted = false,
	): Promise<{
		readonly lines: string[];
		readonly unreadable: number;
		readonly stopped?: { readonly reason: BudgetStop; readonly cursor: string };
	}> {
		const detail = await budget.race(requireWorkflows().getRun(runId));
		budget.takeRows(1);
		const lines: string[] = [];
		let windowNote: string | undefined;
		const withNote = (found: readonly string[]) => (windowNote === undefined ? [...found] : [windowNote, ...found]);
		const noteWindowCut = () => {
			windowNote ??= charged(budget, `history://workflows/${runId}:0: [${MULTILINE_WINDOW_NOTE}]`);
		};
		if (start === undefined || start.stage === 0) {
			const own = await searchRunLinesBounded(
				runId,
				`history://workflows/${runId}`,
				(pacer) => runLines(detail, pacer),
				parkedRunStreams,
				request,
				{
					fromLine: Math.max(1, start?.seq ?? 1),
					emittedThrough: start?.matchIndex ?? 0,
				},
				detail.stages.length > 0,
				alreadyEmitted,
				noteWindowCut,
				budget,
			);
			lines.push(...own.lines);
			if (own.stopped !== undefined) {
				return { lines: withNote(lines), unreadable: 0, stopped: own.stopped };
			}
		}
		const store = projectStore();
		let unreadable = 0;
		for (const [index, stage] of detail.stages.entries()) {
			const stageNumber = index + 1;
			if (start !== undefined && stageNumber < start.stage) continue;
			if (!store || !stage.sessionId) continue;
			const spent = budget.spent();
			if (spent && (alreadyEmitted || lines.length > 0 || stageNumber > (start?.stage ?? 1)))
				return { lines: withNote(lines), unreadable, stopped: { reason: spent, cursor: `${stageNumber}.1` } };
			try {
				if (!(await budget.race(store.readHeader(stage.sessionId)))) continue;
				budget.takeRows(1);
				const fromSeq = start !== undefined && stageNumber === start.stage ? Math.max(1, start.seq) : 1;
				const fromMatchIndex = start !== undefined && stageNumber === start.stage ? start.matchIndex : 0;
				const fromLineOffset = start !== undefined && stageNumber === start.stage ? start.lineOffset : 0;
				const result = await searchSession({
					place: placeOf(stage.sessionId, store, { limit: DEFAULT_LIMIT, offset: 0 }),
					label: `history://sessions/${stage.sessionId}`,
					request: { ...request, ranges: undefined },
					prefilter,
					fromSeq,
					fromMatchIndex,
					fromLineOffset,
					ranges: undefined,
					budget,
				});
				lines.push(...result.lines);
				if (result.windowCut) noteWindowCut();
				if (result.stopped) {
					const cursor = `${stageNumber}.${formatSearchCursor(result.stopped.resume)}`;
					return {
						lines: withNote(lines),
						unreadable,
						stopped: { reason: result.stopped.reason, cursor },
					};
				}
			} catch (error) {
				rethrowAbort(budget, error);
				unreadable++;
			}
		}
		return { lines: withNote(lines), unreadable };
	}

	async function searchWorkflows(
		target: HistoryTarget,
		request: InternalSearchRequest,
		prefilter: LiteralQuery | undefined,
		budget: HistoryCallBudget,
	): Promise<string[]> {
		requireWorkflows();
		const start =
			target.cursor === undefined
				? undefined
				: {
						stage: target.cursor.first,
						seq: target.cursor.second,
						matchIndex: target.cursor.third,
						lineOffset: target.cursor.fourth,
					};
		if (target.id !== undefined) {
			const runId = await authorizedRunId(target.id, budget);
			const { lines, unreadable, stopped } = await searchRun(runId, request, prefilter, start, budget);
			return [
				...(unreadable > 0
					? [charged(budget, `history://workflows/${runId}:0: [${unreadable} stage transcripts unreadable]`)]
					: []),
				...(stopped
					? [
							charged(
								budget,
								`history://workflows/${runId}:0: [${stopText(stopped.reason)}; continue with history://workflows/${runId}?cursor=${stopped.cursor}${request.ranges ? `:${rangeText(request.ranges)}` : ""}]`,
							),
						]
					: []),
				...lines,
			];
		}
		const runs = await recentRuns(budget);
		const window = runs.slice(target.offset, target.offset + target.limit);
		const out: string[] = [];
		let unreadable = 0;
		for (const [index, run] of window.entries()) {
			const spent = budget.spent();
			if (spent && index > 0)
				return [
					charged(
						budget,
						stoppedCoverage(
							"workflows",
							"workflow runs",
							target,
							runs.length,
							index,
							unreadable,
							spent,
							pageUrl("workflows", target, target.offset + index, undefined, request.ranges),
							"",
						),
					),
					...out,
				];
			try {
				const found = await searchRun(
					run.runId,
					request,
					prefilter,
					index === 0 ? start : undefined,
					budget,
					out.length > 0,
				);
				out.push(...found.lines);
				unreadable += found.unreadable;
				if (found.stopped)
					return [
						charged(
							budget,
							stoppedCoverage(
								"workflows",
								"workflow runs",
								target,
								runs.length,
								index + 1,
								unreadable,
								found.stopped.reason,
								pageUrl("workflows", target, target.offset + index, found.stopped.cursor, request.ranges),
								` in history://workflows/${run.runId}`,
							),
						),
						...out,
					];
			} catch (error) {
				rethrowAbort(budget, error);
				unreadable++;
			}
		}
		return [
			...coverage("workflows", target, runs.length, window.length, unreadable, request.ranges).map((line) =>
				charged(budget, line),
			),
			...out,
		];
	}

	async function readSelected(rawUrl: string, rawSelection: InternalReadSelection): Promise<string | undefined> {
		if (!rawUrl.startsWith("history://")) return undefined;
		const { url, selection } = normalizeInlineReadSelection(rawUrl, rawSelection);
		const target = parseTarget(url);
		if (target.domain === undefined) return bounded(HISTORY_HELP);
		const budget = newBudget(selection.signal, noteBytes(url, target, selection.ranges));
		try {
			if (target.domain === "sessions" && target.id !== undefined)
				return bounded(await readSession(target, selection, budget));
			if (target.domain === "sessions") {
				const listed = await listSessions(target, budget);
				if (listed.preselected) return bounded(listed.text);
				const lineCursor =
					target.cursor && target.cursor.first > 0
						? { line: target.cursor.first, char: target.cursor.second }
						: undefined;
				return bounded(await selectLines(url, listed.text.split("\n"), selection, lineCursor, budget));
			}
			const lines =
				target.id === undefined
					? (await listWorkflows(target, budget)).split("\n")
					: await readRun(target.id, budget);
			const lineCursor =
				target.cursor && target.cursor.first > 0
					? { line: target.cursor.first, char: target.cursor.second }
					: undefined;
			return bounded(await selectLines(url, lines, selection, lineCursor, budget));
		} catch (error) {
			if (isHistoryDeadlineError(error)) {
				return bounded(`[the time budget ran out waiting for the store; continue with ${rawUrl}]`);
			}
			throw error;
		}
	}

	return {
		read: (url) => readSelected(url, {}),
		readSelected,
		search: async (rawUrl, rawRequest) => {
			if (!rawUrl.startsWith("history://")) return undefined;
			const { url, request } = normalizeInlineSearchRequest(rawUrl, rawRequest);
			const target = parseTarget(url);
			const multiline = isMultilineSearchPattern(request.pattern, request.ignoreCase, request.literal);
			const budget = newBudget(
				request.signal,
				noteBytes(url, target, request.ranges, target.id === undefined ? 2 : 1, multiline),
			);
			selectRegexEngine(normalizeSearchPattern(request.pattern, request.ignoreCase), request.literal, multiline);
			const prefilter = multiline ? undefined : indexLiterals(request.pattern, request.ignoreCase, request.literal);
			try {
				if (target.domain === "sessions")
					return bounded((await searchSessions(target, request, prefilter, budget)).join("\n"));
				if (target.domain === "workflows")
					return bounded((await searchWorkflows(target, request, prefilter, budget)).join("\n"));
			} catch (error) {
				if (isHistoryDeadlineError(error)) {
					return bounded(`${url}:0: [the time budget ran out waiting for the store; continue with ${rawUrl}]`);
				}
				throw error;
			}
			const [sessions, workflows] = await Promise.allSettled([
				searchSessions(target, request, prefilter, budget),
				searchWorkflows(target, request, prefilter, budget),
			]);
			budget.signal?.throwIfAborted();
			if (sessions.status === "rejected" && workflows.status === "rejected") throw sessions.reason;
			// Line 0 carries notes about the search itself, so a source that failed is named even beside matches.
			const results = (domain: Domain, label: string, settled: PromiseSettledResult<string[]>): string[] =>
				settled.status === "fulfilled"
					? settled.value
					: [
							`history://${domain}:0: [${label} not searched: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}]`,
						];
			return bounded(
				[...results("sessions", "sessions", sessions), ...results("workflows", "workflow runs", workflows)].join(
					"\n",
				),
			);
		},
	};
}
