import {
	builtinToolBlockPresentation,
	clickableKeyTextHint,
	formatTokenSegment,
	initTheme,
	isTaskTurnInterrupted,
	isToolBlock,
	keyHint,
	keyHintIfBound,
	keyText,
	navEntryKeys,
	slashCommandHint,
	spanElapsedMs,
	TASK_MARKS,
	type TaskId,
	type TaskRecord,
	ToolBlock,
	ToolBlockGroup,
	ToolBlockMarkdown,
	ToolBlockRecords,
	type ToolBlockStatus,
	type ToolRenderContext,
	type ToolRenderers,
} from "@bastani/atomic";
import type { AgentToolResult } from "@bastani/atomic-agent-core";
import type { Message } from "@bastani/atomic-ai/compat";
import { type Component, getKeybindings, Text, truncateToWidth } from "@bastani/atomic-tui";
import type { TaskResult, WaitOutcome } from "../../../coding-agent/src/core/tasks/contracts.js";
import { currentChildWorktreeNote } from "../runs/foreground/run-worktrees.js";
import {
	clearSubagentChildTranscriptCache,
	onSubagentCardDiscard,
	type SubagentChildIndexEntry,
	type SubagentChildToolCallEntry,
	subagentChildCardRecord,
	subagentChildCardTask,
	subagentChildIndexEntry,
	subagentChildTranscriptDetails,
	watchSubagentChildCard,
} from "../runs/foreground/subagent-child-card-state.js";
import {
	SUBAGENT_CHILD_GONE_STATUS,
	SUBAGENT_CHILD_RELEASED_STATUS,
} from "../runs/foreground/subagent-child-records.js";
import { getBurstDisplay } from "../runs/foreground/subagent-executor-burst-display.js";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor-types.js";
import { subagentTaskResultLabel } from "../runs/foreground/task-execution.js";
import { retainedTaskOutput } from "../runs/foreground/task-output-retention.js";
import { formatDuration, formatModelThinking } from "../shared/formatters.js";
import type { AgentProgress, Details, SingleResult, ToolCallSummary } from "../shared/types.js";
import { getSingleResultOutput } from "../shared/utils.js";
import { renderLiveSubagentResult } from "../tui/render.js";
import { displayProgressDurationMs, firstOutputLine, statJoin } from "../tui/render-status-progress.js";

type Theme = Parameters<typeof renderLiveSubagentResult>[2];
type RenderContext = Parameters<typeof renderLiveSubagentResult>[3] & {
	toolCallId: string;
	invalidate: () => void;
	isError?: boolean;
	outputPad?: number;
	args?: unknown;
	cwd?: string;
	getTaskRecord?: ToolRenderContext["getTaskRecord"];
	getElapsedMs?: () => number | undefined;
	getToolDefinition?: (toolName: string) => ToolRenderers | undefined;
};

const SHORT_TITLE_CHARS = 60;

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
	intercom: "Intercom",
	contact_supervisor: "Supervisor",
};

const renderRequests = new WeakMap<object, SubagentParamsLike>();
const GLOBAL_THEME_KEY = Symbol.for("@bastani/atomic:theme");

interface TaskElapsedBaseline {
	readonly reportedMs: number | undefined;
	readonly baseMs: number;
	readonly sampledAt: number;
}

interface CachedExpandedSections {
	readonly key: string;
	readonly hydratedRef: unknown;
	readonly sections: readonly Component[];
}

const taskElapsedBaselines = new WeakMap<object, Map<string, TaskElapsedBaseline>>();
const expandedSectionCaches = new WeakMap<object, Map<string, CachedExpandedSections>>();
function discardExpandedSections(card: object) {
	expandedSectionCaches.delete(card);
}

function resolveLiveTaskElapsedMs(
	state: object,
	taskId: string,
	task: TaskRecord | undefined,
	running: boolean,
	fallbackElapsedMs?: number,
): number {
	if (task?.elapsedSpan) return spanElapsedMs(task.elapsedSpan);
	if (task?.execution.kind === "queued") return 0;
	const reportedMs = task?.metrics?.elapsedMs;
	if (!running) {
		taskElapsedBaselines.get(state)?.delete(taskId);
		return reportedMs ?? fallbackElapsedMs ?? 0;
	}
	if (reportedMs === undefined && fallbackElapsedMs === undefined && task === undefined) {
		return 0;
	}
	const now = Date.now();
	let map = taskElapsedBaselines.get(state);
	if (!map) {
		map = new Map();
		taskElapsedBaselines.set(state, map);
	}
	const existing = map.get(taskId);
	if (!existing || existing.reportedMs !== reportedMs) {
		const baseMs = reportedMs ?? fallbackElapsedMs ?? 0;
		map.set(taskId, { reportedMs, baseMs, sampledAt: now });
		return Math.max(baseMs, fallbackElapsedMs ?? 0);
	}
	return Math.max(existing.baseMs + Math.max(0, now - existing.sampledAt), fallbackElapsedMs ?? 0);
}

class DynamicToolBlock implements Component {
	readonly toolBlockKind = "block" as const;
	constructor(
		private readonly evaluate: () => { readonly block: ToolBlock; readonly working: boolean },
		private readonly release?: () => void,
	) {}
	dispose(): void {
		this.release?.();
	}
	isWorking(): boolean {
		return this.evaluate().working;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.evaluate().block.render(width);
	}
}

class DynamicToolBlockGroup implements Component {
	readonly toolBlockKind = "group" as const;
	constructor(private readonly blocks: readonly (ToolBlock | DynamicToolBlock)[]) {}
	dispose(): void {
		for (const block of this.blocks) if (block instanceof DynamicToolBlock) block.dispose();
	}
	isWorking(): boolean {
		return this.blocks.some((block) => block.isWorking());
	}
	invalidate(): void {
		for (const block of this.blocks) block.invalidate();
	}
	render(width: number): string[] {
		const rows: string[] = [];
		for (const block of this.blocks) {
			const rendered = block.render(width);
			if (rendered.length === 0) continue;
			if (rows.length > 0) rows.push("");
			rows.push(...rendered);
		}
		return rows;
	}
}

function ensureGlobalTheme(): void {
	if (!(globalThis as Record<symbol, unknown>)[GLOBAL_THEME_KEY]) {
		initTheme("dark", false);
	}
}

class OneLine implements Component {
	constructor(private readonly text: string | (() => string)) {}
	/** A live line (its text read at each render, such as a running child's elapsed time) keeps the working clock. */
	isWorking(): boolean {
		return typeof this.text === "function";
	}
	invalidate(): void {}
	render(width: number): string[] {
		return width < 1 ? [] : [truncateToWidth(typeof this.text === "string" ? this.text : this.text(), width, "…")];
	}
}

const displayText = (text: string) =>
	text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

const firstDisplayLine = (text: string) => displayText(firstOutputLine(text)).trim();

export function unwrapSubagentPrompt(task: string): string {
	let text = task;
	const forkMarker = "\n\nTask:\n";
	const forkIndex = text.indexOf(forkMarker);
	if (forkIndex >= 0 && text.startsWith("You are continuing from")) {
		text = text.slice(forkIndex + forkMarker.length);
	}
	text = text.replace(
		/\n\n---\n(?:Create and maintain progress at:|Update progress at:|Write your findings to:)(?:[^\S\n]*\n)*[^\n]+$/g,
		"",
	);
	text = text.replace(/\n\n\[Write to:(?:[^\S\n]*\n)*[^\]\n]+\]\s*$/i, "");
	return text.trim();
}

export function shortSubagentTaskTitle(title: string): string {
	const unwrapped = unwrapSubagentPrompt(title);
	const rawLine = unwrapped.split("\n").find((part) => displayText(part).trim().length > 0) ?? "";
	const line = displayText(rawLine).trim();
	const sentence = /^(.{12,}?[.!?])(\s|$)/.exec(line)?.[1];
	if (sentence !== undefined && sentence.length <= SHORT_TITLE_CHARS) return sentence;
	if (line.length <= SHORT_TITLE_CHARS) return line;
	const cut = line.slice(0, SHORT_TITLE_CHARS);
	const space = cut.lastIndexOf(" ");
	return `${(space > SHORT_TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function formatAgentBlockArgs(agent: string | undefined, task: string | undefined): string {
	const cleanAgent = displayText(agent || "?").trim() || "?";
	const shortTitle = shortSubagentTaskTitle(task ?? "");
	return shortTitle && shortTitle !== cleanAgent ? `${cleanAgent} · ${shortTitle}` : cleanAgent;
}

function expandParallelTasks(
	args: SubagentParamsLike | undefined,
	burstCount?: number,
): Array<{ agent: string; task: string }> {
	if (!args) {
		return Array.from({ length: Math.max(1, burstCount ?? 1) }, () => ({ agent: "agent", task: "" }));
	}
	if ((args.tasks?.length ?? 0) > 0) {
		return (args.tasks ?? []).flatMap((task) => {
			const count =
				typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
			return Array.from({ length: count }, () => ({ agent: task.agent || "agent", task: task.task ?? "" }));
		});
	}
	if (burstCount !== undefined && burstCount > 1) {
		return Array.from({ length: burstCount }, (_, index) =>
			index === 0
				? { agent: args.agent || "agent", task: args.task ?? "" }
				: { agent: args.agent || "agent", task: "" },
		);
	}
	if (args.agent) return [{ agent: args.agent, task: args.task ?? "" }];
	return [];
}

function hasPanelRow(task: TaskRecord | undefined, observation?: Pick<WaitOutcome, "kind">): boolean {
	if (task !== undefined) {
		if (task.execution.kind === "settled") return false;
		if (task.wasBackground === true) return true;
		return task.observation.kind === "background" && task.observation.reason !== "not-observed";
	}
	return observation === undefined || observation.kind === "yielded";
}

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

class ComponentList implements Component {
	constructor(private readonly items: readonly Component[]) {}
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
	constructor(private readonly inner: Component) {}
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

function innerToolBlockFromEntry(
	entry: SubagentChildToolCallEntry,
	parentRunning: boolean,
	theme: Theme,
	context?: Pick<RenderContext, "cwd" | "getToolDefinition">,
): Component {
	const isPartial = !entry.completed && parentRunning;
	const isError = entry.isError === true;
	const status: ToolBlockStatus = entry.completed
		? entry.isError
			? "failure"
			: "success"
		: parentRunning
			? "running"
			: "stopped";
	const meta =
		entry.durationMs !== undefined && entry.durationMs >= 1000 ? [formatDuration(entry.durationMs)] : undefined;
	const cwd = context?.cwd ?? process.cwd();
	const resultContent =
		entry.resultContent ?? (entry.resultText !== undefined ? [{ type: "text", text: entry.resultText }] : []);
	const presentation = builtinToolBlockPresentation({
		toolName: entry.name,
		args: entry.args,
		result: entry.completed
			? {
					content: resultContent,
					details: entry.resultDetails,
					isError,
					durationMs: entry.durationMs,
				}
			: undefined,
		expanded: false,
		isPartial,
		cwd,
		executionStarted: true,
		argsComplete: true,
		elapsedMs: entry.durationMs,
	});
	const toolDef = context?.getToolDefinition?.(entry.name);
	if (presentation !== undefined && !toolDef?.renderCall && !toolDef?.renderResult) {
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
			args: entry.args,
			toolCallId: entry.id || entry.name,
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
			durationMs: isPartial ? undefined : entry.durationMs,
			outputPad: 0,
			getToolDefinition: context?.getToolDefinition,
			keyText,
			keyHint,
		};
		let callComp: Component | undefined;
		if (toolDef.renderCall) {
			try {
				callComp = toolDef.renderCall(entry.args, theme, innerContext);
			} catch {
				callComp = new Text(theme.fg("toolTitle", theme.bold(entry.name)), 0, 0);
			}
		}
		let resultComp: Component | undefined;
		if (entry.completed && toolDef.renderResult) {
			try {
				resultComp = toolDef.renderResult(
					{
						content: resultContent as AgentToolResult<unknown>["content"],
						details: entry.resultDetails,
					},
					{ expanded: false, isPartial },
					theme,
					innerContext,
				);
			} catch {
				const firstResult = entry.resultText ? firstDisplayLine(entry.resultText) : "";
				if (firstResult) {
					resultComp = new Text(theme.fg(isError ? "error" : "toolOutput", firstResult), 0, 0);
				}
			}
		} else if (presentation?.details) {
			resultComp = presentation.details;
		} else if (entry.resultText) {
			const firstResult = firstDisplayLine(entry.resultText);
			if (firstResult) {
				resultComp = new Text(theme.fg(isError ? "error" : "toolOutput", firstResult), 0, 0);
			}
		}
		if (resultComp && isToolBlock(resultComp)) return new UnpaddedBlockComponent(resultComp);
		if (callComp && isToolBlock(callComp)) return new UnpaddedBlockComponent(callComp);
		return new ToolBlock({
			status,
			title: callComp ?? (presentation ? presentation.title : toolDisplayName(entry.name)),
			args: callComp ? undefined : presentation ? presentation.args : summarizeToolArgs(entry.name, entry.args),
			...(presentation?.meta ? { meta: presentation.meta } : meta ? { meta } : {}),
			...(resultComp ? { details: resultComp } : {}),
			outputPad: 0,
		});
	}
	if (presentation !== undefined) {
		return new ToolBlock({
			status: presentation.status ?? status,
			title: presentation.title,
			args: presentation.args,
			meta: presentation.meta,
			details: presentation.details,
			outputPad: 0,
		});
	}
	const firstResult = entry.resultText ? firstDisplayLine(entry.resultText) : "";
	return new ToolBlock({
		status,
		title: toolDisplayName(entry.name),
		args: summarizeToolArgs(entry.name, entry.args),
		...(meta ? { meta } : {}),
		...(firstResult
			? { details: new Text(theme.fg(entry.isError ? "error" : "toolOutput", firstResult), 0, 0) }
			: {}),
		outputPad: 0,
	});
}

function toolEntriesFromMessages(messages: readonly Message[] | undefined): SubagentChildToolCallEntry[] {
	if (!messages || messages.length === 0) return [];
	const resultsById = new Map<
		string,
		{
			content: readonly { type: string; text?: string; data?: string; mimeType?: string }[];
			details?: unknown;
			text: string;
			isError: boolean;
		}
	>();
	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		const id = "toolCallId" in msg && typeof msg.toolCallId === "string" ? msg.toolCallId : "";
		if (!id) continue;
		const content = Array.isArray(msg.content)
			? (msg.content as readonly { type: string; text?: string; data?: string; mimeType?: string }[])
			: [];
		const text = content
			.filter(
				(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n");
		resultsById.set(id, {
			content,
			...("details" in msg && msg.details !== undefined ? { details: msg.details } : {}),
			text,
			isError: msg.isError === true,
		});
	}
	const entries: SubagentChildToolCallEntry[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall") continue;
			const id = typeof part.id === "string" ? part.id : "";
			const args =
				typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
					? (part.arguments as Record<string, unknown>)
					: {};
			const matched = id ? resultsById.get(id) : undefined;
			entries.push({
				id,
				name: part.name,
				args,
				...(matched
					? {
							resultContent: matched.content,
							...(matched.details !== undefined ? { resultDetails: matched.details } : {}),
							resultText: matched.text,
							isError: matched.isError,
							completed: true,
						}
					: { completed: false }),
			});
		}
	}
	return entries;
}

function toolBlocksFromSummaries(
	summaries: readonly ToolCallSummary[] | undefined,
	progress: AgentProgress | undefined,
): ToolBlock[] {
	if (summaries && summaries.length > 0) {
		return summaries.map((summary) => {
			const raw = displayText(summary.expandedText || summary.text).trim();
			if (raw.startsWith("$ ")) {
				return new ToolBlock({
					status: "success",
					title: "Bash",
					args: raw.slice(2).trim(),
					outputPad: 0,
				});
			}
			const space = raw.indexOf(" ");
			const name = space > 0 ? raw.slice(0, space) : raw;
			const argText = space > 0 ? raw.slice(space + 1).trim() : "";
			return new ToolBlock({
				status: "success",
				title: toolDisplayName(name),
				args: argText,
				outputPad: 0,
			});
		});
	}
	if (!progress) return [];
	const blocks = progress.recentTools.map(
		(tool) =>
			new ToolBlock({
				status: "success",
				title: toolDisplayName(tool.tool),
				args: displayText(tool.args),
				outputPad: 0,
			}),
	);
	if (progress.currentTool) {
		blocks.push(
			new ToolBlock({
				status: progress.status === "running" ? "running" : "stopped",
				title: toolDisplayName(progress.currentTool),
				args: displayText(progress.currentToolArgs ?? ""),
				outputPad: 0,
			}),
		);
	}
	return blocks;
}

class SectionRecord implements Component {
	constructor(
		private readonly heading: string,
		private readonly content: Component,
	) {}
	invalidate(): void {
		this.content.invalidate();
	}
	render(width: number): string[] {
		return [this.heading, ...this.content.render(width)];
	}
}

function extractInlineSettledOutput(result: AgentToolResult<Details>, taskId: string): string | undefined {
	const textPart = result.content.find((part) => part.type === "text");
	if (textPart?.type !== "text") return undefined;
	const prefix = `Output of ${taskId} (`;
	const start = textPart.text.indexOf(prefix);
	if (start < 0) return undefined;
	const afterStart = textPart.text.slice(start);
	const nextOutput = afterStart.indexOf("\n\nOutput of ", prefix.length);
	const section = nextOutput >= 0 ? afterStart.slice(0, nextOutput) : afterStart;
	const lines = section.split("\n").slice(1);
	while (
		lines.length > 0 &&
		/^(?:Model: ran on |Requested output: |Output file error: |Full output: )/.test(lines[0] ?? "")
	) {
		lines.shift();
	}
	const body = lines.join("\n").trim();
	return body || undefined;
}

function buildExpandedDetails(input: {
	readonly state?: object;
	readonly cacheId?: string;
	readonly hydratedRef?: unknown;
	readonly statusLine: string | (() => string);
	/** The child is running: its unfinished tool calls are still working, and an empty result reads `Running…`. */
	readonly running: boolean;
	readonly promptText: string;
	readonly buildToolBlocks: () => readonly Component[];
	readonly toolCallsUnavailable?: string;
	readonly resultText?: string;
	readonly failureText?: string;
	readonly theme: Theme;
}): ToolBlockRecords {
	const {
		state,
		cacheId,
		hydratedRef,
		statusLine,
		running,
		promptText,
		buildToolBlocks,
		toolCallsUnavailable,
		resultText,
		failureText,
		theme,
	} = input;
	const cleanPrompt = unwrapSubagentPrompt(promptText);
	const runningKey = running ? "1" : "0";
	const key = `${runningKey}\u0000${cleanPrompt}\u0000${toolCallsUnavailable ?? ""}\u0000${resultText ?? ""}\u0000${failureText ?? ""}`;
	if (state && cacheId) {
		let cache = expandedSectionCaches.get(state);
		if (!cache) {
			cache = new Map();
			expandedSectionCaches.set(state, cache);
		}
		const existing = cache.get(cacheId);
		if (existing && existing.key === key && existing.hydratedRef === hydratedRef) {
			return new ToolBlockRecords([new OneLine(statusLine), ...existing.sections]);
		}
		const toolBlocks = buildToolBlocks();
		const sections: readonly Component[] = [
			new SectionRecord(
				theme.bold("Prompt"),
				cleanPrompt ? new ToolBlockMarkdown(cleanPrompt) : new Text(theme.fg("dim", "(none)"), 0, 0),
			),
			new SectionRecord(
				theme.bold("Tool calls"),
				toolBlocks.length > 0
					? new ComponentList(toolBlocks)
					: new Text(theme.fg("dim", toolCallsUnavailable || "(none)"), 0, 0),
			),
			new SectionRecord(
				theme.bold("Result"),
				resultText
					? new ToolBlockMarkdown(resultText)
					: failureText
						? new Text(theme.fg("error", displayText(failureText)), 0, 0)
						: new Text(theme.fg("dim", running ? "Running…" : "(no output)"), 0, 0),
			),
		];
		cache.set(cacheId, { key, hydratedRef, sections });
		return new ToolBlockRecords([new OneLine(statusLine), ...sections]);
	}
	const toolBlocks = buildToolBlocks();
	return new ToolBlockRecords([
		new OneLine(statusLine),
		new SectionRecord(
			theme.bold("Prompt"),
			cleanPrompt ? new ToolBlockMarkdown(cleanPrompt) : new Text(theme.fg("dim", "(none)"), 0, 0),
		),
		new SectionRecord(
			theme.bold("Tool calls"),
			toolBlocks.length > 0
				? new ComponentList(toolBlocks)
				: new Text(theme.fg("dim", toolCallsUnavailable || "(none)"), 0, 0),
		),
		new SectionRecord(
			theme.bold("Result"),
			resultText
				? new ToolBlockMarkdown(resultText)
				: failureText
					? new Text(theme.fg("error", displayText(failureText)), 0, 0)
					: new Text(theme.fg("dim", running ? "Running…" : "(no output)"), 0, 0),
		),
	]);
}

/** A released child's status words: what it waits on, by tool name, as `/tasks` and the agent panel name it. */
function waitingText(tools: string | undefined): string {
	return `Waiting on ${displayText(tools ?? "a tool call")}`;
}

/** The tools a released child waits on, by name and once each; undefined for any other result. */
function releasedWaitingTools(result: TaskResult): string | undefined {
	if (result.kind !== "cancelled" || result.released === undefined) return undefined;
	return [...new Set(result.released.waitingOn.map((call) => call.toolName))].join(", ") || undefined;
}

/**
 * A launched subagent waiting for its turn to run, or being stopped: the agent panel's `queued` and `stopping`. The live
 * task says so, or, with no live task, the child's own record of this task while it waits to be dispatched (its span is
 * null until then). A saved receipt can predate dispatch, and a settled result or a record of its end outranks both.
 */
function waitingState(input: {
	readonly freshTask: TaskRecord | undefined;
	readonly record: Pick<SubagentChildIndexEntry, "state" | "elapsedSpan" | "taskId"> | undefined;
	readonly settled: TaskResult | undefined;
	readonly observation: { readonly kind: WaitOutcome["kind"]; readonly taskId: string };
	readonly activeTaskId: string;
}): "queued" | "stopping" | undefined {
	const { freshTask, record, settled, observation, activeTaskId } = input;
	if (settled !== undefined || record?.state === "terminal") return undefined;
	if (observation.kind === "settled" && observation.taskId === activeTaskId) return undefined;
	const kind = freshTask?.execution.kind;
	if (kind === "cancelling") return "stopping";
	if (kind === "queued") return "queued";
	if (kind === undefined && record?.elapsedSpan === null && record.taskId === activeTaskId) return "queued";
	return undefined;
}

function buildOutcomeToolBlock(input: {
	readonly slot: number;
	readonly outcome:
		| { readonly kind: "sdk-handoff"; readonly childId: string; readonly taskId: string }
		| Extract<NonNullable<Details["taskResponse"]>, { kind: "admitted" | "unstarted" }>
		| NonNullable<Extract<NonNullable<Details["taskResponse"]>, { kind: "parallel" }>["slots"][number]["outcome"]>;
	readonly identity?: { readonly agent: string; readonly task: string };
	readonly result: AgentToolResult<Details>;
	readonly expanded: boolean;
	readonly theme: Theme;
	readonly context: RenderContext;
}): DynamicToolBlock {
	const { outcome, identity, result, expanded, theme, context } = input;
	if (outcome.kind === "unstarted") {
		const agentName = identity?.agent || "agent";
		const promptText = identity?.task || "";
		const args = formatAgentBlockArgs(agentName, promptText);
		if (outcome.reason.kind === "rejected") {
			const reason = firstDisplayLine(outcome.reason.error.message || "Not started");
			const statusLine = theme.fg("error", ["Failed", reason].filter(Boolean).join(" · "));
			const tree = result.details?.rejectedWorktrees?.[input.slot];
			const block = new ToolBlock({
				status: "failure",
				title: "Agent",
				args,
				body: tree
					? {
							invalidate() {},
							render(width) {
								const note = currentChildWorktreeNote(tree.runId, tree.index);
								return note ? new Text(theme.fg("dim", note), 0, 0).render(width) : [];
							},
						}
					: undefined,
				details: expanded
					? buildExpandedDetails({
							statusLine,
							running: false,
							promptText,
							buildToolBlocks: () => [],
							failureText: outcome.reason.error.message,
							theme,
						})
					: new OneLine(statusLine),
				outputPad: context.outputPad,
			});
			return new DynamicToolBlock(() => ({ block, working: false }));
		}
		const statusLine = statJoin(theme, ["Stopped"]);
		const block = new ToolBlock({
			status: "task-stopped",
			title: "Agent",
			args,
			details: expanded
				? buildExpandedDetails({
						statusLine,
						running: false,
						promptText,
						buildToolBlocks: () => [],
						theme,
					})
				: new OneLine(statusLine),
			outputPad: context.outputPad,
		});
		return new DynamicToolBlock(() => ({ block, working: false }));
	}

	const observation =
		outcome.kind === "sdk-handoff" ? { kind: "yielded" as const, taskId: outcome.taskId } : outcome.observation;
	const savedTask = result.details?.taskRecords?.find((item) => item.ref.taskId === observation.taskId);
	const childId = outcome.kind === "sdk-handoff" ? outcome.childId : savedTask?.launchOperationId;
	const initialRecord = subagentChildCardRecord(childId, observation.taskId);
	watchSubagentChildCard(
		context.state,
		context.invalidate,
		initialRecord?.childId ?? childId ?? observation.taskId,
		result.details?.ownerSessionId,
	);

	const evaluate = (): { readonly block: ToolBlock; readonly working: boolean } => {
		const record = subagentChildCardRecord(childId, observation.taskId);
		const activeTaskId = record?.taskId ?? observation.taskId;
		const freshTask = context.getTaskRecord?.(activeTaskId as TaskId);
		const task = freshTask ?? (savedTask?.ref.taskId === activeTaskId ? savedTask : undefined);
		const hydrated = expanded && record ? subagentChildTranscriptDetails(context.state, record) : undefined;
		const recordTask = record ? subagentChildCardTask(record) : undefined;
		const agentName = identity?.agent || task?.agentName || record?.agent || "agent";
		const headerTask = task?.title || recordTask || identity?.task || hydrated?.prompt || "";
		const promptText = hydrated?.prompt || identity?.task || recordTask || task?.title || "";
		const args = formatAgentBlockArgs(agentName, headerTask);
		const taskSettled = task?.execution.kind === "settled" ? task.execution.result : undefined;
		const failure =
			taskSettled?.kind === "failed"
				? taskSettled.message
				: observation.kind === "settled" && observation.result.kind === "failed"
					? observation.result.message
					: undefined;

		// A saved receipt can predate dispatch, or belong to an earlier run of this child.
		const span = freshTask?.elapsedSpan ?? record?.elapsedSpan;
		const turnInterrupted =
			(task !== undefined && isTaskTurnInterrupted(task)) ||
			(record?.state === "running" && !taskSettled && span?.endedAt !== undefined);
		const isRunningNow =
			task?.attention.kind === "input-needed" || turnInterrupted
				? false
				: taskSettled !== undefined
					? false
					: record
						? record.state === "running"
						: observation.kind === "yielded" ||
							task?.execution.kind === "running" ||
							task?.execution.kind === "queued";

		const elapsedMs =
			record?.state === "terminal" && record.elapsedMs !== undefined
				? record.elapsedMs
				: span !== undefined
					? span === null
						? 0
						: spanElapsedMs(span)
					: resolveLiveTaskElapsedMs(
							context.state,
							activeTaskId,
							task,
							isRunningNow,
							record?.taskId !== observation.taskId && record !== undefined
								? record.elapsedMs
								: context.getElapsedMs?.(),
						);
		const tokens = task?.metrics?.tokenCount ?? 0;
		const elapsedText = elapsedMs > 0 ? formatDuration(elapsedMs) : "";
		const runningElapsedText = elapsedMs >= 1000 ? formatDuration(elapsedMs) : "";
		const tokenText = formatTokenSegment({ mode: "receiving", count: tokens });
		const waiting = waitingState({ freshTask, record, settled: taskSettled, observation, activeTaskId });

		let status: ToolBlockStatus;
		let statusLine: string;

		if (waiting === "stopping") {
			// Being stopped, as the agent panel shows it, whatever it was doing.
			status = "task-stopping";
			statusLine = statJoin(theme, ["Stopping", elapsedText]);
		} else if (waiting === "queued") {
			status = "task-queued";
			statusLine = statJoin(theme, ["Queued"]);
		} else if (task?.attention.kind === "input-needed") {
			status = "input";
			const questionFirstLine = firstDisplayLine(task.attention.prompt || "");
			const answerKey = navEntryKeys(getKeybindings(), { action: "app.agents.focus", label: "to answer" });
			statusLine = statJoin(theme, [
				"Needs input",
				questionFirstLine,
				answerKey ? clickableKeyTextHint(answerKey, " to answer") : "",
			]);
		} else if (turnInterrupted) {
			// Esc in its chat paused it: it is still running, and a message continues it.
			status = "paused";
			statusLine = statJoin(theme, ["Paused", elapsedText]);
		} else if (taskSettled !== undefined && (!record || record.state === "running")) {
			if (taskSettled.kind === "completed") {
				status = "success";
				statusLine = statJoin(theme, ["Done", elapsedText, tokenText]);
			} else if (taskSettled.kind === "failed") {
				status = "failure";
				const reason = firstDisplayLine(taskSettled.message || "");
				statusLine = theme.fg("error", ["Failed", elapsedText, reason].filter(Boolean).join(" · "));
			} else if (taskSettled.released) {
				status = "waiting";
				statusLine = statJoin(theme, [waitingText(releasedWaitingTools(taskSettled)), elapsedText]);
			} else if (subagentTaskResultLabel(taskSettled) === "paused · awaiting resume") {
				// Paused or quit until it is resumed: stopped, as the agent panel and /tasks show it.
				status = "task-stopped";
				statusLine = statJoin(theme, ["Paused · awaiting resume", elapsedText]);
			} else {
				status = "task-stopped";
				statusLine = statJoin(theme, ["Stopped", elapsedText]);
			}
		} else if (record) {
			if (record.state === "running") {
				status = "agent-running";
				const manageKey =
					outcome.kind !== "sdk-handoff" && hasPanelRow(task, observation)
						? navEntryKeys(getKeybindings(), { action: "app.agents.focus", label: "to manage" })
						: "";
				statusLine = statJoin(theme, [
					"Running",
					runningElapsedText,
					tokenText,
					manageKey ? clickableKeyTextHint(manageKey, " to manage") : "",
				]);
			} else {
				const terminal = record.terminalStatus ?? "";
				if (terminal === "ok") {
					status = "success";
					statusLine = statJoin(theme, ["Done", elapsedText, tokenText]);
				} else if (terminal === "error" || terminal === SUBAGENT_CHILD_GONE_STATUS) {
					status = "failure";
					const reason = firstDisplayLine(
						failure ?? (terminal === SUBAGENT_CHILD_GONE_STATUS ? "gone after a restart" : ""),
					);
					statusLine = theme.fg("error", ["Failed", elapsedText, reason].filter(Boolean).join(" · "));
				} else if (terminal === "paused" || terminal === "quit") {
					status = "task-stopped";
					const label = terminal === "quit" ? "Quit · paused · awaiting resume" : "Paused · awaiting resume";
					statusLine = statJoin(theme, [label, elapsedText]);
				} else if (terminal === SUBAGENT_CHILD_RELEASED_STATUS) {
					status = "waiting";
					statusLine = statJoin(theme, [
						waitingText(taskSettled === undefined ? undefined : releasedWaitingTools(taskSettled)),
						elapsedText,
					]);
				} else {
					status = "task-stopped";
					statusLine = statJoin(theme, ["Stopped", elapsedText]);
				}
			}
		} else if (observation.kind === "yielded") {
			status = "agent-running";
			const manageKey = hasPanelRow(task, observation)
				? navEntryKeys(getKeybindings(), { action: "app.agents.focus", label: "to manage" })
				: "";
			statusLine = statJoin(theme, [
				"Running",
				runningElapsedText,
				tokenText,
				manageKey ? clickableKeyTextHint(manageKey, " to manage") : "",
			]);
		} else if (observation.result.kind === "completed") {
			status = "success";
			statusLine = statJoin(theme, ["Done", elapsedText, tokenText]);
		} else if (observation.result.kind === "failed") {
			status = "failure";
			const reason = firstDisplayLine(observation.result.message || "");
			statusLine = theme.fg("error", ["Failed", elapsedText, reason].filter(Boolean).join(" · "));
		} else if (observation.result.released) {
			status = "waiting";
			statusLine = statJoin(theme, [waitingText(releasedWaitingTools(observation.result)), elapsedText]);
		} else if (subagentTaskResultLabel(observation.result) === "paused · awaiting resume") {
			status = "task-stopped";
			statusLine = statJoin(theme, ["Paused · awaiting resume", elapsedText]);
		} else {
			status = "task-stopped";
			statusLine = statJoin(theme, ["Stopped", elapsedText]);
		}

		const working = status === "agent-running";

		if (!expanded) {
			return {
				block: new ToolBlock({
					status,
					title: "Agent",
					args,
					details: new OneLine(statusLine),
					outputPad: context.outputPad,
				}),
				working,
			};
		}

		const ownerId =
			task?.ref.ownerId ?? (observation.kind === "settled" ? observation.result.output?.ownerId : undefined);
		const kept = ownerId ? retainedTaskOutput(ownerId, activeTaskId) : undefined;
		const answer = hydrated?.result ?? (kept?.head.trim() || extractInlineSettledOutput(result, activeTaskId));
		const tree = kept?.worktree ?? record;
		const note = !isRunningNow && tree ? currentChildWorktreeNote(tree.runId, tree.index) : undefined;
		const resultText = note ? [note, answer].filter(Boolean).join("\n\n") : answer;
		const toolCallsUnavailable =
			hydrated?.unavailable ??
			((task?.metrics?.toolCount ?? 0) > 0 && (!hydrated || hydrated.toolCalls.length === 0)
				? "Transcript unavailable"
				: undefined);

		return {
			block: new ToolBlock({
				status,
				title: "Agent",
				args,
				details: buildExpandedDetails({
					state: context.state,
					cacheId: activeTaskId,
					hydratedRef: hydrated?.toolCalls,
					statusLine,
					running: working,
					promptText,
					buildToolBlocks: () =>
						(hydrated?.toolCalls ?? []).map((entry) => innerToolBlockFromEntry(entry, working, theme, context)),
					toolCallsUnavailable,
					resultText,
					failureText: failure,
					theme,
				}),
				outputPad: context.outputPad,
			}),
			working,
		};
	};

	if (expanded) onSubagentCardDiscard(context.state, discardExpandedSections);
	return new DynamicToolBlock(evaluate, expanded ? () => clearSubagentChildTranscriptCache(context.state) : undefined);
}

function buildForegroundChildToolBlock(input: {
	readonly child: SingleResult | undefined;
	readonly progress: AgentProgress | undefined;
	readonly identity?: { readonly agent: string; readonly task: string };
	readonly taskRecord?: TaskRecord;
	readonly childId?: string;
	readonly expanded: boolean;
	readonly now?: number;
	readonly theme: Theme;
	readonly outputPad?: number;
	readonly context?: Pick<RenderContext, "cwd" | "getToolDefinition" | "getTaskRecord">;
}): ToolBlock {
	const { child, progress, identity, taskRecord, expanded, now, theme, outputPad, context } = input;
	const activeProgress = child?.progress ?? progress;
	const summary = activeProgress ?? child?.progressSummary;
	const turnInterrupted = taskRecord !== undefined && isTaskTurnInterrupted(taskRecord);
	const isRunning =
		!turnInterrupted && (activeProgress?.status === "running" || (!child && activeProgress?.status === "pending"));
	const agentName = child?.agent || activeProgress?.agent || identity?.agent || taskRecord?.agentName || "agent";
	const headerTask = taskRecord?.title || activeProgress?.task || child?.task || identity?.task || "";
	const rawTask = identity?.task || child?.task || activeProgress?.task || taskRecord?.title || "";
	const args = formatAgentBlockArgs(agentName, headerTask);
	const span = activeProgress?.elapsedSpan ?? taskRecord?.elapsedSpan;
	const elapsedMs = span
		? spanElapsedMs(span, now)
		: summary
			? displayProgressDurationMs(summary, now)
			: (taskRecord?.metrics?.elapsedMs ?? 0);
	const tokens = summary?.tokens ?? taskRecord?.metrics?.tokenCount ?? 0;
	const elapsedText = elapsedMs > 0 ? formatDuration(elapsedMs) : "";
	const tokenText = formatTokenSegment({ mode: "receiving", count: tokens });
	const output = child ? child.truncation?.text || getSingleResultOutput(child) : "";

	let status: ToolBlockStatus;
	let statusLine: string | (() => string);
	/** The child is running here: its live status line and its unfinished tool calls keep working. */
	let live = false;

	if (taskRecord?.attention.kind === "input-needed") {
		status = "input";
		const questionFirstLine = firstDisplayLine(taskRecord.attention.prompt || "");
		const answerKey = navEntryKeys(getKeybindings(), { action: "app.agents.focus", label: "to answer" });
		statusLine = statJoin(theme, [
			"Needs input",
			questionFirstLine,
			answerKey ? clickableKeyTextHint(answerKey, " to answer") : "",
		]);
	} else if (turnInterrupted) {
		status = "paused";
		statusLine = statJoin(theme, ["Paused", elapsedText]);
	} else if (isRunning) {
		status = "agent-running";
		live = true;
		const manageKey = hasPanelRow(taskRecord)
			? navEntryKeys(getKeybindings(), { action: "app.agents.focus", label: "to manage" })
			: "";
		statusLine = () => {
			// Progress may have crossed the engine boundary before the child stopped or started another turn.
			const id = activeProgress?.taskId;
			const current =
				(id ? context?.getTaskRecord?.(id)?.elapsedSpan : undefined) ??
				(input.childId ? subagentChildIndexEntry(input.childId)?.elapsedSpan : undefined) ??
				span;
			const ms = current ? spanElapsedMs(current) : elapsedMs;
			return statJoin(theme, [
				"Running",
				ms >= 1000 ? formatDuration(ms) : "",
				tokenText,
				manageKey ? clickableKeyTextHint(manageKey, " to manage") : "",
			]);
		};
	} else if (!child) {
		status = "task-stopped";
		statusLine = statJoin(theme, ["Stopped", elapsedText]);
	} else if (child.status === "error") {
		status = "failure";
		const reason = firstDisplayLine(child.error ?? (firstOutputLine(output) || "failed"));
		statusLine = theme.fg("error", ["Failed", elapsedText, reason].filter(Boolean).join(" · "));
	} else if (child.detached || child.status === "continued") {
		// It continued on its own and still runs; its own card and the agent panel follow it.
		status = "agent-running";
		statusLine = statJoin(theme, ["Continued", elapsedText]);
	} else if (
		child.interrupted ||
		child.status === "killed" ||
		child.status === "interrupted" ||
		child.status === "skipped"
	) {
		status = "task-stopped";
		statusLine = statJoin(theme, ["Stopped", elapsedText]);
	} else {
		status = "success";
		statusLine = statJoin(theme, ["Done", elapsedText, tokenText]);
	}

	if (!expanded) {
		return new ToolBlock({
			status,
			title: "Agent",
			args,
			details: new OneLine(statusLine),
			outputPad,
		});
	}

	const messageEntries = toolEntriesFromMessages(child?.messages);
	const toolBlocks: readonly Component[] =
		messageEntries.length > 0
			? messageEntries.map((entry) => innerToolBlockFromEntry(entry, live, theme, context))
			: toolBlocksFromSummaries(child?.toolCalls, activeProgress);

	return new ToolBlock({
		status,
		title: "Agent",
		args,
		details: buildExpandedDetails({
			statusLine,
			running: live,
			promptText: rawTask,
			buildToolBlocks: () => toolBlocks,
			resultText: output || undefined,
			failureText: child?.status === "error" ? child.error : undefined,
			theme,
		}),
		outputPad,
	});
}

export function renderSubagentToolCall(args: SubagentParamsLike, theme: Theme, context: RenderContext): Component {
	ensureGlobalTheme();
	renderRequests.set(context.state, args);
	const burst = getBurstDisplay(context.toolCallId);
	if (burst && !burst.owner) return new ToolBlockGroup([]);
	if (args.action) {
		const target = args.agent || args.id || args.runId || (args.all ? "all" : "");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("Agent"))}${theme.fg("text", `(${firstDisplayLine(args.action)}${target ? ` · ${firstDisplayLine(target)}` : ""})`)}`,
			0,
			0,
		);
	}
	const tasks = expandParallelTasks(args, burst?.taskCount);
	if (tasks.length > 1 || (args.tasks?.length ?? 0) > 0 || burst) {
		return new ToolBlockGroup(
			tasks.map(
				(task) =>
					new ToolBlock({
						status: "running",
						title: "Agent",
						args: formatAgentBlockArgs(task.agent, task.task),
						outputPad: context.outputPad,
					}),
			),
		);
	}
	return new ToolBlock({
		status: "running",
		title: "Agent",
		args: formatAgentBlockArgs(args.agent, args.task),
		outputPad: context.outputPad,
	});
}

export function renderSubagentToolResult(
	result: AgentToolResult<Details>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: RenderContext,
): Component {
	ensureGlobalTheme();
	if (!options.expanded) {
		clearSubagentChildTranscriptCache(context.state);
		expandedSectionCaches.delete(context.state);
	}
	const burst = getBurstDisplay(context.toolCallId);
	if (burst && !burst.owner) return new ToolBlockGroup([]);
	result = burst?.result ?? result;
	const request = renderRequests.get(context.state) ?? (context.args as SubagentParamsLike | undefined);
	if (result.details?.taskError) {
		if (request?.action || result.details?.mode === "management") {
			return new Text(theme.fg("error", `✗ ${displayText(result.details.taskError)}`), 0, 0);
		}
		const reason = firstDisplayLine(result.details.taskError);
		return new ToolBlock({
			status: "failure",
			title: "Agent",
			args: formatAgentBlockArgs(request?.agent, request?.task),
			details: new OneLine(theme.fg("error", ["Failed", reason].filter(Boolean).join(" · "))),
			outputPad: context.outputPad,
		});
	}
	const runControl = result.details?.runControl;
	if (runControl) {
		const text = result.content.find((part) => part.type === "text");
		const failed = context.isError === true || (result as { isError?: boolean }).isError === true;
		if (failed || runControl.children.length === 0)
			return new Text(
				theme.fg(
					failed ? "error" : "dim",
					`${failed ? "✗ " : ""}${displayText(text?.type === "text" ? text.text : "")}`,
				),
				0,
				0,
			);
		const lines = runControl.children.map((child) => {
			// Running again or still finishing its worktree, it runs; paused or quit until it is resumed, it is stopped.
			const mark =
				child.state === "running" || child.state === "finishing" ? TASK_MARKS.running : TASK_MARKS.stopped;
			const words =
				child.state === "running"
					? theme.fg("success", `Resumed · ${displayText(child.agent)}`)
					: theme.fg(
							"muted",
							`${child.state === "finishing" ? "Finishing worktree cleanup" : child.state === "paused" ? "Paused" : "Quit (resumable)"} · ${displayText(child.agent)}`,
						);
			const state = `${theme.fg(mark.color, mark.glyph)} ${words}`;
			const identity = theme.fg(
				"dim",
				`\n   ${displayText(child.childId)}${child.intercomTarget ? ` · ${displayText(child.intercomTarget)}` : ""}${options.expanded && child.taskId ? ` · ${displayText(child.taskId)}` : ""}`,
			);
			return `${state}${identity}${child.state === "running" ? theme.fg("dim", "\n   continues in its original launch card") : ""}`;
		});
		if (runControl.message && options.expanded) lines.push(theme.fg("muted", displayText(runControl.message)));
		return new Text(lines.join("\n"), 0, 0);
	}
	if (result.details?.taskRecords && !result.details.taskResponse) {
		const lines = result.details.taskRecords.flatMap((task) => {
			const state =
				task.execution.kind === "settled" ? subagentTaskResultLabel(task.execution.result) : task.execution.kind;
			return [
				theme.bold(`${displayText(task.agentName ?? "bash")} · ${state}`),
				...(task.kind === "agent"
					? [
							theme.fg(
								"dim",
								displayText(formatModelThinking(task.model, task.thinking) || "model / thinking unavailable"),
							),
						]
					: []),
				theme.fg("muted", displayText(task.title)),
				...(options.expanded ? [theme.fg("dim", task.ref.taskId)] : []),
				...(task.execution.kind === "settled" && task.execution.result.kind === "failed"
					? [theme.fg("error", displayText(task.execution.result.message))]
					: []),
			];
		});
		return new Text(lines.join("\n"), 0, 0);
	}
	const response = result.details?.taskResponse;
	if (response) {
		if (request?.action === "wait" && response.kind !== "parallel" && response.kind === "admitted") {
			const observation = response.observation;
			const state =
				observation.kind === "yielded"
					? "Still running in background"
					: observation.result.kind === "completed"
						? "Completed"
						: observation.result.kind === "failed"
							? `Failed · ${firstDisplayLine(observation.result.message)}`
							: subagentTaskResultLabel(observation.result);
			const color =
				observation.kind === "yielded"
					? "accent"
					: observation.result.kind === "failed"
						? "error"
						: observation.result.kind === "completed"
							? "success"
							: "warning";
			return new Text(theme.fg(color, state), 0, 0);
		}
		const outcomes = response.kind === "parallel" ? response.slots.map((slot) => slot.outcome) : [response];
		const labels = request && !burst ? expandParallelTasks(request) : [];
		const blocks = outcomes.map((outcome, index) =>
			buildOutcomeToolBlock({
				slot: index,
				outcome,
				identity: labels[index],
				result,
				expanded: options.expanded,
				theme,
				context,
			}),
		);
		return blocks.length === 1 ? blocks[0]! : new DynamicToolBlockGroup(blocks);
	}
	const text = result.content.find((part) => part.type === "text");
	if (text?.type === "text" && text.text.startsWith("Executable agents:")) {
		const count = text.text.split("\n").filter((line) => line.startsWith("- ") && line !== "- (none)").length;
		return new Text(
			options.expanded
				? text.text
				: `${theme.bold(`${count} available agents`)}\n${theme.fg(
						"dim",
						[slashCommandHint("/agents to browse"), keyHintIfBound("app.tools.expand", "Expand")]
							.filter(Boolean)
							.map((hint, index) => (index ? `(${hint})` : hint))
							.join(" · "),
					)}`,
			0,
			0,
		);
	}
	const d = result.details;
	if (!request?.action && (d?.mode === "single" || d?.mode === "parallel") && !d.statusGroups) {
		const labels = request && !burst ? expandParallelTasks(request) : [];
		const count = Math.max(
			d.results.length,
			d.progress?.length ? Math.max(...d.progress.map((p) => p.index + 1)) : 0,
			d.mode === "parallel" ? (d.totalSteps ?? labels.length) : 0,
		);
		// A call that failed before any child started has only its error to show, not a card per requested task.
		const failedBeforeStart =
			(context.isError || (result as { isError?: boolean }).isError) &&
			d.results.length === 0 &&
			!d.progress?.length;
		if (count > 0 && !failedBeforeStart) {
			const children = new Map(d.results.map((child, i) => [d.resultIndices?.[i] ?? i, child]));
			const progressBySlot = new Map(d.progress?.map((p) => [p.index, p]));
			const blocks = Array.from({ length: count }, (_, index) => {
				const child = children.get(index);
				const progress = progressBySlot.get(index);
				if (d.rejectedWorktrees?.[index] && child?.taskResponse?.kind === "unstarted") {
					return buildOutcomeToolBlock({
						slot: index,
						outcome: child.taskResponse,
						identity: child,
						result,
						expanded: options.expanded,
						theme,
						context,
					});
				}
				if (child?.detached && d.runId) {
					const record = subagentChildIndexEntry(`${d.runId}:${child.progress?.index ?? index}`);
					if (record?.taskId)
						return buildOutcomeToolBlock({
							slot: index,
							outcome: { kind: "sdk-handoff", childId: record.childId, taskId: record.taskId },
							identity: child,
							result,
							expanded: options.expanded,
							theme,
							context,
						});
				}
				return buildForegroundChildToolBlock({
					child,
					progress,
					identity: labels[index],
					taskRecord: d.taskRecords?.[index],
					childId: d.runId ? `${d.runId}:${child?.progress?.index ?? index}` : undefined,
					expanded: options.expanded,
					now: context.state.subagentResultSnapshotNow,
					theme,
					outputPad: context.outputPad,
					context,
				});
			});
			return blocks.length === 1 ? blocks[0]! : new DynamicToolBlockGroup(blocks);
		}
		if (context.isError || (result as { isError?: boolean }).isError) {
			const reason = firstDisplayLine(text?.type === "text" ? text.text : "failed");
			return new ToolBlock({
				status: "failure",
				title: "Agent",
				args: formatAgentBlockArgs(request?.agent, request?.task),
				details: new OneLine(theme.fg("error", ["Failed", reason].filter(Boolean).join(" · "))),
				outputPad: context.outputPad,
			});
		}
	}
	if (
		context.isError &&
		text?.type === "text" &&
		!result.details?.results?.length &&
		!result.details?.progress?.length
	)
		return new Text(theme.fg("error", `✗ ${displayText(text.text)}`), 0, 0);
	return renderLiveSubagentResult(burst?.result ?? result, options, theme, context);
}
