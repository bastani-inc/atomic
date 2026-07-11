import { messageStartsLlmUserTurn, userLikeContentBlockIsLlmVisible } from "../messages.js";
import type {
	CompactableContentBlock,
	CompactableTranscript,
	CompactableTranscriptEntry,
} from "./context-compaction-types.js";
import { isAssistantThinkingBlockType, messageHasAssistantThinkingContentBlock } from "../thinking-blocks.js";

export function assistantEntryHasThinkingContentBlock(entry: CompactableTranscriptEntry): boolean {
	return (
		entry.role === "assistant" &&
		(entry.contentBlocks.some((block) => isAssistantThinkingBlockType(block.type)) ||
			messageHasAssistantThinkingContentBlock(entry.message))
	);
}

export interface AssistantTurnEntry {
	entryId: string;
	role: string;
	hasSignedThinking: boolean;
	startsNewTurn: boolean;
}

export interface AssistantToolUseTurn {
	entryIds: string[];
	assistantEntryIds: string[];
	signedThinkingEntryIds: string[];
	active: boolean;
}

export type CompactableTranscriptDeletionTarget =
	| { readonly kind: "entry"; readonly entryId: string }
	| { readonly kind: "content_block"; readonly entryId: string; readonly blockIndex: number };

export interface CompactableAssistantTurnAnalysis {
	deletedEntryIds: ReadonlySet<string>;
	deletedContentBlocks: ReadonlyMap<string, ReadonlySet<number>>;
	turns: AssistantToolUseTurn[];
}

export function compactableContentBlockIsLlmVisible(
	entry: CompactableTranscriptEntry,
	block: CompactableContentBlock,
): boolean {
	if (typeof block.llmVisible === "boolean") return block.llmVisible;
	const rawContent = (entry.message as { content?: unknown }).content;
	return Array.isArray(rawContent) && userLikeContentBlockIsLlmVisible(rawContent[block.blockIndex]);
}

export function transcriptEntryStartsNewTurn(
	entry: CompactableTranscriptEntry,
	deletedContentBlocks: ReadonlySet<number> = new Set<number>(),
): boolean {
	if (entry.role === "user" || entry.role === "custom") {
		const content = (entry.message as { content?: unknown }).content;
		if (typeof content === "string" || entry.contentBlocks.length === 0) {
			return messageStartsLlmUserTurn(entry.message, deletedContentBlocks);
		}
		return entry.contentBlocks.some(
			(block) => !deletedContentBlocks.has(block.blockIndex) && compactableContentBlockIsLlmVisible(entry, block),
		);
	}
	return messageStartsLlmUserTurn(entry.message, deletedContentBlocks);
}

export function isTranscriptEntryEffectivelyDeleted(
	entry: CompactableTranscriptEntry,
	deletedEntryIds: ReadonlySet<string>,
	deletedContentBlocks: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
	if (deletedEntryIds.has(entry.entryId)) return true;
	const deletedBlocks = deletedContentBlocks.get(entry.entryId);
	return (
		entry.contentBlocks.length > 0 &&
		deletedBlocks !== undefined &&
		entry.contentBlocks.every((block) => deletedBlocks.has(block.blockIndex))
	);
}

/** Shared adaptation from compactable transcript entries to logical assistant-turn inputs. */
export function compactableTranscriptToAssistantTurnEntries(
	transcript: CompactableTranscript,
	deletedEntryIds: ReadonlySet<string>,
	deletedContentBlocks: ReadonlyMap<string, ReadonlySet<number>>,
): AssistantTurnEntry[] {
	return transcript.entries.map((entry) => ({
		entryId: entry.entryId,
		role: entry.role,
		hasSignedThinking: assistantEntryHasThinkingContentBlock(entry),
		startsNewTurn:
			!isTranscriptEntryEffectivelyDeleted(entry, deletedEntryIds, deletedContentBlocks) &&
			transcriptEntryStartsNewTurn(entry, deletedContentBlocks.get(entry.entryId)),
	}));
}

/** Analyze assistant turns after projecting a compactable transcript through deletion targets. */
export function analyzeCompactableAssistantTurns(
	transcript: CompactableTranscript,
	targets: readonly CompactableTranscriptDeletionTarget[],
): CompactableAssistantTurnAnalysis {
	const deletedEntryIds = new Set<string>();
	const deletedContentBlocks = new Map<string, Set<number>>();
	for (const target of targets) {
		if (target.kind === "entry") {
			deletedEntryIds.add(target.entryId);
			continue;
		}
		const blockIndexes = deletedContentBlocks.get(target.entryId) ?? new Set<number>();
		blockIndexes.add(target.blockIndex);
		deletedContentBlocks.set(target.entryId, blockIndexes);
	}
	return {
		deletedEntryIds,
		deletedContentBlocks,
		turns: analyzeAssistantToolUseTurns(
			compactableTranscriptToAssistantTurnEntries(transcript, deletedEntryIds, deletedContentBlocks),
		),
	};
}

/**
 * Analyze chronological LLM-visible entries as logical assistant tool-use turns.
 * Callers adapt each context-visible user-like message into `startsNewTurn`;
 * tool results remain in the current turn. A trailing input-only turn is omitted,
 * intentionally leaving the preceding assistant turn historical rather than active.
 */
export function analyzeAssistantToolUseTurns(entries: readonly AssistantTurnEntry[]): AssistantToolUseTurn[] {
	const groups: Array<Omit<AssistantToolUseTurn, "active">> = [];
	let current: Omit<AssistantToolUseTurn, "active"> | undefined;

	for (const entry of entries) {
		if (entry.startsNewTurn || current === undefined) {
			current = { entryIds: [], assistantEntryIds: [], signedThinkingEntryIds: [] };
			groups.push(current);
		}
		current.entryIds.push(entry.entryId);
		if (entry.role !== "assistant") continue;
		current.assistantEntryIds.push(entry.entryId);
		if (entry.hasSignedThinking) current.signedThinkingEntryIds.push(entry.entryId);
	}

	const activeIndex = groups.length - 1;
	return groups
		.map((turn, index) => ({ ...turn, active: index === activeIndex }))
		.filter((turn) => turn.assistantEntryIds.length > 0);
}
