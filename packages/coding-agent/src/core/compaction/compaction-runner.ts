import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ProviderHeaders, RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getKeptTailTokenEstimate } from "./compaction-boundary.js";
import { reconstructCompactedTranscript, validateDeletedRanges } from "./deleted-ranges.js";
import { planDeletedLineRanges } from "./range-planner.js";
import type { CompactedTranscript, VerbatimCompactionPreparation } from "./compaction-types.js";

export interface CompactionPlanOptions {
	streamFn: StreamFn;
	/** Absolute path of the persisted session file. Undefined for in-memory sessions. */
	sessionFilePath?: string;
	retry?: RetryPolicy;
	callbacks?: RetryCallbacks;
}

export type CompactionRungResult = CompactedTranscript & { rung: "planned" };

/** Calculate the single global line threshold directly from the prepared setting. */
export function targetKeepLines(preparation: VerbatimCompactionPreparation): number {
	const protectedLines = preparation.region.protectedLineNumbers?.size ?? 0;
	return Math.max(
		protectedLines,
		Math.round(preparation.region.lines.length * preparation.parameters.compression_ratio),
	);
}

function withWholeContextStats(
	result: CompactedTranscript,
	preparation: VerbatimCompactionPreparation,
): CompactionRungResult {
	const tokensAfter = result.stats.tokensAfter + getKeptTailTokenEstimate(preparation);
	const percentReduction = preparation.tokensBefore === 0
		? 0
		: Math.round((1 - tokensAfter / preparation.tokensBefore) * 1000) / 10;
	return {
		...result,
		rung: "planned",
		stats: { ...result.stats, tokensBefore: preparation.tokensBefore, tokensAfter, percentReduction },
	};
}

/** Execute one whole-region model plan and mechanically accept its safe deletions. */
export async function runVerbatimCompaction(
	preparation: VerbatimCompactionPreparation,
	model: Model<Api>,
	apiKey: string,
	headers: ProviderHeaders | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	options: CompactionPlanOptions,
): Promise<CompactionRungResult> {
	if (signal?.aborted) throw new Error("Compaction cancelled");
	const raw = await planDeletedLineRanges(
		preparation.region,
		preparation.parameters,
		model,
		{ apiKey, headers },
		signal,
		thinkingLevel,
		preparation.settings.reserveTokens,
		targetKeepLines(preparation),
		{
			streamFn: options.streamFn,
			sessionFilePath: options.sessionFilePath,
			retry: options.retry,
			callbacks: options.callbacks,
		},
	);
	if (signal?.aborted) throw new Error("Compaction cancelled");
	return withWholeContextStats(
		reconstructCompactedTranscript(preparation.region, validateDeletedRanges(raw, preparation.region)),
		preparation,
	);
}
