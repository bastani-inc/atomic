import type { ContextDeletionTarget } from "../session-manager.ts";
import type { CompactableTranscript, ValidatedContextDeletionResult } from "./context-compaction-types.ts";
import { validateContextDeletionRequest } from "./context-deletion-application.ts";
import { canDeleteTarget, deletionRequestFromTargets, isTaskBearingEntry } from "./context-deletion-targets.ts";
import { relaxTranscriptForCriticalEviction } from "./context-compaction-critical.ts";
import { assistantEntryHasThinkingContentBlock } from "./context-transcript-analysis.ts";

export const CONTEXT_COMPACTION_MAX_EVICTION_PASSES = 50;

function terminalDeterministicEvictionError(
	reason: string,
	lastValidated: ValidatedContextDeletionResult | undefined,
	tokenBudget: number,
): Error {
	const statsText = lastValidated
		? `achieved tokensAfter=${lastValidated.stats.tokensAfter}, reduction=${lastValidated.stats.percentReduction}%, deletionTargets=${lastValidated.deletedTargets.length}`
		: "achieved no validated deletion targets";
	return new Error(
		`Context deterministic overflow eviction failed: ${reason}; ${statsText}; budget=${tokenBudget}; nothing more was safely deletable`,
	);
}


function hasFitBudget(result: ValidatedContextDeletionResult | undefined, tokenBudget: number): result is ValidatedContextDeletionResult {
	return result !== undefined && result.deletedTargets.length > 0 && result.stats.tokensAfter <= tokenBudget;
}

function isThinkingAssistantEntryTarget(transcript: CompactableTranscript, target: ContextDeletionTarget): boolean {
	if (target.kind !== "entry") return false;
	const entry = transcript.entries.find((candidate) => candidate.entryId === target.entryId);
	return entry?.role === "assistant" && assistantEntryHasThinkingContentBlock(entry);
}

function isTaskBearingEntryTarget(transcript: CompactableTranscript, target: ContextDeletionTarget): boolean {
	if (target.kind !== "entry") return false;
	const entry = transcript.entries.find((candidate) => candidate.entryId === target.entryId);
	return entry !== undefined && isTaskBearingEntry(entry);
}

function targetSignature(targets: readonly ContextDeletionTarget[]): string {
	return targets
		.map((target) => `${target.kind}:${target.entryId}:${target.kind === "content_block" ? target.blockIndex : ""}`)
		.join("|");
}

function entryOrder(transcript: CompactableTranscript, entryId: string): number {
	const index = transcript.entries.findIndex((entry) => entry.entryId === entryId);
	return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function entryTokenEstimate(transcript: CompactableTranscript, entryId: string): number {
	return transcript.entries.find((entry) => entry.entryId === entryId)?.tokenEstimate ?? 0;
}

function smallestTaskTarget(transcript: CompactableTranscript, targets: readonly ContextDeletionTarget[]): ContextDeletionTarget | undefined {
	return [...targets]
		.filter((target) => isTaskBearingEntryTarget(transcript, target))
		.sort((left: ContextDeletionTarget, right: ContextDeletionTarget) => {
			const tokenDelta = entryTokenEstimate(transcript, left.entryId) - entryTokenEstimate(transcript, right.entryId);
			if (tokenDelta !== 0) return tokenDelta;
			return entryOrder(transcript, left.entryId) - entryOrder(transcript, right.entryId);
		})[0];
}

function newestThinkingTarget(transcript: CompactableTranscript, targets: readonly ContextDeletionTarget[]): ContextDeletionTarget | undefined {
	return [...targets]
		.filter((target) => isThinkingAssistantEntryTarget(transcript, target))
		.sort((left: ContextDeletionTarget, right: ContextDeletionTarget) => entryOrder(transcript, right.entryId) - entryOrder(transcript, left.entryId))[0];
}

type ThinkingExchange = "keep-all" | "drop-all" | "retain-newest";
type TaskExchange = "keep-all" | "drop-all" | "retain-smallest";

const THINKING_EXCHANGES: readonly ThinkingExchange[] = ["keep-all", "drop-all", "retain-newest"];
const TASK_EXCHANGES: readonly TaskExchange[] = ["keep-all", "drop-all", "retain-smallest"];

function shouldDeleteTarget(
	transcript: CompactableTranscript,
	target: ContextDeletionTarget,
	thinkingExchange: ThinkingExchange,
	taskExchange: TaskExchange,
	retainedThinking: ContextDeletionTarget | undefined,
	retainedTask: ContextDeletionTarget | undefined,
): boolean {
	if (thinkingExchange === "drop-all" && isThinkingAssistantEntryTarget(transcript, target)) return false;
	if (thinkingExchange === "retain-newest" && retainedThinking !== undefined && targetSignature([target]) === targetSignature([retainedThinking])) return false;
	if (taskExchange === "drop-all" && isTaskBearingEntryTarget(transcript, target)) return false;
	if (taskExchange === "retain-smallest" && retainedTask !== undefined && targetSignature([target]) === targetSignature([retainedTask])) return false;
	return true;
}

function buildExchangePlan(
	transcript: CompactableTranscript,
	withCandidate: readonly ContextDeletionTarget[],
	thinkingExchange: ThinkingExchange,
	taskExchange: TaskExchange,
): ContextDeletionTarget[] {
	const retainedThinking = thinkingExchange === "retain-newest" ? newestThinkingTarget(transcript, withCandidate) : undefined;
	const retainedTask = taskExchange === "retain-smallest" ? smallestTaskTarget(transcript, withCandidate) : undefined;
	return withCandidate.filter((target) =>
		shouldDeleteTarget(transcript, target, thinkingExchange, taskExchange, retainedThinking, retainedTask),
	);
}

function shouldBuildExchangePlan(
	withCandidate: readonly ContextDeletionTarget[],
	thinkingExchange: ThinkingExchange,
	taskExchange: TaskExchange,
): boolean {
	if (thinkingExchange === "keep-all" && taskExchange === "keep-all") return false;
	if (thinkingExchange === "retain-newest" && withCandidate.filter((target) => target.kind === "entry").length === 0) return false;
	return true;
}

function addExchangePlan(
	plans: ContextDeletionTarget[][],
	seen: Set<string>,
	originalTargets: readonly ContextDeletionTarget[],
	targets: readonly ContextDeletionTarget[],
): void {
	if (targetSignature(targets) === targetSignature(originalTargets)) return;
	const signature = targetSignature(targets);
	if (seen.has(signature)) return;
	seen.add(signature);
	plans.push([...targets]);
}

function exchangePlans(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	entryId: string,
): ContextDeletionTarget[][] {
	const currentTarget: ContextDeletionTarget = { kind: "entry", entryId };
	const withCandidate = [...planned, currentTarget];
	const plans: ContextDeletionTarget[][] = [];
	const seen = new Set<string>();
	// Deterministic cross-product order: thinking handling outermost, then task handling.
	// Variants are keep/drop-all/retain-one for each non-monotone category, minus the
	// keep-all/keep-all no-op; signature dedup collapses degenerate variants.
	for (const thinkingExchange of THINKING_EXCHANGES) {
		for (const taskExchange of TASK_EXCHANGES) {
			if (!shouldBuildExchangePlan(withCandidate, thinkingExchange, taskExchange)) continue;
			addExchangePlan(plans, seen, withCandidate, buildExchangePlan(transcript, withCandidate, thinkingExchange, taskExchange));
		}
	}
	return plans;
}

function validatedExchange(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	entryId: string,
	lastValidated: ValidatedContextDeletionResult | undefined,
): ValidatedContextDeletionResult | undefined {
	let best: ValidatedContextDeletionResult | undefined;
	for (const retryTargets of exchangePlans(transcript, planned, entryId)) {
		try {
			const result = validateContextDeletionRequest(deletionRequestFromTargets(retryTargets), transcript);
			if (lastValidated !== undefined && result.stats.tokensAfter >= lastValidated.stats.tokensAfter) continue;
			if (best === undefined || result.stats.tokensAfter < best.stats.tokensAfter) best = result;
		} catch {
			// Try the next deterministic exchange variant.
		}
	}
	return best;
}

export function runDeterministicContextEviction(
	transcript: CompactableTranscript,
	tokenBudget: number,
): ValidatedContextDeletionResult {
	const relaxed = relaxTranscriptForCriticalEviction(transcript);
	const latestAssistant = [...relaxed.entries].reverse().find((entry) => entry.role === "assistant");
	const protectedThinkingAssistant = latestAssistant && assistantEntryHasThinkingContentBlock(latestAssistant) ? latestAssistant.entryId : undefined;
	const candidates = relaxed.entries
		.filter((entry) => entry.entryId !== protectedThinkingAssistant)
		.filter((entry) => canDeleteTarget(relaxed, { kind: "entry", entryId: entry.entryId }))
		.map((entry) => entry.entryId);
	const planned: ContextDeletionTarget[] = [];
	const excluded = new Set<string>();
	let lastValidated: ValidatedContextDeletionResult | undefined;

	// Hard iteration cap required by the compaction-ladder design: every compaction loop must be
	// bounded (max 50) so no tier can spin indefinitely. Non-monotone validation rules can require
	// local exchange: a prior thinking-bearing or task-bearing deletion can make a newer candidate
	// invalid, even though replacing the prior deletion with that candidate is safe and fits better.
	// Exchanges are deterministic and adopted only when validation succeeds and tokensAfter strictly
	// decreases; exclusions grow monotonically, so no oscillation is possible, and the pass cap remains
	// the terminal safety belt.
	for (let pass = 0; pass < CONTEXT_COMPACTION_MAX_EVICTION_PASSES; pass++) {
		if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
		let changed = false;
		for (const entryId of candidates) {
			if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
			if (planned.some((target) => target.entryId === entryId) || excluded.has(entryId)) continue;
			const nextPlanned: ContextDeletionTarget[] = [...planned, { kind: "entry", entryId }];
			try {
				lastValidated = validateContextDeletionRequest(deletionRequestFromTargets(nextPlanned), relaxed);
				planned.splice(0, planned.length, ...lastValidated.deletedTargets);
				changed = true;
			} catch {
				const exchanged = validatedExchange(relaxed, planned, entryId, lastValidated);
				if (exchanged !== undefined) {
					lastValidated = exchanged;
					planned.splice(0, planned.length, ...lastValidated.deletedTargets);
					changed = true;
					continue;
				}
				excluded.add(entryId);
				changed = true;
			}
		}
		if (!changed) {
			throw terminalDeterministicEvictionError("candidate sweep exhausted", lastValidated, tokenBudget);
		}
	}
	throw terminalDeterministicEvictionError(
		`reached ${CONTEXT_COMPACTION_MAX_EVICTION_PASSES} eviction pass cap`,
		lastValidated,
		tokenBudget,
	);
}
