import type { AssistantMessage, ToolResultMessage } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Container, type MarkdownTheme, Text, type TUI } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { parseSkillBlock } from "../../../core/agent-session.js";
import type { MarkdownTransformer, MessageRenderer, ToolDefinition } from "../../../core/extensions/types.ts";
import {
	type BashExecutionMessage,
	type BranchSummaryMessage,
	type CustomMessage,
	isVerbatimCompactionMessage,
} from "../../../core/messages.ts";
import type { TaskRecord } from "../../../core/tasks/contracts.js";
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
import { TaskRow } from "./task-row.js";
import { ToolExecutionComponent } from "./tool-execution.ts";
import { UserMessageComponent } from "./user-message.ts";
export type ChatMessageEntry =
	| { role: "assistant"; kind: "assistant"; message: AssistantMessage }
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
	  }
	| { role: "tool"; kind: "bashExecution"; message: BashExecutionMessage; isPartial?: boolean }
	| { role: "user"; kind: "user"; text: string }
	| { role: "custom"; kind: "custom"; message: CustomMessage<unknown> }
	| { role: "summary"; kind: "branchSummary"; message: BranchSummaryMessage }
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
	markdownTransformers?: readonly MarkdownTransformer[];
	renderLatex?: boolean;
	getToolDefinition?: (toolName: string) => ToolDefinition<TSchema, unknown> | undefined;
	getCustomMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	createToolComponent?: (entry: Extract<ChatMessageEntry, { kind: "tool" }>) => Component;
	createCustomMessageComponent?: (message: CustomMessage<unknown>) => Component;
}
export function chatEntriesFromAgentMessages(messages: readonly AgentMessage[]): ChatMessageEntry[] {
	const entries: ChatMessageEntry[] = [];
	const pendingTools = new Map<string, Extract<ChatMessageEntry, { kind: "tool" }>>();
	for (const message of messages) {
		if (isLegacyCompactionSummaryMessage(message)) continue;
		switch (message.role) {
			case "assistant": {
				entries.push({ role: "assistant", kind: "assistant", message });
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const toolEntry: ChatMessageEntry = {
						role: "tool",
						kind: "tool",
						toolName: content.name,
						toolCallId: content.id,
						args: content.arguments,
						isPartial: true,
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
					});
				}
				break;
			}
			case "user": {
				const text = getMessageText(message);
				if (text) entries.push({ role: "user", kind: "user", text });
				break;
			}
			case "bashExecution":
				entries.push({ role: "tool", kind: "bashExecution", message });
				break;
			case "custom":
				if (message.display) entries.push({ role: "custom", kind: "custom", message });
				break;
			case "branchSummary":
				entries.push({ role: "summary", kind: "branchSummary", message });
				break;
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
	readonly toolName?: unknown;
	readonly args?: unknown;
	readonly partialResult?: unknown;
	readonly result?: unknown;
	readonly isError?: unknown;
}
type LiveChatEntry = ChatMessageEntry | { role: string };
export class LiveChatEntriesController {
	private streamingAssistantIndex: number | undefined;
	private pendingToolIndexes = new Map<string, number>();
	private declare readonly entries: LiveChatEntry[];
	constructor(entries: LiveChatEntry[]) {
		this.entries = entries;
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
			} else
				this.entries.push({
					role: "tool",
					kind: "task",
					task,
					duplicate,
					siblings: tasks,
					activity,
					activityOmitted,
				});
		}
	}
	appendMessages(messages: readonly AgentMessage[]): void {
		this.entries.push(...chatEntriesFromAgentMessages(messages));
		this.reindexPendingTools();
	}
	replaceMessages(messages: readonly AgentMessage[], preservedEntries: readonly { role: string }[] = []): void {
		this.entries.splice(0, this.entries.length, ...chatEntriesFromAgentMessages(messages), ...preservedEntries);
		this.streamingAssistantIndex = undefined;
		this.reindexPendingTools();
	}
	appendUserText(text: string): void {
		this.entries.push({ role: "user", kind: "user", text });
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
				});
			case "tool_execution_update": {
				const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
				if (!toolCallId) return false;
				return this.updateToolResult(toolCallId, event.partialResult, true, false);
			}
			case "tool_execution_end": {
				const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
				if (!toolCallId) return false;
				return this.updateToolResult(toolCallId, event.result, false, event.isError === true);
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
		const entries = chatEntriesFromAgentMessages([message as AgentMessage]);
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
		const changed = this.updateAssistantMessage(message as AssistantMessage);
		const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
		if (stopReason === "aborted" || stopReason === "error") {
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
		this.streamingAssistantIndex = undefined;
		return changed || true;
	}
	private updateAssistantMessage(message: AssistantMessage): boolean {
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
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.upsertToolEntry({
				toolCallId: content.id,
				toolName: content.name,
				args: content.arguments,
				isPartial: true,
			});
		}
		return true;
	}
	private currentStreamingAssistantMessage(): AssistantMessage | undefined {
		const entry = this.streamingAssistantIndex !== undefined ? this.entries[this.streamingAssistantIndex] : undefined;
		return this.isAssistantEntry(entry) ? entry.message : undefined;
	}
	private upsertToolEntry(update: {
		toolCallId?: string;
		toolName: string;
		args?: unknown;
		isPartial: boolean;
	}): boolean {
		const toolCallId = update.toolCallId ?? `live-${update.toolName}`;
		const index = this.pendingToolIndexes.get(toolCallId) ?? this.findToolEntryIndex(toolCallId, update.toolName);
		const previous = index >= 0 ? this.entries[index] : undefined;
		const previousTool = this.isToolEntry(previous) ? previous : undefined;
		const next: ChatMessageEntry = {
			role: "tool",
			kind: "tool",
			toolName: previousTool?.toolName ?? update.toolName,
			toolCallId,
			args: update.args ?? previousTool?.args ?? {},
			result: previousTool?.result,
			isPartial: update.isPartial,
		};
		if (index >= 0) this.entries[index] = next;
		else this.entries.push(next);
		this.pendingToolIndexes.set(toolCallId, index >= 0 ? index : this.entries.length - 1);
		return true;
	}
	private updateToolResult(toolCallId: string, result: unknown, isPartial: boolean, isError: boolean): boolean {
		const index = this.pendingToolIndexes.get(toolCallId) ?? this.findToolEntryIndex(toolCallId);
		if (index < 0) return false;
		const entry = this.entries[index];
		if (!this.isToolEntry(entry)) return false;
		const resultObject = toolResultFromUnknown(result, entry.toolName, toolCallId, isError);
		this.entries[index] = { ...entry, result: resultObject, isPartial };
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
			);
		case "tool": {
			if (options.createToolComponent) return options.createToolComponent(messageEntry);
			const component = new ToolExecutionComponent(
				messageEntry.toolName,
				messageEntry.toolCallId,
				messageEntry.args,
				{
					showImages: options.showImages ?? true,
					imageWidthCells: options.imageWidthCells,
				},
				options.getToolDefinition?.(messageEntry.toolName),
				options.ui as TUI,
				options.cwd,
			);
			component.setExpanded(options.toolOutputExpanded ?? false);
			if (messageEntry.result) component.updateResult(messageEntry.result, messageEntry.isPartial ?? false);
			return component;
		}
		case "bashExecution": {
			const component = new BashExecutionComponent(
				messageEntry.message.command,
				options.ui as TUI,
				messageEntry.message.excludeFromContext,
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
			);
		case "custom": {
			if (isVerbatimCompactionMessage(messageEntry.message)) {
				return compactionBoundaryFromMessage(messageEntry.message, options.toolOutputExpanded ?? false);
			}
			if (options.createCustomMessageComponent) return options.createCustomMessageComponent(messageEntry.message);
			const component = new CustomMessageComponent(
				messageEntry.message,
				options.getCustomMessageRenderer?.(messageEntry.message.customType),
				markdownTheme,
				options.outputPad ?? 1,
				options.renderLatex,
			);
			component.setExpanded(options.toolOutputExpanded ?? false);
			return component;
		}
		case "branchSummary": {
			const component = new BranchSummaryMessageComponent(messageEntry.message, markdownTheme, options.renderLatex);
			component.setExpanded(options.toolOutputExpanded ?? false);
			return component;
		}
		case "system":
			return new Text(theme.fg("dim", messageEntry.text), 1, 0);
	}
}
function userMessageComponent(
	text: string,
	markdownTheme: MarkdownTheme,
	expanded: boolean,
	outputPad = 1,
	markdownTransformers: readonly MarkdownTransformer[] = [],
	renderLatex = true,
): Component {
	const skillBlock = parseSkillBlock(text);
	if (!skillBlock) return new UserMessageComponent(text, markdownTheme, outputPad, markdownTransformers, renderLatex);
	const container = new Container();
	const skillComponent = new SkillInvocationMessageComponent(skillBlock, markdownTheme, renderLatex);
	skillComponent.setExpanded(expanded);
	container.addChild(skillComponent);
	if (skillBlock.userMessage) {
		container.addChild(
			new UserMessageComponent(skillBlock.userMessage, markdownTheme, outputPad, markdownTransformers, renderLatex),
		);
	}
	return container;
}
function getMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
	return extractMessageText(message.content).trim();
}
