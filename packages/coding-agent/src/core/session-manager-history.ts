import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createBranchSummaryMessage, createCustomMessage } from "./messages.ts";
import { contentArrayHasAssistantThinkingBlock } from "./thinking-blocks.ts";
import { reconcilePersistedToolDependencyFilters } from "./session-manager-tool-dependencies.ts";
import type {
	ContextCompactionEntry,
	ContextDeletionFilters,
	FileEntry,
	SessionContext,
	SessionEntry,
	SessionMessageEntry,
	SessionTreeNode,
} from "./session-manager-types.ts";

export function getLatestCompactionBoundaryEntry(entries: SessionEntry[]): ContextCompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "context_compaction") {
			return entry;
		}
	}
	return null;
}

/**
 * Build raw deletion filters from persisted context_compaction entries.
 *
 * These raw filters do not apply replay-safety repair for latest assistant
 * thinking/redacted_thinking blocks or their paired tool results. Production
 * context rebuild paths should prefer `buildEffectiveContextDeletionFilters`
 * or `buildContextDeletionFilteredPath(path)` unless they intentionally need
 * the un-repaired historical deletion plan for diagnostics.
 */
export function buildContextDeletionFilters(path: SessionEntry[]): ContextDeletionFilters {
	const deletedEntryIds = new Set<string>();
	const deletedContentBlocks = new Map<string, Set<number>>();

	for (const entry of path) {
		if (entry.type !== "context_compaction") continue;
		for (const target of entry.deletedTargets) {
			if (target.kind === "entry") {
				deletedEntryIds.add(target.entryId);
				continue;
			}
			const existing = deletedContentBlocks.get(target.entryId) ?? new Set<number>();
			existing.add(target.blockIndex);
			deletedContentBlocks.set(target.entryId, existing);
		}
	}

	return { deletedEntryIds, deletedContentBlocks };
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

function collectToolCallContentBlockIds(content: readonly unknown[]): Set<string> {
	const toolCallIds = new Set<string>();
	for (const block of content) {
		const toolCallId = getToolCallContentBlockId(block);
		if (toolCallId) toolCallIds.add(toolCallId);
	}
	return toolCallIds;
}

function addDeletionTarget(filters: ContextDeletionFilters, target: ContextCompactionEntry["deletedTargets"][number]): void {
	if (target.kind === "entry") {
		filters.deletedEntryIds.add(target.entryId);
		return;
	}
	const existing = filters.deletedContentBlocks.get(target.entryId) ?? new Set<number>();
	existing.add(target.blockIndex);
	filters.deletedContentBlocks.set(target.entryId, existing);
}

function buildToolResultEntryIdsByCallId(path: SessionEntry[]): Map<string, Set<string>> {
	const toolResultEntryIdsByCallId = new Map<string, Set<string>>();
	for (const entry of path) {
		if (entry.type !== "message") continue;
		const toolCallId = getToolResultCallId(entry.message);
		if (!toolCallId) continue;
		const existing = toolResultEntryIdsByCallId.get(toolCallId) ?? new Set<string>();
		existing.add(entry.id);
		toolResultEntryIdsByCallId.set(toolCallId, existing);
	}
	return toolResultEntryIdsByCallId;
}

function findRetainedThinkingAssistants(
	path: SessionEntry[],
	deletedEntryIds: ReadonlySet<string>,
): SessionMessageEntry[] {
	return path.filter((entry): entry is SessionMessageEntry => {
		if (entry.type !== "message") return false;
		if (deletedEntryIds.has(entry.id)) return false;
		if (entry.message.role !== "assistant") return false;
		return contentArrayHasAssistantThinkingBlock(entry.message.content);
	});
}

export function buildEffectiveContextDeletionFilters(path: SessionEntry[]): ContextDeletionFilters {
	const filters = buildContextDeletionFilters(path);
	if (!path.some((entry) => entry.type === "context_compaction")) return filters;

	const rawDeletedEntryIds = new Set<string>();
	for (const compaction of path) {
		if (compaction.type !== "context_compaction") continue;
		for (const target of compaction.deletedTargets) {
			if (target.kind === "entry") rawDeletedEntryIds.add(target.entryId);
		}
	}
	const retainedThinkingAssistants = findRetainedThinkingAssistants(path, rawDeletedEntryIds);
	const retainedThinkingAssistantIds = new Set(retainedThinkingAssistants.map((entry) => entry.id));
	const retainedThinkingAssistantById = new Map(retainedThinkingAssistants.map((entry) => [entry.id, entry]));
	const toolResultEntryIdsByCallId = buildToolResultEntryIdsByCallId(path);
	const effectiveFilters: ContextDeletionFilters = {
		deletedEntryIds: new Set<string>(),
		deletedContentBlocks: new Map<string, Set<number>>(),
	};
	const allRestoredToolResultEntryIds = new Set<string>();

	for (const compaction of path) {
		if (compaction.type !== "context_compaction") continue;
		for (const target of compaction.deletedTargets) {
			if (target.kind !== "content_block") continue;
			const retainedThinkingAssistant = retainedThinkingAssistantById.get(target.entryId);
			if (!retainedThinkingAssistant) continue;
			const content = (retainedThinkingAssistant.message as { content: readonly unknown[] }).content;
			for (const toolCallId of collectToolCallContentBlockIds(content)) {
				for (const entryId of toolResultEntryIdsByCallId.get(toolCallId) ?? []) {
					allRestoredToolResultEntryIds.add(entryId);
				}
			}
		}
	}

	for (const compaction of path) {
		if (compaction.type !== "context_compaction") continue;
		let restoresRetainedThinkingAssistant = false;
		for (const target of compaction.deletedTargets) {
			if (target.kind === "content_block" && retainedThinkingAssistantIds.has(target.entryId)) {
				restoresRetainedThinkingAssistant = true;
				break;
			}
		}

		for (const target of compaction.deletedTargets) {
			if (target.kind === "content_block" && retainedThinkingAssistantIds.has(target.entryId)) {
				continue;
			}
			// When a stale persisted plan tried to partially filter a retained
			// thinking-bearing assistant, treat the same compaction entry as one
			// unsafe unit and restore its paired tool results. Later compaction
			// entries may still trim those restored multi-block results normally,
			// but whole-entry deletion of those paired results remains unsafe in any
			// later compaction because the assistant tool call is retained.
			if (restoresRetainedThinkingAssistant && allRestoredToolResultEntryIds.has(target.entryId)) continue;
			if (target.kind === "entry" && allRestoredToolResultEntryIds.has(target.entryId)) continue;
			addDeletionTarget(effectiveFilters, target);
		}
	}

	return reconcilePersistedToolDependencyFilters(path, effectiveFilters);
}

function filterContentArray<T>(content: T[], deletedBlocks: ReadonlySet<number>): T[] {
	return content.filter((_, index) => !deletedBlocks.has(index));
}

function filterMessageContentBlocks(
	message: AgentMessage,
	deletedBlocks: ReadonlySet<number> | undefined,
): AgentMessage | undefined {
	if (!deletedBlocks || deletedBlocks.size === 0) return message;

	switch (message.role) {
		case "user": {
			if (!Array.isArray(message.content)) return message;
			const content = filterContentArray(message.content, deletedBlocks);
			if (content.length === 0) return undefined;
			return { ...message, content };
		}
		case "assistant": {
			const content = filterContentArray(message.content, deletedBlocks);
			if (content.length === 0) return undefined;
			return { ...message, content };
		}
		case "toolResult": {
			if (!Array.isArray(message.content)) return message;
			const content = filterContentArray(message.content, deletedBlocks);
			if (content.length === 0) return undefined;
			return { ...message, content };
		}
		case "custom": {
			if (!Array.isArray(message.content)) return message;
			const content = filterContentArray(message.content, deletedBlocks);
			if (content.length === 0) return undefined;
			return { ...message, content };
		}
		case "bashExecution":
		case "branchSummary":
			return message;
	}
}

/**
 * Return the active branch path after applying logical context-deletion entries.
 * Whole-entry deletions remove the entry from the path. Content-block deletions
 * clone only affected message/custom-message entries so retained blocks stay verbatim.
 * The optional filters parameter is for callers that already computed effective
 * filters with `buildEffectiveContextDeletionFilters(path)` and want to avoid
 * repeating the repair pass.
 */
export function buildContextDeletionFilteredPath(
	path: SessionEntry[],
	effectiveFilters: ContextDeletionFilters = buildEffectiveContextDeletionFilters(path),
): SessionEntry[] {
	const filteredPath: SessionEntry[] = [];

	for (const entry of path) {
		if (effectiveFilters.deletedEntryIds.has(entry.id)) continue;

		const deletedBlocks = effectiveFilters.deletedContentBlocks.get(entry.id);
		if (!deletedBlocks || deletedBlocks.size === 0) {
			filteredPath.push(entry);
			continue;
		}

		if (entry.type === "message") {
			const message = filterMessageContentBlocks(entry.message, deletedBlocks);
			if (message) filteredPath.push({ ...entry, message });
			continue;
		}

		if (entry.type === "custom_message" && Array.isArray(entry.content)) {
			const content = filterContentArray(entry.content, deletedBlocks);
			if (content.length > 0) filteredPath.push({ ...entry, content });
			continue;
		}

		filteredPath.push(entry);
	}

	return filteredPath;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Applies context-deletion filtering and includes branch summaries along the path.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	// Build uuid index if not available
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) {
			byId.set(entry.id, entry);
		}
	}

	// Find leaf
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		// Explicitly null - return no messages (navigated to before first entry)
		return { messages: [], thinkingLevel: "off", contextWindow: undefined, model: null };
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		// Fallback to last entry (when leafId is undefined)
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return { messages: [], thinkingLevel: "off", contextWindow: undefined, model: null };
	}

	// Walk from leaf to root, collecting path
	const path = getBranchPath(leaf.id, byId);

	// Extract settings
	let thinkingLevel = "off";
	let contextWindow: number | undefined;
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "context_window_change") {
			contextWindow = entry.contextWindow;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	const filteredPath = buildContextDeletionFilteredPath(path);

	// Build active context messages from the filtered path. Legacy "compaction"
	// entries are archival metadata and intentionally inert here.
	const messages: AgentMessage[] = [];

	const appendMessage = (entry: SessionEntry) => {
		let message: AgentMessage | undefined;
		if (entry.type === "message") {
			message = entry.message;
		} else if (entry.type === "custom_message") {
			message = createCustomMessage(
				entry.customType,
				entry.content,
				entry.display,
				entry.details,
				entry.timestamp,
				entry.excludeFromContext,
			);
		} else if (entry.type === "branch_summary" && entry.summary) {
			message = createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
		}

		if (message) messages.push(message);
	};

	for (const entry of filteredPath) {
		appendMessage(entry);
	}

	return { messages, thinkingLevel, contextWindow, model };
}

export interface SessionIndex {
	byId: Map<string, SessionEntry>;
	labelsById: Map<string, string>;
	labelTimestampsById: Map<string, string>;
	leafId: string | null;
}

export function buildSessionIndex(fileEntries: FileEntry[]): SessionIndex {
	const byId = new Map<string, SessionEntry>();
	const labelsById = new Map<string, string>();
	const labelTimestampsById = new Map<string, string>();
	let leafId: string | null = null;

	for (const entry of fileEntries) {
		if (entry.type === "session") continue;
		byId.set(entry.id, entry);
		leafId = entry.id;
		if (entry.type === "label") {
			if (entry.label) {
				labelsById.set(entry.targetId, entry.label);
				labelTimestampsById.set(entry.targetId, entry.timestamp);
			} else {
				labelsById.delete(entry.targetId);
				labelTimestampsById.delete(entry.targetId);
			}
		}
	}

	return { byId, labelsById, labelTimestampsById, leafId };
}

export function getBranchPath(fromId: string | null | undefined, byId: Map<string, SessionEntry>): SessionEntry[] {
	const path: SessionEntry[] = [];
	let current = fromId ? byId.get(fromId) : undefined;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

export function buildSessionTree(
	entries: SessionEntry[],
	labelsById: ReadonlyMap<string, string>,
	labelTimestampsById: ReadonlyMap<string, string>,
): SessionTreeNode[] {
	const nodeMap = new Map<string, SessionTreeNode>();
	const roots: SessionTreeNode[] = [];

	// Create nodes with resolved labels
	for (const entry of entries) {
		const label = labelsById.get(entry.id);
		const labelTimestamp = labelTimestampsById.get(entry.id);
		nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
	}

	// Build tree
	for (const entry of entries) {
		const node = nodeMap.get(entry.id)!;
		if (entry.parentId === null || entry.parentId === entry.id) {
			roots.push(node);
		} else {
			const parent = nodeMap.get(entry.parentId);
			if (parent) {
				parent.children.push(node);
			} else {
				// Orphan - treat as root
				roots.push(node);
			}
		}
	}

	// Sort children by timestamp (oldest first, newest at bottom)
	// Use iterative approach to avoid stack overflow on deep trees
	const stack: SessionTreeNode[] = [...roots];
	while (stack.length > 0) {
		const node = stack.pop()!;
		node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
		stack.push(...node.children);
	}

	return roots;
}
