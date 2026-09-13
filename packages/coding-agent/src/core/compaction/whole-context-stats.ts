import type { VerbatimCompactionStats } from "./compaction-types.js";

function computePercentReduction(tokensBefore: number, tokensAfter: number): number {
	return tokensBefore === 0 ? 0 : Math.round((1 - tokensAfter / tokensBefore) * 1000) / 10;
}

/**
 * Widen symmetric region-level compaction stats into whole-context stats using
 * the independently estimated kept tail.
 *
 * Both before and after counts are deliberately heuristic and symmetric: the
 * tail estimate is added to the heuristic region `tokensBefore` and — only when
 * the tail is kept — to the heuristic region `tokensAfter`. `percentReduction`
 * is recomputed from these two widened counts. The authoritative provider-aware
 * `preparation.tokensBefore` is *never* mixed into this comparison; it travels
 * separately (`VerbatimCompactionResult.tokensBefore` / `CompactionEntry.tokensBefore`)
 * for budgeting and display only.
 *
 * A dropped tail contributes to the heuristic before count but not the after
 * count, which is what makes fresh-compaction stats honest about the content
 * actually being dropped.
 *
 * Shared by the planned, fresh, and extension compaction rungs (#2052).
 */
export function widenToWholeContextStats(
	regionStats: VerbatimCompactionStats,
	keptTailEstimate: number,
	keptTail: boolean,
): VerbatimCompactionStats {
	const tokensBefore = regionStats.tokensBefore + keptTailEstimate;
	const tokensAfter = regionStats.tokensAfter + (keptTail ? keptTailEstimate : 0);
	return {
		...regionStats,
		tokensBefore,
		tokensAfter,
		percentReduction: computePercentReduction(tokensBefore, tokensAfter),
	};
}