import type { CompactionSettings } from "./compaction.js";

export const VERBATIM_COMPACTION_PROMPT_VERSION = 2 as const;
export const VERBATIM_COMPACTION_STRATEGY = "verbatim-lines" as const;

export const DEFAULT_COMPRESSION_RATIO = 0.5;
export const DEFAULT_PRESERVE_RECENT = 2;
export const CRITICAL_COMPRESSION_RATIO = 0.2;
export const RATIO_DRIFT_TOLERANCE = 0.15;
export const MAX_RANGE_PLAN_ATTEMPTS = 3;
export const MIN_COMPACTABLE_REGION_LINES = 20;
export const CHUNK_TOKEN_MARGIN = 4096;

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
	promptVersion: typeof VERBATIM_COMPACTION_PROMPT_VERSION;
	parameters: VerbatimCompactionParameters;
	stats: VerbatimCompactionStats;
	rung: "standard" | "critical" | "deterministic" | "extension";
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

export interface VerbatimCompactionResult {
	compactedText: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	stats: VerbatimCompactionStats;
	parameters: VerbatimCompactionParameters;
	promptVersion: typeof VERBATIM_COMPACTION_PROMPT_VERSION;
	rung: VerbatimCompactionDetails["rung"];
	backupPath?: string;
}
