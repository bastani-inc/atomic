import {
	DEFAULT_COMPRESSION_RATIO,
	DEFAULT_PRESERVE_RECENT,
	type VerbatimCompactionParameters,
} from "./compaction-types.js";

export const COMPACTION_AUTO_QUERY = "the latest user request";

function normalizeCompressionRatio(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1
		? value
		: DEFAULT_COMPRESSION_RATIO;
}

function normalizePreserveRecent(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: DEFAULT_PRESERVE_RECENT;
}

/**
 * The query is the planner's relevance focus, so it is kept whole. Truncating it made prompt
 * order the retention policy: for a long structured prompt only the leading section survived,
 * and any constraint stated later could not influence what the planner kept.
 */
export function normalizeCompactionQuery(value: string | undefined, fallback: string): string {
	return value?.trim() || fallback.trim() || COMPACTION_AUTO_QUERY;
}

export function normalizeCompactionParameters(
	input: Partial<VerbatimCompactionParameters> = {},
	fallbackQuery = COMPACTION_AUTO_QUERY,
): VerbatimCompactionParameters {
	return {
		compression_ratio: normalizeCompressionRatio(input.compression_ratio),
		preserve_recent: normalizePreserveRecent(input.preserve_recent),
		query: normalizeCompactionQuery(input.query, fallbackQuery),
	};
}
