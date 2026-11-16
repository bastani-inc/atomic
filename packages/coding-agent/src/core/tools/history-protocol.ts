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
import { indexLiterals, type LiteralQuery } from "./history-literals.ts";
import {
	type BudgetStop,
	DEFAULT_HISTORY_BUDGET,
	type HistoryBudget,
	HistoryCallBudget,
	lineBytes,
	oneLine,
	outlineSession,
	rangeText,
	readSessionRanges,
	readWholeOrOutline,
	type SeqCursor,
	type SeqRange,
	type SessionPlace,
	searchSession,
	stopText,
} from "./history-session.ts";
import { entryLines, textLines, timestamp, transcriptHeaderLines, wrapLine } from "./history-transcript.ts";
import { selectExactReadRanges, selectReadRanges } from "./read-selectors.ts";
import {
	type InternalReadSelection,
	type InternalResourceRouter,
	type InternalSearchRequest,
	searchTextSelectorLines,
} from "./resource-selectors.ts";

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
const QUERY_KEYS: Readonly<Record<"sessions" | "workflows" | "root", readonly string[]>> = {
	sessions: ["limit", "offset", "project", "cursor"],
	workflows: ["limit", "offset", "cursor"],
	root: ["limit", "offset", "project", "cursor"],
};
const CURSOR = /^(\d+)(?:\.(\d+))?$/;

type Domain = "sessions" | "workflows";
interface HistoryTarget {
	readonly domain?: Domain;
	readonly id?: string;
	readonly limit: number;
	readonly offset: number;
	/** `undefined` selects the current project, `"all"` every project, anything else is a project directory. */
	readonly project?: string;
	readonly cursor?: { readonly first: number; readonly second: number };
}

const HISTORY_URL = /^history:\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?$/;

export const HISTORY_HELP = [
	"history:// reads and searches this project's past sessions and workflow runs, whatever storage backs them.",
	"  history://sessions                  recent sessions, newest first (?limit=N up to 200, ?offset=N to page)",
	"  history://sessions/<id>             one session's transcript, or an outline of a long one",
	"  history://sessions/<id>:N-M         entries N to M of one session",
	"  history://workflows                 recent workflow runs, newest first (?limit=N, ?offset=N)",
	"  history://workflows/<runId>[:N-M]   one run: inputs, stages with their sessions, result",
	'Search any of them with the search tool, e.g. paths "history://sessions" or "history://" (both); a session match',
	"is labelled with its URL and entry number, which reads back with :N-N. A search of workflow runs also searches",
	"their stages' transcripts. A search covers one page of records (25 by default) and shows at most 10 matches per",
	"session; a read or search that stops early says what it covered and the URL that continues it.",
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
		throw new Error(`history cursor must be N or N.M, as a read or search that stopped early gave it: ${cursorText}`);
	return {
		domain,
		...(idText ? { id: decodeURIComponent(idText) } : {}),
		limit,
		offset,
		...(project === undefined ? {} : { project }),
		...(cursorMatch ? { cursor: { first: Number(cursorMatch[1]), second: Number(cursorMatch[2] ?? 0) } } : {}),
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

function pageUrl(domain: Domain, target: HistoryTarget, offset: number, cursor?: string): string {
	const params = new URLSearchParams();
	if (offset > 0) params.set("offset", String(offset));
	if (target.limit !== DEFAULT_LIMIT) params.set("limit", String(target.limit));
	if (domain === "sessions" && target.project !== undefined) params.set("project", target.project);
	if (cursor !== undefined) params.set("cursor", cursor);
	const query = params.toString();
	return `history://${domain}${query ? `?${query}` : ""}`;
}

function windowText(total: number, offset: number, shown: number): string {
	return shown === 0 ? `none of ${total}` : `${offset + 1}-${offset + shown} of ${total}`;
}

function selectLines(
	url: string,
	lines: readonly string[],
	selection: InternalReadSelection,
	budget: HistoryCallBudget,
) {
	const all = [...lines];
	let picked: { lines: string[]; numbers: number[] };
	if (selection.ranges !== undefined && selection.ranges.length > 0) {
		const ranges = selection.ranges.map((range) => ({ ...range }));
		const chosen = (selection.raw ? selectExactReadRanges : selectReadRanges)(all, ranges);
		picked = { lines: chosen?.selectedLines ?? [], numbers: chosen?.lineNumbers ?? [] };
		if (picked.lines.length === 0)
			return `Requested line ${ranges[0]!.start} is beyond end of resource (${all.length} lines total).`;
	} else {
		const start = Math.max(1, selection.offset ?? 1);
		if (start > all.length && selection.offset !== undefined)
			return `Requested line ${start} is beyond end of resource (${all.length} lines total).`;
		const end = selection.limit === undefined ? all.length : Math.min(all.length, start + selection.limit - 1);
		picked = {
			lines: all.slice(start - 1, end),
			numbers: Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index),
		};
	}
	const out: string[] = [];
	for (const [index, line] of picked.lines.entries()) {
		const size = lineBytes(line);
		if (!budget.fits(size) && out.length > 0) {
			const from = picked.numbers[index]!;
			out.push(
				`[read lines ${picked.numbers[0]}-${from - 1} of ${all.length}; ${stopText("byte")}; continue with ${url}:${from}-${picked.numbers.at(-1)}]`,
			);
			break;
		}
		out.push(line);
		budget.spend(size);
	}
	return out.join("\n");
}

function baseUrl(url: string): string {
	return url.replace(/[?#].*$/, "");
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

	async function recentSessions(target: HistoryTarget): Promise<SessionSummary[]> {
		const found: SessionSummary[] = [];
		for await (const summary of requireStore().list({ ...projectScope(target), withoutSearchText: true }))
			found.push(summary);
		return found.sort(
			(a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt) || b.createdAt.localeCompare(a.createdAt),
		);
	}

	async function recentRuns(): Promise<WorkflowRunSummary[]> {
		const control = requireWorkflows();
		const runs = await (control.listProjectRuns?.() ?? control.listRuns({ includeDurable: true }));
		return [...runs].sort((a, b) => b.startedAt - a.startedAt);
	}

	async function belongsToProjectRun(runId: string): Promise<boolean> {
		try {
			return (await recentRuns()).some((run) => run.runId === runId);
		} catch {
			return false;
		}
	}

	async function authorizedSession(target: HistoryTarget): Promise<{ id: string; header: SessionRecordHeader }> {
		const id = target.id ?? "";
		const header = await requireStore(id).readHeader(id);
		if (!header) throw new Error(`Session not found: ${id}`);
		if (id === sources.currentSessionId) return { id, header };
		const { cwd } = projectScope(target);
		if (cwd === undefined || createSessionCwdMatcher(cwd)(header.cwd)) return { id, header };
		// A stage session can run in its own directory or worktree; the project's run vouches for it.
		if (target.project === undefined && header.workflow && (await belongsToProjectRun(header.workflow.runId)))
			return { id, header };
		throw new Error(
			`Session ${id} belongs to another project. History is limited to the current project unless the user asks for other projects.`,
		);
	}

	async function listSessions(target: HistoryTarget): Promise<string> {
		const sessions = await recentSessions(target);
		const shown = sessions.slice(target.offset, target.offset + target.limit);
		const scope =
			target.project === "all" ? "all projects" : target.project === undefined ? "this project" : target.project;
		const next = target.offset + shown.length;
		return [
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
		].join("\n");
	}

	async function listWorkflows(target: HistoryTarget): Promise<string> {
		const runs = await recentRuns();
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

	async function authorizedRunId(id: string): Promise<string> {
		const runs = await recentRuns();
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

	async function readRun(id: string): Promise<string[]> {
		return runLines(await requireWorkflows().getRun(await authorizedRunId(id)));
	}

	async function readSession(
		target: HistoryTarget,
		selection: InternalReadSelection,
		budget: HistoryCallBudget,
	): Promise<string> {
		const { id, header } = await authorizedSession(target);
		const place = placeOf(id, requireStore(id), target);
		const headerLines = transcriptHeaderLines(header, target.project === undefined);
		const cursor: SeqCursor | undefined =
			target.cursor === undefined
				? undefined
				: { seq: Math.max(1, target.cursor.first), line: target.cursor.second };
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
		if (cursor !== undefined) return outlineSession(place, headerLines, cursor.seq, budget);
		return readWholeOrOutline(place, headerLines, budget, WHOLE_SESSION_ENTRY_LIMIT);
	}

	/** The first line of a windowed search, labelled so the search tool keeps it beside matches. */
	function coverage(
		domain: Domain,
		target: HistoryTarget,
		total: number,
		shown: number,
		unreadable: number,
	): string[] {
		const end = target.offset + shown;
		if (target.offset === 0 && end >= total && unreadable === 0) return [];
		return [
			`${pageUrl(domain, target, target.offset)}:0: [searched ${domain} ${windowText(total, target.offset, shown)}${unreadable > 0 ? `, ${unreadable} unreadable` : ""}${end < total ? `; continue with ${pageUrl(domain, target, end)}` : ""}]`,
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
			const { id } = await authorizedSession(target);
			const fromSeq = Math.max(1, target.cursor?.first ?? 1);
			const result = await searchOneSession(id, target, request, prefilter, fromSeq, budget);
			if (!result.stopped) return result.lines;
			const label = sessionUrl(id, target);
			return [
				`${label}:0: [searched entries ${fromSeq}-${result.stopped.resumeSeq - 1} of ${result.lastSeq}; ${stopText(result.stopped.reason)}; continue with ${sessionUrl(id, target, String(result.stopped.resumeSeq))}]`,
				...result.lines,
			];
		}
		const store = requireStore();
		const candidates = (await recentSessions(target)).filter((summary) => summary.id !== sources.currentSessionId);
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
						pageUrl("sessions", target, target.offset + index),
						"",
					),
					...out,
				];
			const fromSeq = index === 0 ? Math.max(1, target.cursor?.first ?? 1) : 1;
			try {
				const result = await searchOneSession(summary.id, target, request, prefilter, fromSeq, budget, store);
				out.push(...result.lines);
				if (result.stopped)
					return [
						stoppedCoverage(
							"sessions",
							"sessions",
							target,
							candidates.length,
							index + 1,
							unreadable,
							result.stopped.reason,
							pageUrl("sessions", target, target.offset + index, String(result.stopped.resumeSeq)),
							` at entry ${result.stopped.resumeSeq} of ${result.lastSeq} in ${sessionUrl(summary.id, target)}`,
						),
						...out,
					];
			} catch (error) {
				rethrowAbort(budget, error);
				unreadable++;
			}
		}
		return [...coverage("sessions", target, candidates.length, window.length, unreadable), ...out];
	}

	/**
	 * Matches in one run and in its stages' transcripts. Stage sessions are internal, so session listings and session
	 * searches leave them out; the run reaches them. A stage that never saved a session has nothing to search.
	 */
	async function searchRun(
		runId: string,
		request: InternalSearchRequest,
		prefilter: LiteralQuery | undefined,
		start: { readonly stage: number; readonly seq: number } | undefined,
		budget: HistoryCallBudget,
	): Promise<{
		readonly lines: string[];
		readonly unreadable: number;
		readonly stopped?: { readonly reason: BudgetStop; readonly cursor: string };
	}> {
		const detail = await requireWorkflows().getRun(runId);
		const lines: string[] = [];
		if (start === undefined || start.stage === 0) {
			const skipped = start?.seq ?? 0;
			const own = searchLines(`history://workflows/${runId}`, runLines(detail), request).slice(skipped);
			for (const [index, line] of own.entries()) {
				if (!budget.fits(lineBytes(line)))
					return { lines, unreadable: 0, stopped: { reason: "byte", cursor: `0.${skipped + index}` } };
				lines.push(line);
				budget.spend(lineBytes(line));
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
				if (!(await store.readHeader(stage.sessionId))) continue;
				const fromSeq = start !== undefined && stageNumber === start.stage ? Math.max(1, start.seq) : 1;
				const result = await searchSession({
					place: placeOf(stage.sessionId, store, { limit: DEFAULT_LIMIT, offset: 0 }),
					label: `history://sessions/${stage.sessionId}`,
					request: { ...request, ranges: undefined },
					prefilter,
					fromSeq,
					ranges: undefined,
					budget,
				});
				lines.push(...result.lines);
				if (result.stopped)
					return {
						lines,
						unreadable,
						stopped: { reason: result.stopped.reason, cursor: `${stageNumber}.${result.stopped.resumeSeq}` },
					};
			} catch (error) {
				rethrowAbort(budget, error);
				unreadable++;
			}
		}
		return { lines, unreadable };
	}

	const searchLines = (label: string, lines: string[], request: InternalSearchRequest): string[] =>
		searchTextSelectorLines(
			label,
			lines.join("\n"),
			request.pattern,
			request.ignoreCase,
			request.literal,
			request.contextBefore,
			request.contextAfter,
		);

	async function searchWorkflows(
		target: HistoryTarget,
		request: InternalSearchRequest,
		prefilter: LiteralQuery | undefined,
		budget: HistoryCallBudget,
	): Promise<string[]> {
		requireWorkflows();
		const start = target.cursor === undefined ? undefined : { stage: target.cursor.first, seq: target.cursor.second };
		if (target.id !== undefined) {
			const runId = await authorizedRunId(target.id);
			const { lines, unreadable, stopped } = await searchRun(runId, request, prefilter, start, budget);
			return [
				...(unreadable > 0 ? [`history://workflows/${runId}:0: [${unreadable} stage transcripts unreadable]`] : []),
				...(stopped
					? [
							`history://workflows/${runId}:0: [${stopText(stopped.reason)}; continue with history://workflows/${runId}?cursor=${stopped.cursor}]`,
						]
					: []),
				...lines,
			];
		}
		const runs = await recentRuns();
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
						pageUrl("workflows", target, target.offset + index),
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
							pageUrl("workflows", target, target.offset + index, found.stopped.cursor),
							` in history://workflows/${run.runId}`,
						),
						...out,
					];
			} catch (error) {
				rethrowAbort(budget, error);
				unreadable++;
			}
		}
		return [...coverage("workflows", target, runs.length, window.length, unreadable), ...out];
	}

	async function readSelected(url: string, selection: InternalReadSelection): Promise<string | undefined> {
		if (!url.startsWith("history://")) return undefined;
		const target = parseTarget(url);
		if (target.domain === undefined) return HISTORY_HELP;
		const budget = newBudget(selection.signal);
		if (target.domain === "sessions" && target.id !== undefined) return readSession(target, selection, budget);
		const text =
			target.domain === "sessions"
				? await listSessions(target)
				: target.id === undefined
					? await listWorkflows(target)
					: (await readRun(target.id)).join("\n");
		return selectLines(baseUrl(url), text.split("\n"), selection, budget);
	}

	return {
		read: (url) => readSelected(url, {}),
		readSelected,
		search: async (url, request) => {
			if (!url.startsWith("history://")) return undefined;
			const target = parseTarget(url);
			const budget = newBudget(request.signal);
			const prefilter = indexLiterals(request.pattern, request.ignoreCase, request.literal);
			if (target.domain === "sessions") return (await searchSessions(target, request, prefilter, budget)).join("\n");
			if (target.domain === "workflows")
				return (await searchWorkflows(target, request, prefilter, budget)).join("\n");
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
