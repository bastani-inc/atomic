import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { VerbatimCompactionDetails } from "./compaction/compaction-types.js";
import { serializeRetainedTranscript, type TranscriptChunk } from "./compaction/transcript-serialization.js";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCustomMessage,
	createVerbatimCompactionMessage,
	normalizeMessageContent,
} from "./messages.ts";
import { normalizeDerivedSessionEntries } from "./session-entry-normalization.ts";
import type {
	CompactionEntry,
	FileEntry,
	SessionContext,
	SessionEntry,
	SessionTreeNode,
} from "./session-manager-types.ts";

/** Build the single context message a durable entry contributes, if any. */
function contextMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return normalizeMessageContent(entry.message);
	if (entry.type === "custom_message") {
		return createCustomMessage(
			entry.customType,
			entry.content,
			entry.display,
			entry.details,
			entry.timestamp,
			entry.excludeFromContext,
			entry.stageAdmissionKey,
		);
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string" && entry.summary.length > 0) {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

/**
 * Serialize the kept tail into the compaction boundary's transcript grammar.
 *
 * The tail is concatenated onto the end of the boundary string instead of being
 * replayed as structured messages. A tail that starts mid-turn (a tool result whose
 * tool call was compacted away, or a trailing unanswered tool call) would otherwise
 * emit ill-ordered provider blocks and fail the request. Serialization is lossless:
 * tool results keep their full text and images stay as image blocks, because the tail
 * is exactly the span `preserve_recent` promised to keep.
 */
function serializeKeptTail(entries: SessionEntry[]): TranscriptChunk[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		const message = contextMessageFromEntry(entry);
		if (message) messages.push(message);
	}
	if (messages.length === 0) return [];
	return serializeRetainedTranscript(convertToLlm(messages));
}

export function getLatestCompactionBoundaryEntry(
	entries: SessionEntry[],
): CompactionEntry<VerbatimCompactionDetails> | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		const details = (entry as CompactionEntry<{ strategy?: string }>).details;
		if (details?.strategy === "verbatim-lines") return entry as CompactionEntry<VerbatimCompactionDetails>;
	}
	return null;
}

/** Convert one durable session entry into the messages it contributes to model context. */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") return [normalizeMessageContent(entry.message)];
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(
				entry.customType,
				entry.content,
				entry.display,
				entry.details,
				entry.timestamp,
				entry.excludeFromContext,
				entry.stageAdmissionKey,
			),
		];
	}
	if (entry.type === "branch_summary" && entry.summary.length > 0) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		const details = (entry as CompactionEntry<{ strategy?: string }>).details;
		if (details?.strategy === "verbatim-lines") {
			return [
				createVerbatimCompactionMessage(
					entry.summary,
					entry.tokensBefore,
					entry.timestamp,
					entry.details as VerbatimCompactionDetails,
				),
			];
		}
	}
	return [];
}

/** Return the active branch entries after applying the latest compaction boundary. */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId = new Map(entries.map((entry) => [entry.id, entry])),
): SessionEntry[] {
	if (leafId === null) return [];
	const leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
	if (!leaf) return [];
	const path = normalizeDerivedSessionEntries(getBranchPath(leaf.id, byId));
	const boundary = getLatestCompactionBoundaryEntry(path);
	if (!boundary) return path;
	const boundaryIndex = path.findIndex((entry) => entry.id === boundary.id);
	const firstKeptIndex = path.findIndex(
		(entry, index) => index < boundaryIndex && entry.id === boundary.firstKeptEntryId,
	);
	return [
		boundary,
		...(firstKeptIndex >= 0 ? path.slice(firstKeptIndex, boundaryIndex) : []),
		...path.slice(boundaryIndex + 1),
	];
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Emits the latest verbatim compaction boundary as one custom-role text message: the
 * compacted string with the kept tail serialized and appended to its end, rather than
 * the tail being replayed as separate structured messages.
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
		return { messages: [], thinkingLevel: "off", model: null };
	}
	if (leafId) {
		leaf = byId.get(leafId);
	}
	if (!leaf) {
		// Fallback to last entry (when leafId is undefined)
		leaf = entries[entries.length - 1];
	}

	if (!leaf) {
		return { messages: [], thinkingLevel: "off", model: null };
	}

	// Walk from leaf to root, collecting path
	const path = normalizeDerivedSessionEntries(getBranchPath(leaf.id, byId));

	// Extract settings
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	const messages: AgentMessage[] = [];
	const appendMessage = (entry: SessionEntry): void => {
		const message = contextMessageFromEntry(entry);
		if (message) messages.push(message);
	};

	const boundary = getLatestCompactionBoundaryEntry(path);
	if (!boundary) {
		for (const entry of path) appendMessage(entry);
		return { messages, thinkingLevel, model };
	}

	const boundaryIndex = path.findIndex((entry) => entry.id === boundary.id);
	const firstKeptIndex = path.findIndex(
		(entry, index) => index < boundaryIndex && entry.id === boundary.firstKeptEntryId,
	);
	const keptTail = firstKeptIndex >= 0 ? serializeKeptTail(path.slice(firstKeptIndex, boundaryIndex)) : [];
	const separator: TranscriptChunk[] =
		keptTail.length > 0 && boundary.summary.length > 0 ? [{ type: "text", text: "\n\n" }] : [];
	messages.push(
		createVerbatimCompactionMessage(boundary.summary, boundary.tokensBefore, boundary.timestamp, boundary.details, [
			...separator,
			...keptTail,
		]),
	);
	for (let i = boundaryIndex + 1; i < path.length; i++) appendMessage(path[i]);

	return { messages, thinkingLevel, model };
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
