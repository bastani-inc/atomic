import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { createBranchSummaryMessage, createCustomMessage } from "../messages.ts";
import {
	isAssistantThinkingBlockType,
	messageHasAssistantThinkingContentBlock,
} from "../thinking-blocks.ts";
import {
	buildContextDeletionFilteredPath,
	buildEffectiveContextDeletionFilters,
	type SessionEntry,
} from "../session-manager.ts";
import type { CompactionSettings } from "./compaction.ts";
import { ESTIMATED_IMAGE_TOKENS, estimateTokens } from "./compaction.ts";
import {
	CONTEXT_COMPACTION_AUTO_QUERY,
	type CompactableContentBlock,
	type CompactableTranscriptEntry,
	type ContextCompactionPreparation,
	type ContextCompactionRunOptions,
} from "./context-compaction-types.ts";
import {
	normalizeContextCompactionParameters,
	normalizeContextCompactionQuery,
} from "./context-compaction-strategy.ts";

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content,
			entry.display,
			entry.details,
			entry.timestamp,
			entry.excludeFromContext,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

export function isExcludedFromLlmContext(message: AgentMessage): boolean {
	switch (message.role) {
		case "bashExecution":
			return Boolean(message.excludeFromContext);
		case "custom":
			return (message as { excludeFromContext?: boolean }).excludeFromContext === true;
		default:
			return false;
	}
}

function getContextEligibleMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	const message = getMessageFromEntry(entry);
	if (!message || isExcludedFromLlmContext(message)) return undefined;
	return message;
}

function textFromUnknownContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content);
	return content.map((block) => textFromContentBlock(block)).join("\n");
}

function textFromContentBlock(block: unknown): string {
	if (!block || typeof block !== "object") return String(block);
	const record = block as Record<string, unknown>;
	if (record.type === "text" && typeof record.text === "string") return record.text;
	if (record.type === "thinking" && typeof record.thinking === "string") return record.thinking;
	if (record.type === "toolCall") {
		const name = typeof record.name === "string" ? record.name : "tool";
		const id = typeof record.id === "string" ? record.id : "unknown";
		const args = "arguments" in record ? JSON.stringify(record.arguments) : "";
		return `toolCall ${id} ${name} ${args}`.trim();
	}
	if (record.type === "image") return "[image]";
	return JSON.stringify(record);
}

export function assistantEntryHasThinkingContentBlock(entry: CompactableTranscriptEntry): boolean {
	return (
		entry.role === "assistant" &&
		(entry.contentBlocks.some((block) => isAssistantThinkingBlockType(block.type)) ||
			messageHasAssistantThinkingContentBlock(entry.message))
	);
}

function estimateTextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function estimateContentBlockTokens(block: unknown, text: string): number {
	if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
		return ESTIMATED_IMAGE_TOKENS;
	}
	return estimateTextTokens(text);
}

function getToolCallIdFromBlock(block: unknown): string | undefined {
	if (!block || typeof block !== "object") return undefined;
	const record = block as Record<string, unknown>;
	if (record.type !== "toolCall") return undefined;
	return typeof record.id === "string" ? record.id : undefined;
}

function getToolResultCallId(message: AgentMessage): string | undefined {
	if (message.role !== "toolResult") return undefined;
	const callId = (message as { toolCallId?: unknown }).toolCallId;
	return typeof callId === "string" ? callId : undefined;
}

function contentBlocksForEntry(
	entryId: string,
	message: AgentMessage,
	protectedEntry: boolean,
	existingDeletedBlocks: ReadonlySet<number> | undefined,
): CompactableContentBlock[] {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content
		.map((block, blockIndex): CompactableContentBlock | undefined => {
			if (existingDeletedBlocks?.has(blockIndex)) {
				return undefined;
			}
			const type =
				block && typeof block === "object" && typeof (block as { type?: unknown }).type === "string"
					? ((block as { type: string }).type)
					: "unknown";
			const text = textFromContentBlock(block);
			return {
				entryId,
				blockIndex,
				type,
				text,
				tokenEstimate: estimateContentBlockTokens(block, text),
				protected: protectedEntry,
				toolCallId: getToolCallIdFromBlock(block),
			};
		})
		.filter((block): block is CompactableContentBlock => block !== undefined);
}

function messageText(message: AgentMessage): string {
	switch (message.role) {
		case "bashExecution":
			return `Ran ${message.command}\n${message.output}`;
		case "branchSummary":
			return message.summary;
		case "custom":
		case "toolResult":
		case "user":
			return textFromUnknownContent(message.content);
		case "assistant":
			return textFromUnknownContent(message.content);
		case "compactionSummary":
			// Legacy summary-compaction message type retained in the upstream AgentMessage union
			// after summary compaction was removed; surface its archival summary text.
			return message.summary;
		default: {
			// Exhaustiveness guard: adding a new AgentMessage role must fail the build here instead
			// of silently degrading to an empty string.
			const _exhaustiveCheck: never = message;
			void _exhaustiveCheck;
			return "";
		}
	}
}

export function hasAssistantError(message: AgentMessage): boolean {
	return message.role === "assistant" && (message as AssistantMessage).stopReason === "error";
}

export function hasToolResultError(message: AgentMessage): boolean {
	return message.role === "toolResult" && (message as { isError?: unknown }).isError === true;
}

export function hasFailedBashExecution(message: AgentMessage): boolean {
	return message.role === "bashExecution" && typeof message.exitCode === "number" && message.exitCode !== 0;
}

export function autoDetectContextCompactionQuery(pathEntries: readonly SessionEntry[]): string {
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		const entry = pathEntries[index];
		if (entry.type === "context_compaction") continue;
		const message = getContextEligibleMessageFromEntry(entry);
		if (!message || message.role !== "user") continue;
		const text = messageText(message).trim();
		if (text.length > 0) return normalizeContextCompactionQuery(text, CONTEXT_COMPACTION_AUTO_QUERY);
	}
	return CONTEXT_COMPACTION_AUTO_QUERY;
}

function isProtectedEntry(
	entry: SessionEntry,
	message: AgentMessage,
	recentEntryIds: ReadonlySet<string>,
): boolean {
	if (recentEntryIds.has(entry.id)) return true;
	if (message.role === "user") return true;
	if (message.role === "custom") return true;
	if (message.role === "branchSummary") return true;
	if (hasAssistantError(message) || hasToolResultError(message)) return true;
	if (hasFailedBashExecution(message)) return true;
	if (entry.type === "branch_summary") return true;
	return false;
}

export function prepareContextCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	options: ContextCompactionRunOptions = {},
): ContextCompactionPreparation | undefined {
	if (pathEntries.length === 0) return undefined;

	const effectiveDeletionFilters = buildEffectiveContextDeletionFilters(pathEntries);
	const filteredPathEntries = buildContextDeletionFilteredPath(pathEntries, effectiveDeletionFilters);
	const parameters = normalizeContextCompactionParameters(
		{ ...settings, ...options },
		autoDetectContextCompactionQuery(filteredPathEntries),
	);
	const rawEntryById = new Map(pathEntries.map((entry) => [entry.id, entry]));
	const messageEntryIds = filteredPathEntries
		.filter((entry) => entry.type !== "context_compaction" && getContextEligibleMessageFromEntry(entry) !== undefined)
		.map((entry) => entry.id);
	const recentEntryIds = new Set(parameters.preserve_recent > 0 ? messageEntryIds.slice(-parameters.preserve_recent) : []);
	const protectedEntryIds = new Set<string>();
	const entries: CompactableTranscriptEntry[] = [];

	for (const entry of filteredPathEntries) {
		if (entry.type === "context_compaction") continue;
		const message = getContextEligibleMessageFromEntry(entry);
		if (!message) continue;
		const rawEntry = rawEntryById.get(entry.id) ?? entry;
		const protectedEntry = isProtectedEntry(entry, message, recentEntryIds);
		if (protectedEntry) protectedEntryIds.add(entry.id);
		const rawMessage = getContextEligibleMessageFromEntry(rawEntry) ?? message;
		const contentBlocks = contentBlocksForEntry(
			entry.id,
			rawMessage,
			protectedEntry,
			effectiveDeletionFilters.deletedContentBlocks.get(entry.id),
		);
		const toolCallIds = contentBlocks.map((block) => block.toolCallId).filter((id): id is string => id !== undefined);
		const text = contentBlocks.length > 0 ? contentBlocks.map((block) => block.text).join("\n") : messageText(message);
		entries.push({
			entryId: entry.id,
			entryType: entry.type,
			role: message.role,
			text,
			tokenEstimate: estimateTokens(message),
			protected: protectedEntry,
			contentBlocks,
			message,
			toolCallIds,
			toolResultFor: getToolResultCallId(message),
		});
	}

	if (entries.length < 2) return undefined;

	return {
		branchEntries: pathEntries,
		parameters,
		transcript: {
			entries,
			protectedEntryIds: [...protectedEntryIds],
			tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
			settings,
			parameters,
		},
	};
}
