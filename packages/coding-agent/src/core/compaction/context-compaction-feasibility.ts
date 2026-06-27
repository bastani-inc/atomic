/**
 * Feasibility-aware graduated protection for Verbatim Compaction.
 *
 * `computeCompactionFeasibility` is a read-only oracle: it reports the maximal
 * achievable verbatim reduction under current protection and whether that
 * reduction fits the model's liveness budget, without mutating anything. It
 * reuses `validateContextDeletionRequest` so the oracle and the deletion planner
 * agree on what is actually deletable.
 *
 * `buildEvictionTargets` deterministically expands a planner deletion set with
 * oldest-first forced evictions of protected task-bearing entries
 * (`user`/`custom`/`branchSummary`) until the projected result fits the budget.
 * Eviction never enters the `preserve_recent` window and never evicts the most
 * recent task-bearing entry; the validator's ≥1-task-bearing guard is the final
 * backstop.
 *
 * See `specs/2026-06-27-context-compaction-graduated-protection.md`.
 */

import type { ContextDeletionTarget } from "../session-manager.ts";
import type {
	CompactableTranscript,
	CompactableTranscriptEntry,
	ContextCompactionParameters,
	ContextDeletionRequest,
} from "./context-compaction-types.ts";
import { computeContextCompactionStats, validateContextDeletionRequest } from "./context-deletion-application.ts";
import {
	canDeleteTarget,
	getRecentContextEntryIds,
	isRecentContextEntry,
	isTaskBearingEntry,
} from "./context-deletion-targets.ts";
import {
	contextCompactionTargetReductionPercent,
	roundPercent,
} from "./context-compaction-metrics.ts";

/**
 * Which strategy `contextCompact` used to make the transcript fit the budget.
 *
 * - `meet_target`     — the planner met the quality target under full protection.
 * - `best_effort`     — the quality target was provably infeasible, but the
 *   result fits the liveness budget, so the most feasible reduction is accepted.
 * - `evict_protected` — protected mass overflowed the budget, so oldest-first
 *   protected task-bearing entries were force-evicted to fit.
 */
export type CompactionFitStrategy = "meet_target" | "best_effort" | "evict_protected";

/** Liveness budget: `getEffectiveInputBudget(model) - reserveTokens`, clamped to > 0. */
export interface LivenessBudget {
	/** Token budget the post-compaction transcript must fit inside. */
	tokens: number;
	/** Effective input budget used to derive `tokens`. */
	effectiveInputBudget: number;
	/** Reserve tokens subtracted from the effective input budget. */
	reserveTokens: number;
}

/** Read-only feasibility report produced by `computeCompactionFeasibility`. */
export interface CompactionFeasibility {
	tokensBefore: number;
	maxDeletableTokens: number;
	achievableTokensAfter: number;
	achievableReductionPercent: number;
	qualityTargetPercent: number;
	targetFeasible: boolean;
	fitsBudgetAtMaxDeletion: boolean;
	protectedFloorTokens: number;
	recommendedStrategy: CompactionFitStrategy;
}

/**
 * Compute the liveness budget = `effectiveInputBudget - reserveTokens`.
 *
 * The result is clamped to at least 1 so a misconfigured/zero budget does not
 * produce a non-positive budget that would make every compaction overflow.
 */
export function computeLivenessBudget(effectiveInputBudget: number, reserveTokens: number): LivenessBudget {
	const tokens = Math.max(1, Math.floor(effectiveInputBudget - Math.max(0, reserveTokens)));
	return { tokens, effectiveInputBudget, reserveTokens };
}

/**
 * Build the maximal deletable request from the transcript: every entry and every
 * content block for which `canDeleteTarget(transcript, target)` is true under
 * normal (non-eviction) protection.
 */
export function buildMaximalDeletableRequest(transcript: CompactableTranscript): ContextDeletionRequest {
	const deletions: ContextDeletionRequest["deletions"] = [];
	for (const entry of transcript.entries) {
		if (canDeleteTarget(transcript, { kind: "entry", entryId: entry.entryId })) {
			deletions.push({ kind: "entry", entryId: entry.entryId });
			continue;
		}
		for (const block of entry.contentBlocks) {
			const target: ContextDeletionTarget = { kind: "content_block", entryId: entry.entryId, blockIndex: block.blockIndex };
			if (canDeleteTarget(transcript, target)) {
				deletions.push({ kind: "content_block", entryId: entry.entryId, blockIndex: block.blockIndex });
			}
		}
	}
	return { deletions };
}

/**
 * Read-only oracle: report the maximal achievable verbatim reduction under
 * current protection, whether it meets the quality target, and whether the
 * resulting transcript fits the liveness budget.
 *
 * Never mutates the transcript. Never throws on a well-formed transcript: if the
 * maximal deletable set fails validation as a whole (for example because of a
 * tool-pairing invariant or the ≥1-task-bearing guard), the oracle performs a
 * deterministic validator-backed feasible subset search and reports the largest
 * feasible reduction it can find instead of collapsing to zero.
 */
export function computeCompactionFeasibility(
	transcript: CompactableTranscript,
	parameters: ContextCompactionParameters,
	budget: LivenessBudget,
): CompactionFeasibility {
	const tokensBefore = transcript.tokensBefore;
	const qualityTargetPercent = contextCompactionTargetReductionPercent(parameters);

	const maximalRequest = buildMaximalDeletableRequest(transcript);
	const achievableTokensAfter = computeMaxFeasibleTokensAfter(transcript, maximalRequest);

	const deletedTokensAtMax = Math.max(0, tokensBefore - achievableTokensAfter);
	const achievableReductionPercent = tokensBefore > 0 ? roundPercent((deletedTokensAtMax / tokensBefore) * 100) : 0;
	const targetFeasible = achievableReductionPercent >= qualityTargetPercent;
	const fitsBudgetAtMaxDeletion = achievableTokensAfter <= budget.tokens;
	const protectedFloorTokens = Math.max(0, tokensBefore - deletedTokensAtMax);

	const recommendedStrategy: CompactionFitStrategy = targetFeasible
		? "meet_target"
		: fitsBudgetAtMaxDeletion
			? "best_effort"
			: "evict_protected";

	return {
		tokensBefore,
		maxDeletableTokens: deletedTokensAtMax,
		achievableTokensAfter,
		achievableReductionPercent,
		qualityTargetPercent,
		targetFeasible,
		fitsBudgetAtMaxDeletion,
		protectedFloorTokens,
		recommendedStrategy,
	};
}

/**
 * Deterministically find the maximal feasible deletion set under the validator
 * invariants and return its projected `tokensAfter`. Try the full maximal set
 * first; if it fails validation as a whole (for example because of a
 * tool-pairing invariant or the ≥1-task-bearing guard), greedily add deletions
 * oldest-first, revalidating the cumulative set each time and skipping any
 * target that would make the set invalid. Reuses `validateContextDeletionRequest`
 * as the single source of truth so the oracle and the planner agree on what is
 * deletable. Conservative: the result is a feasible subset, not necessarily the
 * globally maximal one.
 *
 * Never throws on a well-formed transcript.
 */
function computeMaxFeasibleDeletions(
	transcript: CompactableTranscript,
	maximalRequest: ContextDeletionRequest,
): { deletions: ContextDeletionRequest["deletions"]; tokensAfter: number } {
	if (maximalRequest.deletions.length === 0) {
		return { deletions: [], tokensAfter: transcript.tokensBefore };
	}
	// Try the full maximal set first.
	try {
		const result = validateContextDeletionRequest(maximalRequest, transcript);
		return { deletions: [...maximalRequest.deletions], tokensAfter: result.stats.tokensAfter };
	} catch {
		// Fall through to the greedy subset search.
	}
	// Greedy incremental subset search: add deletions oldest-first, revalidating
	// the cumulative set each time. Deterministic and conservative.
	const ordered = orderDeletionsOldestFirst(transcript, maximalRequest.deletions);
	const accepted: ContextDeletionRequest["deletions"] = [];
	for (const deletion of ordered) {
		const candidate = [...accepted, deletion];
		try {
			validateContextDeletionRequest({ deletions: candidate }, transcript);
			accepted.push(deletion);
		} catch {
			// Skip this target; it makes the cumulative set invalid.
		}
	}
	if (accepted.length === 0) {
		return { deletions: [], tokensAfter: transcript.tokensBefore };
	}
	try {
		const result = validateContextDeletionRequest({ deletions: accepted }, transcript);
		return { deletions: accepted, tokensAfter: result.stats.tokensAfter };
	} catch {
		return { deletions: [], tokensAfter: transcript.tokensBefore };
	}
}

/**
 * Return the tokensAfter for the maximal feasible deletion set. Thin wrapper
 * over {@link computeMaxFeasibleDeletions} for callers that only need the
 * projected token count.
 */
function computeMaxFeasibleTokensAfter(
	transcript: CompactableTranscript,
	maximalRequest: ContextDeletionRequest,
): number {
	return computeMaxFeasibleDeletions(transcript, maximalRequest).tokensAfter;
}

/**
 * Build the maximal feasible unprotected deletion request under the validator
 * invariants: the full `buildMaximalDeletableRequest` set if it validates as a
 * whole, otherwise the greedy oldest-first feasible subset. Returns the raw
 * deletion request (possibly empty) ready for `validateContextDeletionRequest`.
 *
 * Used by the runner as a deterministic `best_effort` candidate when the
 * planner's own result is over budget but a more aggressive unprotected
 * deletion set would fit (target-met-over-budget). See
 * `specs/2026-06-27-context-compaction-graduated-protection.md` §5.1.
 *
 * Never throws on a well-formed transcript.
 */
export function buildMaxFeasibleDeletionRequest(transcript: CompactableTranscript): ContextDeletionRequest {
	const maximalRequest = buildMaximalDeletableRequest(transcript);
	return { deletions: computeMaxFeasibleDeletions(transcript, maximalRequest).deletions };
}

/**
 * Order deletions oldest-first by transcript position, with entry deletions
 * before content-block deletions of the same entry (then by blockIndex).
 * Deterministic ordering for the greedy subset search.
 */
function orderDeletionsOldestFirst(
	transcript: CompactableTranscript,
	deletions: ContextDeletionRequest["deletions"],
): ContextDeletionRequest["deletions"] {
	const position = new Map(transcript.entries.map((entry, index) => [entry.entryId, index]));
	return [...deletions].sort((a, b) => {
		const pa = position.get(a.entryId) ?? Number.MAX_SAFE_INTEGER;
		const pb = position.get(b.entryId) ?? Number.MAX_SAFE_INTEGER;
		if (pa !== pb) return pa - pb;
		const ta = a.kind === "entry" ? 0 : 1;
		const tb = b.kind === "entry" ? 0 : 1;
		if (ta !== tb) return ta - tb;
		return (a.blockIndex ?? 0) - (b.blockIndex ?? 0);
	});
}

/**
 * Identify eviction candidates: protected task-bearing entries
 * (`user`/`custom`/`branchSummary`) that are NOT in the `preserve_recent` window
 * and are NOT the most-recent task-bearing entry. Returned oldest-first.
 */
export function findEvictionCandidates(transcript: CompactableTranscript): CompactableTranscriptEntry[] {
	const recentEntryIds = getRecentContextEntryIds(transcript);
	const taskBearing = transcript.entries.filter(isTaskBearingEntry);
	const mostRecentTaskBearingId = taskBearing.length > 0 ? taskBearing[taskBearing.length - 1].entryId : undefined;

	return transcript.entries.filter((entry) => {
		if (!isTaskBearingEntry(entry)) return false;
		if (!entry.protected) return false;
		if (recentEntryIds.has(entry.entryId)) return false;
		if (isRecentContextEntry(entry, transcript)) return false;
		if (entry.entryId === mostRecentTaskBearingId) return false;
		return true;
	});
}

/**
 * Deterministically expand `plannerTargets` with oldest-first forced evictions
 * of protected task-bearing entries until the projected `tokensAfter` fits the
 * budget, then return the merged set. Returns the union as a raw deletion
 * request ready for `validateContextDeletionRequest(..., { evict: true })`.
 *
 * Greedy: stops the instant the projected result fits. Recomputes the projected
 * `tokensAfter` after each candidate using the same stats estimator the planner
 * and validator use.
 */
export function buildEvictionTargets(
	transcript: CompactableTranscript,
	plannerTargets: readonly ContextDeletionTarget[],
	budget: LivenessBudget,
): { deletions: ContextDeletionRequest["deletions"]; evictedProtectedEntryIds: string[] } {
	const candidates = findEvictionCandidates(transcript);
	const plannerEntryIds = new Set(plannerTargets.filter((t) => t.kind === "entry").map((t) => t.entryId));
	const evictedProtectedEntryIds: string[] = [];
	const merged: ContextDeletionTarget[] = [...plannerTargets];

	const projectedTokensAfter = (targets: readonly ContextDeletionTarget[]): number => {
		try {
			const stats = computeContextCompactionStats(transcript, targets);
			return stats.tokensAfter;
		} catch {
			return transcript.tokensBefore;
		}
	};

	// If the planner set already fits, no eviction is needed.
	if (projectedTokensAfter(merged) <= budget.tokens) {
		return { deletions: merged.map((t) => rawDeletion(t)), evictedProtectedEntryIds };
	}

	for (const candidate of candidates) {
		if (plannerEntryIds.has(candidate.entryId)) continue;
		// Promote any partial content-block deletions of this entry to a full entry deletion.
		const next = merged.filter((t) => !(t.kind === "content_block" && t.entryId === candidate.entryId));
		next.push({ kind: "entry", entryId: candidate.entryId });
		const projected = projectedTokensAfter(next);
		merged.length = 0;
		merged.push(...next);
		evictedProtectedEntryIds.push(candidate.entryId);
		if (projected <= budget.tokens) break;
	}

	return { deletions: merged.map((t) => rawDeletion(t)), evictedProtectedEntryIds };
}

function rawDeletion(target: ContextDeletionTarget): ContextDeletionRequest["deletions"][number] {
	return target.kind === "entry"
		? { kind: "entry", entryId: target.entryId }
		: { kind: "content_block", entryId: target.entryId, blockIndex: target.blockIndex };
}
