import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextDeletionTarget } from "../session-manager.ts";
import type { CompactableTranscript } from "./context-compaction-types.ts";
import { assistantEntryHasThinkingContentBlock } from "./context-transcript-analysis.ts";

export interface EntryTextRow {
	entry_id: string;
	text: string;
	is_protected: number;
	has_assistant_thinking_blocks: number;
}

export interface EntryReadRow extends EntryTextRow {
	role: string;
	token_estimate: number;
}

export interface ContentBlockTextRow {
	entry_id: string;
	block_index: number;
	role: AgentMessage["role"];
	type: string;
	text: string;
	entry_protected: number;
	block_protected: number;
	block_count: number;
	has_assistant_thinking_blocks: number;
}

export interface ContentBlockReadRow extends ContentBlockTextRow {
	token_estimate: number;
}

export interface StoredTranscriptEntry {
	entryId: string;
	role: AgentMessage["role"];
	protected: boolean;
	hasAssistantThinkingBlocks: boolean;
	tokenEstimate: number;
	text: string;
}

export interface StoredContentBlock {
	entryPosition: number;
	entryId: string;
	blockIndex: number;
	role: AgentMessage["role"];
	type: string;
	protected: boolean;
	hasAssistantThinkingBlocks: boolean;
	tokenEstimate: number;
	text: string;
}

export interface ContextDeletionMemorySnapshot {
	deletionTargets: ContextDeletionTarget[];
	callCount: number;
	lastError?: string;
}

function copyDeletionTarget(target: ContextDeletionTarget): ContextDeletionTarget {
	return target.kind === "entry"
		? { kind: "entry", entryId: target.entryId }
		: { kind: "content_block", entryId: target.entryId, blockIndex: target.blockIndex };
}

export class ContextDeletionMemoryStore {
	private readonly entries: StoredTranscriptEntry[];
	private readonly entriesById: Map<string, StoredTranscriptEntry>;
	private readonly contentBlocks: StoredContentBlock[];
	private readonly contentBlockCountByEntryId: Map<string, number>;
	private deletionTargets: ContextDeletionTarget[] = [];
	private callCount = 0;
	private lastError: string | undefined;

	constructor(transcript: CompactableTranscript) {
		const entryIds = new Set<string>();
		const blockKeys = new Set<string>();
		this.entries = transcript.entries.map((entry) => {
			if (entryIds.has(entry.entryId)) {
				throw new Error(`Duplicate transcript entry id: ${entry.entryId}`);
			}
			entryIds.add(entry.entryId);
			return {
				entryId: entry.entryId,
				role: entry.role,
				protected: entry.protected,
				hasAssistantThinkingBlocks: assistantEntryHasThinkingContentBlock(entry),
				tokenEstimate: entry.tokenEstimate,
				text: entry.text,
			};
		});
		this.entriesById = new Map<string, StoredTranscriptEntry>(this.entries.map((entry) => [entry.entryId, entry] as const));
		this.contentBlocks = transcript.entries.flatMap((entry, entryPosition) => {
			const hasAssistantThinkingBlocks = assistantEntryHasThinkingContentBlock(entry);
			return entry.contentBlocks.map((block) => {
				if (block.entryId !== entry.entryId) {
					throw new Error(`Transcript content block ${block.entryId}:${block.blockIndex} does not belong to entry ${entry.entryId}`);
				}
				const blockKey = `${block.entryId}:${block.blockIndex}`;
				if (blockKeys.has(blockKey)) {
					throw new Error(`Duplicate transcript content block: ${blockKey}`);
				}
				blockKeys.add(blockKey);
				return {
					entryPosition,
					entryId: block.entryId,
					blockIndex: block.blockIndex,
					role: entry.role,
					type: block.type,
					protected: block.protected,
					hasAssistantThinkingBlocks,
					tokenEstimate: block.tokenEstimate,
					text: block.text,
				};
			});
		});
		this.contentBlockCountByEntryId = new Map();
		for (const block of this.contentBlocks) {
			this.contentBlockCountByEntryId.set(block.entryId, (this.contentBlockCountByEntryId.get(block.entryId) ?? 0) + 1);
		}
	}

	transaction<T>(operation: () => T): T {
		const snapshot = this.snapshot();
		try {
			return operation();
		} catch (error) {
			this.restore(snapshot);
			throw error;
		}
	}

	readTargets(): ContextDeletionTarget[] {
		return this.deletionTargets.map(copyDeletionTarget);
	}

	replaceTargets(targets: readonly ContextDeletionTarget[]): void {
		this.deletionTargets = targets.map(copyDeletionTarget);
	}

	listEntriesForGrep(): EntryTextRow[] {
		return this.entries.map((entry) => ({
			entry_id: entry.entryId,
			text: entry.text,
			is_protected: entry.protected ? 1 : 0,
			has_assistant_thinking_blocks: entry.hasAssistantThinkingBlocks ? 1 : 0,
		}));
	}

	listContentBlocksForGrep(): ContentBlockTextRow[] {
		return [...this.contentBlocks]
			.sort((a, b) => a.entryPosition - b.entryPosition || a.blockIndex - b.blockIndex)
			.map((block) => ({
				entry_id: block.entryId,
				block_index: block.blockIndex,
				role: block.role,
				type: block.type,
				text: block.text,
				entry_protected: this.entriesById.get(block.entryId)?.protected ? 1 : 0,
				block_protected: block.protected ? 1 : 0,
				block_count: this.contentBlockCountByEntryId.get(block.entryId) ?? 0,
				has_assistant_thinking_blocks: block.hasAssistantThinkingBlocks ? 1 : 0,
			}));
	}

	getEntryForRead(entryId: string): EntryReadRow | undefined {
		const entry = this.entriesById.get(entryId);
		if (!entry) return undefined;
		return {
			entry_id: entry.entryId,
			role: entry.role,
			is_protected: entry.protected ? 1 : 0,
			has_assistant_thinking_blocks: entry.hasAssistantThinkingBlocks ? 1 : 0,
			token_estimate: entry.tokenEstimate,
			text: entry.text,
		};
	}

	getContentBlockForRead(entryId: string, blockIndex: number): ContentBlockReadRow | undefined {
		const block = this.contentBlocks.find((candidate) => candidate.entryId === entryId && candidate.blockIndex === blockIndex);
		if (!block) return undefined;
		return {
			entry_id: block.entryId,
			block_index: block.blockIndex,
			role: block.role,
			type: block.type,
			token_estimate: block.tokenEstimate,
			text: block.text,
			entry_protected: this.entriesById.get(block.entryId)?.protected ? 1 : 0,
			block_protected: block.protected ? 1 : 0,
			block_count: this.contentBlockCountByEntryId.get(block.entryId) ?? 0,
			has_assistant_thinking_blocks: block.hasAssistantThinkingBlocks ? 1 : 0,
		};
	}

	getGrepScanTextLength(target: "entry" | "content_block"): number {
		const texts = target === "entry" ? this.entries : this.contentBlocks;
		return texts.reduce((sum, item) => sum + item.text.length, 0);
	}

	incrementCallCount(): number {
		this.callCount += 1;
		return this.callCount;
	}

	getCallCount(): number {
		return this.callCount;
	}

	setLastError(message: string): void {
		this.lastError = message;
	}

	clearLastError(): void {
		this.lastError = undefined;
	}

	getLastError(): string | undefined {
		return this.lastError;
	}

	private snapshot(): ContextDeletionMemorySnapshot {
		return {
			deletionTargets: this.readTargets(),
			callCount: this.callCount,
			...(this.lastError === undefined ? {} : { lastError: this.lastError }),
		};
	}

	private restore(snapshot: ContextDeletionMemorySnapshot): void {
		this.deletionTargets = snapshot.deletionTargets.map(copyDeletionTarget);
		this.callCount = snapshot.callCount;
		this.lastError = snapshot.lastError;
	}
}

export function createContextDeletionStore(transcript: CompactableTranscript): ContextDeletionMemoryStore {
	return new ContextDeletionMemoryStore(transcript);
}
