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
import type { WorkflowRunControl, WorkflowRunDetail, WorkflowRunSummary } from "../extensions/workflow-run-control.js";
import type { SessionEntry } from "../session-manager-types.ts";
import type { SessionRecordHeader, SessionStore, SessionSummary } from "../storage/session/types.js";
import { indexLiterals, isMultilineSearchPattern, type LiteralQuery } from "./history-literals.ts";
import { matchLinesInWorker, matchMultilineInWorker } from "./history-regex-worker.ts";
import {
	type BudgetStop,
	cutTextToUtf8Bytes,
	DEFAULT_HISTORY_BUDGET,
	formatSearchCursor,
	type HistoryBudget,
	HistoryCallBudget,
	isHistoryDeadlineError,
	lineBytes,
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
import { entryLines, textLines, timestamp, transcriptHeaderLines, wrapLine } from "./history-transcript.ts";
import { selectExactReadRanges, selectReadRanges, splitReadLineSelector } from "./read-selectors.ts";
import {
	formatSearchTextLine,
	type InternalReadSelection,
	type InternalResourceRouter,
	type InternalSearchRequest,
	normalizeSearchPattern,
} from "./resource-selectors.ts";
import { filterSearchOutputByLineRange, splitLineRangeSelector } from "./search-line-ranges.ts";
import { loadNativeSearchBinding } from "./search-native.ts";

export type { HistoryBudget } from "./history-session.ts";

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
const QUERY_KEYS: Readonly<Record<"sessions" | "workflows" | "root", readonly string[]>> = {
	sessions: ["limit", "offset", "project", "cursor"],
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
	readonly cursor?: {
		readonly first: number;
		readonly second: number;
		readonly third: number;
		readonly fourth: number;
	};
}

interface ParkedDiscovery {
	readonly iterator: AsyncIterator<SessionSummary>;
	readonly items: { readonly summary: SessionSummary; readonly modifiedMs: number }[];
	pending?: Promise<IteratorResult<SessionSummary>>;
	updatedAt: number;
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
): string {
	const params = new URLSearchParams();
	if (offset > 0) params.set("offset", String(offset));
	if (target.limit !== DEFAULT_LIMIT) params.set("limit", String(target.limit));
	if (domain === "sessions" && target.project !== undefined) params.set("project", target.project);
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

function selectLines(
	url: string,
	lines: readonly string[],
	selection: InternalReadSelection,
	cursor: { readonly line: number; readonly char: number } | undefined,
	budget: HistoryCallBudget,
): string {
	const all = [...lines];
	let picked: { lines: string[]; numbers: number[] };
	if (selection.ranges !== undefined && selection.ranges.length > 0) {
		const ranges = selection.ranges.map((range) => ({ ...range }));
		const chosen = (selection.raw ? selectExactReadRanges : selectReadRanges)(all, ranges);
		picked = { lines: chosen?.selectedLines ?? [], numbers: chosen?.lineNumbers ?? [] };
		if (picked.lines.length === 0)
			return `Requested line ${ranges[0]!.start} is beyond end of resource (${all.length} lines total).`;
	} else {
		const start = Math.max(1, cursor?.line ?? selection.offset ?? 1);
		if (start > all.length && (selection.offset !== undefined || cursor !== undefined))
			return `Requested line ${start} is beyond end of resource (${all.length} lines total).`;
		const end = selection.limit === undefined ? all.length : Math.min(all.length, start + selection.limit - 1);
		picked = {
			lines: all.slice(start - 1, end),
			numbers: Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index),
		};
	}
	const out: string[] = [];
	const firstNumber = picked.numbers[0] ?? 1;
	const lastNumber = picked.numbers.at(-1) ?? all.length;
	for (const [index, fullLine] of picked.lines.entries()) {
		const lineNum = picked.numbers[index]!;
		if (cursor !== undefined && lineNum < cursor.line) continue;
		const charOffset = cursor !== undefined && lineNum === cursor.line ? cursor.char : 0;
		const text = charOffset > 0 ? fullLine.slice(charOffset) : fullLine;
		const size = lineBytes(text);
		if (!budget.fits(size)) {
			if (out.length > 0) {
				const contUrl = urlWithCursor(url, charOffset > 0 ? `${lineNum}.${charOffset}` : undefined);
				out.push(
					`[read lines ${firstNumber}-${Math.max(firstNumber, lineNum - 1)} of ${all.length}; ${stopText("byte")}; continue with ${contUrl}:${lineNum}-${lastNumber}]`,
				);
				break;
			}
			const piece = cutTextToUtf8Bytes(text, Math.max(1, budget.bytesAvailable()));
			out.push(piece);
			budget.spend(lineBytes(piece));
			const nextChar = charOffset + piece.length;
			if (nextChar < fullLine.length) {
				const contUrl = urlWithCursor(url, `${lineNum}.${nextChar}`);
				out.push(
					`[read line ${lineNum} of ${all.length}; ${stopText("byte")}; continue with ${contUrl}:${lineNum}-${lastNumber}]`,
				);
				break;
			}
			if (lineNum < lastNumber) {
				const contUrl = urlWithCursor(url, undefined);
				out.push(
					`[read lines ${firstNumber}-${lineNum} of ${all.length}; ${stopText("byte")}; continue with ${contUrl}:${lineNum + 1}-${lastNumber}]`,
				);
			}
			break;
		}
		out.push(text);
		budget.spend(size);
	}
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

async function searchLinesBounded(
	label: string,
	lines: readonly string[],
	request: InternalSearchRequest,
	budget: HistoryCallBudget,
): Promise<{ readonly rows: string[]; readonly timedOut: boolean }> {
	const normalized = normalizeSearchPattern(request.pattern, request.ignoreCase);
	const ignoreCase = normalized.flags.includes("i");
	const multiline = isMultilineSearchPattern(request.pattern, request.ignoreCase, request.literal);
	const engine = selectRegexEngine(normalized, request.literal, multiline);
	const text = lines.join("\n");

	if (!request.literal && !multiline) {
		const safeText = engine === "native-only" ? text.replaceAll("\0", "\ufffd") : text;
		if (!safeText.includes("\0")) {
			try {
				const native = loadNativeSearchBinding()?.search?.(safeText, {
					pattern: normalized.pattern,
					ignoreCase,
					multiline: false,
					contextBefore: request.contextBefore,
					contextAfter: request.contextAfter,
				});
				if (native && !native.error) {
					const rows = native.matches.flatMap((match) => [
						...(match.contextBefore ?? []).map((line) =>
							formatSearchTextLine(label, line.lineNumber, line.line, false),
						),
						formatSearchTextLine(label, match.lineNumber, match.line, true),
						...(match.contextAfter ?? []).map((line) =>
							formatSearchTextLine(label, line.lineNumber, line.line, false),
						),
					]);
					return {
						rows:
							request.ranges !== undefined
								? filterSearchOutputByLineRange(
										rows.join("\n"),
										request.ranges,
										request.contextBefore,
										request.contextAfter,
									)
										.split("\n")
										.filter((line) => line !== "" && line !== "No matches found")
								: rows,
						timedOut: false,
					};
				}
			} catch {}
		}
		if (engine === "native-only") return { rows: [], timedOut: false };
	}

	const matchLines = new Set<number>();
	const contextLines = new Set<number>();
	if (multiline) {
		const spans =
			engine === "native-only"
				? matchMultilineNative(text, text.length + 1, normalized, ignoreCase, lines.length + 1)
				: await (async () => {
						const res = await matchMultilineInWorker(
							text,
							0,
							text.length + 1,
							normalized.pattern,
							normalized.flags,
							ignoreCase,
							request.literal,
							budget.remainingMs(),
							budget.signal,
						);
						return res.timedOut ? ("timedOut" as const) : res.matches;
					})();
		if (spans === "timedOut") return { rows: [], timedOut: true };
		for (const span of spans) {
			matchLines.add(span.startLine + 1);
			for (
				let n = Math.max(1, span.startLine + 1 - request.contextBefore);
				n <= Math.min(lines.length, span.endLine + 1 + request.contextAfter);
				n++
			) {
				contextLines.add(n);
			}
		}
	} else {
		const res = await matchLinesInWorker(
			lines,
			normalized.pattern,
			normalized.flags,
			ignoreCase,
			request.literal,
			budget.remainingMs(),
			budget.signal,
		);
		if (res.timedOut) return { rows: [], timedOut: true };
		for (const idx of res.matchedIndices) {
			const lineNum = idx + 1;
			matchLines.add(lineNum);
			for (
				let n = Math.max(1, lineNum - request.contextBefore);
				n <= Math.min(lines.length, lineNum + request.contextAfter);
				n++
			) {
				contextLines.add(n);
			}
		}
	}
	const rows = [...contextLines]
		.sort((a, b) => a - b)
		.map((line) => formatSearchTextLine(label, line, lines[line - 1] ?? "", matchLines.has(line)));
	if (request.ranges === undefined) return { rows, timedOut: false };
	const filtered = filterSearchOutputByLineRange(
		rows.join("\n"),
		request.ranges,
		request.contextBefore,
		request.contextAfter,
	);
	return {
		rows: filtered === "No matches found" ? [] : filtered.split("\n").filter((line) => line !== ""),
		timedOut: false,
	};
}

export function createHistoryRouter(sources: HistorySources): InternalResourceRouter {
	const limits: HistoryBudget = { ...DEFAULT_HISTORY_BUDGET, ...sources.budget };
	const newBudget = (signal: AbortSignal | undefined) => new HistoryCallBudget(limits, signal);

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
		const now = Date.now();
		for (const [key, entry] of byScope) {
			if (now - entry.updatedAt > DISCOVERY_TTL_MS) {
				void entry.iterator.return?.();
				byScope.delete(key);
			}
		}
		const isContinuation = target.cursor !== undefined && target.cursor.first === 0;
		let parked = isContinuation ? byScope.get(scopeKey) : undefined;
		if (!parked) {
			const existing = byScope.get(scopeKey);
			if (existing) {
				void existing.iterator.return?.();
				byScope.delete(scopeKey);
			}
			const iterable = store.list({ ...scope, withoutSearchText: true });
			parked = { iterator: iterable[Symbol.asyncIterator](), items: [], updatedAt: now };
		}
		let progressed = false;
		try {
			for (;;) {
				const reason = budget.spent();
				if (reason && progressed) {
					parked.updatedAt = Date.now();
					byScope.set(scopeKey, parked);
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
				parked.updatedAt = Date.now();
				byScope.set(scopeKey, parked);
				return { stopped: { reason: "time", scanned: parked.items.length } };
			}
			void parked.iterator.return?.();
			byScope.delete(scopeKey);
			throw error;
		}
		byScope.delete(scopeKey);
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
		const shown = runs.slice(target.offset, target.offset + target.limit);
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

	function runLines(detail: WorkflowRunDetail): string[] {
		return [
			`# workflow run ${detail.runId}`,
			`name: ${detail.name}`,
			`status: ${detail.status}`,
			`started: ${timestamp(detail.startedAt)}`,
			...(detail.endedAt === undefined ? [] : [`ended: ${timestamp(detail.endedAt)}`]),
			...(detail.identity ? textLines(`label: ${detail.identity}`) : []),
			...(detail.summary ? textLines(`summary: ${detail.summary}`) : []),
			...wrapLine(`inputs: ${JSON.stringify(detail.inputs)}`),
			"stages:",
			...detail.stages.flatMap((stage) => [
				[
					`- ${stage.name} [${stage.status}]`,
					...(stage.sessionId ? [`transcript history://sessions/${stage.sessionId}`] : []),
				].join(" "),
				...(stage.error ? textLines(`  error: ${stage.error}`) : []),
			]),
			...(detail.result === undefined ? [] : wrapLine(`result: ${JSON.stringify(detail.result)}`)),
			...(detail.error ? textLines(`error: ${detail.error}`) : []),
		];
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

	async function readRun(id: string, budget: HistoryCallBudget): Promise<string[]> {
		const runId = await authorizedRunId(id, budget);
		return runLines(await budget.race(requireWorkflows().getRun(runId)));
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
						`${label}:0: [the time budget ran out waiting for the store; continue with ${sessionUrl(rawId, target, target.cursor ? cursor : undefined, request.ranges)}]`,
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
			if (!result.stopped) return result.lines;
			const label = sessionUrl(id, target);
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
								end: result.lastSeq > 0 ? Math.min(range.end, result.lastSeq) : range.end,
							}))
							.filter((range) => range.start <= range.end);
			const cursor = formatSearchCursor(resume);
			const totalText = result.lastSeq > 0 ? ` of ${result.lastSeq}` : "";
			return [
				`${label}:0: [searched entries ${result.coveredFromSeq}-${coveredEnd}${totalText}; ${stopText(result.stopped.reason)}; continue with ${sessionUrl(id, target, cursor, remainingRanges)}]`,
				...result.lines,
			];
		}
		const discovered = await discoverSessions(target, budget);
		if (discovered.stopped !== undefined) {
			const contUrl = pageUrl("sessions", target, target.offset, `0.${discovered.stopped.scanned}`, request.ranges);
			return [
				`${pageUrl("sessions", target, target.offset)}:0: [searched sessions 0 of ${discovered.stopped.scanned}+; ${stopText(discovered.stopped.reason)} after scanning ${discovered.stopped.scanned} sessions; continue with ${contUrl}]`,
			];
		}
		const store = requireStore();
		const candidates = discovered.sessions.filter((summary) => summary.id !== sources.currentSessionId);
		const window = candidates.slice(target.offset, target.offset + target.limit);
		const out: string[] = [];
		let unreadable = 0;
		for (const [index, summary] of window.entries()) {
			const spent = budget.spent();
			if (spent && index > 0)
				return [
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
					...out,
				];
			const fromSeq = index === 0 && target.cursor && target.cursor.first > 0 ? target.cursor.first : 1;
			const fromMatchIndex = index === 0 && target.cursor && target.cursor.first > 0 ? target.cursor.second : 0;
			const fromLineOffset = index === 0 && target.cursor && target.cursor.first > 0 ? target.cursor.third : 0;
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
				if (result.stopped) {
					const cursor = formatSearchCursor(result.stopped.resume);
					const totalText = result.lastSeq > 0 ? ` of ${result.lastSeq}` : "";
					return [
						stoppedCoverage(
							"sessions",
							"sessions",
							target,
							candidates.length,
							index + 1,
							unreadable,
							result.stopped.reason,
							pageUrl("sessions", target, target.offset + index, cursor, request.ranges),
							` at entry ${result.stopped.resume.seq}${totalText} in ${sessionUrl(summary.id, target)}`,
						),
						...out,
					];
				}
			} catch (error) {
				if (isHistoryDeadlineError(error)) {
					return [
						stoppedCoverage(
							"sessions",
							"sessions",
							target,
							candidates.length,
							index + 1,
							unreadable,
							"time",
							pageUrl("sessions", target, target.offset + index, String(fromSeq), request.ranges),
							` in ${sessionUrl(summary.id, target)}`,
						),
						...out,
					];
				}
				rethrowAbort(budget, error);
				unreadable++;
			}
		}
		return [...coverage("sessions", target, candidates.length, window.length, unreadable, request.ranges), ...out];
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
	): Promise<{
		readonly lines: string[];
		readonly unreadable: number;
		readonly stopped?: { readonly reason: BudgetStop; readonly cursor: string };
	}> {
		const detail = await budget.race(requireWorkflows().getRun(runId));
		const lines: string[] = [];
		if (start === undefined || start.stage === 0) {
			const skipped = start?.seq ?? 0;
			const evaluated = await searchLinesBounded(`history://workflows/${runId}`, runLines(detail), request, budget);
			if (evaluated.timedOut) {
				return { lines, unreadable: 0, stopped: { reason: "time", cursor: `0.${skipped}` } };
			}
			const own = evaluated.rows.slice(skipped);
			for (const [index, line] of own.entries()) {
				const size = lineBytes(line);
				if (!budget.fits(size)) {
					if (lines.length === 0) {
						const cut = cutTextToUtf8Bytes(line, Math.max(32, budget.bytesAvailable()));
						lines.push(cut);
						budget.spend(lineBytes(cut));
						if (index + 1 < own.length || detail.stages.length > 0) {
							return {
								lines,
								unreadable: 0,
								stopped: {
									reason: "byte",
									cursor: index + 1 < own.length ? `0.${skipped + index + 1}` : "1.1",
								},
							};
						}
						break;
					}
					return { lines, unreadable: 0, stopped: { reason: "byte", cursor: `0.${skipped + index}` } };
				}
				lines.push(line);
				budget.spend(size);
			}
		}
		const store = projectStore();
		let unreadable = 0;
		for (const [index, stage] of detail.stages.entries()) {
			const stageNumber = index + 1;
			if (start !== undefined && stageNumber < start.stage) continue;
			if (!store || !stage.sessionId) continue;
			const spent = budget.spent();
			if (spent && (lines.length > 0 || stageNumber > (start?.stage ?? 1)))
				return { lines, unreadable, stopped: { reason: spent, cursor: `${stageNumber}.1` } };
			try {
				if (!(await budget.race(store.readHeader(stage.sessionId)))) continue;
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
				if (result.stopped) {
					const cursor = `${stageNumber}.${formatSearchCursor(result.stopped.resume)}`;
					return {
						lines,
						unreadable,
						stopped: { reason: result.stopped.reason, cursor },
					};
				}
			} catch (error) {
				rethrowAbort(budget, error);
				unreadable++;
			}
		}
		return { lines, unreadable };
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
				...(unreadable > 0 ? [`history://workflows/${runId}:0: [${unreadable} stage transcripts unreadable]`] : []),
				...(stopped
					? [
							`history://workflows/${runId}:0: [${stopText(stopped.reason)}; continue with history://workflows/${runId}?cursor=${stopped.cursor}${request.ranges ? `:${rangeText(request.ranges)}` : ""}]`,
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
					...out,
				];
			try {
				const found = await searchRun(run.runId, request, prefilter, index === 0 ? start : undefined, budget);
				out.push(...found.lines);
				unreadable += found.unreadable;
				if (found.stopped)
					return [
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
						...out,
					];
			} catch (error) {
				rethrowAbort(budget, error);
				unreadable++;
			}
		}
		return [...coverage("workflows", target, runs.length, window.length, unreadable, request.ranges), ...out];
	}

	async function readSelected(rawUrl: string, rawSelection: InternalReadSelection): Promise<string | undefined> {
		if (!rawUrl.startsWith("history://")) return undefined;
		const { url, selection } = normalizeInlineReadSelection(rawUrl, rawSelection);
		const target = parseTarget(url);
		if (target.domain === undefined) return HISTORY_HELP;
		const budget = newBudget(selection.signal);
		try {
			if (target.domain === "sessions" && target.id !== undefined)
				return await readSession(target, selection, budget);
			if (target.domain === "sessions") {
				const listed = await listSessions(target, budget);
				if (listed.preselected) return listed.text;
				const lineCursor =
					target.cursor && target.cursor.first > 0
						? { line: target.cursor.first, char: target.cursor.second }
						: undefined;
				return selectLines(url, listed.text.split("\n"), selection, lineCursor, budget);
			}
			const text =
				target.id === undefined
					? await listWorkflows(target, budget)
					: (await readRun(target.id, budget)).join("\n");
			const lineCursor =
				target.cursor && target.cursor.first > 0
					? { line: target.cursor.first, char: target.cursor.second }
					: undefined;
			return selectLines(url, text.split("\n"), selection, lineCursor, budget);
		} catch (error) {
			if (isHistoryDeadlineError(error)) {
				return `[the time budget ran out waiting for the store; continue with ${rawUrl}]`;
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
			const budget = newBudget(request.signal);
			const multiline = isMultilineSearchPattern(request.pattern, request.ignoreCase, request.literal);
			selectRegexEngine(normalizeSearchPattern(request.pattern, request.ignoreCase), request.literal, multiline);
			const prefilter = multiline ? undefined : indexLiterals(request.pattern, request.ignoreCase, request.literal);
			try {
				if (target.domain === "sessions")
					return (await searchSessions(target, request, prefilter, budget)).join("\n");
				if (target.domain === "workflows")
					return (await searchWorkflows(target, request, prefilter, budget)).join("\n");
			} catch (error) {
				if (isHistoryDeadlineError(error)) {
					return `${url}:0: [the time budget ran out waiting for the store; continue with ${rawUrl}]`;
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
			return [
				...results("sessions", "sessions", sessions),
				...results("workflows", "workflow runs", workflows),
			].join("\n");
		},
	};
}
