import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentArrayHasAssistantThinkingBlock } from "./thinking-blocks.ts";
import type { ContextDeletionFilters, SessionEntry, SessionMessageEntry } from "./session-manager-types.ts";

interface ToolCallReference {
	entry: SessionMessageEntry;
	blockIndex: number;
	hasThinkingContent: boolean;
}

interface ToolResultReference {
	entry: SessionMessageEntry;
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

function collectToolReferences(path: SessionEntry[]): {
	callsById: Map<string, ToolCallReference[]>;
	resultsByCallId: Map<string, ToolResultReference[]>;
} {
	const callsById = new Map<string, ToolCallReference[]>();
	const resultsByCallId = new Map<string, ToolResultReference[]>();
	for (const entry of path) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "assistant") {
			const content = getMessageContent(entry.message);
			if (!content) continue;
			const hasThinkingContent = contentArrayHasAssistantThinkingBlock(entry.message.content);
			for (const [blockIndex, block] of content.entries()) {
				const callId = getToolCallContentBlockId(block);
				if (!callId) continue;
				const refs = callsById.get(callId) ?? [];
				refs.push({ entry, blockIndex, hasThinkingContent });
				callsById.set(callId, refs);
			}
			continue;
		}
		const resultCallId = getToolResultCallId(entry.message);
		if (!resultCallId) continue;
		const refs = resultsByCallId.get(resultCallId) ?? [];
		refs.push({ entry });
		resultsByCallId.set(resultCallId, refs);
	}
	return { callsById, resultsByCallId };
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

function isToolResultDeleted(ref: ToolResultReference, filters: ContextDeletionFilters): boolean {
	return isMessageEntryEffectivelyDeleted(ref.entry, filters);
}

function addEntryDeletion(filters: ContextDeletionFilters, entryId: string): boolean {
	if (filters.deletedEntryIds.has(entryId)) return false;
	filters.deletedEntryIds.add(entryId);
	filters.deletedContentBlocks.delete(entryId);
	return true;
}

function addToolCallDeletion(filters: ContextDeletionFilters, ref: ToolCallReference): boolean {
	if (filters.deletedEntryIds.has(ref.entry.id)) return false;
	const deletedBlocks = filters.deletedContentBlocks.get(ref.entry.id) ?? new Set<number>();
	if (deletedBlocks.has(ref.blockIndex)) return false;
	deletedBlocks.add(ref.blockIndex);
	filters.deletedContentBlocks.set(ref.entry.id, deletedBlocks);
	return true;
}

function restoreResultEntry(filters: ContextDeletionFilters, entryId: string): boolean {
	const hadEntryDeletion = filters.deletedEntryIds.delete(entryId);
	const hadBlockDeletion = filters.deletedContentBlocks.delete(entryId);
	return hadEntryDeletion || hadBlockDeletion;
}

export function reconcilePersistedToolDependencyFilters(
	path: SessionEntry[],
	filters: ContextDeletionFilters,
): ContextDeletionFilters {
	const { callsById, resultsByCallId } = collectToolReferences(path);
	if (callsById.size === 0 || resultsByCallId.size === 0) return filters;

	let changed = true;
	let remainingPasses = Math.max(1, path.length * 2);
	while (changed && remainingPasses > 0) {
		changed = false;
		remainingPasses -= 1;

		for (const [callId, callRefs] of callsById) {
			const resultRefs = resultsByCallId.get(callId) ?? [];
			if (resultRefs.length === 0) continue;
			const callDeleted = callRefs.every((ref) => isToolCallDeleted(ref, filters));
			if (callDeleted) {
				for (const resultRef of resultRefs) {
					if (!isToolResultDeleted(resultRef, filters)) {
						changed = addEntryDeletion(filters, resultRef.entry.id) || changed;
					}
				}
				continue;
			}

			for (const resultRef of resultRefs) {
				if (!isToolResultDeleted(resultRef, filters)) continue;
				const retainedThinkingCall = callRefs.some(
					(ref) => ref.hasThinkingContent && !isToolCallDeleted(ref, filters),
				);
				if (retainedThinkingCall) {
					changed = restoreResultEntry(filters, resultRef.entry.id) || changed;
					continue;
				}
				for (const callRef of callRefs) {
					if (!isToolCallDeleted(callRef, filters)) {
						changed = addToolCallDeletion(filters, callRef) || changed;
					}
				}
			}
		}
	}

	return filters;
}
