/**
 * history:// resolution: the session and workflow history of the current project, read through the configured
 * `SessionStore` and the registered workflow run control rather than through any backend's own files.
 *
 *   history://                     what is available
 *   history://sessions             recent sessions, newest first
 *   history://sessions/<id>        one session's transcript, one line per text line
 *   history://workflows            recent workflow runs, newest first
 *   history://workflows/<runId>    one run: inputs, stages with their sessions, result
 *
 * Query parameters: `limit=N` (at most 200) and `offset=N` page a listing or a multi-record search, so every record is
 * reachable; `project=all|<path>` on sessions widens the scope beyond the current project.
 *
 * Transcripts are never shortened: a long text line is split into parts of at most `LINE_WIDTH` characters, so every
 * part can be read with a `:N-M` range.
 */

import { createSessionCwdMatcher } from "../../utils/canonical-path.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { WorkflowRunControl, WorkflowRunDetail, WorkflowRunSummary } from "../extensions/workflow-run-control.js";
import type { SessionEntry } from "../session-manager-types.ts";
import type { SessionStore, SessionSummary } from "../storage/session/types.js";
import {
	type InternalResourceRouter,
	type InternalSearchRequest,
	searchTextSelectorLines,
} from "./resource-selectors.ts";

export interface HistorySources {
	/** The project whose history is visible by default. */
	readonly cwd: string;
	readonly currentSessionId?: string;
	readonly sessionStore: () => SessionStore | undefined;
	readonly workflows: () => WorkflowRunControl | undefined;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;
const LINE_WIDTH = 4000;
const LABEL_LIMIT = 120;
const QUERY_KEYS: Readonly<Record<"sessions" | "workflows" | "root", readonly string[]>> = {
	sessions: ["limit", "offset", "project"],
	workflows: ["limit", "offset"],
	root: ["limit", "offset", "project"],
};

type Domain = "sessions" | "workflows";
interface HistoryTarget {
	readonly domain?: Domain;
	readonly id?: string;
	readonly limit: number;
	readonly offset: number;
	/** `undefined` selects the current project, `"all"` every project, anything else is a project directory. */
	readonly project?: string;
}

const HISTORY_URL = /^history:\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?$/;

export const HISTORY_HELP = [
	"history:// reads and searches this project's past sessions and workflow runs, whatever storage backs them.",
	"  history://sessions                  recent sessions, newest first (?limit=N up to 200, ?offset=N to page)",
	"  history://sessions/<id>[:N-M]       one session's transcript",
	"  history://workflows                 recent workflow runs, newest first (?limit=N, ?offset=N)",
	"  history://workflows/<runId>[:N-M]   one run: inputs, stages with their sessions, result",
	'Search any of them with the search tool, e.g. paths "history://sessions" or "history://" (both); matches are',
	"labelled with a URL and line number to read with :N-M. A search covers one page of records (25 by default); its",
	"first result says which records it covered and the ?offset=N URL that continues it.",
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
	return {
		domain,
		...(idText ? { id: decodeURIComponent(idText) } : {}),
		limit,
		offset,
		...(project === undefined ? {} : { project }),
	};
}

/** A preview for a listing row, which links to the full record. */
function oneLine(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Splits one line into parts of at most `LINE_WIDTH` characters, preferring a space, so no character is lost. */
function wrapLine(line: string): string[] {
	const parts: string[] = [];
	let rest = line;
	while (rest.length > LINE_WIDTH) {
		let cut = rest.lastIndexOf(" ", LINE_WIDTH - 1) + 1;
		if (cut < LINE_WIDTH * 0.75) {
			cut = LINE_WIDTH;
			const last = rest.charCodeAt(cut - 1);
			if (last >= 0xd800 && last <= 0xdbff) cut--;
		}
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	parts.push(rest);
	return parts;
}

function textLines(text: string): string[] {
	return text.split("\n").flatMap(wrapLine);
}

function timestamp(value: string | number | undefined): string {
	if (value === undefined) return "unknown time";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

interface ContentBlock {
	readonly type?: string;
	readonly text?: string;
	readonly name?: string;
	readonly arguments?: unknown;
}

function contentLines(content: unknown): string[] {
	if (typeof content === "string") return textLines(content);
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const block of content as ContentBlock[]) {
		if (block.type === "text" && typeof block.text === "string") lines.push(...textLines(block.text));
		else if (block.type === "toolCall")
			lines.push(...wrapLine(`[tool call] ${block.name ?? "unknown"} ${JSON.stringify(block.arguments ?? {})}`));
		else if (block.type === "image") lines.push("[image]");
	}
	return lines;
}

function entryLines(entry: SessionEntry): string[] {
	const heading = (label: string): string => `## ${timestamp(entry.timestamp)} ${label}`;
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			switch (message.role) {
				case "user":
					return [heading("user"), ...contentLines(message.content)];
				case "assistant":
					return [heading("assistant"), ...contentLines(message.content)];
				case "toolResult":
					return [heading(`tool result ${message.toolName}`), ...contentLines(message.content)];
				case "bashExecution":
					return [heading("bash"), ...textLines(`$ ${message.command}`), ...textLines(message.output)];
				case "custom":
					return [heading(`custom ${message.customType}`), ...contentLines(message.content)];
				case "branchSummary":
					return [heading("branch summary"), ...textLines(message.summary)];
				default:
					return [];
			}
		}
		case "custom_message":
			return [heading(`custom ${entry.customType}`), ...contentLines(entry.content)];
		case "compaction":
		case "branch_summary":
		case "session_summary":
			return [heading(entry.type.replace("_", " ")), ...textLines(entry.summary)];
		case "session_info":
			return entry.name ? [heading(`session name: ${entry.name}`)] : [];
		default:
			return [];
	}
}

/** `linkRun` is false for a cross-project view, whose workflow history is not reachable from here. */
async function loadTranscript(store: SessionStore, sessionId: string, linkRun: boolean): Promise<string[]> {
	const { header, entries } = await store.load(sessionId);
	return [
		`# session ${header.id}`,
		`created: ${timestamp(header.createdAt)}`,
		...(header.workflow
			? [
					`workflow stage: ${header.workflow.stageName} of run ${header.workflow.runId}${linkRun ? ` (history://workflows/${header.workflow.runId})` : ""}`,
				]
			: []),
		...entries.flatMap(entryLines),
	];
}

function sessionLabel(summary: SessionSummary): string {
	return summary.name ? oneLine(summary.name, LABEL_LIMIT) : oneLine(summary.firstMessage, LABEL_LIMIT);
}

/** A link that reads back in the same scope as the view it came from. */
function sessionUrl(id: string, target: HistoryTarget): string {
	const query = target.project === undefined ? "" : `?project=${encodeURIComponent(target.project)}`;
	return `history://sessions/${id}${query}`;
}

function pageUrl(domain: Domain, target: HistoryTarget, offset: number): string {
	const params = new URLSearchParams();
	if (offset > 0) params.set("offset", String(offset));
	if (target.limit !== DEFAULT_LIMIT) params.set("limit", String(target.limit));
	if (domain === "sessions" && target.project !== undefined) params.set("project", target.project);
	const query = params.toString();
	return `history://${domain}${query ? `?${query}` : ""}`;
}

function windowText(total: number, offset: number, shown: number): string {
	return shown === 0 ? `none of ${total}` : `${offset + 1}-${offset + shown} of ${total}`;
}

export function createHistoryRouter(sources: HistorySources): InternalResourceRouter {
	const projectScope = (target: HistoryTarget): { cwd?: string } =>
		target.project === "all"
			? {}
			: { cwd: target.project === undefined ? sources.cwd : resolvePath(target.project, sources.cwd) };

	const requireStore = (): SessionStore => {
		const store = sources.sessionStore();
		if (!store) throw new Error("Session history is unavailable: this session has no session store.");
		return store;
	};

	const requireWorkflows = (): WorkflowRunControl => {
		const control = sources.workflows();
		if (!control)
			throw new Error("Workflow history is unavailable: no workflow run control is registered for this session.");
		return control;
	};

	async function recentSessions(target: HistoryTarget): Promise<SessionSummary[]> {
		const found: SessionSummary[] = [];
		for await (const summary of requireStore().list(projectScope(target))) found.push(summary);
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

	async function authorizedSessionId(target: HistoryTarget): Promise<string> {
		const id = target.id ?? "";
		const header = await requireStore().readHeader(id);
		if (!header) throw new Error(`Session not found: ${id}`);
		const { cwd } = projectScope(target);
		if (cwd === undefined || createSessionCwdMatcher(cwd)(header.cwd)) return id;
		// A stage session can run in its own directory or worktree; the project's run vouches for it.
		if (target.project === undefined && header.workflow && (await belongsToProjectRun(header.workflow.runId)))
			return id;
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

	async function searchSessions(target: HistoryTarget, request: InternalSearchRequest): Promise<string[]> {
		const store = requireStore();
		const linkRun = target.project === undefined;
		if (target.id !== undefined) {
			const id = await authorizedSessionId(target);
			return searchLines(sessionUrl(id, target), await loadTranscript(store, id, linkRun), request);
		}
		const candidates = (await recentSessions(target)).filter((summary) => summary.id !== sources.currentSessionId);
		const window = candidates.slice(target.offset, target.offset + target.limit);
		const out: string[] = [];
		let unreadable = 0;
		for (const summary of window) {
			try {
				out.push(
					...searchLines(
						sessionUrl(summary.id, target),
						await loadTranscript(store, summary.id, linkRun),
						request,
					),
				);
			} catch {
				unreadable++;
			}
		}
		return [...coverage("sessions", target, candidates.length, window.length, unreadable), ...out];
	}

	async function searchWorkflows(target: HistoryTarget, request: InternalSearchRequest): Promise<string[]> {
		const control = requireWorkflows();
		if (target.id !== undefined)
			return searchLines(
				`history://workflows/${await authorizedRunId(target.id)}`,
				await readRun(target.id),
				request,
			);
		const runs = await recentRuns();
		const window = runs.slice(target.offset, target.offset + target.limit);
		const out: string[] = [];
		let unreadable = 0;
		for (const run of window) {
			try {
				out.push(
					...searchLines(`history://workflows/${run.runId}`, runLines(await control.getRun(run.runId)), request),
				);
			} catch {
				unreadable++;
			}
		}
		return [...coverage("workflows", target, runs.length, window.length, unreadable), ...out];
	}

	return {
		read: async (url) => {
			if (!url.startsWith("history://")) return undefined;
			const target = parseTarget(url);
			if (target.domain === undefined) return HISTORY_HELP;
			if (target.domain === "sessions") {
				if (target.id === undefined) return listSessions(target);
				const id = await authorizedSessionId(target);
				return (await loadTranscript(requireStore(), id, target.project === undefined)).join("\n");
			}
			return target.id === undefined ? listWorkflows(target) : (await readRun(target.id)).join("\n");
		},
		search: async (url, request) => {
			if (!url.startsWith("history://")) return undefined;
			const target = parseTarget(url);
			if (target.domain === "sessions") return (await searchSessions(target, request)).join("\n");
			if (target.domain === "workflows") return (await searchWorkflows(target, request)).join("\n");
			const [sessions, workflows] = await Promise.allSettled([
				searchSessions(target, request),
				searchWorkflows(target, request),
			]);
			if (sessions.status === "rejected" && workflows.status === "rejected") throw sessions.reason;
			return [
				...(sessions.status === "fulfilled" ? sessions.value : []),
				...(workflows.status === "fulfilled" ? workflows.value : []),
			].join("\n");
		},
	};
}
