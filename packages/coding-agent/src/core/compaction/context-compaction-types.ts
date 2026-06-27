import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextCompactionStats, ContextDeletionTarget, SessionEntry } from "../session-manager.ts";
import type { CompactionSettings } from "./compaction.ts";

export const CONTEXT_COMPACTION_PROMPT_VERSION = 1 as const;

export interface ContextCompactionParameters {
	/** Fraction of compactable context to keep. 0.3 is aggressive, 0.7 is light. */
	compression_ratio: number;
	/** Number of recent context-eligible messages to preserve. */
	preserve_recent: number;
	/** Focus query for relevance-based pruning. */
	query: string;
}

export interface ContextDeletionRequest {
	deletions: Array<{
		kind: "entry" | "content_block";
		entryId: string;
		blockIndex?: number;
	}>;
}

export interface CompactableContentBlock {
	entryId: string;
	blockIndex: number;
	type: string;
	text: string;
	tokenEstimate: number;
	protected: boolean;
	toolCallId?: string;
}

export interface CompactableTranscriptEntry {
	entryId: string;
	entryType: SessionEntry["type"];
	role: AgentMessage["role"];
	text: string;
	tokenEstimate: number;
	protected: boolean;
	contentBlocks: CompactableContentBlock[];
	message: AgentMessage;
	toolCallIds: string[];
	toolResultFor?: string;
}

export interface CompactableTranscript {
	entries: CompactableTranscriptEntry[];
	protectedEntryIds: string[];
	tokensBefore: number;
	settings: CompactionSettings;
	parameters?: ContextCompactionParameters;
}

export interface ContextCompactionPreparation {
	transcript: CompactableTranscript;
	branchEntries: SessionEntry[];
	parameters: ContextCompactionParameters;
}

export interface ValidatedContextDeletionResult {
	deletedTargets: ContextDeletionTarget[];
	protectedEntryIds: string[];
	stats: ContextCompactionStats;
	/**
	 * Which strategy satisfied liveness. Absent for legacy/extension-provided results
	 * that did not pass through the graduated-protection ladder.
	 */
	fitStrategy?: "meet_target" | "best_effort" | "evict_protected";
	/** Entry ids force-evicted by the `evict_protected` strategy (oldest-first). */
	evictedProtectedEntryIds?: string[];
	/** Mirrors `stats.percentReduction` for reason-reading callers. */
	achievedReductionPercent?: number;
}

export interface ContextCompactionResult extends ValidatedContextDeletionResult {
	promptVersion: typeof CONTEXT_COMPACTION_PROMPT_VERSION;
	parameters: ContextCompactionParameters;
	backupPath?: string;
}

export interface ContextCompactionRunOptions {
	contextWindow?: number;
	compression_ratio?: number;
	preserve_recent?: number;
	query?: string;
}

export const CONTEXT_COMPACTION_DEFAULT_COMPRESSION_RATIO = 0.5 as const;
export const CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT = 50 as const;
export const CONTEXT_COMPACTION_DEFAULT_PRESERVE_RECENT = 2 as const;
export const CONTEXT_COMPACTION_AUTO_QUERY = "auto-detected" as const;
