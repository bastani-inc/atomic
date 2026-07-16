import type { CompactionSettings } from "./compaction.js";

export const VERBATIM_COMPACTION_PROMPT_VERSION = 4 as const;
export const VERBATIM_COMPACTION_STRATEGY = "verbatim-lines" as const;
/**
 * Discriminates the additive v2 "full-collapse" persisted format. Present only on
 * boundaries written by the full-context collapse path; absent on legacy hybrid
 * (`firstKeptEntryId` kept-tail) boundaries.
 */
export const VERBATIM_COMPACTION_FORMAT_FULL = "full-collapse" as const;

export const DEFAULT_COMPRESSION_RATIO = 0.5;
export const DEFAULT_PRESERVE_RECENT = 2;
export const MIN_COMPACTABLE_REGION_LINES = 20;

export interface VerbatimCompactionParameters {
	/** Fraction of compactable region lines to keep. */
	compression_ratio: number;
	/** Recent context-eligible messages retained outside the compactable region. */
	preserve_recent: number;
	/** Relevance focus used by the range planner. */
	query: string;
}

export interface LineRange {
	/** One-based inclusive first line. */
	start: number;
	/** One-based inclusive last line. */
	end: number;
}

export type RawLineEndpoint = number | string | boolean | null;

export interface RawLineRange {
	start?: RawLineEndpoint;
	end?: RawLineEndpoint;
}

export interface NumberedRegion {
	readonly __brand: "NumberedRegion";
	lines: string[];
	headerLineNumbers: ReadonlySet<number>;
	priorMarkerNs: ReadonlyMap<number, number>;
	/** Optional future protected spans, expressed as one-based line numbers. */
	protectedLineNumbers?: ReadonlySet<number>;
	tokenEstimate: number;
}

export type ValidatedRanges = readonly LineRange[] & { readonly __brand: "ValidatedRanges" };

export interface CompactedTranscript {
	text: string;
	ranges: LineRange[];
	stats: VerbatimCompactionStats;
}

export interface VerbatimCompactionStats {
	linesBefore: number;
	linesDeleted: number;
	linesKept: number;
	rangeCount: number;
	tokensBefore: number;
	tokensAfter: number;
	percentReduction: number;
}

export interface VerbatimCompactionDetails {
	strategy: typeof VERBATIM_COMPACTION_STRATEGY;
	/** 3 = legacy hybrid, 4 = full-collapse. Relaxed to `number` so both coexist. */
	promptVersion: number;
	/** Present only on v2 full-collapse boundaries; absent => legacy hybrid. */
	format?: typeof VERBATIM_COMPACTION_FORMAT_FULL;
	parameters: VerbatimCompactionParameters;
	stats: VerbatimCompactionStats;
	rung: "planned" | "extension";
	backupPath?: string;
}

export interface VerbatimCompactionPreparation {
	firstKeptEntryId: string;
	region: NumberedRegion;
	regionEntryIds: string[];
	keptTailMessageCount: number;
	tokensBefore: number;
	parameters: VerbatimCompactionParameters;
	settings: CompactionSettings;
}

/**
 * Preparation for a v2 full-collapse boundary. Structurally a
 * `VerbatimCompactionPreparation` (so the `session_before_compact` extension
 * surface is unchanged) with the collapse discriminator and the count of
 * mandatory verbatim trailing messages. `keptTailMessageCount` is always 0 and
 * `firstKeptEntryId` is a self-anchor (the boundary's parent leaf), ignored on
 * reconstruction.
 */
export interface FullCollapsePreparation extends VerbatimCompactionPreparation {
	format: typeof VERBATIM_COMPACTION_FORMAT_FULL;
	protectedMessageCount: number;
}

export interface VerbatimCompactionResult {
	compactedText: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	stats: VerbatimCompactionStats;
	parameters: VerbatimCompactionParameters;
	promptVersion: number;
	/** Present only on v2 full-collapse results; absent => legacy hybrid. */
	format?: typeof VERBATIM_COMPACTION_FORMAT_FULL;
	rung: VerbatimCompactionDetails["rung"];
	backupPath?: string;
}
