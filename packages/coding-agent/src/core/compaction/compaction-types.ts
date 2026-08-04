import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { CompactionSettings } from "./compaction.ts";

export const VERBATIM_COMPACTION_PROMPT_VERSION = 3 as const;
export const VERBATIM_COMPACTION_STRATEGY = "verbatim-lines" as const;

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
	/**
	 * Ranges force-preserved by `<keepContext>` protection; empty when nothing was protected.
	 * Reported so protection that fired unexpectedly — a transcript that quotes tag text, say —
	 * is diagnosable rather than a silent reduction in what compaction reclaimed.
	 */
	keptRanges: LineRange[];
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

/** How much the caller can afford to lose if compaction does not happen. */
export type CompactionUrgency =
	/** Manual /compact, threshold auto-compaction — failing is safe. */
	| "recoverable"
	/** Overflow recovery, post-tool preflight — failing kills the turn. */
	| "load_bearing";

/** How a durable compaction boundary was produced. */
export type CompactionRung = "planned" | "extension" | "fresh";

/** Credentials for one planner request. Resolved per model, never shared. */
export interface PlannerAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
}

/**
 * What one planner request may spend.
 *
 * `maxTokens` is declared `undefined`, not `number | undefined`: the type
 * forbids reintroducing the `0.8 * reserveTokens` output cap without changing
 * the type and failing review. pi-ai's `clampMaxTokensToContext` is the only bound.
 */
export interface PlannerBudget {
	readonly maxTokens: undefined;
	readonly reasoning: ThinkingLevel | undefined;
}

/**
 * A planner-only model borrowing. Cannot be confused with a session model switch.
 *
 * It carries no attempted-set key: the effective identity of an attempt is
 * `provider/model:<effective reasoning>`, derived from `model` and
 * `budget.reasoning` by `plannerAttemptKey`. Storing a key resolved from the raw
 * optional suffix would let the same effective request run twice.
 */
export interface BorrowedPlanner {
	readonly model: Model<Api>;
	readonly budget: PlannerBudget;
	readonly auth: PlannerAuth;
}

/** Identity of the model that ranked the deleted lines, when it was borrowed. */
export interface CompactionPlannerModel {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

export interface VerbatimCompactionDetails {
	strategy: typeof VERBATIM_COMPACTION_STRATEGY;
	promptVersion: typeof VERBATIM_COMPACTION_PROMPT_VERSION;
	parameters: VerbatimCompactionParameters;
	stats: VerbatimCompactionStats;
	rung: CompactionRung;
	/** Present only when a borrowed fallback model ranked the lines. */
	plannerModel?: CompactionPlannerModel;
	backupPath?: string;
}

export interface VerbatimCompactionPreparation {
	/** First context-visible tail entry, or null when no pre-boundary message is retained. */
	firstKeptEntryId: string | null;
	region: NumberedRegion;
	regionEntryIds: string[];
	keptTailMessageCount: number;
	tokensBefore: number;
	parameters: VerbatimCompactionParameters;
	settings: CompactionSettings;
}

export interface VerbatimCompactionResult {
	compactedText: string;
	firstKeptEntryId: string | null;
	tokensBefore: number;
	stats: VerbatimCompactionStats;
	parameters: VerbatimCompactionParameters;
	promptVersion: typeof VERBATIM_COMPACTION_PROMPT_VERSION;
	rung: CompactionRung;
	/** Present only when a borrowed fallback model ranked the lines. */
	plannerModel?: CompactionPlannerModel;
	backupPath?: string;
}
