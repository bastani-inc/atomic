import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentArrayHasAssistantThinkingBlock } from "./thinking-blocks.ts";
import { messageStartsLlmUserTurn, userLikeContentIsLlmVisible } from "./messages.ts";
import type { ContextDeletionFilters, SessionEntry, SessionMessageEntry } from "./session-manager-types.ts";

interface ToolCallReference {
	entry: SessionMessageEntry;
	blockIndex: number;
	hasThinkingContent: boolean;
}

interface ToolDependencyPair {
	call: ToolCallReference;
	result: SessionMessageEntry;
}

function getMessageContent(message: AgentMessage): readonly unknown[] | undefined {
	return "content" in message && Array.isArray(message.content) ? message.content : undefined;
}

function getToolCallContentBlockId(block: unknown): string | undefined {
	if (!block || typeof block !== "object") return undefined;
	const candidate = block as { type?: unknown; id?: unknown };
	return candidate.type === "toolCall" && typeof candidate.id === "string" ? candidate.id : undefined;
}

function getToolResultCallId(message: AgentMessage): string | undefined {
	if (message.role !== "toolResult") return undefined;
	const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
	return typeof toolCallId === "string" ? toolCallId : undefined;
}

function entryStartsNewToolPairingTurn(entry: SessionEntry, filters: ContextDeletionFilters): boolean {
	if (filters.deletedEntryIds.has(entry.id)) return false;
	const deletedBlocks = filters.deletedContentBlocks.get(entry.id);
	if (entry.type === "branch_summary") return typeof entry.summary === "string" && entry.summary.length > 0;
	if (entry.type === "custom_message") {
		return entry.excludeFromContext !== true && userLikeContentIsLlmVisible(entry.content, deletedBlocks);
	}
	return entry.type === "message" && messageStartsLlmUserTurn(entry.message, deletedBlocks);
}

/**
 * Pair each result with the nearest preceding unmatched call occurrence in its
 * structural user turn. Opaque call ids are correlation tokens, not globally
 * unique identities: the same id may legitimately be reused in later turns.
 */
function collectToolDependencyPairs(path: SessionEntry[], filters: ContextDeletionFilters): ToolDependencyPair[] {
	const pairs: ToolDependencyPair[] = [];
	const pendingCalls = new Map<string, ToolCallReference[]>();
	for (const entry of path) {
		if (entryStartsNewToolPairingTurn(entry, filters)) pendingCalls.clear();
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			const content = getMessageContent(entry.message);
			if (!content) continue;
			const hasThinkingContent = contentArrayHasAssistantThinkingBlock(entry.message.content);
			for (const [blockIndex, block] of content.entries()) {
				const callId = getToolCallContentBlockId(block);
				if (!callId) continue;
				const pendingForId = pendingCalls.get(callId) ?? [];
				pendingForId.push({ entry, blockIndex, hasThinkingContent });
				pendingCalls.set(callId, pendingForId);
			}
			continue;
		}
		const resultCallId = getToolResultCallId(entry.message);
		if (!resultCallId) continue;
		const pendingForId = pendingCalls.get(resultCallId);
		const call = pendingForId?.shift();
		if (!call) continue;
		if (pendingForId?.length === 0) pendingCalls.delete(resultCallId);
		pairs.push({ call, result: entry });
	}
	return pairs;
}

function isMessageEntryEffectivelyDeleted(entry: SessionMessageEntry, filters: ContextDeletionFilters): boolean {
	if (filters.deletedEntryIds.has(entry.id)) return true;
	const deletedBlocks = filters.deletedContentBlocks.get(entry.id);
	if (!deletedBlocks || deletedBlocks.size === 0) return false;
	const content = getMessageContent(entry.message);
	return content !== undefined && content.length > 0 && content.every((_block, index) => deletedBlocks.has(index));
}

function isToolCallDeleted(ref: ToolCallReference, filters: ContextDeletionFilters): boolean {
	if (isMessageEntryEffectivelyDeleted(ref.entry, filters)) return true;
	return filters.deletedContentBlocks.get(ref.entry.id)?.has(ref.blockIndex) === true;
}

function isToolResultDeleted(entry: SessionMessageEntry, filters: ContextDeletionFilters): boolean {
	return isMessageEntryEffectivelyDeleted(entry, filters);
}

function addEntryDeletion(filters: ContextDeletionFilters, entryId: string): boolean {
	if (filters.deletedEntryIds.has(entryId)) return false;
	filters.deletedEntryIds.add(entryId);
	filters.deletedContentBlocks.delete(entryId);
	return true;
}

function addToolCallDeletion(filters: ContextDeletionFilters, ref: ToolCallReference): boolean {
	if (filters.deletedEntryIds.has(ref.entry.id)) return false;
	if (ref.hasThinkingContent) return addEntryDeletion(filters, ref.entry.id);
	const deletedBlocks = filters.deletedContentBlocks.get(ref.entry.id) ?? new Set<number>();
	if (deletedBlocks.has(ref.blockIndex)) return false;
	deletedBlocks.add(ref.blockIndex);
	filters.deletedContentBlocks.set(ref.entry.id, deletedBlocks);
	return true;
}

/**
 * Expand persisted context-compaction filters in place until replay retains
 * both sides of every tool-call/tool-result pair or neither side. Durable
 * omissions are authoritative: repair may only add omissions, never restore a
 * persisted target. Callers should pass a fresh, unshared filter set.
 */
export function reconcilePersistedToolDependencyFilters(
	path: SessionEntry[],
	filters: ContextDeletionFilters,
): ContextDeletionFilters {
	const pairs = collectToolDependencyPairs(path, filters);
	if (pairs.length === 0) return filters;

	let changed = true;
	let remainingPasses = Math.max(1, path.length * 2);
	while (changed && remainingPasses > 0) {
		changed = false;
		remainingPasses -= 1;

		for (const pair of pairs) {
			const callDeleted = isToolCallDeleted(pair.call, filters);
			const resultDeleted = isToolResultDeleted(pair.result, filters);
			if (callDeleted && !resultDeleted) {
				changed = addEntryDeletion(filters, pair.result.id) || changed;
				continue;
			}
			if (resultDeleted && !callDeleted) {
				changed = addToolCallDeletion(filters, pair.call) || changed;
			}
		}
	}

	return filters;
}
