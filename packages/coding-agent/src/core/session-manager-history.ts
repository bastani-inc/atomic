import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createBranchSummaryMessage,
	createCustomMessage,
	messageStartsLlmUserTurn,
	normalizeMessageContent,
	userLikeContentIsLlmVisible,
} from "./messages.ts";
import { normalizeDerivedSessionEntries } from "./session-entry-normalization.ts";
import { contentArrayHasAssistantThinkingBlock } from "./thinking-blocks.ts";
import { reconcilePersistedToolDependencyFilters } from "./session-manager-tool-dependencies.ts";
import { analyzeAssistantToolUseTurns, type AssistantTurnEntry } from "./compaction/context-assistant-turns.js";
import type {
	ContextCompactionEntry,
	ContextDeletionFilters,
	FileEntry,
	SessionContext,
	SessionEntry,
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
 * These raw filters do not apply replay-safety repair for assistant
 * thinking/redacted_thinking turns or their paired tool results. Production
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

function restoreEntry(filters: ContextDeletionFilters, entryId: string): void {
	filters.deletedEntryIds.delete(entryId);
	filters.deletedContentBlocks.delete(entryId);
}

function addDeletionTarget(
	filters: ContextDeletionFilters,
	target: ContextCompactionEntry["deletedTargets"][number],
): void {
	if (target.kind === "entry") {
		filters.deletedEntryIds.add(target.entryId);
		filters.deletedContentBlocks.delete(target.entryId);
		return;
	}
	if (filters.deletedEntryIds.has(target.entryId)) return;
	const existing = filters.deletedContentBlocks.get(target.entryId) ?? new Set<number>();
	existing.add(target.blockIndex);
	filters.deletedContentBlocks.set(target.entryId, existing);
}

function sessionBoundaryIsVisible(entry: SessionEntry, filters: ContextDeletionFilters): boolean {
	if (filters.deletedEntryIds.has(entry.id)) return false;
	const deletedBlocks = filters.deletedContentBlocks.get(entry.id);
	if (entry.type === "custom_message") {
		return entry.excludeFromContext !== true && userLikeContentIsLlmVisible(entry.content, deletedBlocks);
	}
	if (entry.type === "branch_summary") return typeof entry.summary === "string" && entry.summary.length > 0;
	if (entry.type !== "message") return false;
	return messageStartsLlmUserTurn(entry.message, deletedBlocks);
}

function sessionEntryAsTurnEntry(
	entry: SessionEntry,
	filters: ContextDeletionFilters,
): AssistantTurnEntry | undefined {
	if (entry.type === "custom_message") {
		if (entry.excludeFromContext === true) return undefined;
		return {
			entryId: entry.id,
			role: "custom",
			hasSignedThinking: false,
			startsNewTurn: sessionBoundaryIsVisible(entry, filters),
		};
	}
	if (entry.type === "branch_summary") {
		return {
			entryId: entry.id,
			role: "branchSummary",
			hasSignedThinking: false,
			startsNewTurn: sessionBoundaryIsVisible(entry, filters),
		};
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "compactionSummary") return undefined;
	if (
		(message.role === "bashExecution" && message.excludeFromContext === true) ||
		(message.role === "custom" && (message as { excludeFromContext?: boolean }).excludeFromContext === true)
	) {
		return undefined;
	}
	return {
		entryId: entry.id,
		role: message.role,
		hasSignedThinking: message.role === "assistant" && contentArrayHasAssistantThinkingBlock(message.content),
		startsNewTurn: sessionBoundaryIsVisible(entry, filters),
	};
}

function analyzeSessionAssistantTurns(path: SessionEntry[], filters: ContextDeletionFilters) {
	return analyzeAssistantToolUseTurns(path.flatMap((entry) => sessionEntryAsTurnEntry(entry, filters) ?? []));
}

function repairSignedThinkingTurnFilters(path: SessionEntry[], filters: ContextDeletionFilters): ContextDeletionFilters {
	const turns = analyzeSessionAssistantTurns(path, filters);

	// A retained signed assistant is byte-exact/all-or-nothing at message level.
	// Whole-entry deletion alone counts toward a safe historical omission.
	for (const turn of turns) {
		for (const entryId of turn.signedThinkingEntryIds) {
			if (!filters.deletedEntryIds.has(entryId)) filters.deletedContentBlocks.delete(entryId);
		}
	}

	for (const turn of turns) {
		const deletedSignedIds = turn.signedThinkingEntryIds.filter((entryId) => filters.deletedEntryIds.has(entryId));
		const unsafe = turn.active
			? deletedSignedIds.length > 0
			: deletedSignedIds.length > 0 && deletedSignedIds.length < turn.signedThinkingEntryIds.length;
		if (!unsafe) continue;
		for (const entryId of turn.signedThinkingEntryIds) restoreEntry(filters, entryId);
	}
	return filters;
}

function signedTurnReplayPolicy(
	path: SessionEntry[],
	finalIntent: ContextDeletionFilters,
): { restoredEntryIds: Set<string>; retainedEntryIds: Set<string> } {
	const restoredEntryIds = new Set<string>();
	const retainedEntryIds = new Set<string>();
	for (const turn of analyzeSessionAssistantTurns(path, finalIntent)) {
		const deleted = turn.signedThinkingEntryIds.filter((entryId) => finalIntent.deletedEntryIds.has(entryId));
		const restoreTurn = turn.active
			? deleted.length > 0
			: deleted.length > 0 && deleted.length < turn.signedThinkingEntryIds.length;
		for (const entryId of turn.signedThinkingEntryIds) {
			if (restoreTurn) restoredEntryIds.add(entryId);
			if (restoreTurn || !finalIntent.deletedEntryIds.has(entryId)) retainedEntryIds.add(entryId);
		}
	}
	return { restoredEntryIds, retainedEntryIds };
}

export function buildEffectiveContextDeletionFilters(path: SessionEntry[]): ContextDeletionFilters {
	const derivedPath = normalizeDerivedSessionEntries(path);
	const finalIntent = buildContextDeletionFilters(derivedPath);
	if (!derivedPath.some((entry) => entry.type === "context_compaction")) return finalIntent;

	// Decide turn-level restoration from the cumulative durable intent so safe
	// complete historical omissions may span multiple compaction entries. Then
	// replay each entry chronologically: reconciliation at each boundary restores
	// an unsafe paired whole-result deletion without erasing a later independent
	// content-block deletion on that result.
	const { restoredEntryIds, retainedEntryIds } = signedTurnReplayPolicy(derivedPath, finalIntent);
	const effective: ContextDeletionFilters = {
		deletedEntryIds: new Set<string>(),
		deletedContentBlocks: new Map<string, Set<number>>(),
	};
	for (const entry of derivedPath) {
		if (entry.type !== "context_compaction") continue;
		for (const target of entry.deletedTargets) {
			if (target.kind === "entry" && restoredEntryIds.has(target.entryId)) continue;
			if (target.kind === "content_block" && retainedEntryIds.has(target.entryId)) continue;
			addDeletionTarget(effective, target);
		}
		reconcilePersistedToolDependencyFilters(derivedPath, effective);
	}

	// Defensive final repair handles malformed dependency graphs and keeps this
	// reconstruction path authoritative even if reconciliation behavior evolves.
	repairSignedThinkingTurnFilters(derivedPath, effective);
	return reconcilePersistedToolDependencyFilters(derivedPath, effective);
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
	effectiveFilters?: ContextDeletionFilters,
): SessionEntry[] {
	const derivedPath = normalizeDerivedSessionEntries(path);
	const filters = effectiveFilters ?? buildEffectiveContextDeletionFilters(derivedPath);
	const filteredPath: SessionEntry[] = [];

	for (const entry of derivedPath) {
		if (filters.deletedEntryIds.has(entry.id)) continue;

		const deletedBlocks = filters.deletedContentBlocks.get(entry.id);
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
	const path = normalizeDerivedSessionEntries(getBranchPath(leaf.id, byId));

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
			message = normalizeMessageContent(entry.message);
		} else if (entry.type === "custom_message") {
			message = createCustomMessage(
				entry.customType,
				entry.content,
				entry.display,
				entry.details,
				entry.timestamp,
				entry.excludeFromContext,
			);
		} else if (entry.type === "branch_summary" && typeof entry.summary === "string" && entry.summary.length > 0) {
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
