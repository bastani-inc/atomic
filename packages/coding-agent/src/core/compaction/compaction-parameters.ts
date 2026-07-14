import {
	DEFAULT_COMPRESSION_RATIO,
	DEFAULT_PRESERVE_RECENT,
	type VerbatimCompactionParameters,
} from "./compaction-types.js";

export const COMPACTION_AUTO_QUERY = "the latest user request";
const QUERY_MAX_CHARS = 1000;

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

export function normalizeCompactionQuery(value: string | undefined, fallback: string): string {
	const query = value?.trim() || fallback.trim() || COMPACTION_AUTO_QUERY;
	if (query.length <= QUERY_MAX_CHARS) return query;
	return `${query.slice(0, QUERY_MAX_CHARS)}\n[... ${query.length - QUERY_MAX_CHARS} more characters omitted from compaction query]`;
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
