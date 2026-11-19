import { stripVTControlCharacters } from "node:util";
import { isProxy } from "node:util/types";
import type { AgentToolResult } from "@bastani/atomic-agent-core";
import { type Component, stripTerminalSequences, Text, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import type { ToolRenderContext, ToolRenderers } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import {
	completionTitleDescription,
	completionTitleText,
	releasedWaitingOn,
	type TaskCompletionNotice,
	type TaskNoticeLine,
} from "../../../core/tasks/completion.js";
import type { TaskId } from "../../../core/tasks/contracts.js";
import { reopenedCompletionName } from "../../../core/tasks/reopened-completion.js";
import type { TaskTranscriptHistory, TaskTranscriptSource } from "../../../core/tasks/supervisor.js";
import {
	projectTaskCompletionEntries,
	type TaskCompletionHistory,
} from "../../../core/tasks/task-completion-history.js";
import { isBuiltinToolCallRenderer, isBuiltinToolResultRenderer } from "../../../core/tools/builtin-renderers.js";
import { theme } from "../theme/theme.js";
import { keyHint, keyHintIfBound, keyText } from "./keybinding-hints.js";
import { NoticeLine, type NoticeLineSpec } from "./notice-line.ts";
import {
	isToolBlock,
	markdownPreviewRows,
	ToolBlock,
	ToolBlockMarkdown,
	ToolBlockRecords,
	type ToolBlockStatus,
} from "./tool-block.ts";
import { type BuiltinToolBlockContentPart, builtinToolBlockPresentation } from "./tool-block-families.ts";
import { type RowRange, rowsFrom } from "./transcript-block-clicks.ts";

function previewRow(row: string): string {
	return process.env.NO_COLOR === undefined ? row : stripTerminalSequences(row);
}

const NOTICE_LINE_STATUSES = new Set(["success", "failure", "stopped", "warning", "paused", "waiting"]);
const parsedNotices = new WeakMap<object, TaskCompletionNotice>();
// A second message can share a notice but supply different content. Keep its source weak until a name is confirmed.
const stopEvidence = new WeakMap<TaskCompletionNotice, WeakSet<object> | string>();

/**
 * A line's status as saved. Earlier versions saved the line of a subagent released while it waits as paused; its
 * outcome alone says it waits, so it reads as waiting, as every other view shows that subagent (#5489).
 */
function savedNoticeStatus(status: string, outcome: string): TaskNoticeLine["status"] {
	if (status === "paused" && outcome.startsWith("is waiting on ")) return "waiting";
	return status as TaskNoticeLine["status"];
}

function noticeLineFrom(value: unknown): TaskNoticeLine | undefined {
	if (!value || typeof value !== "object") return undefined;
	const line = value as Partial<Record<keyof TaskNoticeLine, unknown>>;
	if (typeof line.status !== "string" || !NOTICE_LINE_STATUSES.has(line.status)) return undefined;
	if (typeof line.label !== "string" || typeof line.outcome !== "string") return undefined;
	return {
		status: savedNoticeStatus(line.status, line.outcome),
		label: line.label,
		outcome: line.outcome,
		...(typeof line.subject === "string" ? { subject: line.subject } : {}),
		...(typeof line.elapsedMs === "number" && Number.isFinite(line.elapsedMs) ? { elapsedMs: line.elapsedMs } : {}),
	};
}

export function completionNoticeFromDetails(details: unknown): TaskCompletionNotice | undefined {
	return readCompletionNotice(details);
}

type CapturedStop = [notice: TaskCompletionNotice, savedName: string];
function readCompletionNotice(details: unknown): TaskCompletionNotice | undefined;
function readCompletionNotice(details: unknown, captureName: true): TaskCompletionNotice | CapturedStop | undefined;
function readCompletionNotice(details: unknown, captureName = false): TaskCompletionNotice | CapturedStop | undefined {
	if (!details || typeof details !== "object" || !("notification" in details)) return undefined;
	const existing = parsedNotices.get(details);
	if (existing !== undefined) return existing;
	const notice = details.notification;
	if (!notice || typeof notice !== "object") return undefined;
	if (
		!("title" in notice) ||
		typeof notice.title !== "string" ||
		!("preview" in notice) ||
		typeof notice.preview !== "string" ||
		!("taskId" in notice) ||
		typeof notice.taskId !== "string" ||
		!("status" in notice)
	)
		return undefined;
	if (notice.status !== "completed" && notice.status !== "failed" && notice.status !== "cancelled") return undefined;
	const line = "line" in notice ? noticeLineFrom(notice.line) : undefined;
	const parsed: TaskCompletionNotice = {
		title: notice.title,
		preview: notice.preview,
		taskId: notice.taskId,
		...("taskKind" in notice && (notice.taskKind === "agent" || notice.taskKind === "command")
			? { taskKind: notice.taskKind }
			: {}),
		...("agentName" in notice && typeof notice.agentName === "string" ? { agentName: notice.agentName } : {}),
		status: notice.status,
		...("model" in notice && typeof notice.model === "string" ? { model: notice.model } : {}),
		...("thinking" in notice && typeof notice.thinking === "string" ? { thinking: notice.thinking } : {}),
		...(line === undefined ? {} : { line }),
	};
	let savedName: string | undefined;
	if (!line && parsed.status === "cancelled" && parsed.taskKind !== "command") {
		const result = "result" in details ? details.result : undefined;
		const stop = legacyStop(parsed.title, result);
		if (stop) {
			if (result === undefined && parsed.preview === "" && parsed.agentName && stop.agentName?.endsWith(":")) {
				stopEvidence.set(parsed, new WeakSet([notice]));
				if (captureName) savedName = parsed.agentName;
			}
			parsed.line = stop.line;
			if (stop.agentName !== undefined) parsed.agentName = stop.agentName;
		}
	}
	parsedNotices.set(details, parsed);
	return savedName === undefined ? parsed : [parsed, savedName];
}

/** How long a task ran: `12s`, `3m 2s`, `1h 31m`. */
export function noticeDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function isAgentNotice(notice: TaskCompletionNotice): boolean {
	return (
		notice.taskKind === "agent" ||
		(notice.taskKind === undefined &&
			(notice.agentName !== undefined ||
				notice.model !== undefined ||
				notice.thinking !== undefined ||
				notice.title.startsWith("Subagent ")))
	);
}

function agentNoticeName(notice: TaskCompletionNotice): string {
	if (notice.agentName?.trim()) return notice.agentName.trim();
	if (notice.title.startsWith("Subagent ")) {
		const rest = notice.title.slice("Subagent ".length).trim();
		const matched =
			/^(\S+?)(?:\s+(?:completed|failed|stopped|killed|paused|quit|released|timed\s+out|interrupted)\b|:|$)/i.exec(
				rest,
			)?.[1] ?? rest.split(/[\s:]+/)[0];
		if (matched === "agent" && notice.line?.subject && !/\s/.test(notice.line.subject.trim())) {
			return notice.line.subject.trim();
		}
		if (matched) return matched;
	}
	return notice.line?.subject?.trim() || "agent";
}

function agentNoticeOutcome(status: NoticeLineSpec["status"], line: TaskNoticeLine | undefined): string {
	if (status === "success") return "finished";
	if (status === "failure") return "failed";
	if (status === "stopped") return "stopped";
	return line?.outcome || "stopped";
}

const RELEASE_WORDING = "released while waiting on ";
const PAUSE_WORDING = "paused · awaiting resume";
const QUIT_WORDING = "quit · paused, awaiting resume";
// Named agents could time out, but only shells recorded a timeout duration or a restart.
const AGENT_STOP_SUFFIX =
	/^ (?:killed \(non-resumable\)|timed out|stopped(?: \((?:task owner closed|session closed|workflow stage closed|Atomic shut down)\))?):$/u;

function ownData(object: unknown, key: string): unknown {
	if (!object || typeof object !== "object" || isProxy(object)) return undefined;
	const property = Object.getOwnPropertyDescriptor(object, key);
	return property && Object.hasOwn(property, "value") ? property.value : undefined;
}

function isPlainRecord(value: unknown): value is object {
	if (!value || typeof value !== "object" || isProxy(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || prototype === Object.prototype;
}

/** A different message may share this snapshot. Only consult the original, still-intact saved data, never a lease. */
function sharedSavedName(details: unknown, notice: TaskCompletionNotice, sources: WeakSet<object>): string | undefined {
	if (!isPlainRecord(details) || "result" in details) return undefined;
	const source = ownData(details, "notification");
	if (!isPlainRecord(source) || !sources.has(source) || "line" in source) return undefined;
	if (
		ownData(source, "title") !== notice.title ||
		ownData(source, "taskId") !== notice.taskId ||
		ownData(source, "preview") !== "" ||
		ownData(source, "status") !== "cancelled" ||
		ownData(source, "taskKind") !== notice.taskKind
	)
		return undefined;
	const name = ownData(source, "agentName");
	return typeof name === "string" ? name : undefined;
}

/** A name can itself end in `killed (non-resumable):`. Only a separately saved name fixes the boundary. */
function witnessedStopName(title: string, savedName: string, label: string): string | undefined {
	if (!label.endsWith(":") || !AGENT_STOP_SUFFIX.test(label.slice(savedName.length))) return undefined;
	const name = label.slice(0, savedName.length);
	if (name !== completionTitleText(savedName)) return undefined;
	const description = title.slice("Subagent ".length + label.length + 1);
	return description === completionTitleDescription(description) ? name.trim() : undefined;
}

/** Before notices had a line, the title held the outcome, followed by `: <task description>` or a final period. */
function legacyStopWording(title: string, result: unknown): string | undefined {
	if (result !== undefined) {
		const saved = result as { kind?: string; cause?: string; released?: { waitingOn?: unknown } } | null;
		if (saved?.kind !== "cancelled") return undefined;
		if (saved.released !== undefined) {
			const calls = saved.released?.waitingOn;
			if (
				!Array.isArray(calls) ||
				!calls.every((call) => typeof call?.toolName === "string" && typeof call?.toolCallId === "string")
			)
				return undefined;
			return (
				RELEASE_WORDING + releasedWaitingOn({ kind: "cancelled", cause: "pause", released: { waitingOn: calls } })
			);
		}
		return saved.cause === "pause" ? PAUSE_WORDING : saved.cause === "quit" ? QUIT_WORDING : undefined;
	}
	// Only the notification survived. Never read a quoted notice in the task description as this task's outcome.
	const prefix =
		/^(?:Subagent (.+?)|Background task) (released while waiting on |(?:paused · awaiting resume|quit · paused, awaiting resume)(?=: |\.$))/su.exec(
			title,
		);
	if (!prefix || prefix[1]?.includes(": ")) return undefined;
	if (prefix[2] !== RELEASE_WORDING) return prefix[2];
	const calls = /^(a tool call|.+?\))(?:: |\.$)/su.exec(title.slice(prefix[0].length))?.[1];
	return calls ? RELEASE_WORDING + calls : undefined;
}

function legacyStop(title: string, result: unknown): { line: TaskNoticeLine; agentName?: string } | undefined {
	const wording = legacyStopWording(title, result);
	if (wording === undefined) return undefined;
	// The space after "Subagent" introduces its name, even if the name itself starts with the recorded outcome.
	const end = title.indexOf(` ${wording}: `, title.startsWith("Subagent ") ? "Subagent ".length : 0);
	// The writer saved only the first physical line, even when a call ID continued on the next one.
	const [ending] = ` ${wording}.`.split("\n", 1);
	const label = end >= 0 ? title.slice(0, end) : title.endsWith(ending) ? title.slice(0, -ending.length) : undefined;
	if (label !== "Background task" && !label?.startsWith("Subagent ")) return undefined;
	const waiting = wording.startsWith(RELEASE_WORDING);
	return {
		...(label.startsWith("Subagent ") ? { agentName: label.slice("Subagent ".length) } : {}),
		line: {
			label: label === "Background task" ? "Task" : "Agent",
			status: waiting ? "waiting" : "paused",
			outcome: waiting
				? `is waiting on ${wording.slice(RELEASE_WORDING.length)}`
				: wording === QUIT_WORDING
					? "quit · awaiting resume"
					: PAUSE_WORDING,
		},
	};
}

export function taskNoticeLineSpec(notice: TaskCompletionNotice): NoticeLineSpec {
	const line = notice.line;
	if (isAgentNotice(notice)) {
		const status: NoticeLineSpec["status"] =
			line?.status ??
			(notice.status === "completed" ? "success" : notice.status === "failed" ? "failure" : "stopped");
		return {
			status,
			label: agentNoticeName(notice),
			outcome: agentNoticeOutcome(status, line),
			...(line?.elapsedMs === undefined ? {} : { meta: [noticeDuration(line.elapsedMs)] }),
		};
	}
	if (line !== undefined)
		return {
			status: line.status,
			label: line.label,
			...(line.subject === undefined ? {} : { subject: line.subject }),
			outcome: line.outcome,
			...(line.elapsedMs === undefined ? {} : { meta: [noticeDuration(line.elapsedMs)] }),
		};
	return {
		status: notice.status === "completed" ? "success" : notice.status === "failed" ? "failure" : "stopped",
		label: notice.title.split("\n")[0] ?? "",
		outcome: "",
	};
}

/** Text a task reported, made safe for the terminal: no controls, tabs as spaces. */
function cleanPreview(value: string): string {
	return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
}

/**
 * Finished-task notices in the transcript, each one notice line. A shell's line expands to the tail of its output; an
 * agent's line is followed by the first line of its result, and expands to the rest. Notices joined in one message
 * show one line each. The same component renders them in the main chat, a workflow stage's chat and a subagent's view.
 */
const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
	read: "Read",
	bash: "Bash",
	edit: "Edit",
	write: "Write",
	search: "Search",
	find: "Find",
	ls: "List",
	todo: "Todo",
	web_search: "WebSearch",
	fetch_content: "Fetch",
	subagent: "Agent",
	workflow: "Workflow",
	intercom: "Intercom",
	contact_supervisor: "Supervisor",
};

function toolDisplayName(name: string): string {
	return TOOL_DISPLAY_NAMES[name] ?? name;
}

function summarizeToolArgs(name: string, args: Record<string, unknown>): string {
	if (name === "bash" && typeof args.command === "string") {
		const lines = args.command.split("\n");
		return lines.length > 1 ? `${lines[0] ?? ""}…` : (lines[0] ?? "");
	}
	if ((name === "read" || name === "write" || name === "edit") && typeof (args.path ?? args.file_path) === "string") {
		const target = String(args.path ?? args.file_path);
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		if (name === "read" && offset !== undefined && limit !== undefined) {
			return `${target}:${offset}-${offset + limit - 1}`;
		}
		return target;
	}
	if (name === "search" && typeof args.pattern === "string") {
		const paths = typeof args.paths === "string" ? args.paths : undefined;
		return paths ? `/${args.pattern}/ in ${paths}` : `/${args.pattern}/`;
	}
	if ((name === "find" || name === "ls") && typeof (args.path ?? args.paths) === "string") {
		return String(args.path ?? args.paths);
	}
	for (const value of Object.values(args)) {
		if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0] ?? "";
	}
	return "";
}

class SectionRecord implements Component {
	private readonly heading: string;
	private readonly content: Component;
	constructor(heading: string, content: Component) {
		this.heading = heading;
		this.content = content;
	}
	invalidate(): void {
		this.content.invalidate();
	}
	render(width: number): string[] {
		return [this.heading, ...this.content.render(width)];
	}
}

class ComponentList implements Component {
	private readonly items: readonly Component[];
	constructor(items: readonly Component[]) {
		this.items = items;
	}
	invalidate(): void {
		for (const item of this.items) item.invalidate();
	}
	render(width: number): string[] {
		const rows: string[] = [];
		for (const item of this.items) {
			const rendered = item.render(width);
			if (rendered.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...rendered);
		}
		return rows;
	}
}

class UnpaddedBlockComponent implements Component {
	private readonly inner: Component;
	constructor(inner: Component) {
		this.inner = inner;
	}
	invalidate(): void {
		this.inner.invalidate();
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const lines = this.inner.render(width + 1);
		if (lines.length > 0 && lines.every((line) => line.startsWith(" "))) {
			return lines.map((line) => truncateToWidth(line.slice(1), width, "…"));
		}
		return this.inner.render(width);
	}
}

interface ExtractedNoticeTranscript {
	readonly prompt: string;
	readonly toolBlocks: readonly Component[];
	readonly unavailable?: string;
}

export type TaskCompletionTranscriptLoadResult =
	| TaskCompletionHistory
	| TaskTranscriptHistory
	| ReturnType<TaskTranscriptSource["getEntries"]>
	| undefined;

export interface TaskCompletionMessageOptions {
	/** The host's independently witnessed header when the card is painted in another process. */
	readonly reopenedStopName?: string;
	/** Read when a card is expanded; `signal` aborts once no expanded card waits for the read. */
	readonly loadTranscript?: (
		taskId: TaskId,
		options?: { readonly signal?: AbortSignal },
	) => Promise<TaskCompletionTranscriptLoadResult> | TaskCompletionTranscriptLoadResult;
	readonly hasTranscript?: (taskId: TaskId) => boolean;
	readonly getToolDefinition?: (toolName: string) => ToolRenderers | undefined;
	readonly cwd?: string;
	readonly requestRender?: () => void;
}

/** A read for an expanded notice, shared by the cards that show it expanded while it runs. */
interface NoticeLoad {
	readonly result: Promise<ExtractedNoticeTranscript | null>;
	readonly controller: AbortController;
	users: number;
}

const expandedNoticeCache = new WeakMap<TaskCompletionNotice, ExtractedNoticeTranscript | null>();
const pendingNoticeLoads = new WeakMap<TaskCompletionNotice, NoticeLoad>();

function isCompletionHistory(loaded: object): loaded is TaskCompletionHistory {
	return !Array.isArray(loaded) && (loaded as { kind?: unknown }).kind === "task-completion-history";
}

function formatUnavailableReason(reason: string): string {
	const cleaned = cleanPreview(reason).trim();
	if (!cleaned) return "Transcript unavailable";
	if (/^transcript unavailable/i.test(cleaned)) return cleaned;
	return `Transcript unavailable · ${cleaned}`;
}

function renderInnerNoticeToolCall(input: {
	readonly id: string;
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly matched?: {
		readonly content: readonly BuiltinToolBlockContentPart[];
		readonly details?: unknown;
		readonly text: string;
		readonly isError: boolean;
		readonly durationMs?: number;
	};
	readonly settledStatus: ToolBlockStatus;
	readonly getToolDefinition?: (toolName: string) => ToolRenderers | undefined;
	readonly cwd: string;
}): Component {
	const { id, name, args, matched, settledStatus, getToolDefinition, cwd } = input;
	const isPartial = !matched && settledStatus === "running";
	const isError = matched?.isError === true;
	const status: ToolBlockStatus = matched
		? matched.isError
			? "failure"
			: "success"
		: settledStatus === "running"
			? "running"
			: "stopped";
	const durationMeta =
		matched?.durationMs !== undefined && matched.durationMs >= 1000
			? [noticeDuration(matched.durationMs)]
			: undefined;
	const toolDef = getToolDefinition?.(name);
	const presentation = builtinToolBlockPresentation({
		toolName: name,
		args,
		result: matched
			? {
					content: matched.content,
					details: matched.details,
					isError: matched.isError,
					durationMs: matched.durationMs,
				}
			: undefined,
		expanded: false,
		isPartial,
		cwd,
		executionStarted: true,
		argsComplete: true,
		elapsedMs: matched?.durationMs,
	});
	const canonicalCall =
		presentation !== undefined && (!toolDef?.renderCall || isBuiltinToolCallRenderer(toolDef.renderCall));
	const canonicalResult =
		presentation !== undefined && (!toolDef?.renderResult || isBuiltinToolResultRenderer(toolDef.renderResult));
	if (canonicalCall && canonicalResult && presentation) {
		return new ToolBlock({
			status: presentation.status ?? status,
			title: presentation.title,
			args: presentation.args,
			meta: presentation.meta,
			details: presentation.details,
			outputPad: 0,
		});
	}
	if (toolDef?.renderCall || toolDef?.renderResult) {
		const innerContext: ToolRenderContext = {
			args,
			toolCallId: id || name,
			invalidate: () => {},
			lastComponent: undefined,
			state: {},
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded: false,
			showImages: false,
			isError,
			durationMs: isPartial ? undefined : matched?.durationMs,
			outputPad: 0,
			getToolDefinition,
			keyText,
			keyHint,
		};
		let callComp: Component | undefined;
		if (toolDef.renderCall && !canonicalCall) {
			try {
				callComp = toolDef.renderCall(args, theme, innerContext);
			} catch {
				callComp = new Text(theme.fg("toolTitle", theme.bold(name)), 0, 0);
			}
		}
		let resultComp: Component | undefined;
		if (matched && toolDef.renderResult && !canonicalResult) {
			try {
				resultComp = toolDef.renderResult(
					{
						content: matched.content as AgentToolResult<unknown>["content"],
						details: matched.details,
					},
					{ expanded: false, isPartial },
					theme,
					innerContext,
				);
			} catch {
				const firstResult = matched.text
					.split("\n")
					.find((line) => line.trim())
					?.trim();
				if (firstResult) {
					resultComp = new Text(theme.fg(isError ? "error" : "toolOutput", cleanPreview(firstResult)), 0, 0);
				}
			}
		} else if (canonicalResult && presentation) {
			resultComp = presentation.details;
		} else if (matched?.text) {
			const firstResult = matched.text
				.split("\n")
				.find((line) => line.trim())
				?.trim();
			if (firstResult) {
				resultComp = new Text(theme.fg(isError ? "error" : "toolOutput", cleanPreview(firstResult)), 0, 0);
			}
		}
		if (resultComp && isToolBlock(resultComp)) return new UnpaddedBlockComponent(resultComp);
		if (callComp && isToolBlock(callComp)) return new UnpaddedBlockComponent(callComp);
		return new ToolBlock({
			status,
			title: callComp ?? (presentation ? presentation.title : toolDisplayName(name)),
			args: callComp ? undefined : presentation ? presentation.args : summarizeToolArgs(name, args),
			meta: presentation?.meta ?? durationMeta,
			details: resultComp,
			outputPad: 0,
		});
	}
	const firstResult = matched?.text
		? matched.text
				.split("\n")
				.find((line) => line.trim())
				?.trim()
		: undefined;
	return new ToolBlock({
		status,
		title: toolDisplayName(name),
		args: summarizeToolArgs(name, args),
		meta: durationMeta,
		details: firstResult
			? new Text(theme.fg(matched?.isError ? "error" : "toolOutput", cleanPreview(firstResult)), 0, 0)
			: undefined,
		outputPad: 0,
	});
}

function extractEntriesExpansion(
	loaded: TaskCompletionTranscriptLoadResult,
	settledStatus: ToolBlockStatus,
	options?: TaskCompletionMessageOptions,
): ExtractedNoticeTranscript | undefined {
	if (!loaded) return undefined;
	const history = isCompletionHistory(loaded)
		? loaded
		: Array.isArray(loaded)
			? projectTaskCompletionEntries(loaded)
			: projectTaskCompletionEntries(loaded.entries ?? [], loaded.unavailable);
	const { prompt, unavailable } = history;
	// No entries, or none that prompted the task, and no reason why: there is nothing more to show than the preview.
	if (!prompt && !unavailable) return undefined;
	const cwd = options?.cwd ?? process.cwd();
	const toolBlocks = history.toolCalls.map(({ id, name, args, result }) =>
		renderInnerNoticeToolCall({
			id,
			name,
			args,
			matched: result as Parameters<typeof renderInnerNoticeToolCall>[0]["matched"],
			settledStatus,
			getToolDefinition: options?.getToolDefinition,
			cwd,
		}),
	);
	return {
		prompt,
		toolBlocks,
		...(unavailable !== undefined ? { unavailable: formatUnavailableReason(unavailable) } : {}),
	};
}

export class TaskCompletionMessage implements Component {
	readonly expandsOnClick = true;
	private readonly notices: readonly TaskCompletionNotice[];
	private expanded: boolean;
	private readonly options: TaskCompletionMessageOptions | undefined;
	private disposed = false;
	private readonly loadedByTask = new Map<TaskId, ExtractedNoticeTranscript | null>();
	/** Reads this card waits for, while it is expanded. */
	private readonly pendingByTask = new Map<TaskId, NoticeLoad>();
	private readonly previewRows = new Map<TaskCompletionNotice, readonly string[]>();
	private readonly expandedPreviews = new Map<TaskCompletionNotice, ToolBlockMarkdown>();
	private stoppedName?: string;

	/** Recognize our own cards without asking an extension component for its prototype. */
	static isCard(component: Component | undefined): component is TaskCompletionMessage {
		return component !== undefined && #reuseHeader in component;
	}

	static fromMessage(
		message: CustomMessage,
		expanded: boolean,
		options?: TaskCompletionMessageOptions,
		previous?: TaskCompletionMessage,
	): TaskCompletionMessage | undefined {
		const details = message.details;
		const read = readCompletionNotice(details, true);
		if (!read) return undefined;
		const notice = Array.isArray(read) ? read[0] : read;
		const card = new TaskCompletionMessage(notice, expanded, options);
		if (card.#reuseHeader(previous, notice)) return card;
		const restored = options?.reopenedStopName ?? reopenedCompletionName(message, isProxy);
		if (restored !== undefined && notice.preview === "" && notice.agentName?.endsWith(":")) {
			const body = ownData(message, "content");
			if (body === "" || body === notice.title) card.stoppedName = restored;
			return card;
		}
		const evidence = stopEvidence.get(notice);
		if (evidence) {
			// A surviving body rules out recovery before we scan the independent name. Never invoke a body getter.
			const body = ownData(message, "content");
			if (body !== "" && body !== notice.title) return card;
			if (typeof evidence === "string") card.stoppedName = evidence;
			else {
				const name = Array.isArray(read) ? read[1] : sharedSavedName(details, notice, evidence);
				if (name && notice.agentName) {
					card.stoppedName = witnessedStopName(notice.title, name, notice.agentName);
					if (card.stoppedName) stopEvidence.set(notice, card.stoppedName);
					else stopEvidence.delete(notice);
				}
			}
		}
		return card;
	}

	// A repaint of this mounted message keeps its header decision, not its old render or transcript state.
	#reuseHeader(previous: TaskCompletionMessage | undefined, notice: TaskCompletionNotice): boolean {
		if (previous?.notices[0] !== notice) return false;
		this.stoppedName = previous.stoppedName;
		return true;
	}

	constructor(
		notices: TaskCompletionNotice | readonly TaskCompletionNotice[],
		expanded: boolean,
		options?: TaskCompletionMessageOptions,
	) {
		this.notices = Array.isArray(notices) ? notices : [notices as TaskCompletionNotice];
		this.expanded = expanded;
		this.options = options;
		if (!expanded) {
			for (const notice of this.notices) {
				expandedNoticeCache.delete(notice);
				pendingNoticeLoads.delete(notice);
			}
		}
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	/** Every row of the card, each notice's `● … finished` line and what it shows under it. */
	clickArea(width: number): RowRange | undefined {
		return rowsFrom(0, this.render(width).length);
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		if (!expanded) this.release();
	}

	dispose(): void {
		this.disposed = true;
		this.release();
		this.previewRows.clear();
	}

	/** Folded or closed: drop what the expanded card showed, and stop reading for it once no other card waits. */
	private release(): void {
		this.loadedByTask.clear();
		for (const load of this.pendingByTask.values()) if (--load.users === 0) load.controller.abort();
		this.pendingByTask.clear();
		this.expandedPreviews.clear();
		for (const notice of this.notices) {
			expandedNoticeCache.delete(notice);
			pendingNoticeLoads.delete(notice);
		}
	}

	invalidate(): void {
		this.previewRows.clear();
		this.expandedPreviews.clear();
	}

	render(width: number): string[] {
		if (width < 1) return [];
		return this.notices.flatMap((notice, index) => [
			...(index === 0 ? [] : [""]),
			...this.renderNotice(notice, width),
		]);
	}

	private ensureTranscriptLoaded(
		notice: TaskCompletionNotice,
		status: ToolBlockStatus,
	): ExtractedNoticeTranscript | undefined {
		const taskId = notice.taskId as TaskId;
		if (this.loadedByTask.has(taskId)) {
			return this.loadedByTask.get(taskId) ?? undefined;
		}
		if (expandedNoticeCache.has(notice)) {
			const cached = expandedNoticeCache.get(notice) ?? null;
			this.loadedByTask.set(taskId, cached);
			return cached ?? undefined;
		}
		const loader = this.options?.loadTranscript;
		if (!loader || this.disposed) return undefined;
		if (!this.pendingByTask.has(taskId)) {
			let load = pendingNoticeLoads.get(notice);
			if (!load) {
				const controller = new AbortController();
				const result = Promise.resolve()
					.then(() => loader(taskId, { signal: controller.signal }))
					.then(
						(loaded) => extractEntriesExpansion(loaded, status, this.options) ?? null,
						() => null,
					)
					.finally(() => {
						if (pendingNoticeLoads.get(notice) === created) pendingNoticeLoads.delete(notice);
					});
				const created: NoticeLoad = { result, controller, users: 0 };
				load = created;
				pendingNoticeLoads.set(notice, created);
			}
			const joined = load;
			joined.users += 1;
			this.pendingByTask.set(taskId, joined);
			void joined.result.then((extracted) => {
				// A fold or close released this read: it never shows, and its rows are not kept.
				if (this.pendingByTask.get(taskId) !== joined) return;
				this.pendingByTask.delete(taskId);
				joined.users -= 1;
				this.loadedByTask.set(taskId, extracted);
				expandedNoticeCache.set(notice, extracted);
				this.options?.requestRender?.();
			});
		}
		return undefined;
	}

	private renderNotice(notice: TaskCompletionNotice, width: number): string[] {
		const preview = cleanPreview(notice.preview).trimEnd();
		const agent = isAgentNotice(notice);
		const spec = taskNoticeLineSpec(notice);
		if (!agent) {
			const tail = preview.split("\n").slice(-20).join("\n");
			return new NoticeLine({ ...spec, ...(tail ? { detail: tail } : {}) }, this.expanded).render(width);
		}
		const [line] = new NoticeLine(
			this.stoppedName === undefined ? spec : { status: "stopped", label: this.stoppedName, outcome: "stopped" },
		).render(width);
		const taskId = notice.taskId as TaskId;
		const contentWidth = Math.max(1, width - 6);
		if (this.expanded) {
			const transcript = this.ensureTranscriptLoaded(notice, spec.status);
			if (transcript) {
				const records = new ToolBlockRecords([
					new SectionRecord(
						theme.bold("Prompt"),
						transcript.prompt
							? new ToolBlockMarkdown(transcript.prompt)
							: new Text(theme.fg("dim", "(none)"), 0, 0),
					),
					new SectionRecord(
						theme.bold("Tool calls"),
						transcript.toolBlocks.length > 0
							? new ComponentList(transcript.toolBlocks)
							: new Text(theme.fg("dim", transcript.unavailable ?? "(none)"), 0, 0),
					),
					new SectionRecord(
						theme.bold("Result"),
						preview ? new ToolBlockMarkdown(preview) : new Text(theme.fg("dim", "(no output)"), 0, 0),
					),
				]);
				const detailWidth = Math.max(1, width - 1);
				return [
					...(line === undefined ? [] : [line]),
					...records.render(detailWidth).map((row) => previewRow(truncateToWidth(` ${row}`, width, "…"))),
				];
			}
			if (!preview) return line === undefined ? [] : [line];
			let markdown = this.expandedPreviews.get(notice);
			if (!markdown) {
				markdown = new ToolBlockMarkdown(preview, { color: (text) => theme.fg("muted", text) });
				this.expandedPreviews.set(notice, markdown);
			}
			return [
				...(line === undefined ? [] : [line]),
				...markdown
					.render(contentWidth)
					.map((text, index) =>
						previewRow(
							truncateToWidth(
								`${theme.fg("muted", index === 0 ? "   ⎿  " : "      ")}${text.trimEnd()}`,
								width,
								"…",
							),
						),
					),
			];
		}
		const canLoadTranscript =
			this.loadedByTask.get(taskId) !== null &&
			(this.options?.hasTranscript ? this.options.hasTranscript(taskId) : Boolean(this.options?.loadTranscript));
		if (!preview && !canLoadTranscript) return line === undefined ? [] : [line];
		let rows = this.previewRows.get(notice);
		if (!rows) {
			rows = preview ? markdownPreviewRows(preview, (text) => theme.fg("muted", text)) : [];
			this.previewRows.set(notice, rows);
		}
		const firstRow = rows[0] ?? "";
		const hasMore = canLoadTranscript || rows.length > 1 || visibleWidth(firstRow) > contentWidth;
		const hintLabel = canLoadTranscript ? "for prompt, tool calls and full result" : "for the full result";
		const hint = hasMore ? keyHintIfBound("app.tools.expand", hintLabel) : "";
		return [
			...(line === undefined ? [] : [line]),
			...(firstRow ? [previewRow(truncateToWidth(`${theme.fg("muted", "   ⎿  ")}${firstRow}`, width, "…"))] : []),
			...(hint
				? [
						previewRow(
							truncateToWidth(
								`${firstRow ? "      " : "   ⎿  "}${theme.fg("dim", "(")}${hint}${theme.fg("dim", ")")}`,
								width,
								"…",
							),
						),
					]
				: []),
		];
	}
}
