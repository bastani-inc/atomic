import {
	CONTEXT_COMPACTION_AUTO_QUERY,
	CONTEXT_COMPACTION_DEFAULT_COMPRESSION_RATIO,
	CONTEXT_COMPACTION_DEFAULT_PRESERVE_RECENT,
	type CompactableTranscript,
	type ContextCompactionParameters,
} from "./context-compaction-types.ts";

const CONTEXT_COMPACTION_QUERY_MAX_CHARS = 1000;

function normalizeCompressionRatio(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1
		? value
		: CONTEXT_COMPACTION_DEFAULT_COMPRESSION_RATIO;
}

function normalizePreserveRecent(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : CONTEXT_COMPACTION_DEFAULT_PRESERVE_RECENT;
}

export function normalizeContextCompactionQuery(value: string | undefined, fallbackQuery: string): string {
	const query = value?.trim() || fallbackQuery.trim() || CONTEXT_COMPACTION_AUTO_QUERY;
	return query.length > CONTEXT_COMPACTION_QUERY_MAX_CHARS
		? `${query.slice(0, CONTEXT_COMPACTION_QUERY_MAX_CHARS)}\n[... ${query.length - CONTEXT_COMPACTION_QUERY_MAX_CHARS} more characters omitted from compaction query]`
		: query;
}

export function normalizeContextCompactionParameters(
	input: Partial<ContextCompactionParameters> = {},
	fallbackQuery: string = CONTEXT_COMPACTION_AUTO_QUERY,
): ContextCompactionParameters {
	return {
		compression_ratio: normalizeCompressionRatio(input.compression_ratio),
		preserve_recent: normalizePreserveRecent(input.preserve_recent),
		query: normalizeContextCompactionQuery(input.query, fallbackQuery),
	};
}

export function getTranscriptCompactionParameters(transcript: CompactableTranscript): ContextCompactionParameters {
	return normalizeContextCompactionParameters(
		transcript.parameters ?? transcript.settings,
		transcript.parameters?.query ?? transcript.settings.query ?? CONTEXT_COMPACTION_AUTO_QUERY,
	);
}
