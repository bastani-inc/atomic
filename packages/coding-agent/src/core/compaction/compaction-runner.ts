import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { planFullCollapse } from "./collapse-planner.js";
import { getKeptTailTokenEstimate } from "./compaction-boundary.js";
import { reconstructCompactedTranscript, validateDeletedRanges } from "./deleted-ranges.js";
import { planDeletedLineRanges } from "./range-planner.js";
import type {
	CompactedTranscript,
	CompactionCacheTelemetry,
	CompactionRequestPrefix,
	FullCollapsePreparation,
	VerbatimCompactionPreparation,
} from "./compaction-types.js";

export interface CompactionPlanOptions {
	streamFn: StreamFn;
	/** Absolute path of the persisted session file. Undefined for in-memory sessions. */
	sessionFilePath?: string;
	/** Active-request prefix to reuse for cache-read on the full-collapse path. */
	prefix?: CompactionRequestPrefix;
}

export type CompactionRungResult = CompactedTranscript & { rung: "planned"; cache?: CompactionCacheTelemetry };

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
	headers: Record<string, string> | undefined,
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
		{ streamFn: options.streamFn, sessionFilePath: options.sessionFilePath },
	);
	if (signal?.aborted) throw new Error("Compaction cancelled");
	return withWholeContextStats(
		reconstructCompactedTranscript(preparation.region, validateDeletedRanges(raw, preparation.region)),
		preparation,
	);
}

/** Re-base a full-collapse transcript's stats onto the whole prior context (no kept tail). */
function withFullCollapseStats(
	result: CompactedTranscript,
	preparation: FullCollapsePreparation,
	cache: CompactionCacheTelemetry | undefined,
): CompactionRungResult {
	const tokensAfter = result.stats.tokensAfter;
	const percentReduction = preparation.tokensBefore === 0
		? 0
		: Math.round((1 - tokensAfter / preparation.tokensBefore) * 1000) / 10;
	return {
		...result,
		rung: "planned",
		stats: { ...result.stats, tokensBefore: preparation.tokensBefore, tokensAfter, percentReduction },
		...(cache ? { cache } : {}),
	};
}

/**
 * Execute one whole-context v2 collapse: the model returns a compacted string
 * that the host validates as an ordered byte-identical subsequence, then rebuilds
 * mechanically with canonical elision markers. When `options.prefix` is set the
 * request reuses the cached active prefix and cache telemetry is attached.
 */
export async function runFullCollapseCompaction(
	preparation: FullCollapsePreparation,
	model: Model<Api>,
	apiKey: string,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	options: CompactionPlanOptions,
): Promise<CompactionRungResult> {
	if (signal?.aborted) throw new Error("Compaction cancelled");
	const plan = await planFullCollapse(
		preparation.region,
		preparation.parameters,
		model,
		{ apiKey, headers },
		signal,
		thinkingLevel,
		preparation.settings.reserveTokens,
		targetKeepLines(preparation),
		{ streamFn: options.streamFn, sessionFilePath: options.sessionFilePath, prefix: options.prefix },
	);
	if (signal?.aborted) throw new Error("Compaction cancelled");
	return withFullCollapseStats(
		reconstructCompactedTranscript(preparation.region, plan.ranges),
		preparation,
		plan.telemetry,
	);
}
