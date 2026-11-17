import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@bastani/atomic-ai/compat";
import { type Component, Container, type MarkdownTheme, Text, type TUI } from "@bastani/atomic-tui";
import { parseSkillBlock } from "../../../core/agent-session.js";
import type { MarkdownTransformer, MessageRenderer, ToolRenderers } from "../../../core/extensions/types.ts";
import {
	type BashExecutionMessage,
	type BranchSummaryMessage,
	type CustomMessage,
	isVerbatimCompactionMessage,
} from "../../../core/messages.ts";
import type { TaskId, TaskRecord } from "../../../core/tasks/contracts.js";
import type { OwnerTaskStore, TaskActivity } from "../../../core/tasks/owner-store.js";
import {
	applyAssistantMessageDelta,
	beginStreamingAssistantMessage,
	type StreamingAssistantDelta,
} from "../streaming-assistant-message.ts";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { BashExecutionComponent } from "./bash-execution.ts";
import { BranchSummaryMessageComponent } from "./branch-summary-message.ts";
import { extractMessageText } from "./chat-session-host-utils.ts";
import { compactionBoundaryFromMessage } from "./compaction-boundary-message.ts";
import { CustomMessageComponent } from "./custom-message.ts";
import { SkillInvocationMessageComponent } from "./skill-invocation-message.ts";
import type { TaskCompletionMessageOptions } from "./task-completion-message.js";
import { TaskRow } from "./task-row.js";
import type { ToolGroupRole } from "./tool-block.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";
import {
	assistantCallBreaks,
	type ToolGroupMemberState,
	ToolGroupTracker,
	toolResultGroupState,
} from "./tool-group-tracker.ts";
import { UserMessageComponent } from "./user-message.ts";
export interface PersistedMessageMeta {
	id: string;
	timestamp: string;
}
export type ChatMessageEntry =
	| { role: "assistant"; kind: "assistant"; message: AssistantMessage; messageId?: string; timestamp?: string }
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
	createToolComponent?: (entry: Extract<ChatMessageEntry, { kind: "tool" }>) => Component;
	createCustomMessageComponent?: (message: CustomMessage<unknown>) => Component;
}
type ToolChatEntry = Extract<ChatMessageEntry, { kind: "tool" }>;
export interface ChatEntryGrouping {
	readonly tracker?: ToolGroupTracker;
	readonly groupBash?: boolean;
}
export function chatEntriesFromAgentMessages(
	messages: readonly AgentMessage[],
	messageMeta?: ReadonlyMap<AgentMessage, PersistedMessageMeta>,
	grouping: ChatEntryGrouping = {},
): ChatMessageEntry[] {
	const entries = buildChatEntries(messages, messageMeta);
	groupChatEntries(entries, grouping.tracker ?? new ToolGroupTracker({ groupBash: grouping.groupBash }));
	return entries;
}
function groupedChatEntries(
	messages: readonly AgentMessage[],
	tracker: ToolGroupTracker,
	carried: boolean,
): { readonly entries: ChatMessageEntry[]; readonly carried: boolean } {
	const entries = buildChatEntries(messages);
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
function buildChatEntries(
	messages: readonly AgentMessage[],
	messageMeta?: ReadonlyMap<AgentMessage, PersistedMessageMeta>,
): ChatMessageEntry[] {
	const entries: ChatMessageEntry[] = [];
	const pendingTools = new Map<string, Extract<ChatMessageEntry, { kind: "tool" }>>();
	for (const message of messages) {
		if (isLegacyCompactionSummaryMessage(message)) continue;
		switch (message.role) {
			case "assistant": {
				const meta = messageMeta?.get(message);
				entries.push({
					role: "assistant",
					kind: "assistant",
					message,
					messageId: meta?.id,
					timestamp: meta?.timestamp,
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
				break;
			}
			case "toolResult": {
				const toolEntry = pendingTools.get(message.toolCallId);
				if (toolEntry) {
					toolEntry.result = message;
					toolEntry.isPartial = false;
					pendingTools.delete(message.toolCallId);
				} else {
					entries.push({
						role: "tool",
						kind: "tool",
						toolName: message.toolName,
						toolCallId: message.toolCallId,
						args: {},
						result: message,
						isPartial: false,
						argsComplete: true,
					});
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
		for (const task of tasks) {
			const activity = store?.recentActivity(task.ref.taskId) ?? [];
			const activityOmitted = store?.activityOmitted(task.ref.taskId) ?? false;
			const duplicate =
				tasks.filter((other) => other.agentName === task.agentName && other.title === task.title).length > 1;
			const entry = this.entries.find(
				(entry) => "kind" in entry && entry.kind === "task" && entry.task.ref.taskId === task.ref.taskId,
			);
			if (entry && "kind" in entry && entry.kind === "task") {
				entry.task = task;
				entry.duplicate = duplicate;
				entry.siblings = tasks;
				entry.activity = activity;
				entry.activityOmitted = activityOmitted;
			} else {
				this.entries.push({
					role: "tool",
					kind: "task",
					task,
					duplicate,
					siblings: tasks,
					activity,
					activityOmitted,
				});
				this.tracker.break();
			}
		}
	}
	appendMessages(messages: readonly AgentMessage[]): void {
		const grouped = groupedChatEntries(messages, this.tracker, this.carriedToolBreak);
		this.carriedToolBreak = grouped.carried;
		this.entries.push(...grouped.entries);
		this.reindexPendingTools();
	}
	/** Adds earlier history ahead of every entry, keeping a stream in progress and its pending tools in place. */
	prependMessages(messages: readonly AgentMessage[]): void {
		const entries = chatEntriesFromAgentMessages(messages, undefined, { groupBash: this.groupBash });
		if (entries.length === 0) return;
		this.entries.unshift(...entries);
		if (this.streamingAssistantIndex !== undefined) this.streamingAssistantIndex += entries.length;
		this.reindexPendingTools();
	}
	replaceMessages(messages: readonly AgentMessage[], preservedEntries: readonly { role: string }[] = []): void {
		const started = this.startedToolEntries();
		this.tracker.reset();
		const grouped = groupedChatEntries(messages, this.tracker, false);
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
		if (preservedEntries.length > 0) {
			this.tracker.break();
			this.carriedToolBreak = false;
		}
		this.streamingAssistantIndex = undefined;
		this.reindexPendingTools();
	}
	appendUserText(text: string): void {
		this.entries.push({ role: "user", kind: "user", text });
		this.tracker.break();
		this.carriedToolBreak = false;
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
			if (this.findToolEntryIndex(toolResult.toolCallId) >= 0) return true;
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
		if (
			this.streamingAssistantIndex !== undefined &&
			this.isAssistantEntry(this.entries[this.streamingAssistantIndex])
		) {
			this.entries[this.streamingAssistantIndex] = {
				...(this.entries[this.streamingAssistantIndex] as Extract<ChatMessageEntry, { kind: "assistant" }>),
				message,
			};
		} else {
			this.entries.push({ role: "assistant", kind: "assistant", message });
			this.streamingAssistantIndex = this.entries.length - 1;
		}
		const calls = assistantCallBreaks(message.content, this.carriedToolBreak);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.upsertToolEntry({
				toolCallId: content.id,
				toolName: content.name,
				args: content.arguments,
				isPartial: true,
				argsComplete,
				breakBefore: calls.breakBefore.has(content.id),
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
		this.pendingToolIndexes.set(toolCallId, index >= 0 ? index : this.entries.length - 1);
		return true;
	}
	private replaceToolEntry(index: number, next: ToolChatEntry): void {
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
			return new AssistantMessageComponent(
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
			);
		case "tool": {
			if (options.createToolComponent) return options.createToolComponent(messageEntry);
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
			if (isVerbatimCompactionMessage(messageEntry.message)) {
				return compactionBoundaryFromMessage(
					messageEntry.message,
					options.toolOutputExpanded ?? false,
					options.outputPad,
				);
			}
			if (options.createCustomMessageComponent) return options.createCustomMessageComponent(messageEntry.message);
			const component = new CustomMessageComponent(
				messageEntry.message,
				options.getCustomMessageRenderer?.(messageEntry.message.customType),
				markdownTheme,
				options.outputPad ?? 1,
				options.renderLatex,
				options.markdownTransformers,
				messageEntry.messageId,
				messageEntry.timestamp,
				options.loadTaskTranscript
					? {
							loadTranscript: options.loadTaskTranscript,
							...(options.hasTaskTranscript ? { hasTranscript: options.hasTaskTranscript } : {}),
							requestRender: () => options.ui.requestRender(),
						}
					: undefined,
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
class SkillMessageContainer extends Container {
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
	const container = new SkillMessageContainer();
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
	container.addChild(skillComponent);
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
