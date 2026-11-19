/**
 * history:// reads the session history of the current project through its configured SessionStore.
 *
 *   history://                     what is available
 *   history://sessions             recent sessions, newest first
 *   history://sessions/<id>        one session: its transcript, or an outline when it is too long to read whole
 *   history://sessions/<id>:N-M    entries N to M of one session
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
import type { SessionEntry } from "../session-manager-types.ts";
import type { SessionRecordHeader, SessionStore, SessionSummary } from "../storage/session/types.js";
import { indexLiterals, isMultilineSearchPattern, type LiteralQuery } from "./history-literals.js";
import {
	compareCreated,
	compareFrozen,
	HistorySearchPositions,
	sessionPosition,
	unpackIds,
	withoutSearchPosition,
} from "./history-search-position.js";
import { expandSearchUrl, frozenClocks, searchPosition } from "./history-search-wire.js";
import {
	type BudgetStop,
	cutTextToUtf8Bytes,
	DEFAULT_HISTORY_BUDGET,
	formatSearchCursor,
	type HistoryBudget,
	HistoryCallBudget,
	isHistoryDeadlineError,
	lineBytes,
	MULTILINE_WINDOW_NOTE,
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
import { entryLines, timestamp, transcriptHeaderLines } from "./history-transcript.js";
import { mergeReadRanges, splitReadLineSelector } from "./read-selectors.ts";
import {
	historyNoteWindows,
	type InternalReadSelection,
	type InternalResourceRouter,
	type InternalSearchRequest,
	normalizeSearchPattern,
} from "./resource-selectors.ts";
import { splitLineRangeSelector } from "./search-line-ranges.ts";

export type { HistoryBudget } from "./history-session.js";

function charged(budget: HistoryCallBudget, line: string): string {
	budget.spend(lineBytes(line));
	return line;
}

/** Subagents inherit their launching session's project store but keep a separate transcript. */
export interface ProjectHistory {
	readonly sessionStore: () => SessionStore | undefined;
}

export interface HistorySources {
	/** The project whose history is visible by default. */
	readonly cwd: string;
	readonly currentSessionId?: string;
	/** The store that holds the current session. */
	readonly sessionStore: () => SessionStore | undefined;
	/** The store that holds the project's other sessions, when it is not the current session's. */
	readonly projectSessionStore?: () => SessionStore | undefined;
	readonly budget?: Partial<HistoryBudget>;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const LABEL_LIMIT = 120;
const WHOLE_SESSION_ENTRY_LIMIT = 2_000;
const DISCOVERY_TTL_MS = 60_000;
const MAX_PARKED_DISCOVERIES = 16;
const QUERY_KEYS: Readonly<Record<"sessions" | "root", readonly string[]>> = {
	sessions: ["limit", "offset", "project", "cursor", "session", "after"],
	root: ["limit", "offset", "project", "cursor"],
};
const CURSOR = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?$/;

interface HistoryTarget {
	readonly domain?: "sessions";
	readonly id?: string;
	readonly limit: number;
	readonly offset: number;
	/** `undefined` selects the current project, `"all"` every project, anything else is a project directory. */
	readonly project?: string;
	readonly session?: string;
	readonly after?: SessionKey;
	readonly order?: string;
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
	return b.activeMs - a.activeMs || compareCreated(a, b);
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

const REMOVED_WORKFLOW_URL = /^history:\/\/workflows(?:[/?#:]|$)/;
const WORKFLOW_HISTORY_REMOVED =
	"Workflow history is no longer available. Atomic has not changed your old workflow store (by default, ~/.atomic/workflows/journal/). Use history://sessions for session transcripts.";

const HISTORY_URL = /^history:\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?$/;

export const HISTORY_HELP = [
	"history:// reads and searches this project's past sessions, whatever storage backs them.",
	"  history://sessions                  recent sessions, newest first (?limit=N up to 200, ?offset=N to page)",
	"  history://sessions/<id>             one session's transcript, or an outline of a long one",
	"  history://sessions/<id>:N-M         entries N to M of one session",
	'Search any of them with the search tool, e.g. paths "history://sessions" or "history://"; a session match',
	"is labelled with its URL and entry number, which reads back with :N-N, and context lines may cross neighbouring",
	"entries. A search covers one page of records",
	"(25 by default) and shows at most 10 matches per session; a read or search that stops early says what it covered",
	"and the ?cursor= URL that continues it.",
	"Sessions of other projects appear only with ?project=all or ?project=<dir>; use that only when the user asks.",
].join("\n");

function parseTarget(url: string): HistoryTarget {
	const match = HISTORY_URL.exec(url);
	if (!match) throw new Error(`Invalid history URL: ${url}`);
	const [, domainText = "", idText, queryText] = match;
	if (domainText !== "" && domainText !== "sessions")
		throw new Error(`Unknown history resource: ${domainText}; use history://sessions`);
	const domain = domainText === "" ? undefined : domainText;
	if (domain === undefined && idText) throw new Error(`Unknown history resource: ${idText}`);
	const params = new URLSearchParams(queryText ?? "");
	const allowed = QUERY_KEYS[domain ?? "root"];
	for (const key of params.keys())
		if (!allowed.includes(key) && !(domain && !idText && key === "order"))
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
		order: searchPosition(params.get("order"), domain),
		...(project === undefined ? {} : { project }),
		...(session === undefined ? {} : { session }),
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
	if (target.project !== undefined) params.set("project", target.project);
	if (pinned !== undefined) params.set("session", pinned);
	if (cursor !== undefined) params.set("cursor", cursor);
	if (after !== undefined) params.set("after", sessionKeyText(after, pinned));
	const query = params.toString();
	return `history://sessions${query ? `?${query}` : ""}${ranges && ranges.length > 0 ? `:${rangeText(ranges)}` : ""}`;
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

	const placeOf = (id: string, store: SessionStore, target: HistoryTarget): SessionPlace => ({
		store,
		sessionId: id,
		urlWith: (query, ranges) => sessionUrl(id, target, query.cursor, ranges),
	});

	async function discoverSessions(
		target: HistoryTarget,
		budget: HistoryCallBudget,
		pin?: string,
		order?: string,
	): Promise<
		| {
				readonly sessions: SessionSummary[];
				readonly keys: SessionKey[];
				readonly compare: typeof compareSessionKeys;
				readonly stopped?: undefined;
		  }
		| {
				readonly sessions?: undefined;
				readonly stopped: { readonly reason: BudgetStop; readonly scanned: number; readonly cursor: string };
		  }
	> {
		const store = requireStore();
		const scope = projectScope(target);
		const keyOf = (cursor: string) => JSON.stringify([scope.cwd ?? null, cursor, pin ?? null]);
		let parkedHere = parkedDiscoveries.get(store);
		if (!parkedHere) {
			parkedHere = new Map<string, ParkedDiscovery>();
			parkedDiscoveries.set(store, parkedHere);
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
		// Decode only after discovery finishes. An abandoned or waiting listing needs no copy of an earlier order.
		const ranks = order?.startsWith("s.") ? new Map(unpackIds(order.slice(2)).map((id, i) => [id, i])) : undefined;
		const clocks = order?.startsWith("v") ? frozenClocks(order) : undefined;
		const compare = ranks
			? (a: SessionKey, b: SessionKey) => ranks.get(a.id)! - ranks.get(b.id)!
			: clocks
				? (a: SessionKey, b: SessionKey) => compareFrozen(clocks, a, b)
				: order === "c"
					? compareCreated
					: compareSessionKeys;
		const items = ranks ? parked.items.filter(({ key }) => ranks.has(key.id)) : parked.items;
		items.sort((a, b) => compare(a.key, b.key));
		return { sessions: items.map((item) => item.summary), keys: items.map((item) => item.key), compare };
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
			const contUrl = `${pageUrl(target, target.offset, discovered.stopped.cursor)}${suffix}`;
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
				`# sessions ${windowText(sessions.length, target.offset, shown.length)} in ${scope}, newest first${next < sessions.length ? `; next page: ${pageUrl(target, next)}` : ""}`,
				...shown.map((summary) =>
					[
						sessionUrl(summary.id, target),
						timestamp(summary.modifiedAt),
						`${summary.estimated ? "at least " : ""}${summary.messageCount} messages`,
						...(summary.estimated ? ["metadata may be incomplete"] : []),
						...(summary.id === sources.currentSessionId ? ["current session"] : []),
						...(target.project === undefined ? [] : [summary.cwd]),
						sessionLabel(summary),
					].join(" | "),
				),
			].join("\n"),
		};
	}

	async function readSession(
		target: HistoryTarget,
		selection: InternalReadSelection,
		budget: HistoryCallBudget,
	): Promise<string> {
		const { id, header } = await authorizedSession(target, budget);
		const place = placeOf(id, requireStore(id), target);
		const headerLines = transcriptHeaderLines(header);
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
			`${pageUrl(target, target.offset)}:0: [searched sessions ${windowText(total, target.offset, shown)}${unreadable > 0 ? `, ${unreadable} unreadable` : ""}${end < total ? `; continue with ${pageUrl(target, end, undefined, ranges, nextPin, after)}` : ""}]`,
		];
	}

	function stoppedCoverage(
		target: HistoryTarget,
		total: number,
		searched: number,
		unreadable: number,
		reason: BudgetStop,
		continuation: string | undefined,
		where: string,
	): string {
		return `${pageUrl(target, target.offset)}:0: [searched sessions ${windowText(total, target.offset, searched)}${unreadable > 0 ? `, ${unreadable} unreadable` : ""}; ${stopText(reason)}${where}${continuation === undefined ? "" : `; continue with ${continuation}`}]`;
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
		positions?: HistorySearchPositions,
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
			return (room) => [
				fittingLine(
					(clause) =>
						`${label}:0: [searched entries ${result.coveredFromSeq}-${coveredEnd}${totalText}; ${reason}${clause}; continue with ${sessionUrl(id, target, cursor, remainingRanges)}]`,
					skippedClauses(result.skipped),
					room - linesBytes([...windowNote, ...result.lines]),
				),
				...windowNote,
				...result.lines,
			];
		}
		const pin = positionCursor(target) === undefined ? undefined : target.session;
		const discovered = await discoverSessions(target, budget, pin, target.order);
		if (discovered.stopped !== undefined) {
			const contUrl = pageUrl(target, target.offset, discovered.stopped.cursor, request.ranges, pin, target.after);
			const lines = [
				charged(
					budget,
					`${pageUrl(target, target.offset)}:0: [searched sessions 0 of ${discovered.stopped.scanned}+; ${stopText(discovered.stopped.reason)} after scanning ${discovered.stopped.scanned} sessions; continue with ${contUrl}]`,
				),
			];
			return () => {
				if (target.order) positions?.offer(lines[0], () => target.order);
				return lines;
			};
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
				? candidateKeys.findIndex((key) => discovered.compare(key, after) > 0)
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
					`${pageUrl(scope, scope.offset)}:0: [session ${target.session} is no longer listed, so the search could not resume in it; it continued with the sessions after it]`,
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
				scope,
				candidates.length,
				index + 1,
				unreadableBefore,
				reason,
				pageUrl(scope, scope.offset + index, formatSearchCursor(next), request.ranges, id, positionOf(index)),
				` at entry ${next.seq}${totalText(lastSeq)} in ${sessionUrl(id, target)}${clause}`,
			);
		const nextSessionFooter = (index: number, reason: BudgetStop, unreadableAfter: number): string =>
			stoppedCoverage(
				scope,
				candidates.length,
				index + 1,
				unreadableAfter,
				reason,
				scope.offset + index + 1 < candidates.length
					? pageUrl(scope, scope.offset + index + 1, undefined, request.ranges, undefined, positionOf(index))
					: undefined,
				"",
			);
		const afterFooter = (index: number, reason: BudgetStop, unreadableAfter: number): string[] =>
			index + 1 >= window.length
				? coverage(
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
							scope,
							candidates.length,
							index + 1,
							unreadableBefore,
							"time",
							pageUrl(scope, scope.offset + index, cursor, request.ranges, summary.id, positionOf(index)),
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
		const windowNoteLine = `${pageUrl(scope, scope.offset)}:0: [${MULTILINE_WINDOW_NOTE}]`;
		const checkpointFooter = (session: (typeof searched)[number], next: SearchResume, cut = false): string[] => {
			const lastSeq = session.result?.lastSeq ?? 0;
			if (!pastEnd(next, lastSeq))
				return [stopFooter(session.index, session.summary.id, next, lastSeq, "byte", session.unreadable)];
			return cut
				? [nextSessionFooter(session.index, "byte", session.unreadable)]
				: afterFooter(session.index, "byte", session.unreadable);
		};
		const fitPage = (room: number): string[] => {
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
		// An older URL keeps its original meaning through the rest of its chain.
		if (!positions || (!target.order && (target.after || target.session))) return fitPage;
		return (room) => {
			const lines = fitPage(room);
			positions.offer(lines[0], (available) => target.order ?? sessionPosition(candidateKeys, available));
			return lines;
		};
	}

	async function readSelected(rawUrl: string, rawSelection: InternalReadSelection): Promise<string | undefined> {
		if (!rawUrl.startsWith("history://")) return undefined;
		if (REMOVED_WORKFLOW_URL.test(rawUrl)) return bounded(WORKFLOW_HISTORY_REMOVED);
		const { url: input, selection } = normalizeInlineReadSelection(rawUrl, rawSelection);
		const expanded = expandSearchUrl(input);
		const target = parseTarget(expanded?.url ?? input);
		if (expanded) searchPosition(expanded.state, target.domain);
		const url = expanded?.url ?? (target.order ? withoutSearchPosition(input) : input);
		if (target.domain === undefined) return bounded(HISTORY_HELP);
		const budget = newBudget(selection.signal, noteBytes(url, target, selection.ranges));
		const lineSelection: InternalReadSelection =
			positionCursor(target) === undefined ? selection : { ...selection, raw: true };
		const lineCursor =
			target.cursor && target.cursor.first > 0
				? { line: target.cursor.first, char: target.cursor.second }
				: undefined;
		try {
			if (target.id !== undefined) return bounded(await readSession(target, selection, budget));
			const listed = await listSessions(target, lineSelection, budget);
			if (listed.preselected) return bounded(listed.text);
			return bounded(await selectLines(url, listed.text.split("\n"), lineSelection, lineCursor, budget));
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
			if (REMOVED_WORKFLOW_URL.test(rawUrl)) return bounded(`history://workflows:0: [${WORKFLOW_HISTORY_REMOVED}]`);
			const { url: input, request } = normalizeInlineSearchRequest(rawUrl, rawRequest);
			// Don't expand a search position on a cancelled call. Plain URLs retain their original validation order.
			if (/^history:\/\/sessions\/?\?(?:[^&]*&)*(?:o|order)=/.test(input)) request.signal?.throwIfAborted();
			const expanded = expandSearchUrl(input);
			const plain = parseTarget(expanded?.url ?? input);
			const target = expanded ? { ...plain, order: searchPosition(expanded.state, plain.domain) } : plain;
			if (target.order) request.signal?.throwIfAborted();
			const url = expanded?.url ?? (target.order ? withoutSearchPosition(input) : input);
			const multiline = isMultilineSearchPattern(request.pattern, request.ignoreCase, request.literal);
			const budget = newBudget(
				request.signal,
				noteBytes(url, target, request.ranges, target.id === undefined ? 2 : 1, multiline),
			);
			selectRegexEngine(normalizeSearchPattern(request.pattern, request.ignoreCase), request.literal, multiline);
			const prefilter = multiline ? undefined : indexLiterals(request.pattern, request.ignoreCase, request.literal);
			const positions =
				target.id === undefined ? new HistorySearchPositions(historyNoteWindows.get(rawRequest)) : undefined;
			const render = (lines: string[]) => bounded(positions ? positions.render(lines) : lines.join("\n"));
			try {
				if (!target.domain && limits.rows === 0) {
					request.signal?.throwIfAborted();
					const cursor = target.cursor === undefined ? undefined : cursorText(target.cursor);
					return render([
						`history://sessions:0: [sessions not searched: ${stopText("row")}; continue with ${pageUrl(target, target.offset, cursor, request.ranges)}]`,
					]);
				}
				const page = await searchSessions(target, request, prefilter, budget, positions);
				request.signal?.throwIfAborted();
				return render(page(limits.bytes));
			} catch (error) {
				if (isHistoryDeadlineError(error)) {
					const ranges =
						request.ranges !== undefined && request.ranges.length > 0 ? `:${rangeText(request.ranges)}` : "";
					const note = `${url}:0: [the time budget ran out waiting for the store; continue with ${url}${ranges}]`;
					if (target.domain && target.order) positions?.offer(note, () => target.order);
					return render([note]);
				}
				throw error;
			}
		},
	};
}
