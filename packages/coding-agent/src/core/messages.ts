/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai/compat";

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
	}
}

/** Normalize lax JavaScript/legacy message input before it reaches history or providers. */
export function normalizeMessageContent<T extends AgentMessage>(message: T): T {
	switch (message.role) {
		case "user":
		case "assistant":
		case "toolResult":
		case "custom":
			return message.content == null ? ({ ...message, content: [] } as T) : message;
		default:
			return message;
	}
}

export function userLikeContentBlockIsLlmVisible(block: unknown): boolean {
	if (!block || typeof block !== "object") return false;
	const candidate = block as { type?: unknown; text?: unknown };
	if (candidate.type === "image") return true;
	if (candidate.type === "text") return typeof candidate.text === "string" && candidate.text.trim().length > 0;
	// Future provider-supported blocks must fail visible; only malformed/untyped blocks fail closed.
	return typeof candidate.type === "string" && candidate.type.trim().length > 0;
}

/** Whether user/custom content survives provider conversion as a visible input. */
export function userLikeContentIsLlmVisible(
	content: unknown,
	deletedBlockIndexes: ReadonlySet<number> = new Set<number>(),
): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some((block, index) => !deletedBlockIndexes.has(index) && userLikeContentBlockIsLlmVisible(block));
}

/** Whether an Atomic message emits an LLM-visible user-like turn boundary. */
export function messageStartsLlmUserTurn(
	message: AgentMessage,
	deletedBlockIndexes: ReadonlySet<number> = new Set<number>(),
): boolean {
	switch (message.role) {
		case "user":
			return userLikeContentIsLlmVisible(message.content, deletedBlockIndexes);
		case "custom":
			return (
				(message as CustomMessage & { excludeFromContext?: boolean }).excludeFromContext !== true &&
				userLikeContentIsLlmVisible(message.content, deletedBlockIndexes)
			);
		case "branchSummary":
			// Empty summaries are omitted by session reconstruction. Whitespace is
			// visible because the branch-summary wrapper itself is non-whitespace.
			return typeof message.summary === "string" && message.summary.length > 0;
		case "bashExecution":
			return message.excludeFromContext !== true;
		default:
			return false;
	}
}

/** Whether an Atomic message survives conversion into provider-visible context. */
export function messageIsLlmVisible(
	message: AgentMessage,
	deletedBlockIndexes: ReadonlySet<number> = new Set<number>(),
): boolean {
	if (message.role === "assistant" || message.role === "toolResult") return true;
	return messageStartsLlmUserTurn(message, deletedBlockIndexes);
}

/** Filter invalid user-like blocks only in transient provider-bound content. */
function filterUserLikeContentBlocks(content: unknown[]): unknown[] {
	return content.filter(userLikeContentBlockIsLlmVisible);
}

/** Normalize raw blocks only in the transient LLM-compatible message returned by convertToLlm. */
function normalizeRawRedactedThinking(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
	let changed = false;
	const content = message.content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const candidate = block as { type?: unknown; data?: unknown };
		if (candidate.type !== "redacted_thinking" || typeof candidate.data !== "string") return block;
		changed = true;
		return {
			type: "thinking" as const,
			thinking: "",
			thinkingSignature: candidate.data,
			redacted: true,
		};
	});
	return changed ? ({ ...message, content } as AgentMessage) : message;
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export const VERBATIM_COMPACTION_PREFIX =
	'The earlier conversation was compacted. Below is the verbatim transcript of the retained lines; elided spans are marked "(filtered N lines)".\n\n';

/** Create the visible custom-role boundary used to replay a verbatim compaction. */
export function createVerbatimCompactionMessage(
	compactedText: string,
	tokensBefore: number,
	timestamp: string,
	details?: unknown,
): CustomMessage {
	return createCustomMessage(
		"compaction",
		[{ type: "text", text: VERBATIM_COMPACTION_PREFIX + compactedText }],
		true,
		details ?? { tokensBefore },
		timestamp,
	);
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	excludeFromContext?: boolean,
): CustomMessage {
	const message: CustomMessage & { excludeFromContext?: boolean } = {
		role: "custom",
		customType,
		content: content ?? [],
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
	if (excludeFromContext === true) message.excludeFromContext = true;
	return message;
}

function collectAssistantToolCallIds(message: Message): Set<string> {
	const content = (message as { content?: unknown }).content;
	const ids = new Set<string>();
	if (!Array.isArray(content)) return ids;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; id?: unknown };
		if (candidate.type === "toolCall" && typeof candidate.id === "string") ids.add(candidate.id);
	}
	return ids;
}

function getToolResultCallId(message: Message): string | undefined {
	if (message.role !== "toolResult") return undefined;
	const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
	return typeof toolCallId === "string" ? toolCallId : undefined;
}

export function repairOrphanToolResults(messages: Message[]): Message[] {
	let allowedToolCallIds: Set<string> | undefined;
	let changed = false;
	const repaired: Message[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			allowedToolCallIds = collectAssistantToolCallIds(message);
			repaired.push(message);
			continue;
		}
		if (message.role === "toolResult") {
			const toolCallId = getToolResultCallId(message);
			if (toolCallId && allowedToolCallIds?.has(toolCallId)) {
				repaired.push(message);
				continue;
			}
			changed = true;
			continue;
		}
		allowedToolCallIds = undefined;
		repaired.push(message);
	}
	return changed ? repaired : messages;
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Branch summarization (for summarizing abandoned branches)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	const converted = messages
		.map((rawMessage): Message | undefined => {
			const m = normalizeRawRedactedThinking(normalizeMessageContent(rawMessage));
			switch (m.role) {
				case "bashExecution":
					if (!messageStartsLlmUserTurn(m)) return undefined;
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					if (!messageStartsLlmUserTurn(m)) return undefined;
					const content = typeof m.content === "string"
						? [{ type: "text" as const, text: m.content }]
						: filterUserLikeContentBlocks(m.content) as Message["content"];
					return { role: "user", content, timestamp: m.timestamp } as Message;
				}
				case "branchSummary":
					if (!messageStartsLlmUserTurn(m)) return undefined;
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "user": {
					if (!messageStartsLlmUserTurn(m)) return undefined;
					if (!Array.isArray(m.content)) return m;
					return { ...m, content: filterUserLikeContentBlocks(m.content) } as Message;
				}
				case "assistant":
				case "toolResult":
					return m;
				case "compactionSummary":
					// Legacy generated summaries remain archival and never enter active LLM context.
					return undefined;
				default: {
					// Exhaustiveness guard: new AgentMessage roles must define provider conversion explicitly.
					const _exhaustiveCheck: never = m;
					void _exhaustiveCheck;
					return undefined;
				}
			}
		})
		.filter((m) => m !== undefined);
	return repairOrphanToolResults(converted);
}
