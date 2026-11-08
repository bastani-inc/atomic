/** Recovery from a policy refusal that arrives partway through the planner's output (#4543). */

import type { LineRange, RawLineRange, VerbatimCompactionPreparation } from "./compaction-types.js";
import { validateDeletedRanges } from "./deleted-ranges.js";
import type { TerminalPlannerOutcome } from "./planner-outcome.js";
import { keepTargetForView, type RegionPart, splitRegionAtMessageBoundary } from "./region-trimming.js";

/** One planner model's attempt at a region: validated ranges, or the outcome that ended it. */
export type PlannerAttempt =
	| { kind: "planned"; ranges: RawLineRange[] }
	| { kind: "terminal"; outcome: TerminalPlannerOutcome };

/** Plan the region of `preparation` with one planner model. */
export type PlanRegion = (preparation: VerbatimCompactionPreparation) => Promise<PlannerAttempt>;

/** How many times the region may be split: depth 1 plans halves, depth 2 quarters, and a refused quarter ends the strategy. */
export const MAX_REFUSAL_SPLIT_DEPTH = 2;

type PolicyRefusalAttempt = {
	kind: "terminal";
	outcome: Extract<TerminalPlannerOutcome, { kind: "policyRefusal" }>;
};

function isPolicyRefusal(attempt: PlannerAttempt): attempt is PolicyRefusalAttempt {
	return attempt.kind === "terminal" && attempt.outcome.kind === "policyRefusal";
}

function isMidstreamRefusal(attempt: PlannerAttempt): boolean {
	return isPolicyRefusal(attempt) && attempt.outcome.phase === "midstream";
}

function hasDeletableLines(preparation: VerbatimCompactionPreparation): boolean {
	const view = preparation.region;
	return view.lines.length > keepTargetForView(view, preparation.parameters.compression_ratio);
}

function shiftToWholeRegion(ranges: readonly LineRange[], part: RegionPart): LineRange[] {
	const offset = part.firstLine - 1;
	return ranges.map((range) => ({ start: range.start + offset, end: range.end + offset }));
}

async function planPart(
	preparation: VerbatimCompactionPreparation,
	planRegion: PlanRegion,
	depth: number,
): Promise<readonly LineRange[] | undefined> {
	if (!hasDeletableLines(preparation)) return [];
	const attempt = await planRegion(preparation);
	if (attempt.kind === "planned") return validateDeletedRanges(attempt.ranges, preparation.region);
	if (!isPolicyRefusal(attempt) || depth >= MAX_REFUSAL_SPLIT_DEPTH) return undefined;
	return planInParts(preparation, planRegion, depth + 1);
}

async function planInParts(
	preparation: VerbatimCompactionPreparation,
	planRegion: PlanRegion,
	depth: number,
): Promise<LineRange[] | undefined> {
	const parts = splitRegionAtMessageBoundary(preparation.region);
	if (!parts) return undefined;
	const merged: LineRange[] = [];
	for (const part of parts) {
		const ranges = await planPart({ ...preparation, region: part.region }, planRegion, depth);
		if (!ranges) return undefined;
		merged.push(...shiftToWholeRegion(ranges, part));
	}
	return merged;
}

/**
 * Plan `preparation.region`, recovering from a mid-stream policy refusal.
 *
 * Any other outcome, including an immediate input refusal, is returned as it is. A mid-stream
 * refusal is retried once. A retry that plans the region is returned; a retry that fails without
 * a refusal returns the original refusal, so the caller still falls back to a summary; a retry
 * that is refused again plans the region in parts. When the parts cannot be planned, or every part
 * is skipped, the retry's refusal is returned for the same fallback. Cancellation and the planning
 * time limit surface as a throw from `planRegion`.
 */
export async function planWithRefusalRecovery(
	preparation: VerbatimCompactionPreparation,
	planRegion: PlanRegion,
): Promise<PlannerAttempt> {
	const first = await planRegion(preparation);
	if (!isMidstreamRefusal(first)) return first;
	const retried = await planRegion(preparation);
	if (retried.kind === "planned") return retried;
	if (!isPolicyRefusal(retried)) return first;
	const merged = await planInParts(preparation, planRegion, 1);
	return merged && merged.length > 0 ? { kind: "planned", ranges: merged } : retried;
}
