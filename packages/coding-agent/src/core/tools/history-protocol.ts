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
 * Query parameters: `limit=N` bounds a listing or a multi-session search; `project=all|<path>` on sessions widens the
 * scope beyond the current project.
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
const MESSAGE_TEXT_LIMIT = 8000;
const TOOL_TEXT_LIMIT = 800;
const ARGUMENT_TEXT_LIMIT = 300;
const LABEL_LIMIT = 120;
const JSON_LIMIT = 2000;
const QUERY_KEYS: Readonly<Record<"sessions" | "workflows" | "root", readonly string[]>> = {
	sessions: ["limit", "project"],
	workflows: ["limit"],
	root: ["limit", "project"],
};

type Domain = "sessions" | "workflows";
interface HistoryTarget {
	readonly domain?: Domain;
	readonly id?: string;
	readonly limit: number;
	/** `undefined` selects the current project, `"all"` every project, anything else is a project directory. */
	readonly project?: string;
}

const HISTORY_URL = /^history:\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?$/;

export const HISTORY_HELP = [
	"history:// reads and searches this project's past sessions and workflow runs, whatever storage backs them.",
	"  history://sessions                  recent sessions, newest first (?limit=N)",
	"  history://sessions/<id>[:N-M]       one session's transcript",
	"  history://workflows                 recent workflow runs, newest first (?limit=N)",
	"  history://workflows/<runId>[:N-M]   one run: inputs, stages with their sessions, result",
	'Search any of them with the search tool, e.g. paths "history://sessions" or "history://" (both); matches are',
	"labelled with a URL and line number to read with :N-M.",
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
	if (!Number.isInteger(limit) || limit < 1) throw new Error(`history limit must be a positive integer: ${limitText}`);
	const project = params.get("project") ?? undefined;
	if (project === "") throw new Error("history project must be 'all' or a directory");
	return {
		domain,
		...(idText ? { id: decodeURIComponent(idText) } : {}),
		limit: Math.min(limit, MAX_LIMIT),
		...(project === undefined ? {} : { project }),
	};
}

function clip(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more characters]` : text;
}

function oneLine(text: string, limit: number): string {
	return clip(text.replace(/\s+/g, " ").trim(), limit);
}

function jsonText(value: unknown): string {
	return clip(JSON.stringify(value) ?? "", JSON_LIMIT);
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

function contentLines(content: unknown, textLimit: number): string[] {
	if (typeof content === "string") return clip(content, textLimit).split("\n");
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const block of content as ContentBlock[]) {
		if (block.type === "text" && typeof block.text === "string")
			lines.push(...clip(block.text, textLimit).split("\n"));
		else if (block.type === "toolCall")
			lines.push(
				`[tool call] ${block.name ?? "unknown"} ${clip(JSON.stringify(block.arguments ?? {}), ARGUMENT_TEXT_LIMIT)}`,
			);
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
					return [heading("user"), ...contentLines(message.content, MESSAGE_TEXT_LIMIT)];
				case "assistant":
					return [heading("assistant"), ...contentLines(message.content, MESSAGE_TEXT_LIMIT)];
				case "toolResult":
					return [heading(`tool result ${message.toolName}`), ...contentLines(message.content, TOOL_TEXT_LIMIT)];
				case "bashExecution":
					return [
						heading(`bash ${oneLine(message.command, ARGUMENT_TEXT_LIMIT)}`),
						...clip(message.output, TOOL_TEXT_LIMIT).split("\n"),
					];
				case "custom":
					return [heading(`custom ${message.customType}`), ...contentLines(message.content, TOOL_TEXT_LIMIT)];
				case "branchSummary":
					return [heading("branch summary"), ...clip(message.summary, MESSAGE_TEXT_LIMIT).split("\n")];
				default:
					return [];
			}
		}
		case "custom_message":
			return [heading(`custom ${entry.customType}`), ...contentLines(entry.content, TOOL_TEXT_LIMIT)];
		case "compaction":
		case "branch_summary":
		case "session_summary":
			return [heading(entry.type.replace("_", " ")), ...clip(entry.summary, MESSAGE_TEXT_LIMIT).split("\n")];
		case "session_info":
			return entry.name ? [heading(`session name: ${entry.name}`)] : [];
		default:
			return [];
	}
}

async function loadTranscript(store: SessionStore, sessionId: string): Promise<string[]> {
	const { header, entries } = await store.load(sessionId);
	return [
		`# session ${header.id}`,
		`created: ${timestamp(header.createdAt)}`,
		...(header.workflow
			? [
					`workflow stage: ${header.workflow.stageName} of run ${header.workflow.runId} (history://workflows/${header.workflow.runId})`,
				]
			: []),
		...entries.flatMap(entryLines),
	];
}

function sessionLabel(summary: SessionSummary): string {
	return summary.name ? `${oneLine(summary.name, LABEL_LIMIT)}` : oneLine(summary.firstMessage, LABEL_LIMIT);
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

	async function authorizedSessionId(target: HistoryTarget): Promise<string> {
		const id = target.id ?? "";
		const header = await requireStore().readHeader(id);
		if (!header) throw new Error(`Session not found: ${id}`);
		const { cwd } = projectScope(target);
		if (cwd !== undefined && !createSessionCwdMatcher(cwd)(header.cwd))
			throw new Error(
				`Session ${id} belongs to another project. History is limited to the current project unless the user asks for other projects.`,
			);
		return id;
	}

	async function listSessions(target: HistoryTarget): Promise<string> {
		const sessions = await recentSessions(target);
		const shown = sessions.slice(0, target.limit);
		const scope =
			target.project === "all" ? "all projects" : target.project === undefined ? "this project" : target.project;
		return [
			`# ${sessions.length} sessions in ${scope}, newest first${sessions.length > shown.length ? ` (showing ${shown.length}; add ?limit=N for more)` : ""}`,
			...shown.map((summary) =>
				[
					`history://sessions/${summary.id}`,
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

	async function recentRuns(): Promise<WorkflowRunSummary[]> {
		const control = requireWorkflows();
		const runs = await (control.listProjectRuns?.() ?? control.listRuns({ includeDurable: true }));
		return [...runs].sort((a, b) => b.startedAt - a.startedAt);
	}

	async function listWorkflows(target: HistoryTarget): Promise<string> {
		const runs = await recentRuns();
		const shown = runs.slice(0, target.limit);
		return [
			`# ${runs.length} workflow runs in this project, newest first${runs.length > shown.length ? ` (showing ${shown.length}; add ?limit=N for more)` : ""}`,
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
			...(detail.identity ? [`label: ${oneLine(detail.identity, LABEL_LIMIT)}`] : []),
			...(detail.summary ? [`summary: ${detail.summary}`] : []),
			`inputs: ${jsonText(detail.inputs)}`,
			"stages:",
			...detail.stages.map((stage) =>
				[
					`- ${stage.name} [${stage.status}]`,
					...(stage.sessionId ? [`transcript history://sessions/${stage.sessionId}`] : []),
					...(stage.error ? [`error: ${oneLine(stage.error, LABEL_LIMIT)}`] : []),
				].join(" "),
			),
			...(detail.result === undefined ? [] : [`result: ${jsonText(detail.result)}`]),
			...(detail.error ? [`error: ${detail.error}`] : []),
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

	async function searchSessions(target: HistoryTarget, request: InternalSearchRequest): Promise<string[]> {
		const out: string[] = [];
		const search = (label: string, lines: string[]): void => {
			out.push(
				...searchTextSelectorLines(
					label,
					lines.join("\n"),
					request.pattern,
					request.ignoreCase,
					request.literal,
					request.contextBefore,
					request.contextAfter,
				),
			);
		};
		const store = requireStore();
		if (target.id !== undefined) {
			const id = await authorizedSessionId(target);
			search(`history://sessions/${id}`, await loadTranscript(store, id));
			return out;
		}
		const candidates = (await recentSessions(target)).filter((summary) => summary.id !== sources.currentSessionId);
		for (const summary of candidates.slice(0, target.limit)) {
			try {
				search(`history://sessions/${summary.id}`, await loadTranscript(store, summary.id));
			} catch {}
		}
		if (out.length === 0 && candidates.length > target.limit)
			out.push(
				`No matches in the ${target.limit} most recent of ${candidates.length} sessions; add ?limit=N to search further back.`,
			);
		return out;
	}

	async function searchWorkflows(target: HistoryTarget, request: InternalSearchRequest): Promise<string[]> {
		const out: string[] = [];
		const ids =
			target.id === undefined
				? (await recentRuns()).slice(0, target.limit).map((run) => run.runId)
				: [await authorizedRunId(target.id)];
		const control = requireWorkflows();
		for (const id of ids) {
			try {
				out.push(
					...searchTextSelectorLines(
						`history://workflows/${id}`,
						runLines(await control.getRun(id)).join("\n"),
						request.pattern,
						request.ignoreCase,
						request.literal,
						request.contextBefore,
						request.contextAfter,
					),
				);
			} catch {}
		}
		return out;
	}

	return {
		read: async (url) => {
			if (!url.startsWith("history://")) return undefined;
			const target = parseTarget(url);
			if (target.domain === undefined) return HISTORY_HELP;
			if (target.domain === "sessions") {
				if (target.id === undefined) return listSessions(target);
				return (await loadTranscript(requireStore(), await authorizedSessionId(target))).join("\n");
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
