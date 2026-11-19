import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@bastani/atomic-ai/compat";
import { type Component, Container, type MarkdownTheme, Text, type TUI } from "@bastani/atomic-tui";
import { parseSkillBlock } from "../../../core/agent-session.js";
import type { MarkdownTransformer, MessageRenderer, ToolRenderers } from "../../../core/extensions/types.ts";
import { HOST_NOTICE_TYPE } from "../../../core/host-notices.js";
import {
	type BashExecutionMessage,
	type BranchSummaryMessage,
	type CustomMessage,
	isVerbatimCompactionMessage,
} from "../../../core/messages.ts";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import type { OwnerTaskStore, TaskActivity } from "../../../core/tasks/owner-store.js";
import { carryRowSource, noteRowSource, rowSource, savedTaskRows } from "../../../core/tasks/transcript-origin.js";
import { stripTerminalControls } from "../../../utils/ansi.js";
import {
	applyAssistantMessageDelta,
	beginStreamingAssistantMessage,
	type StreamingAssistantDelta,
} from "../streaming-assistant-message.ts";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { AssistantMessageComponent, hasAssistantVisibleContent } from "./assistant-message.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { BranchSummaryMessageComponent } from "./branch-summary-message.ts";
import { extractMessageText } from "./chat-session-host-utils.ts";
import { compactionBoundaryFromMessage } from "./compaction-boundary-message.ts";
import { CustomMessageComponent } from "./custom-message.ts";
import { fromChatComponentFactory } from "./renderer-disposal.js";
import { SkillInvocationMessageComponent } from "./skill-invocation-message.ts";
import type { TaskCompletionMessageOptions } from "./task-completion-message.js";
import { countTasksBy, TaskRow, taskNameAndTitle, taskSiblings } from "./task-row.js";
import { pagedNotices } from "./task-transcript-notices.ts";
import type { ToolGroupRole } from "./tool-block.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";
import {
	assistantCallBreaks,
	type ToolGroupMemberState,
	ToolGroupTracker,
	toolResultGroupState,
} from "./tool-group-tracker.ts";
import type { RowRange } from "./transcript-block-clicks.ts";
import { UserMessageComponent } from "./user-message.ts";

type DisplayLine = { level: "error" | "warning" | "dim"; text: string; childUnprefixed?: true };
const displayLines = new WeakMap<object, DisplayLine>();
/** Only reader-created messages have this provenance; a legacy extension may own the very same custom type. */
export function taskDisplayLine(line: DisplayLine): ChatMessageEntry {
	const message: CustomMessage = {
		role: "custom",
		customType: HOST_NOTICE_TYPE,
		content: line.text,
		display: true,
		details: line.level,
		timestamp: 0,
	};
	displayLines.set(message, line.childUnprefixed ? { ...line, text: line.text.slice("Error: ".length) } : line);
	return { role: "custom", kind: "custom", message };
}
/** A reader-only line, live or read from the chat's records, rather than a row of the conversation. */
export function isTaskDisplayLine(entry: object): boolean {
	const message = (entry as { kind?: unknown; message?: unknown }).message;
	return (
		(entry as { kind?: unknown }).kind === "custom" &&
		typeof message === "object" &&
		message !== null &&
		displayLines.has(message)
	);
}
export interface PersistedMessageMeta {
	id: string;
	timestamp: string;
}
export type ChatMessageEntry =
	| {
			role: "assistant";
			kind: "assistant";
			message: AssistantMessage;
			messageId?: string;
			timestamp?: string;
			interruptedActivity?: readonly string[];
	  }
	| {
			role: "tool";
			kind: "task";
			task: TaskRecord;
			duplicate: boolean;
			siblings: readonly TaskRecord[];
			activity: TaskActivity[];
			activityOmitted: boolean;
	  }
	| {
			role: "tool";
			kind: "tool";
			toolName: string;
			toolCallId: string;
			rendererTaskId?: TaskId;
			args: unknown;
			result?: RenderableToolResult;
			isPartial?: boolean;
			argsComplete?: boolean;
			executionStarted?: boolean;
			startedAt?: number;
			groupRole?: ToolGroupRole;
	  }
	| { role: "tool"; kind: "bashExecution"; message: BashExecutionMessage; isPartial?: boolean }
	| { role: "user"; kind: "user"; text: string; messageId?: string; timestamp?: string }
	| { role: "custom"; kind: "custom"; message: CustomMessage<unknown>; messageId?: string; timestamp?: string }
	| { role: "summary"; kind: "branchSummary"; message: BranchSummaryMessage; messageId?: string; timestamp?: string }
	| { role: "system"; kind: "system"; text: string };
type TaskChatEntry = Extract<ChatMessageEntry, { kind: "task" }>;
export interface ChatMessageRenderOptions {
	ui: Pick<TUI, "requestRender">;
	cwd: string;
	markdownTheme?: MarkdownTheme;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
	toolOutputExpanded?: boolean;
	showImages?: boolean;
	imageWidthCells?: number;
	outputPad?: number;
	isStreaming?: boolean;
	groupBash?: boolean;
	markdownTransformers?: readonly MarkdownTransformer[];
	renderLatex?: boolean;
	getToolDefinition?: (toolName: string) => ToolRenderers | undefined;
	getTaskRecord?: (taskId: TaskId) => TaskRecord | undefined;
	loadTaskTranscript?: TaskCompletionMessageOptions["loadTranscript"];
	hasTaskTranscript?: (taskId: TaskId) => boolean;
	getCustomMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	createToolComponent?: (
		entry: Extract<ChatMessageEntry, { kind: "tool" }>,
		context?: ChatRendererContext,
	) => Component;
	createCustomMessageComponent?: (message: CustomMessage<unknown>, context?: ChatRendererContext) => Component;
}
export type ToolChatEntry = Extract<ChatMessageEntry, { kind: "tool" }>;
export interface ChatEntryGrouping {
	/** The final row produced by each assistant occurrence, including its tool calls. */
	readonly onAssistantGroup?: (lastRow: ChatMessageEntry) => void;
	/** Source-row boundary after converting one message. No callbacks for consumers that don't need provenance. */
	readonly onMessageGroup?: (lastRow: ChatMessageEntry | undefined) => void;
	readonly tracker?: ToolGroupTracker;
	readonly groupBash?: boolean;
	readonly onSourceRow?: (entry: ChatMessageEntry, message: AgentMessage, block: number) => void;
}
export function chatEntriesFromAgentMessages(
	messages: readonly AgentMessage[],
	messageMeta?: ReadonlyMap<AgentMessage, PersistedMessageMeta>,
	grouping: ChatEntryGrouping = {},
): ChatMessageEntry[] {
	const entries = buildChatEntries(
		messages,
		messageMeta,
		grouping.onSourceRow,
		grouping.onAssistantGroup,
		grouping.onMessageGroup,
	);
	groupChatEntries(entries, grouping.tracker ?? new ToolGroupTracker({ groupBash: grouping.groupBash }));
	return entries;
}
function groupedChatEntries(
	messages: readonly AgentMessage[],
	tracker: ToolGroupTracker,
	carried: boolean,
	onMessageGroup?: ChatEntryGrouping["onMessageGroup"],
): { readonly entries: ChatMessageEntry[]; readonly carried: boolean } {
	const entries = buildChatEntries(messages, undefined, undefined, undefined, onMessageGroup);
	return { entries, carried: groupChatEntries(entries, tracker, carried) };
}
export function groupChatEntries(
	entries: readonly (ChatMessageEntry | { role: string })[],
	tracker: ToolGroupTracker,
	carriedBreak = false,
): boolean {
	let carried = carriedBreak;
	let breakBefore: ReadonlySet<string> = new Set();
	for (const entry of entries) {
		if (isChatMessageEntry(entry) && entry.kind === "tool") {
			if (breakBefore.has(entry.toolCallId)) tracker.break();
			tracker.append(entry.toolCallId, entry.toolName, toolEntryState(entry), toolEntryRoleSink(entry));
		} else if (isChatMessageEntry(entry) && entry.kind === "assistant") {
			const calls = assistantCallBreaks(entry.message.content, carried);
			breakBefore = calls.breakBefore;
			carried = calls.trailing;
		} else {
			tracker.break();
			carried = false;
		}
	}
	return carried;
}
function toolEntryState(entry: ToolChatEntry): ToolGroupMemberState {
	if (entry.isPartial !== false || entry.result === undefined) return "pending";
	return toolResultGroupState(entry.result, entry.result.isError);
}
function toolEntryRoleSink(entry: ToolChatEntry): (role: ToolGroupRole) => void {
	return (role) => {
		entry.groupRole = role;
	};
}
function inferInterruptedToolActivity(
	message: AssistantMessage,
	entries: readonly LiveChatEntry[],
	beforeIndex: number,
): readonly string[] | undefined {
	if (message.stopReason !== "aborted") return undefined;
	if (hasAssistantVisibleContent(message.content)) return undefined;
	const trailingTools: ToolChatEntry[] = [];
	for (let index = beforeIndex - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isChatMessageEntry(entry) || entry.kind !== "tool") break;
		trailingTools.unshift(entry);
	}
	for (let index = beforeIndex + 1; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!isChatMessageEntry(entry) || entry.kind !== "tool") break;
		trailingTools.push(entry);
	}
	const interrupted = trailingTools.filter((entry) => entry.isPartial !== false || entry.result?.isError === true);
	const names = [...new Set(interrupted.map((entry) => entry.toolName).filter(Boolean))];
	return names.length > 0 ? names : undefined;
}
/** Tool cards drawn from a saved result whose call was not among the messages they were drawn with. */
const resultsWithoutCall = new WeakSet<object>();

/** Whether `entry` is a tool card drawn from a result alone: its call is on an earlier page, if anywhere. */
export function isResultWithoutCall(entry: object): boolean {
	return resultsWithoutCall.has(entry);
}

function isTurnStart(
	entry: ChatMessageEntry | { role: string },
): entry is Extract<ChatMessageEntry, { kind: "assistant" | "user" }> {
	return isChatMessageEntry(entry) && (entry.kind === "assistant" || entry.kind === "user");
}

/**
 * The calls of the last assistant message in `entries` that have no result there. When `entries` are a page of saved
 * history with a later page, their results are saved after the page's end: they are not still running.
 */
export function callsAwaitingLaterResults(entries: readonly (ChatMessageEntry | { role: string })[]): ToolChatEntry[] {
	const calls: ToolChatEntry[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (isTurnStart(entry)) break;
		if (
			isChatMessageEntry(entry) &&
			entry.kind === "tool" &&
			entry.isPartial !== false &&
			entry.result === undefined &&
			!resultsWithoutCall.has(entry)
		)
			calls.unshift(entry);
	}
	return calls;
}

/**
 * Whether `entry`, drawn after a page that ends with calls awaiting results, shows that their results were never
 * saved: a call's result is saved before the next prompt and before the next reply. The entry `first` after the page
 * may be the rest of the reply the page cut, so only a prompt shows it there.
 */
export function endsAwaitedResults(entry: ChatMessageEntry | { role: string }, first: boolean): boolean {
	return isTurnStart(entry) && !(first && entry.kind === "assistant");
}

/**
 * Draws `calls`, which `entry` showed never got results, as a whole transcript draws them: still pending, or failed
 * with the error of the reply that ended the run.
 */
export function settleUnansweredCalls(
	entry: ChatMessageEntry | { role: string },
	calls: readonly ToolChatEntry[],
): void {
	const message = isChatMessageEntry(entry) && entry.kind === "assistant" ? entry.message : undefined;
	if (message?.stopReason !== "aborted" && message?.stopReason !== "error") return;
	const text =
		message.stopReason === "aborted"
			? message.errorMessage || "Operation aborted"
			: message.errorMessage || "Unknown error";
	for (const call of calls) {
		call.result = {
			role: "toolResult",
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			content: [{ type: "text", text }],
			isError: true,
			timestamp: message.timestamp,
		};
		call.isPartial = false;
	}
}

function buildChatEntries(
	messages: readonly AgentMessage[],
	messageMeta?: ReadonlyMap<AgentMessage, PersistedMessageMeta>,
	onSourceRow?: ChatEntryGrouping["onSourceRow"],
	onAssistantGroup?: (lastRow: ChatMessageEntry) => void,
	onMessageGroup?: (lastRow: ChatMessageEntry | undefined) => void,
): ChatMessageEntry[] {
	onSourceRow ??= savedTaskRows(messages);
	const entries: ChatMessageEntry[] = [];
	const pendingTools = new Map<string, Extract<ChatMessageEntry, { kind: "tool" }>>();
	for (const message of messages) {
		if (isLegacyCompactionSummaryMessage(message)) {
			onMessageGroup?.(entries.at(-1));
			continue;
		}
		const first = entries.length;
		switch (message.role) {
			case "assistant": {
				const meta = messageMeta?.get(message);
				const interruptedActivity = inferInterruptedToolActivity(message, entries, entries.length);
				entries.push({
					role: "assistant",
					kind: "assistant",
					message,
					messageId: meta?.id,
					timestamp: meta?.timestamp,
					...(interruptedActivity ? { interruptedActivity } : {}),
				});
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const toolEntry: ChatMessageEntry = {
						role: "tool",
						kind: "tool",
						toolName: content.name,
						toolCallId: content.id,
						args: content.arguments,
						isPartial: true,
						argsComplete: true,
					};
					entries.push(toolEntry);
					pendingTools.set(content.id, toolEntry);
				}
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					const errorText =
						message.stopReason === "aborted"
							? message.errorMessage || "Operation aborted"
							: message.errorMessage || "Unknown error";
					for (const toolEntry of pendingTools.values()) {
						toolEntry.result = {
							role: "toolResult",
							toolCallId: toolEntry.toolCallId,
							toolName: toolEntry.toolName,
							content: [{ type: "text", text: errorText }],
							isError: true,
							timestamp: message.timestamp,
						};
						toolEntry.isPartial = false;
					}
					pendingTools.clear();
				}
				onAssistantGroup?.(entries[entries.length - 1]!);
				break;
			}
			case "toolResult": {
				const toolEntry = pendingTools.get(message.toolCallId);
				if (toolEntry) {
					toolEntry.result = message;
					toolEntry.isPartial = false;
					carryRowSource(toolEntry, toolEntry, message);
					pendingTools.delete(message.toolCallId);
					// A saved card is known by its result: the same card whether a page cut fell between call and result.
					onSourceRow?.(toolEntry, message, 0);
				} else {
					const card: ToolChatEntry = {
						role: "tool",
						kind: "tool",
						toolName: message.toolName,
						toolCallId: message.toolCallId,
						args: {},
						result: message,
						isPartial: false,
						argsComplete: true,
					};
					resultsWithoutCall.add(card);
					entries.push(card);
				}
				break;
			}
			case "user": {
				const text = getMessageText(message);
				const meta = messageMeta?.get(message);
				if (text)
					entries.push({ role: "user", kind: "user", text, messageId: meta?.id, timestamp: meta?.timestamp });
				break;
			}
			case "bashExecution":
				entries.push({ role: "tool", kind: "bashExecution", message });
				break;
			case "custom": {
				const meta = messageMeta?.get(message);
				if (message.display)
					entries.push({
						role: "custom",
						kind: "custom",
						message,
						messageId: meta?.id,
						timestamp: meta?.timestamp,
					});
				break;
			}
			case "branchSummary": {
				const meta = messageMeta?.get(message);
				entries.push({
					role: "summary",
					kind: "branchSummary",
					message,
					messageId: meta?.id,
					timestamp: meta?.timestamp,
				});
				break;
			}
			case "system":
				// System messages carry prompt sections, not chat content; rendering
				// them printed a bare dim "system" line in workflow stage chats.
				break;
			default: {
				const role = (message as { role: string }).role;
				entries.push({ role: "system", kind: "system", text: role });
				break;
			}
		}
		for (let i = first; i < entries.length; i++) {
			noteRowSource(entries[i]!, { message, part: i - first });
			onSourceRow?.(entries[i]!, message, i - first);
		}
		onMessageGroup?.(entries.at(-1));
	}
	return entries;
}
export interface LiveChatEventLike {
	readonly type?: unknown;
	readonly message?: unknown;
	readonly assistantMessageEvent?: StreamingAssistantDelta;
	readonly toolCallId?: unknown;
	readonly parentToolCallId?: unknown;
	readonly toolName?: unknown;
	readonly args?: unknown;
	readonly partialResult?: unknown;
	readonly result?: unknown;
	readonly isError?: unknown;
	readonly durationMs?: unknown;
}
type LiveChatEntry = ChatMessageEntry | { role: string };
interface ToolEntryUpdate {
	toolCallId?: string;
	toolName: string;
	args?: unknown;
	isPartial: boolean;
	argsComplete?: boolean;
	executionStarted?: boolean;
	startedAt?: number;
	breakBefore?: boolean;
	/** The assistant message whose call this row shows, and the row's position among that message's rows. */
	source?: { readonly message: object; readonly part: number };
}
const nextGroups = new WeakMap<LiveChatEntriesController, NonNullable<ChatEntryGrouping["onMessageGroup"]>>();
/** @internal Only the next projected page of this controller supplies source positions. */
export function bindNextChatGroups(
	controller: LiveChatEntriesController,
	observer: ChatEntryGrouping["onMessageGroup"],
): void {
	if (observer) nextGroups.set(controller, observer);
}
export class LiveChatEntriesController {
	private streamingAssistantIndex: number | undefined;
	private carriedToolBreak = false;
	private pendingToolIndexes = new Map<string, number>();
	private tracker: ToolGroupTracker;
	private groupBash: boolean;
	private declare readonly entries: LiveChatEntry[];
	constructor(entries: LiveChatEntry[], options: { readonly groupBash?: boolean } = {}) {
		this.entries = entries;
		this.groupBash = options.groupBash ?? true;
		this.tracker = new ToolGroupTracker({ groupBash: this.groupBash });
	}
	setGroupBash(groupBash: boolean): boolean {
		if (this.groupBash === groupBash) return false;
		this.groupBash = groupBash;
		this.tracker = new ToolGroupTracker({ groupBash });
		for (const entry of this.entries) if (this.isToolEntry(entry)) entry.groupRole = undefined;
		groupChatEntries(this.entries, this.tracker);
		return true;
	}
	markToolExecutionStarted(toolCallId: string, startedAt: number): boolean {
		if (!Number.isFinite(startedAt) || startedAt > Date.now()) return false;
		const index = this.pendingToolIndexes.get(toolCallId);
		const entry = index === undefined ? undefined : this.entries[index];
		if (!this.isToolEntry(entry) || entry.isPartial === false) return false;
		if (entry.executionStarted && entry.startedAt !== undefined && entry.startedAt <= startedAt) return false;
		this.replaceToolEntry(index as number, { ...entry, executionStarted: true, startedAt, argsComplete: true });
		return true;
	}
	clearTasks(): void {
		const streaming =
			this.streamingAssistantIndex === undefined ? undefined : this.entries[this.streamingAssistantIndex];
		for (let index = this.entries.length - 1; index >= 0; index--) {
			const entry = this.entries[index];
			if ("kind" in entry && entry.kind === "task") this.entries.splice(index, 1);
		}
		this.streamingAssistantIndex = streaming === undefined ? undefined : this.entries.indexOf(streaming);
		this.reindexPendingTools();
	}
	upsertTasks(tasks: readonly TaskRecord[], store?: OwnerTaskStore): void {
		const siblings = taskSiblings(tasks);
		const copies = countTasksBy(siblings, taskNameAndTitle);
		const taskEntries = new Map<TaskId, TaskChatEntry>();
		for (const entry of this.entries) {
			if ("kind" in entry && entry.kind === "task" && !taskEntries.has(entry.task.ref.taskId))
				taskEntries.set(entry.task.ref.taskId, entry);
		}
		for (const task of siblings) {
			const activity = store?.recentActivity(task.ref.taskId) ?? [];
			const activityOmitted = store?.activityOmitted(task.ref.taskId) ?? false;
			const duplicate = (copies.get(taskNameAndTitle(task)) ?? 0) > 1;
			const entry = taskEntries.get(task.ref.taskId);
			if (entry) {
				entry.task = task;
				entry.duplicate = duplicate;
				entry.siblings = siblings;
				entry.activity = activity;
				entry.activityOmitted = activityOmitted;
			} else {
				const added: TaskChatEntry = {
					role: "tool",
					kind: "task",
					task,
					duplicate,
					siblings,
					activity,
					activityOmitted,
				};
				this.entries.push(added);
				taskEntries.set(task.ref.taskId, added);
				this.tracker.break();
			}
		}
	}
	appendMessages(messages: readonly AgentMessage[]): void {
		const onMessageGroup = nextGroups.get(this);
		if (onMessageGroup) nextGroups.delete(this);
		const grouped = groupedChatEntries(messages, this.tracker, this.carriedToolBreak, onMessageGroup);
		this.carriedToolBreak = grouped.carried;
		this.entries.push(...grouped.entries);
		this.reindexPendingTools();
	}
	/** Adds saved history at `index`, as a newer saved page above a live window, keeping a stream in place. */
	insertMessages(index: number, messages: readonly AgentMessage[]): void {
		const onMessageGroup = nextGroups.get(this);
		if (onMessageGroup) nextGroups.delete(this);
		const entries = chatEntriesFromAgentMessages(messages, undefined, { groupBash: this.groupBash, onMessageGroup });
		if (entries.length === 0) return;
		this.entries.splice(index, 0, ...entries);
		if (this.streamingAssistantIndex !== undefined && this.streamingAssistantIndex >= index)
			this.streamingAssistantIndex += entries.length;
		this.reindexPendingTools();
	}
	/** Adds earlier history ahead of every entry, keeping a stream in progress and its pending tools in place. */
	prependMessages(messages: readonly AgentMessage[]): void {
		const onMessageGroup = nextGroups.get(this);
		if (onMessageGroup) nextGroups.delete(this);
		const entries = chatEntriesFromAgentMessages(messages, undefined, { groupBash: this.groupBash, onMessageGroup });
		if (entries.length === 0) return;
		this.entries.unshift(...entries);
		if (this.streamingAssistantIndex !== undefined) this.streamingAssistantIndex += entries.length;
		this.reindexPendingTools();
	}
	replaceMessages(messages: readonly AgentMessage[], preservedEntries: readonly { role: string }[] = []): void {
		const onMessageGroup = nextGroups.get(this);
		if (onMessageGroup) nextGroups.delete(this);
		const started = this.startedToolEntries();
		this.tracker.reset();
		const grouped = groupedChatEntries(messages, this.tracker, false, onMessageGroup);
		const entries = grouped.entries;
		this.carriedToolBreak = grouped.carried;
		if (started.size > 0) {
			for (const entry of entries) {
				if (entry.kind !== "tool" || entry.isPartial === false) continue;
				const previous = started.get(entry.toolCallId);
				if (previous === undefined) continue;
				entry.executionStarted = true;
				entry.startedAt = previous.startedAt;
				entry.argsComplete = true;
			}
		}
		this.entries.splice(0, this.entries.length, ...entries, ...preservedEntries);
		pagedNotices.get(this.entries)?.reset();
		if (preservedEntries.length > 0) {
			this.tracker.break();
			this.carriedToolBreak = false;
		}
		this.streamingAssistantIndex = undefined;
		this.reindexPendingTools();
	}
	/** Remove a saved page, preserving the entry identities anchoring the pages that remain. */
	dropSavedEntries(page: ReadonlySet<LiveChatEntry>): void {
		const streaming =
			this.streamingAssistantIndex === undefined ? undefined : this.entries[this.streamingAssistantIndex];
		const retained = this.entries.filter((entry) => !page.has(entry));
		this.entries.splice(0, this.entries.length, ...retained);
		this.streamingAssistantIndex =
			streaming && retained.includes(streaming) ? retained.indexOf(streaming) : undefined;
		this.regroup();
	}
	/** Put saved entries back after `after`, as `dropSavedEntries` leaves the entries around them. */
	restoreSavedEntries(after: LiveChatEntry, restored: readonly LiveChatEntry[]): void {
		const at = this.entries.indexOf(after);
		if (at < 0 || restored.length === 0) return;
		const streaming =
			this.streamingAssistantIndex === undefined ? undefined : this.entries[this.streamingAssistantIndex];
		this.entries.splice(at + 1, 0, ...restored);
		if (streaming !== undefined) this.streamingAssistantIndex = this.entries.indexOf(streaming);
		this.regroup();
	}
	/** Groups every entry again; a call that no longer groups is drawn on its own, not with its old role. */
	private regroup(): void {
		for (const entry of this.entries) if (this.isToolEntry(entry)) entry.groupRole = undefined;
		this.tracker.reset();
		this.carriedToolBreak = groupChatEntries(this.entries, this.tracker);
		this.reindexPendingTools();
	}
	/** Patch only captured row objects, leaving live events that arrived after their page in place. */
	decorateRows(
		moves: ReadonlyMap<ChatMessageEntry, ChatMessageEntry>,
		after: ReadonlyMap<ChatMessageEntry | null, readonly ChatMessageEntry[]>,
	): boolean {
		if (!moves.size && !after.size) return false;
		const streaming =
			this.streamingAssistantIndex === undefined ? undefined : this.entries[this.streamingAssistantIndex];
		for (const [notice, prompt] of moves) {
			const start = this.entries.indexOf(notice),
				end = this.entries.indexOf(prompt);
			if (start >= 0 && end > start) {
				this.entries.splice(end, 1);
				this.entries.splice(start, 0, prompt);
			}
		}
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const row = this.entries[i];
			if (isChatMessageEntry(row)) {
				const added = after.get(row);
				if (added?.length) for (let j = added.length - 1; j >= 0; j--) this.entries.splice(i + 1, 0, added[j]!);
			}
		}
		const leading = after.get(null);
		if (leading) for (let j = leading.length - 1; j >= 0; j--) this.entries.unshift(leading[j]!);
		if (streaming) {
			const i = this.entries.indexOf(streaming);
			this.streamingAssistantIndex = i >= 0 ? i : undefined;
		}
		this.reindexPendingTools();
		return true;
	}
	appendTaskLine(line: DisplayLine): void {
		this.entries.push(taskDisplayLine(line));
	}
	appendUserText(text: string): void {
		this.entries.push({ role: "user", kind: "user", text });
		this.tracker.break();
		this.carriedToolBreak = false;
	}
	/**
	 * Keep the rows a reader parked above the end sees through a replaced window: `kept` stay ahead of it, and a new row
	 * of a message the reader sees is replaced by the row they see, found by its saved row key.
	 */
	keepParkedEntries(
		kept: readonly object[],
		adopted: ReadonlyMap<string, object>,
		keyOf: (entry: object) => string | undefined,
	): Map<object, object> {
		const replaced = new Map<object, object>();
		const next = this.entries.map((entry) => {
			const key = keyOf(entry);
			const kept = key === undefined ? undefined : adopted.get(key);
			if (kept && kept !== entry) replaced.set(entry, kept);
			return (kept ?? entry) as LiveChatEntry;
		});
		this.entries.splice(0, this.entries.length, ...(kept as LiveChatEntry[]), ...next);
		this.streamingAssistantIndex = undefined;
		this.tracker.reset();
		this.carriedToolBreak = groupChatEntries(this.entries, this.tracker);
		this.reindexPendingTools();
		return replaced;
	}
	/**
	 * Seed the assistant message a chat mounted mid-stream never saw start.
	 *
	 * Delta-only updates carry just the next fragment, so a consumer attached
	 * part-way through a turn cannot recover the text that already streamed. The
	 * live session keeps that in-flight message, and seeding it here makes the
	 * deltas that arrive afterwards continue it instead of opening a second
	 * assistant message. A stream this consumer is already following wins.
	 */
	hydrateStreamingAssistantMessage(message: unknown): boolean {
		if (!isAgentMessageLike(message) || message.role !== "assistant") return false;
		if (this.currentStreamingAssistantMessage() !== undefined) return false;
		return this.updateAssistantMessage(beginStreamingAssistantMessage(message as AssistantMessage));
	}
	applyEvent(event: LiveChatEventLike): boolean {
		const type = String(event.type ?? "");
		if (typeof event.parentToolCallId === "string" && type.startsWith("tool_execution_")) return false;
		switch (type) {
			case "message_start":
				return this.handleMessageStart(event.message);
			case "message_update":
				return this.handleMessageUpdate(event);
			case "message_end":
				return this.handleMessageEnd(event.message);
			case "tool_execution_start":
				return this.upsertToolEntry({
					toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
					toolName: typeof event.toolName === "string" ? event.toolName : "tool",
					args: event.args,
					isPartial: true,
					argsComplete: true,
					executionStarted: true,
					startedAt: Date.now(),
				});
			case "tool_call_args":
				return this.upsertToolEntry({
					toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
					toolName: typeof event.toolName === "string" ? event.toolName : "tool",
					args: event.args,
					isPartial: true,
				});
			case "tool_execution_update": {
				const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
				if (!toolCallId) return false;
				return this.updateToolResult(toolCallId, event.partialResult, true, false);
			}
			case "tool_execution_end": {
				const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
				if (!toolCallId) return false;
				return this.updateToolResult(
					toolCallId,
					event.result,
					false,
					event.isError === true,
					typeof event.durationMs === "number" ? event.durationMs : undefined,
				);
			}
			default:
				return false;
		}
	}
	pendingToolIds(): string[] {
		return [...this.pendingToolIndexes.keys()];
	}
	clearPendingTools(): void {
		this.pendingToolIndexes.clear();
		this.tracker.reset();
		this.carriedToolBreak = false;
	}

	isStreamingAssistantEntry(entry: ChatMessageEntry): boolean {
		return this.streamingAssistantIndex !== undefined && this.entries[this.streamingAssistantIndex] === entry;
	}

	private handleMessageStart(message: unknown): boolean {
		if (!isAgentMessageLike(message)) return false;
		if (message.role === "assistant") {
			this.streamingAssistantIndex = undefined;
			return this.updateAssistantMessage(beginStreamingAssistantMessage(message as AssistantMessage));
		}
		if (message.role === "toolResult") {
			const toolResult = message as ToolResultMessage;
			const index = this.findToolEntryIndex(toolResult.toolCallId);
			if (index >= 0) {
				const row = this.entries[index]!;
				carryRowSource(row, row, message);
				return true;
			}
		}
		const grouped = groupedChatEntries([message as AgentMessage], this.tracker, this.carriedToolBreak);
		this.carriedToolBreak = grouped.carried;
		const entries = grouped.entries;
		if (entries.length === 0) return false;
		this.entries.push(...entries);
		this.reindexPendingTools();
		return true;
	}
	private handleMessageUpdate(event: LiveChatEventLike): boolean {
		if (!event.assistantMessageEvent) return false;
		const message = this.currentStreamingAssistantMessage() ?? minimalAssistantMessage();
		if (!applyAssistantMessageDelta(message, event.assistantMessageEvent)) return false;
		return this.updateAssistantMessage(message);
	}
	private handleMessageEnd(message: unknown): boolean {
		if (!isAgentMessageLike(message) || message.role !== "assistant") return false;
		const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
		const failed = stopReason === "aborted" || stopReason === "error";
		const changed = this.updateAssistantMessage(message as AssistantMessage, !failed);
		if (failed) {
			const errorText =
				typeof message.errorMessage === "string" && message.errorMessage
					? message.errorMessage
					: stopReason === "aborted"
						? "Operation aborted"
						: "Unknown error";
			for (const toolCallId of this.pendingToolIds()) {
				this.updateToolResult(toolCallId, { content: [{ type: "text", text: errorText }] }, false, true);
			}
			this.clearPendingTools();
		}
		this.carriedToolBreak = assistantCallBreaks(
			(message as AssistantMessage).content,
			this.carriedToolBreak,
		).trailing;
		this.streamingAssistantIndex = undefined;
		return changed || true;
	}
	private updateAssistantMessage(message: AssistantMessage, argsComplete = false): boolean {
		const existingIndex =
			this.streamingAssistantIndex !== undefined && this.isAssistantEntry(this.entries[this.streamingAssistantIndex])
				? this.streamingAssistantIndex
				: undefined;
		const interruptedActivity = inferInterruptedToolActivity(
			message,
			this.entries,
			existingIndex ?? this.entries.length,
		);
		if (existingIndex !== undefined) {
			const previous = this.entries[existingIndex] as Extract<ChatMessageEntry, { kind: "assistant" }>;
			const next = {
				...previous,
				message,
				...(interruptedActivity ? { interruptedActivity } : {}),
			};
			this.entries[existingIndex] = next;
			noteRowSource(next, { message, part: 0 });
		} else {
			const next: ChatMessageEntry = {
				role: "assistant",
				kind: "assistant",
				message,
				...(interruptedActivity ? { interruptedActivity } : {}),
			};
			this.entries.push(next);
			noteRowSource(next, { message, part: 0 });
			this.streamingAssistantIndex = this.entries.length - 1;
		}
		const calls = assistantCallBreaks(message.content, this.carriedToolBreak);
		let part = 0;
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.upsertToolEntry({
				toolCallId: content.id,
				toolName: content.name,
				args: content.arguments,
				isPartial: true,
				argsComplete,
				breakBefore: calls.breakBefore.has(content.id),
				source: { message, part: ++part },
			});
		}
		return true;
	}
	private currentStreamingAssistantMessage(): AssistantMessage | undefined {
		const entry = this.streamingAssistantIndex !== undefined ? this.entries[this.streamingAssistantIndex] : undefined;
		return this.isAssistantEntry(entry) ? entry.message : undefined;
	}
	private upsertToolEntry(update: ToolEntryUpdate): boolean {
		const toolCallId = update.toolCallId ?? `live-${update.toolName}`;
		const index = this.pendingToolIndexes.get(toolCallId) ?? this.findToolEntryIndex(toolCallId, update.toolName);
		const previous = index >= 0 ? this.entries[index] : undefined;
		const previousTool = this.isToolEntry(previous) ? previous : undefined;
		const next: ToolChatEntry = {
			role: "tool",
			kind: "tool",
			toolName: previousTool?.toolName ?? update.toolName,
			toolCallId,
			args: update.args ?? previousTool?.args ?? {},
			result: previousTool?.result,
			isPartial: update.isPartial,
			argsComplete: previousTool?.argsComplete === true || update.argsComplete === true || undefined,
			executionStarted: previousTool?.executionStarted === true || update.executionStarted === true || undefined,
			startedAt: previousTool?.startedAt ?? update.startedAt,
			groupRole: previousTool?.groupRole,
		};
		if (index >= 0) this.replaceToolEntry(index, next);
		else {
			if (update.breakBefore === true) this.tracker.break();
			this.entries.push(next);
			this.tracker.append(toolCallId, next.toolName, toolEntryState(next), toolEntryRoleSink(next));
		}
		if (update.source) {
			const result = rowSource(next)?.result;
			noteRowSource(next, result === undefined ? update.source : { ...update.source, result });
		}
		this.pendingToolIndexes.set(toolCallId, index >= 0 ? index : this.entries.length - 1);
		return true;
	}
	private replaceToolEntry(index: number, next: ToolChatEntry): void {
		carryRowSource(this.entries[index], next);
		this.entries[index] = next;
		this.tracker.bind(next.toolCallId, toolEntryRoleSink(next));
		this.tracker.settle(next.toolCallId, toolEntryState(next));
	}
	private startedToolEntries(): Map<string, { readonly startedAt?: number }> {
		const started = new Map<string, { readonly startedAt?: number }>();
		for (const index of this.pendingToolIndexes.values()) {
			const entry = this.entries[index];
			if (this.isToolEntry(entry) && entry.executionStarted === true)
				started.set(entry.toolCallId, { startedAt: entry.startedAt });
		}
		return started;
	}
	private updateToolResult(
		toolCallId: string,
		result: unknown,
		isPartial: boolean,
		isError: boolean,
		durationMs?: number,
	): boolean {
		const index = this.pendingToolIndexes.get(toolCallId) ?? this.findToolEntryIndex(toolCallId);
		if (index < 0) return false;
		const entry = this.entries[index];
		if (!this.isToolEntry(entry)) return false;
		const resultObject = toolResultFromUnknown(result, entry.toolName, toolCallId, isError);
		if (durationMs !== undefined) resultObject.durationMs = durationMs;
		this.replaceToolEntry(index, { ...entry, result: resultObject, isPartial });
		if (!isPartial) this.pendingToolIndexes.delete(toolCallId);
		return true;
	}
	private isSyntheticToolCallId(toolCallId: string): boolean {
		return toolCallId.startsWith("live-");
	}
	private findToolEntryIndex(toolCallId: string, toolName?: string): number {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (!this.isToolEntry(entry)) continue;
			if (entry.toolCallId === toolCallId) return i;
			if (
				toolName &&
				entry.toolName === toolName &&
				entry.isPartial !== false &&
				(this.isSyntheticToolCallId(toolCallId) || this.isSyntheticToolCallId(entry.toolCallId))
			) {
				return i;
			}
		}
		return -1;
	}
	private reindexPendingTools(): void {
		this.pendingToolIndexes.clear();
		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i];
			if (this.isToolEntry(entry) && entry.isPartial !== false) this.pendingToolIndexes.set(entry.toolCallId, i);
		}
	}
	private isAssistantEntry(
		entry: LiveChatEntry | undefined,
	): entry is Extract<ChatMessageEntry, { kind: "assistant" }> {
		return isChatMessageEntry(entry) && entry.kind === "assistant";
	}
	private isToolEntry(entry: LiveChatEntry | undefined): entry is Extract<ChatMessageEntry, { kind: "tool" }> {
		return isChatMessageEntry(entry) && entry.kind === "tool";
	}
}
function isChatMessageEntry(entry: LiveChatEntry | undefined): entry is ChatMessageEntry {
	return entry !== undefined && "kind" in entry;
}
function isLegacyCompactionSummaryMessage(message: AgentMessage): boolean {
	return message.role === "compaction" + "Summary";
}
function isAgentMessageLike(
	message: unknown,
): message is AgentMessage & { stopReason?: unknown; errorMessage?: unknown } {
	return message !== null && typeof message === "object" && "role" in message;
}
function minimalAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "stop",
	} as unknown as AssistantMessage;
}
/** UI progress may contain in-memory details; only durable transcript results are JSON. */
type RenderableToolResult = Omit<ToolResultMessage, "details"> & { details?: unknown };
function toolResultFromUnknown(
	result: unknown,
	toolName: string,
	toolCallId: string,
	isError: boolean,
): RenderableToolResult {
	if (result !== null && typeof result === "object" && "content" in result) {
		const candidate = result as { content?: unknown; details?: unknown };
		const content = Array.isArray(candidate.content) ? candidate.content : [];
		return {
			role: "toolResult",
			toolCallId,
			toolName,
			content: content as ToolResultMessage["content"],
			details: candidate.details,
			isError,
			timestamp: Date.now(),
		};
	}
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: typeof result === "string" ? [{ type: "text", text: result }] : [],
		isError,
		timestamp: Date.now(),
	};
}
export interface ChatRendererContext {
	requestRender(): void;
	expanded: boolean;
	outputPad: number;
	showImages: boolean;
	imageWidthCells?: number;
}

function rendererContext(options: ChatMessageRenderOptions, requestRender: () => void): ChatRendererContext {
	return {
		requestRender,
		expanded: options.toolOutputExpanded ?? false,
		outputPad: options.outputPad ?? 1,
		showImages: options.showImages ?? true,
		imageWidthCells: options.imageWidthCells,
	};
}

export interface ToolEntryStateTarget {
	setExpanded(expanded: boolean): void;
	setArgsComplete(): void;
	markExecutionStarted(startedAt?: number): void;
	updateResult(result: Parameters<ToolExecutionComponent["updateResult"]>[0], isPartial?: boolean): void;
	setGroupRole(role: ToolGroupRole): void;
}
export function applyToolEntryState(component: ToolEntryStateTarget, entry: ToolChatEntry, expanded: boolean): void {
	component.setExpanded(expanded);
	if (entry.argsComplete) component.setArgsComplete();
	if (entry.executionStarted) component.markExecutionStarted(entry.startedAt);
	if (entry.result) component.updateResult(entry.result, entry.isPartial ?? false);
	if (entry.groupRole) component.setGroupRole(entry.groupRole);
}
export function renderChatMessageEntry(entry: ChatMessageEntry, options: ChatMessageRenderOptions): Component {
	return renderHostedChatEntry(entry, options);
}

export function renderHostedChatEntry(
	entry: ChatMessageEntry,
	options: ChatMessageRenderOptions,
	AssistantCard = AssistantMessageComponent,
): Component {
	const messageEntry = entry as ChatMessageEntry;
	const markdownTheme = options.markdownTheme ?? getMarkdownTheme();
	switch (messageEntry.kind) {
		case "task":
			return new TaskRow(messageEntry.task, {
				expanded: options.toolOutputExpanded,
				duplicate: messageEntry.duplicate,
				siblings: messageEntry.siblings,
				activity: messageEntry.activity,
				activityOmitted: messageEntry.activityOmitted,
			});
		case "assistant":
			return new AssistantCard(
				messageEntry.message,
				options.hideThinkingBlock ?? false,
				markdownTheme,
				options.hiddenThinkingLabel ?? "Thinking...",
				options.outputPad ?? 1,
				options.markdownTransformers,
				options.isStreaming,
				options.renderLatex,
				messageEntry.messageId,
				messageEntry.timestamp,
				messageEntry.interruptedActivity,
			);
		case "tool": {
			if (options.createToolComponent) {
				let seeding = true;
				const component = options.createToolComponent(
					messageEntry,
					rendererContext(options, () => {
						if (!seeding) options.ui.requestRender();
					}),
				);
				seeding = false;
				return fromChatComponentFactory(component);
			}
			let seeding = true;
			const ui = {
				requestRender: () => {
					if (!seeding) options.ui.requestRender();
				},
			};
			const component = new ToolExecutionComponent(
				messageEntry.toolName,
				messageEntry.toolCallId,
				messageEntry.args,
				{
					showImages: options.showImages ?? true,
					imageWidthCells: options.imageWidthCells,
					outputPad: options.outputPad,
					getTaskRecord: options.getTaskRecord,
					getToolDefinition: options.getToolDefinition,
				},
				options.getToolDefinition?.(messageEntry.toolName),
				ui as TUI,
				options.cwd,
			);
			applyToolEntryState(component, messageEntry, options.toolOutputExpanded ?? false);
			seeding = false;
			return component;
		}
		case "bashExecution": {
			const component = new BashExecutionComponent(
				messageEntry.message.command,
				options.ui as TUI,
				messageEntry.message.excludeFromContext,
				options.outputPad,
			);
			if (messageEntry.message.output) component.appendOutput(messageEntry.message.output);
			component.setExpanded(options.toolOutputExpanded ?? false);
			if (messageEntry.isPartial !== true) {
				component.setComplete(
					messageEntry.message.exitCode,
					messageEntry.message.cancelled,
					messageEntry.message.truncated
						? ({ truncated: true } as Parameters<BashExecutionComponent["setComplete"]>[2])
						: undefined,
					messageEntry.message.fullOutputPath,
				);
			}
			return component;
		}
		case "user":
			return userMessageComponent(
				messageEntry.text,
				markdownTheme,
				options.toolOutputExpanded ?? false,
				options.outputPad ?? 1,
				options.markdownTransformers,
				options.renderLatex,
				messageEntry.messageId,
				messageEntry.timestamp,
			);
		case "custom": {
			const diagnostic = displayLines.get(messageEntry.message);
			if (diagnostic)
				return new Text(
					theme.fg(diagnostic.level, stripTerminalControls(diagnostic.text)),
					options.outputPad ?? 1,
					0,
				);
			if (isVerbatimCompactionMessage(messageEntry.message)) {
				return compactionBoundaryFromMessage(
					messageEntry.message,
					options.toolOutputExpanded ?? false,
					options.outputPad,
				);
			}
			if (options.createCustomMessageComponent) {
				let seeding = true;
				const component = options.createCustomMessageComponent(
					messageEntry.message,
					rendererContext(options, () => {
						if (!seeding) options.ui.requestRender();
					}),
				);
				seeding = false;
				return fromChatComponentFactory(component);
			}
			const component = new CustomMessageComponent(
				messageEntry.message,
				options.getCustomMessageRenderer?.(messageEntry.message.customType),
				markdownTheme,
				options.outputPad ?? 1,
				options.renderLatex,
				options.markdownTransformers,
				messageEntry.messageId,
				messageEntry.timestamp,
				{
					...(options.loadTaskTranscript ? { loadTranscript: options.loadTaskTranscript } : {}),
					...(options.hasTaskTranscript ? { hasTranscript: options.hasTaskTranscript } : {}),
					requestRender: () => options.ui.requestRender(),
					getToolDefinition: options.getToolDefinition,
					cwd: options.cwd,
				},
			);
			component.setExpanded(options.toolOutputExpanded ?? false);
			return component;
		}
		case "branchSummary": {
			const component = new BranchSummaryMessageComponent(
				messageEntry.message,
				markdownTheme,
				options.renderLatex,
				options.outputPad,
				options.markdownTransformers,
				messageEntry.messageId,
				messageEntry.timestamp,
			);
			component.setExpanded(options.toolOutputExpanded ?? false);
			return component;
		}
		case "system":
			return new Text(theme.fg("dim", messageEntry.text), options.outputPad ?? 1, 0);
	}
}
/** A skill block and the message typed with it: a click on the skill block's rows expands or collapses it. */
class SkillMessageContainer extends Container {
	readonly expandsOnClick = true;
	private readonly skill: SkillInvocationMessageComponent;

	constructor(skill: SkillInvocationMessageComponent) {
		super();
		this.skill = skill;
		this.addChild(skill);
	}

	isExpanded(): boolean {
		return this.skill.isExpanded();
	}

	setExpanded(expanded: boolean): void {
		this.skill.setExpanded(expanded);
	}

	clickArea(width: number): RowRange | undefined {
		return this.skill.clickArea(width);
	}

	setOutputPad(outputPad: number): void {
		for (const child of this.children) {
			if ("setOutputPad" in child && typeof child.setOutputPad === "function") child.setOutputPad(outputPad);
		}
	}
}

function userMessageComponent(
	text: string,
	markdownTheme: MarkdownTheme,
	expanded: boolean,
	outputPad = 1,
	markdownTransformers: readonly MarkdownTransformer[] = [],
	renderLatex = true,
	messageId?: string,
	timestamp?: string,
): Component {
	const skillBlock = parseSkillBlock(text);
	if (!skillBlock)
		return new UserMessageComponent(
			text,
			markdownTheme,
			outputPad,
			markdownTransformers,
			renderLatex,
			messageId,
			timestamp,
		);
	const skillComponent = new SkillInvocationMessageComponent(
		skillBlock,
		markdownTheme,
		renderLatex,
		outputPad,
		markdownTransformers,
		messageId,
		timestamp,
	);
	skillComponent.setExpanded(expanded);
	const container = new SkillMessageContainer(skillComponent);
	if (skillBlock.userMessage) {
		container.addChild(
			new UserMessageComponent(
				skillBlock.userMessage,
				markdownTheme,
				outputPad,
				markdownTransformers,
				renderLatex,
				messageId,
				timestamp,
			),
		);
	}
	return container;
}
function getMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
	return extractMessageText(message.content).trim();
}
