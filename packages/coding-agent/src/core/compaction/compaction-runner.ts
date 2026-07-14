import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { getKeptTailTokenEstimate } from "./compaction-boundary.js";
import { reconstructCompactedTranscript, validateDeletedRanges } from "./deleted-ranges.js";
import { evictLinesDeterministically } from "./deterministic-line-eviction.js";
import { planDeletedLineRanges, RangePlanError } from "./range-planner.js";
import {
	CRITICAL_COMPRESSION_RATIO,
	type CompactedTranscript,
	type VerbatimCompactionParameters,
	type VerbatimCompactionPreparation,
} from "./compaction-types.js";

export interface CompactionLadderOptions {
	acceptanceTokenBudget?: number;
	criticalEvictionTokenBudget?: number;
	streamFn?: StreamFn;
}

export type CompactionRungResult = CompactedTranscript & { rung: "standard" | "critical" | "deterministic" };

function tailTokens(preparation: VerbatimCompactionPreparation): number {
	return getKeptTailTokenEstimate(preparation);
}

function withWholeContextStats(
	result: CompactedTranscript,
	preparation: VerbatimCompactionPreparation,
	rung: CompactionRungResult["rung"],
): CompactionRungResult {
	const tokensAfter = result.stats.tokensAfter + tailTokens(preparation);
	const percentReduction = preparation.tokensBefore === 0
		? 0
		: Math.round((1 - tokensAfter / preparation.tokensBefore) * 1000) / 10;
	return {
		...result,
		rung,
		stats: { ...result.stats, tokensBefore: preparation.tokensBefore, tokensAfter, percentReduction },
	};
}

function accepted(result: CompactionRungResult, budget: number | undefined): boolean {
	return result.stats.linesDeleted > 0 && (budget === undefined || result.stats.tokensAfter <= budget);
}

async function runPlannedRung(
	preparation: VerbatimCompactionPreparation,
	parameters: VerbatimCompactionParameters,
	model: Model<Api>,
	apiKey: string,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	promptSuffix: string,
	streamFn: StreamFn | undefined,
	rung: "standard" | "critical",
): Promise<CompactionRungResult> {
	const raw = await planDeletedLineRanges(
		preparation.region,
		parameters,
		model,
		{ apiKey, headers },
		signal,
		thinkingLevel,
		promptSuffix,
		{ streamFn },
	);
	return withWholeContextStats(
		reconstructCompactedTranscript(preparation.region, validateDeletedRanges(raw, preparation.region)),
		preparation,
		rung,
	);
}

function criticalPrompt(preparation: VerbatimCompactionPreparation, parameters: VerbatimCompactionParameters): string {
	const requiredLines = Math.ceil((1 - parameters.compression_ratio) * preparation.region.lines.length);
	return `\n<critical-overflow-mode>\nThe previous model request overflowed the context window. Delete at least ${requiredLines} lines. Keep only: the user's objective, unresolved errors, final decisions, and identifying file paths. Everything else is expendable.\n</critical-overflow-mode>`;
}

/** Execute standard, critical, then deterministic string compaction as applicable. */
export async function runVerbatimCompaction(
	preparation: VerbatimCompactionPreparation,
	model: Model<Api>,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	ladder?: CompactionLadderOptions,
): Promise<CompactionRungResult> {
	const attempts: string[] = [];
	let providerOverflow = false;
	if (signal?.aborted) throw new Error("Compaction cancelled");
	try {
		const standard = await runPlannedRung(
			preparation,
			preparation.parameters,
			model,
			apiKey,
			headers,
			signal,
			thinkingLevel,
			"",
			ladder?.streamFn,
			"standard",
		);
		if (accepted(standard, ladder?.acceptanceTokenBudget)) return standard;
		attempts.push(`standard achieved tokensAfter=${standard.stats.tokensAfter}`);
	} catch (error) {
		if (signal?.aborted || (error instanceof Error && error.message === "Compaction cancelled")) throw new Error("Compaction cancelled");
		providerOverflow = error instanceof RangePlanError && error.providerOverflow;
		attempts.push(`standard failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	const deterministicBudget = ladder?.criticalEvictionTokenBudget;
	if (deterministicBudget !== undefined && !providerOverflow) {
		if (signal?.aborted) throw new Error("Compaction cancelled");
		const criticalParameters = {
			...preparation.parameters,
			compression_ratio: Math.min(preparation.parameters.compression_ratio, CRITICAL_COMPRESSION_RATIO),
		};
		try {
			const critical = await runPlannedRung(
				preparation,
				criticalParameters,
				model,
				apiKey,
				headers,
				signal,
				thinkingLevel,
				criticalPrompt(preparation, criticalParameters),
				ladder?.streamFn,
				"critical",
			);
			if (accepted(critical, deterministicBudget)) return critical;
			attempts.push(`critical achieved tokensAfter=${critical.stats.tokensAfter}`);
		} catch (error) {
			if (signal?.aborted || (error instanceof Error && error.message === "Compaction cancelled")) throw new Error("Compaction cancelled");
			attempts.push(`critical failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (deterministicBudget !== undefined) {
		if (signal?.aborted) throw new Error("Compaction cancelled");
		const stringBudget = deterministicBudget - tailTokens(preparation);
		return withWholeContextStats(
			evictLinesDeterministically(preparation.region, stringBudget),
			preparation,
			"deterministic",
		);
	}

	throw new Error(`Compaction failed: ${attempts.join("; ")}`);
}
