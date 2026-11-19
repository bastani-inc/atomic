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

import { createSessionCwdMatcherAsync } from "../../utils/canonical-path.ts";
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
import { indexLiterals, isMultilineSearchPattern, type LiteralQuery } from "./history-literals.js";
import { matchLinesInWorker } from "./history-regex-worker.js";
import { historyCursorCache, seekableHistoryStop } from "./history-search-continuations.js";
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
	matchMultilineWindow,
	mergeSeqRanges,
	oneLine,
	outlineSession,
	rangeText,
	readSessionRanges,
	readWholeOrOutline,
	type SearchResume,
	type SeqCursor,
	type SeqRange,
	type SessionPlace,
	type SessionSearchResult,
	searchSession,
	selectRegexEngine,
	stopText,
} from "./history-session.js";
import { entryLines, timestamp, transcriptHeaderLines, wrapLine } from "./history-transcript.js";
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

export type { HistoryBudget } from "./history-session.js";

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
	sessions: ["limit", "offset", "project", "cursor", "session", "after"],
	workflows: ["limit", "offset", "cursor", "run"],
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
	readonly run?: string;
	readonly after?: SessionKey;
	readonly cursor?: HistoryCursor;
}

interface SessionKey {
	readonly activeMs: number;
	readonly createdMs: number;
	readonly id: string;
}

const SESSION_KEY = /^(-?\d+)\.(-?\d+)(?:\.(.+))?$/s;

function timeMs(text: string): number {
	const ms = Date.parse(text);
	return Number.isNaN(ms) ? 0 : ms;
}

function sessionKey(summary: SessionSummary): SessionKey {
	return { activeMs: timeMs(summary.modifiedAt), createdMs: timeMs(summary.createdAt), id: summary.id };
}

function compareSessionKeys(a: SessionKey, b: SessionKey): number {
	return b.activeMs - a.activeMs || b.createdMs - a.createdMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function sessionKeyText(key: SessionKey, pinned?: string): string {
	return key.id === pinned ? `${key.activeMs}.${key.createdMs}` : `${key.activeMs}.${key.createdMs}.${key.id}`;
}

interface HistoryCursor {
	readonly first: number;
	readonly second: number;
	readonly third: number;
	readonly fourth: number;
}

function cursorText(cursor: HistoryCursor): string {
	const parts = [cursor.first, cursor.second, cursor.third, cursor.fourth];
	while (parts.length > 1 && parts.at(-1) === 0) parts.pop();
	return parts.join(".");
}

function positionCursor(target: HistoryTarget): string | undefined {
	return target.cursor !== undefined && target.cursor.first > 0 ? cursorText(target.cursor) : undefined;
}

interface ParkedDiscovery {
	readonly iterator: AsyncIterator<SessionSummary>;
	readonly controller: AbortController;
	readonly items: { readonly summary: SessionSummary; readonly key: SessionKey }[];
	pending?: Promise<IteratorResult<SessionSummary>>;
	timer?: ReturnType<typeof setTimeout>;
}

function closeDiscovery(discovery: ParkedDiscovery): void {
	clearTimeout(discovery.timer);
	discovery.controller.abort();
	void (async () => discovery.iterator.return?.())().catch(() => {});
}

const parkedDiscoveries = new WeakMap<SessionStore, Map<string, ParkedDiscovery>>();

interface ParkedRunListing {
	readonly runs: Promise<readonly WorkflowRunSummary[]>;
	readonly startedAt: number;
	readonly timer: ReturnType<typeof setTimeout>;
}

const publicRunListings = new WeakMap<WorkflowRunHistory, ParkedRunListing>();

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
	const run = params.get("run") ?? undefined;
	if (run === "") throw new Error("history run must be a workflow run id");
	const afterText = params.get("after");
	const afterMatch = afterText === null ? undefined : SESSION_KEY.exec(afterText);
	const afterId = afterMatch?.[3] ?? session;
	if (afterText !== null && (!afterMatch || afterId === undefined))
		throw new Error(`history after must be the position a session search gave: ${afterText}`);
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
		...(run === undefined ? {} : { run }),
		...(afterMatch && afterId !== undefined
			? { after: { activeMs: Number(afterMatch[1]), createdMs: Number(afterMatch[2]), id: afterId } }
			: {}),
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
	pinned?: string,
	after?: SessionKey,
): string {
	const params = new URLSearchParams();
	if (offset > 0) params.set("offset", String(offset));
	if (target.limit !== DEFAULT_LIMIT) params.set("limit", String(target.limit));
	if (domain === "sessions" && target.project !== undefined) params.set("project", target.project);
	if (pinned !== undefined) params.set(domain === "sessions" ? "session" : "run", pinned);
	if (cursor !== undefined) params.set("cursor", cursor);
	if (after !== undefined) params.set("after", sessionKeyText(after, pinned));
	const query = params.toString();
	return `history://${domain}${query ? `?${query}` : ""}${ranges && ranges.length > 0 ? `:${rangeText(ranges)}` : ""}`;
}

function skippedClauses(seq: number | undefined, where = ""): readonly string[] {
	return seq === undefined
		? [""]
		: [
				`; entry ${seq}${where} not searched: the pattern ran past the time budget on it`,
				`; entry ${seq}${where} not searched`,
			];
}

function linesBytes(lines: readonly string[]): number {
	return lines.reduce((sum, line) => sum + lineBytes(line), 0);
}

function fittingLine(make: (clause: string) => string, clauses: readonly string[], room: number): string {
	const lines = clauses.map(make);
	return lines.find((line) => lineBytes(line) <= room) ?? lines[0]!;
}

function runPinBytes(runId: string): number {
	return lineBytes(` in history://workflows/${runId}`) + lineBytes(`&${new URLSearchParams({ run: runId })}`);
}

function exactLineSuffix(selection: InternalReadSelection): string {
	const ranges =
		selection.ranges !== undefined && selection.ranges.length > 0
			? mergeReadRanges(selection.ranges, Number.POSITIVE_INFINITY, selection.raw !== true)
			: selection.offset !== undefined
				? [
						{
							start: selection.offset,
							end:
								selection.limit === undefined
									? Number.POSITIVE_INFINITY
									: selection.offset + selection.limit - 1,
						},
					]
				: [];
	if (ranges.length === 0) return "";
	return `:${ranges.map((range) => `${range.start}-${Number.isFinite(range.end) ? range.end : ""}`).join(",")}`;
}

function lineSuffix(selection: InternalReadSelection): string {
	if (selection.ranges !== undefined && selection.ranges.length > 0)
		return `:${selection.ranges.map((range) => `${range.start}-${range.end ?? ""}`).join(",")}${selection.raw ? ":raw" : ""}`;
	if (selection.offset === undefined) return selection.raw ? ":raw" : "";
	const end = selection.limit === undefined ? "" : String(selection.offset + selection.limit - 1);
	return `:${selection.offset}-${end}${selection.raw || end !== "" ? ":raw" : ""}`;
}

function entrySuffix(selection: InternalReadSelection): string {
	const ranges =
		selection.ranges !== undefined && selection.ranges.length > 0
			? selection.ranges
			: selection.offset !== undefined
				? [
						{
							start: selection.offset,
							...(selection.limit === undefined ? {} : { end: selection.offset + selection.limit - 1 }),
						},
					]
				: [];
	const text = ranges.map((range) => `${range.start}-${range.end ?? ""}`).join(",");
	return `${text === "" ? "" : `:${text}`}${selection.raw ? ":raw" : ""}`;
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
				const cut = await ensureLine(last + 1);
				if (cut) onWindowCut();
				const windowLines = sliceLines(first, last);
				const spans = await matchMultilineWindow(
					{
						text: windowLines.join("\n"),
						lineCount: windowLines.length,
						ownedFrom: leftChars,
						ownedTo: leftChars + ownedChars,
						cut,
						entryStart: first === 1 ? 0 : -1,
					},
					normalized,
					ignoreCase,
					request.literal,
					engine,
					budget,
				);
				if (spans === "timedOut") {
					const resumeLine = pendingSpans[0]?.start ?? sliceStart;
					return stopWith("time", formatStageZeroCursor(resumeLine, emittedThrough));
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
		pin?: string,
	): Promise<
		| { readonly sessions: SessionSummary[]; readonly keys: SessionKey[]; readonly stopped?: undefined }
		| {
				readonly sessions?: undefined;
				readonly stopped: { readonly reason: BudgetStop; readonly scanned: number; readonly cursor: string };
		  }
	> {
		const store = requireStore();
		const scope = projectScope(target);
		const keyOf = (cursor: string) => JSON.stringify([scope.cwd ?? null, cursor, pin ?? null]);
		const discoveries = historyCursorCache(parkedDiscoveries, () => new WeakMap());
		let parkedHere = discoveries.get(store);
		if (!parkedHere) {
			parkedHere = new Map<string, ParkedDiscovery>();
			discoveries.set(store, parkedHere);
		}
		const byKey = parkedHere;
		const requestKey = target.cursor === undefined ? undefined : keyOf(cursorText(target.cursor));
		let parked = requestKey === undefined ? undefined : byKey.get(requestKey);
		if (parked && requestKey !== undefined) {
			clearTimeout(parked.timer);
			byKey.delete(requestKey);
		}
		if (!parked) {
			const controller = new AbortController();
			const iterable = store.list({ ...scope, withoutSearchText: true, signal: controller.signal });
			parked = { iterator: iterable[Symbol.asyncIterator](), controller, items: [] };
		}
		const active = parked;
		const park = (reason: BudgetStop) => {
			const position = positionCursor(target);
			const cursor = position ?? `0.${active.items.length}`;
			const key = keyOf(position ?? cursorText({ first: 0, second: active.items.length, third: 0, fourth: 0 }));
			const replaced = byKey.get(key);
			if (replaced && replaced !== active) closeDiscovery(replaced);
			byKey.delete(key);
			while (byKey.size >= MAX_PARKED_DISCOVERIES) {
				const oldestKey = byKey.keys().next().value;
				if (oldestKey === undefined) break;
				const oldest = byKey.get(oldestKey)!;
				byKey.delete(oldestKey);
				closeDiscovery(oldest);
			}
			active.timer = setTimeout(() => {
				if (byKey.get(key) !== active) return;
				byKey.delete(key);
				closeDiscovery(active);
			}, DISCOVERY_TTL_MS);
			active.timer.unref?.();
			byKey.set(key, active);
			return { stopped: { reason, scanned: active.items.length, cursor } };
		};
		let progressed = false;
		try {
			for (;;) {
				const reason = budget.spent();
				if (reason && progressed) return park(reason);
				parked.pending ??= parked.iterator.next();
				const next = await budget.race(parked.pending);
				parked.pending = undefined;
				progressed = true;
				if (next.done) break;
				const summary = next.value;
				parked.items.push({ summary, key: sessionKey(summary) });
				budget.takeRows(1);
				if (parked.items.length % 64 === 0) await budget.pace();
			}
		} catch (error) {
			if (isHistoryDeadlineError(error)) return park("time");
			closeDiscovery(parked);
			throw error;
		}
		await budget.pace();
		parked.items.sort((a, b) => compareSessionKeys(a.key, b.key));
		return { sessions: parked.items.map((item) => item.summary), keys: parked.items.map((item) => item.key) };
	}

	async function recentRuns(budget: HistoryCallBudget, wanted?: string, fresh = false): Promise<WorkflowRunSummary[]> {
		const control = requireWorkflows();
		const parkedRunListings = historyCursorCache(publicRunListings, () => new WeakMap());
		const parked = fresh ? undefined : parkedRunListings.get(control);
		if (parked) {
			clearTimeout(parked.timer);
			parkedRunListings.delete(control);
		}
		const adopted =
			parked !== undefined && performance.now() - parked.startedAt < DISCOVERY_TTL_MS ? parked : undefined;
		const listing = adopted?.runs ?? control.listProjectRuns?.() ?? control.listRuns({ includeDurable: true });
		const startedAt = adopted?.startedAt ?? performance.now();
		let runs: readonly WorkflowRunSummary[];
		try {
			runs = await budget.race(listing);
		} catch (error) {
			const current = parkedRunListings.get(control);
			if (isHistoryDeadlineError(error) && (current === undefined || current.startedAt > startedAt)) {
				clearTimeout(current?.timer);
				const timer = setTimeout(() => {
					if (parkedRunListings.get(control)?.runs === listing) parkedRunListings.delete(control);
				}, DISCOVERY_TTL_MS);
				timer.unref?.();
				parkedRunListings.set(control, { runs: listing, startedAt, timer });
			}
			throw error;
		}
		if (adopted && wanted !== undefined && !runs.some((run) => run.runId.startsWith(wanted)))
			return recentRuns(budget, undefined, true);
		return [...runs].sort((a, b) => b.startedAt - a.startedAt);
	}

	async function belongsToProjectRun(runId: string, budget: HistoryCallBudget): Promise<boolean> {
		try {
			return (await recentRuns(budget, runId)).some((run) => run.runId === runId);
		} catch (error) {
			if (budget.signal?.aborted || isHistoryDeadlineError(error)) throw error;
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
		if (cwd === undefined || (await createSessionCwdMatcherAsync(cwd)(header.cwd))) return { id, header };
		// A stage session can run in its own directory or worktree; the project's run vouches for it.
		if (target.project === undefined && header.workflow && (await belongsToProjectRun(header.workflow.runId, budget)))
			return { id, header };
		throw new Error(
			`Session ${id} belongs to another project. History is limited to the current project unless the user asks for other projects.`,
		);
	}

	async function listSessions(
		target: HistoryTarget,
		selection: InternalReadSelection,
		budget: HistoryCallBudget,
	): Promise<{ readonly text: string; readonly preselected?: true }> {
		const scope =
			target.project === "all" ? "all projects" : target.project === undefined ? "this project" : target.project;
		const discovered = await discoverSessions(target, budget);
		if (discovered.stopped !== undefined) {
			const suffix = positionCursor(target) === undefined ? lineSuffix(selection) : exactLineSuffix(selection);
			const contUrl = `${pageUrl("sessions", target, target.offset, discovered.stopped.cursor)}${suffix}`;
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
						`${summary.estimated ? "at least " : ""}${summary.messageCount} messages`,
						...(summary.estimated ? ["metadata may be incomplete"] : []),
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
		const runs = await recentRuns(budget, id);
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
		budget.holdProgressFloor();
		const detail = await budget.race(requireWorkflows().getRun(runId));
		budget.markProgress();
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
			return outlineSession(
				place,
				headerLines,
				cursor.seq,
				budget,
				target.cursor !== undefined && target.cursor.fourth > 0 ? target.cursor.fourth : undefined,
			);
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
		nextPin?: string,
		after?: SessionKey,
	): string[] {
		const end = target.offset + shown;
		if (target.offset === 0 && end >= total && unreadable === 0) return [];
		return [
			`${pageUrl(domain, target, target.offset)}:0: [searched ${domain} ${windowText(total, target.offset, shown)}${unreadable > 0 ? `, ${unreadable} unreadable` : ""}${end < total ? `; continue with ${pageUrl(domain, target, end, undefined, ranges, nextPin, after)}` : ""}]`,
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
		continuation: string | undefined,
		where: string,
	): string {
		return `${pageUrl(domain, target, target.offset)}:0: [searched ${label} ${windowText(total, target.offset, searched)}${unreadable > 0 ? `, ${unreadable} unreadable` : ""}; ${stopText(reason)}${where}${continuation === undefined ? "" : `; continue with ${continuation}`}]`;
	}

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
		emittedBefore = false,
		deferCut = false,
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
			emittedBefore,
			deferCut,
		});
	}

	async function searchSessions(
		target: HistoryTarget,
		request: InternalSearchRequest,
		prefilter: LiteralQuery | undefined,
		budget: HistoryCallBudget,
	): Promise<(room: number) => string[]> {
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
					const lines = [
						charged(
							budget,
							`${label}:0: [the time budget ran out waiting for the store; continue with ${sessionUrl(rawId, target, target.cursor ? cursor : undefined, request.ranges)}]`,
						),
					];
					return () => lines;
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
			if (!result.stopped) {
				const lines = [...windowNote, ...result.lines];
				return () => lines;
			}
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
			const reason = stopText(result.stopped.reason);
			// Unlike discovery and workflow line streams, this position is seekable without a parked iterator.
			const url = sessionUrl(id, target, cursor, remainingRanges);
			return (room) => [
				seekableHistoryStop(
					fittingLine(
						(clause) =>
							`${label}:0: [searched entries ${result.coveredFromSeq}-${coveredEnd}${totalText}; ${reason}${clause}; continue with ${url}]`,
						skippedClauses(result.skipped),
						room - linesBytes([...windowNote, ...result.lines]),
					),
					url,
				),
				...windowNote,
				...result.lines,
			];
		}
		const pin = positionCursor(target) === undefined ? undefined : target.session;
		const discovered = await discoverSessions(target, budget, pin);
		if (discovered.stopped !== undefined) {
			const contUrl = pageUrl(
				"sessions",
				target,
				target.offset,
				discovered.stopped.cursor,
				request.ranges,
				pin,
				target.after,
			);
			const lines = [
				charged(
					budget,
					`${pageUrl("sessions", target, target.offset)}:0: [searched sessions 0 of ${discovered.stopped.scanned}+; ${stopText(discovered.stopped.reason)} after scanning ${discovered.stopped.scanned} sessions; continue with ${contUrl}]`,
				),
			];
			return () => lines;
		}
		const store = requireStore();
		const candidateKeys: SessionKey[] = [];
		const candidates = discovered.sessions.filter((summary, index) => {
			if (summary.id === sources.currentSessionId) return false;
			candidateKeys.push(discovered.keys[index]!);
			return true;
		});
		const resuming = target.cursor !== undefined && target.cursor.first > 0;
		const pinnedAt =
			resuming && target.session !== undefined
				? candidates.findIndex((summary) => summary.id === target.session)
				: -1;
		const pinnedGone = resuming && target.session !== undefined && pinnedAt === -1;
		const pinned = pinnedAt === -1 ? undefined : candidates[pinnedAt];
		const after = target.after;
		const restStart =
			after !== undefined
				? candidateKeys.findIndex((key) => compareSessionKeys(key, after) > 0)
				: pinned !== undefined
					? Math.max(target.offset, pinnedAt) + 1
					: target.offset;
		const restFrom = restStart === -1 ? candidates.length : restStart;
		const scope: HistoryTarget = { ...target, offset: pinned === undefined ? restFrom : Math.max(0, restFrom - 1) };
		const rest = candidates
			.slice(restFrom)
			.filter((summary) => summary.id !== pinned?.id)
			.slice(0, target.limit - (pinned === undefined ? 0 : 1));
		const window = pinned === undefined ? rest : [pinned, ...rest];
		const positionOf = (index: number): SessionKey | undefined =>
			index === 0 && pinned !== undefined ? (after ?? candidateKeys[restFrom - 1]) : sessionKey(window[index]!);
		const out: string[] = [];
		const notes: string[] = pinnedGone
			? [
					`${pageUrl("sessions", scope, scope.offset)}:0: [session ${target.session} is no longer listed, so the search could not resume in it; it continued with the sessions after it]`,
				]
			: [];
		for (const note of notes) budget.spend(lineBytes(note));
		budget.releaseReserve();
		let windowCut = false;
		let unreadable = 0;
		const searched: {
			readonly index: number;
			readonly summary: SessionSummary;
			readonly start: number;
			readonly unreadable: number;
			readonly result?: SessionSearchResult;
			readonly complete: boolean;
		}[] = [];
		const totalText = (lastSeq: number) => (Number.isFinite(lastSeq) && lastSeq > 0 ? ` of ${lastSeq}` : "");
		const stopFooter = (
			index: number,
			id: string,
			next: SearchResume,
			lastSeq: number,
			reason: BudgetStop,
			unreadableBefore: number,
			clause = "",
		) =>
			stoppedCoverage(
				"sessions",
				"sessions",
				scope,
				candidates.length,
				index + 1,
				unreadableBefore,
				reason,
				pageUrl(
					"sessions",
					scope,
					scope.offset + index,
					formatSearchCursor(next),
					request.ranges,
					id,
					positionOf(index),
				),
				` at entry ${next.seq}${totalText(lastSeq)} in ${sessionUrl(id, target)}${clause}`,
			);
		const nextSessionFooter = (index: number, reason: BudgetStop, unreadableAfter: number): string =>
			stoppedCoverage(
				"sessions",
				"sessions",
				scope,
				candidates.length,
				index + 1,
				unreadableAfter,
				reason,
				scope.offset + index + 1 < candidates.length
					? pageUrl(
							"sessions",
							scope,
							scope.offset + index + 1,
							undefined,
							request.ranges,
							undefined,
							positionOf(index),
						)
					: undefined,
				"",
			);
		const afterFooter = (index: number, reason: BudgetStop, unreadableAfter: number): string[] =>
			index + 1 >= window.length
				? coverage(
						"sessions",
						scope,
						candidates.length,
						window.length,
						unreadableAfter,
						request.ranges,
						undefined,
						window.length === 0 ? after : positionOf(window.length - 1),
					)
				: [nextSessionFooter(index, reason, unreadableAfter)];
		const pastEnd = (next: SearchResume, lastSeq: number) =>
			(next.lineOffset ?? 0) === 0 &&
			next.matchIndex === 0 &&
			(next.seq > lastSeq ||
				(request.ranges !== undefined && !mergeSeqRanges(request.ranges).some((range) => range.end >= next.seq)));
		let ending: (room: number) => string[] = () => afterFooter(window.length - 1, "byte", unreadable);
		for (const [index, summary] of window.entries()) {
			const spent = budget.spent();
			if (spent && index > 0) {
				const unreadableBefore = unreadable;
				ending = () => afterFooter(index - 1, spent, unreadableBefore);
				break;
			}
			const resumesHere = index === 0 && resuming && !pinnedGone;
			const fromSeq = resumesHere ? target.cursor!.first : 1;
			const fromMatchIndex = resumesHere ? target.cursor!.second : 0;
			const fromLineOffset = resumesHere ? target.cursor!.third : 0;
			const start = out.length;
			const unreadableBefore = unreadable;
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
					out.length > 0,
					true,
				);
				out.push(...result.lines);
				windowCut ||= result.windowCut;
				const stopped = result.stopped;
				const complete =
					stopped === undefined ||
					(result.skipped === undefined &&
						result.checkpoints.at(-1)?.lines === result.lines.length &&
						pastEnd(stopped.resume, result.lastSeq));
				searched.push({ index, summary, start, unreadable: unreadableBefore, result, complete });
				if (stopped && !complete) {
					ending = (room) => [
						fittingLine(
							(clause) =>
								stopFooter(
									index,
									summary.id,
									stopped.resume,
									result.lastSeq,
									stopped.reason,
									unreadableBefore,
									clause,
								),
							skippedClauses(result.skipped),
							room - linesBytes(fixedLines()) - linesBytes(out),
						),
					];
					break;
				}
			} catch (error) {
				if (isHistoryDeadlineError(error)) {
					const cursor = formatSearchCursor({
						seq: fromSeq,
						matchIndex: fromMatchIndex,
						...(fromLineOffset > 0 ? { lineOffset: fromLineOffset } : {}),
					});
					ending = () => [
						stoppedCoverage(
							"sessions",
							"sessions",
							scope,
							candidates.length,
							index + 1,
							unreadableBefore,
							"time",
							pageUrl(
								"sessions",
								scope,
								scope.offset + index,
								cursor,
								request.ranges,
								summary.id,
								positionOf(index),
							),
							` in ${sessionUrl(summary.id, target)}`,
						),
					];
					break;
				}
				if (budget.signal?.aborted) throw error;
				unreadable++;
				searched.push({ index, summary, start, unreadable: unreadableBefore, complete: true });
			}
			ending = () => afterFooter(window.length - 1, "byte", unreadable);
		}
		function fixedLines(): string[] {
			return [...notes, ...(windowCut ? [windowNoteLine] : [])];
		}
		const windowNoteLine = `${pageUrl("sessions", scope, scope.offset)}:0: [${MULTILINE_WINDOW_NOTE}]`;
		const checkpointFooter = (session: (typeof searched)[number], next: SearchResume, cut = false): string[] => {
			const lastSeq = session.result?.lastSeq ?? 0;
			if (!pastEnd(next, lastSeq))
				return [stopFooter(session.index, session.summary.id, next, lastSeq, "byte", session.unreadable)];
			return cut
				? [nextSessionFooter(session.index, "byte", session.unreadable)]
				: afterFooter(session.index, "byte", session.unreadable);
		};
		return (room: number): string[] => {
			const page = (footer: readonly string[], rows: readonly string[]) => [...footer, ...fixedLines(), ...rows];
			const fits = (lines: readonly string[]) => linesBytes(lines) - 1 <= room;
			const natural = page(ending(room), out);
			if (fits(natural)) return natural;
			for (const session of [...searched].reverse()) {
				const result = session.result;
				const unreadableAfter = session.unreadable + (result === undefined ? 1 : 0);
				if (session.complete) {
					const complete = page(
						afterFooter(session.index, "byte", unreadableAfter),
						out.slice(0, session.start + (result?.lines.length ?? 0)),
					);
					if (fits(complete)) return complete;
				}
				for (const checkpoint of [...(result?.checkpoints ?? [])].reverse()) {
					const trimmed = page(
						checkpointFooter(session, checkpoint.next),
						out.slice(0, session.start + checkpoint.lines),
					);
					if (fits(trimmed)) return trimmed;
				}
			}
			const first = searched.find((session) => (session.result?.checkpoints.length ?? 0) > 0);
			const checkpoint = first?.result?.checkpoints[0];
			if (first === undefined || checkpoint === undefined) return natural;
			const footer = checkpointFooter(first, checkpoint.next, true);
			const row = out[first.start + checkpoint.match]!;
			const textStart = row.indexOf(": ", sessionUrl(first.summary.id, target).length) + 2;
			const roomForRow = room - linesBytes([...footer, ...fixedLines()]);
			if (textStart < 2 || Buffer.byteLength(row.slice(0, textStart + 1), "utf8") > roomForRow) return natural;
			return page(footer, [cutTextToUtf8Bytes(row, roomForRow)]);
		};
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
		firstRecord = true,
	): Promise<{
		readonly lines: string[];
		readonly unreadable: number;
		readonly stopped?: {
			readonly reason: BudgetStop;
			readonly cursor: string;
			readonly skipped?: readonly string[];
		};
	}> {
		if (firstRecord) budget.holdProgressFloor();
		const detail = await budget.race(requireWorkflows().getRun(runId));
		budget.takeRows(1);
		const lines: string[] = [];
		let windowNote: string | undefined;
		const withNote = (found: readonly string[]) => (windowNote === undefined ? [...found] : [windowNote, ...found]);
		const noteWindowCut = () => {
			windowNote ??= charged(budget, `history://workflows/${runId}:0: [${MULTILINE_WINDOW_NOTE}]`);
		};
		if (start === undefined || start.stage === 0) {
			if (firstRecord) budget.markProgress();
			const own = await searchRunLinesBounded(
				runId,
				`history://workflows/${runId}`,
				(pacer) => runLines(detail, pacer),
				historyCursorCache(parkedRunStreams, () => new Map()),
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
			const resumesHere = start !== undefined && stageNumber === start.stage;
			const from = {
				seq: resumesHere ? Math.max(1, start.seq) : 1,
				matchIndex: resumesHere ? start.matchIndex : 0,
				lineOffset: resumesHere ? start.lineOffset : 0,
			};
			try {
				if (!(await budget.race(store.readHeader(stage.sessionId)))) continue;
				budget.takeRows(1);
				const result = await searchSession({
					place: placeOf(stage.sessionId, store, { limit: DEFAULT_LIMIT, offset: 0 }),
					label: `history://sessions/${stage.sessionId}`,
					request: { ...request, ranges: undefined },
					prefilter,
					fromSeq: from.seq,
					fromMatchIndex: from.matchIndex,
					fromLineOffset: from.lineOffset,
					ranges: undefined,
					budget,
					emittedBefore: alreadyEmitted || lines.length > 0,
				});
				lines.push(...result.lines);
				if (result.windowCut) noteWindowCut();
				if (result.stopped) {
					const cursor = `${stageNumber}.${formatSearchCursor(result.stopped.resume)}`;
					return {
						lines: withNote(lines),
						unreadable,
						stopped: {
							reason: result.stopped.reason,
							cursor,
							skipped: skippedClauses(result.skipped, ` in history://sessions/${stage.sessionId}`),
						},
					};
				}
			} catch (error) {
				if (budget.signal?.aborted) throw error;
				if (isHistoryDeadlineError(error))
					return {
						lines: withNote(lines),
						unreadable,
						stopped: { reason: "time", cursor: `${stageNumber}.${formatSearchCursor(from)}` },
					};
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
			const unreadableNotes =
				unreadable > 0
					? [charged(budget, `history://workflows/${runId}:0: [${unreadable} stage transcripts unreadable]`)]
					: [];
			const stopLines = stopped
				? [
						charged(
							budget,
							fittingLine(
								(clause) =>
									`history://workflows/${runId}:0: [${stopText(stopped.reason)}${clause}; continue with history://workflows/${runId}?cursor=${stopped.cursor}${request.ranges ? `:${rangeText(request.ranges)}` : ""}]`,
								stopped.skipped ?? [""],
								limits.bytes - linesBytes([...unreadableNotes, ...lines]),
							),
						),
					]
				: [];
			return [...unreadableNotes, ...stopLines, ...lines];
		}
		const runs = await recentRuns(budget);
		const pinnedAt = target.run === undefined ? -1 : runs.findIndex((run) => run.runId === target.run);
		const pinnedGone = target.run !== undefined && pinnedAt === -1;
		const scope: HistoryTarget = pinnedAt === -1 ? target : { ...target, offset: pinnedAt };
		const resume = pinnedGone ? undefined : start;
		const resumeCursor = resume === undefined || target.cursor === undefined ? undefined : cursorText(target.cursor);
		const window = runs.slice(scope.offset, scope.offset + scope.limit);
		const nextRun = runs[scope.offset + window.length];
		budget.spend(Math.max(0, ...[...window, ...(nextRun ? [nextRun] : [])].map((run) => runPinBytes(run.runId))));
		const notes = pinnedGone
			? [
					charged(
						budget,
						`${pageUrl("workflows", scope, scope.offset)}:0: [run ${target.run} is no longer listed, so the search could not resume in it; it continued with the runs after it]`,
					),
				]
			: [];
		const out: string[] = [];
		let unreadable = 0;
		const stoppedAt = (
			index: number,
			searched: number,
			reason: BudgetStop,
			inRun: boolean,
			cursor?: string,
			skipped: readonly string[] = [""],
		): string[] => {
			const run = window[index]!;
			return [
				charged(
					budget,
					fittingLine(
						(clause) =>
							stoppedCoverage(
								"workflows",
								"workflow runs",
								scope,
								runs.length,
								searched,
								unreadable,
								reason,
								pageUrl("workflows", scope, scope.offset + index, cursor, request.ranges, run.runId),
								`${inRun ? ` in history://workflows/${run.runId}` : ""}${clause}`,
							),
						skipped,
						limits.bytes - linesBytes([...notes, ...out]),
					),
				),
				...notes,
				...out,
			];
		};
		for (const [index, run] of window.entries()) {
			const spent = budget.spent();
			if (spent && index > 0) return stoppedAt(index, index, spent, false);
			try {
				const found = await searchRun(
					run.runId,
					request,
					prefilter,
					index === 0 ? resume : undefined,
					budget,
					out.length > 0,
					index === 0,
				);
				out.push(...found.lines);
				unreadable += found.unreadable;
				if (found.stopped)
					return stoppedAt(
						index,
						index + 1,
						found.stopped.reason,
						true,
						found.stopped.cursor,
						found.stopped.skipped,
					);
			} catch (error) {
				if (budget.signal?.aborted) throw error;
				if (isHistoryDeadlineError(error))
					return stoppedAt(index, index, "time", true, index === 0 ? resumeCursor : undefined);
				unreadable++;
			}
		}
		return [
			...coverage("workflows", scope, runs.length, window.length, unreadable, request.ranges, nextRun?.runId).map(
				(line) => charged(budget, line),
			),
			...notes,
			...out,
		];
	}

	async function readSelected(rawUrl: string, rawSelection: InternalReadSelection): Promise<string | undefined> {
		if (!rawUrl.startsWith("history://")) return undefined;
		const { url, selection } = normalizeInlineReadSelection(rawUrl, rawSelection);
		const target = parseTarget(url);
		if (target.domain === undefined) return bounded(HISTORY_HELP);
		const budget = newBudget(selection.signal, noteBytes(url, target, selection.ranges));
		const lineSelection: InternalReadSelection =
			positionCursor(target) === undefined ? selection : { ...selection, raw: true };
		const lineCursor =
			target.cursor && target.cursor.first > 0
				? { line: target.cursor.first, char: target.cursor.second }
				: undefined;
		try {
			if (target.domain === "sessions" && target.id !== undefined)
				return bounded(await readSession(target, selection, budget));
			if (target.domain === "sessions") {
				const listed = await listSessions(target, lineSelection, budget);
				if (listed.preselected) return bounded(listed.text);
				return bounded(await selectLines(url, listed.text.split("\n"), lineSelection, lineCursor, budget));
			}
			const lines =
				target.id === undefined
					? (await listWorkflows(target, budget)).split("\n")
					: await readRun(target.id, budget);
			return bounded(await selectLines(url, lines, lineSelection, lineCursor, budget));
		} catch (error) {
			if (isHistoryDeadlineError(error)) {
				const retry =
					target.domain === "sessions" && target.id !== undefined
						? `${url}${entrySuffix(selection)}`
						: positionCursor(target) === undefined
							? `${url}${lineSuffix(selection)}`
							: `${url}${exactLineSuffix(lineSelection)}`;
				return bounded(`[the time budget ran out waiting for the store; continue with ${retry}]`);
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
					return bounded((await searchSessions(target, request, prefilter, budget))(limits.bytes).join("\n"));
				if (target.domain === "workflows")
					return bounded((await searchWorkflows(target, request, prefilter, budget)).join("\n"));
			} catch (error) {
				if (isHistoryDeadlineError(error)) {
					const ranges =
						request.ranges !== undefined && request.ranges.length > 0 ? `:${rangeText(request.ranges)}` : "";
					return bounded(
						`${url}:0: [the time budget ran out waiting for the store; continue with ${url}${ranges}]`,
					);
				}
				throw error;
			}
			const domainNoteBytes = noteBytes(url, target, request.ranges, 2, multiline);
			const sessionRows = Math.ceil(limits.rows / 2);
			const workflowRows = limits.rows - sessionRows;
			const workflowBytes = workflowRows > 0 ? Math.floor(limits.bytes / 2) : 0;
			const notSearched = (domain: Domain, label: string): string[] => [
				`history://${domain}:0: [${label} not searched: ${stopText("row")}; continue with ${pageUrl(domain, target, target.offset, target.cursor === undefined ? undefined : cursorText(target.cursor), request.ranges)}]`,
			];
			const [sessions, workflows] = await Promise.allSettled([
				sessionRows > 0
					? searchSessions(
							target,
							request,
							prefilter,
							new HistoryCallBudget(
								{ ...limits, bytes: limits.bytes - workflowBytes, rows: sessionRows },
								request.signal,
								domainNoteBytes,
							),
						)
					: Promise.resolve(() => notSearched("sessions", "sessions")),
				workflowRows > 0
					? searchWorkflows(
							target,
							request,
							prefilter,
							new HistoryCallBudget(
								{ ...limits, bytes: workflowBytes, rows: workflowRows },
								request.signal,
								domainNoteBytes,
							),
						)
					: Promise.resolve(notSearched("workflows", "workflow runs")),
			]);
			request.signal?.throwIfAborted();
			if (
				sessions.status === "rejected" &&
				workflows.status === "rejected" &&
				!isHistoryDeadlineError(sessions.reason) &&
				!isHistoryDeadlineError(workflows.reason)
			)
				throw sessions.reason;
			// Line 0 carries notes about the search itself, so a source that failed is named even beside matches.
			const results = (
				domain: Domain,
				label: string,
				settled: PromiseSettledResult<string[] | ((room: number) => string[])>,
			): string[] => {
				if (isHistoryDeadlineError(settled.status === "rejected" ? settled.reason : undefined)) {
					const cursor = target.cursor === undefined ? undefined : cursorText(target.cursor);
					return [
						`history://${domain}:0: [${label} not searched: ${stopText("time")} waiting for the store; continue with ${pageUrl(domain, target, target.offset, cursor, request.ranges)}]`,
					];
				}
				const reason = settled.status === "rejected" ? settled.reason : undefined;
				return [
					`history://${domain}:0: [${label} not searched: ${reason instanceof Error ? reason.message : String(reason)}]`,
				];
			};
			const workflowLines =
				workflows.status === "fulfilled" ? workflows.value : results("workflows", "workflow runs", workflows);
			const sessionLines =
				sessions.status === "fulfilled"
					? sessions.value(limits.bytes - linesBytes(workflowLines))
					: results("sessions", "sessions", sessions);
			return bounded([...sessionLines, ...workflowLines].join("\n"));
		},
	};
}
