import type { ContextDeletionTarget } from "../session-manager.js";
import { relaxTranscriptForCriticalEviction } from "./context-compaction-critical.js";
import {
	alternateBoundaryPlan,
	assistantTurnsForTargets,
	currentHistoricalSignedGroups,
	type EvictionGroup,
	hasFitBudget,
	repairSignedTurnTargets,
	skippedBoundaryRestorationGroups,
	targetsWithGroup,
	tryGroup,
	validateTargets,
} from "./context-compaction-eviction-alternates.js";
import type { CompactableTranscript, ValidatedContextDeletionResult } from "./context-compaction-types.js";
import { transcriptEntryStartsNewTurn } from "./context-assistant-turns.js";
import { canDeleteTarget, getDeletedEntryIds } from "./context-deletion-targets.js";

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

function initialEvictionGroups(transcript: CompactableTranscript): EvictionGroup[] {
	const turns = assistantTurnsForTargets(transcript, []);
	const signedGroupByEntryId = new Map<string, string[]>();
	const activeSignedIds = new Set<string>();
	for (const turn of turns) {
		if (turn.active) {
			for (const entryId of turn.signedThinkingEntryIds) activeSignedIds.add(entryId);
			continue;
		}
		for (const entryId of turn.signedThinkingEntryIds) {
			signedGroupByEntryId.set(entryId, turn.signedThinkingEntryIds);
		}
	}

	const entryById = new Map(transcript.entries.map((entry, index) => [entry.entryId, { entry, index }]));
	const grouped = new Set<string>();
	const groups: EvictionGroup[] = [];
	for (let index = 0; index < transcript.entries.length; index++) {
		const entry = transcript.entries[index]!;
		if (activeSignedIds.has(entry.entryId) || grouped.has(entry.entryId)) continue;
		const entryIds = signedGroupByEntryId.get(entry.entryId) ?? [entry.entryId];
		for (const entryId of entryIds) grouped.add(entryId);
		if (!entryIds.every((entryId) => canDeleteTarget(transcript, { kind: "entry", entryId }))) continue;
		groups.push({
			entryIds: [...entryIds],
			order: index,
			tokens: entryIds.reduce((sum, entryId) => sum + (entryById.get(entryId)?.entry.tokenEstimate ?? 0), 0),
			boundary: entryIds.length === 1 && transcriptEntryStartsNewTurn(entry),
		});
	}
	return groups;
}

function repairedFittingBoundaryPrefix(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	groups: readonly EvictionGroup[],
	tokenBudget: number,
	currentTokens: number,
): ValidatedContextDeletionResult | undefined {
	const required = currentTokens - tokenBudget;
	if (required <= 0) return undefined;
	let rawRemoved = 0;
	let lowerBound = 0;
	while (lowerBound < groups.length && rawRemoved < required) {
		rawRemoved += groups[lowerBound]!.tokens;
		lowerBound += 1;
	}
	if (rawRemoved < required) return undefined;

	let prospective = [...planned];
	for (let index = 0; index < groups.length; index++) {
		prospective = targetsWithGroup(prospective, groups[index]!.entryIds);
		if (index + 1 < lowerBound) continue;
		const repaired = repairSignedTurnTargets(transcript, prospective);
		const validated = validateTargets(transcript, repaired);
		if (!validated || !hasFitBudget(validated, tokenBudget)) continue;
		const deleted = getDeletedEntryIds(validated.deletedTargets);
		const prefixRetained = groups
			.slice(0, index + 1)
			.some((group) => group.entryIds.some((entryId) => !deleted.has(entryId)));
		if (!prefixRetained) return validated;
	}
	return undefined;
}

function adoptSmallestFittingPrefix(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	groups: readonly EvictionGroup[],
	tokenBudget: number,
): ValidatedContextDeletionResult | undefined {
	if (groups.length === 0) return undefined;
	const prefixTargets = (count: number): ContextDeletionTarget[] =>
		groups.slice(0, count).reduce((targets, group) => targetsWithGroup(targets, group.entryIds), [...planned]);
	const full = validateTargets(transcript, prefixTargets(groups.length));
	if (!full) return undefined;
	if (!hasFitBudget(full, tokenBudget)) return full;

	let low = 1;
	let high = groups.length;
	let best = full;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const result = validateTargets(transcript, prefixTargets(middle));
		if (result && hasFitBudget(result, tokenBudget)) {
			best = result;
			high = middle - 1;
		} else {
			low = middle + 1;
		}
	}
	return best;
}

/**
 * Finite deterministic eviction phases:
 * 1. Batch or sweep non-boundary groups in transcript order.
 * 2. Try repaired boundary prefixes, then individual boundaries by token value.
 * 3. Sweep newly historical signed groups exposed by those deletions.
 * 4. Retry skipped boundaries by shared restoration component, then individually.
 * 5. Search bounded alternate boundary states (at most 16 per boundary) and their signed groups.
 * 6. Fail with the best validated stats after every finite candidate set is exhausted.
 */
export function runDeterministicContextEviction(
	transcript: CompactableTranscript,
	tokenBudget: number,
): ValidatedContextDeletionResult {
	const relaxed = relaxTranscriptForCriticalEviction(transcript);
	const groups = initialEvictionGroups(relaxed);
	const nonBoundaries = groups.filter((group) => !group.boundary).sort((left, right) => left.order - right.order);
	const boundaries = groups
		.filter((group) => group.boundary)
		.sort((left, right) => right.tokens - left.tokens || left.order - right.order);
	let planned: ContextDeletionTarget[] = [];
	let lastValidated: ValidatedContextDeletionResult | undefined;
	const skippedBoundaries: EvictionGroup[] = [];

	if (relaxed.tokensBefore > tokenBudget) {
		const batch = adoptSmallestFittingPrefix(relaxed, planned, nonBoundaries, tokenBudget);
		if (batch) {
			planned = [...batch.deletedTargets];
			lastValidated = batch;
			if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
		} else {
			for (const group of nonBoundaries) {
				const result = tryGroup(relaxed, planned, group, false);
				if (!result) continue;
				planned = [...result.deletedTargets];
				lastValidated = result;
				if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
			}
		}
	} else {
		for (const group of nonBoundaries) {
			const result = tryGroup(relaxed, planned, group, false);
			if (!result) continue;
			return result;
		}
	}

	const boundaryBaseTargets = [...planned];
	const boundaryBaseResult = lastValidated;
	const boundaryBatch = repairedFittingBoundaryPrefix(
		relaxed,
		planned,
		boundaries,
		tokenBudget,
		lastValidated?.stats.tokensAfter ?? relaxed.tokensBefore,
	);
	if (boundaryBatch) {
		const standalone = boundaries[0] ? tryGroup(relaxed, [], boundaries[0], true) : undefined;
		return standalone && hasFitBudget(standalone, tokenBudget) && standalone.stats.tokensAfter > boundaryBatch.stats.tokensAfter
			? standalone
			: boundaryBatch;
	}

	for (const group of boundaries) {
		const result = tryGroup(relaxed, planned, group, true);
		if (!result || (lastValidated && result.stats.tokensAfter >= lastValidated.stats.tokensAfter)) {
			skippedBoundaries.push(group);
			continue;
		}
		planned = [...result.deletedTargets];
		lastValidated = result;
		if (hasFitBudget(lastValidated, tokenBudget)) {
			const standalone = tryGroup(relaxed, [], group, true);
			return standalone && hasFitBudget(standalone, tokenBudget) && standalone.stats.tokensAfter > result.stats.tokensAfter
				? standalone
				: result;
		}
	}

	for (const group of currentHistoricalSignedGroups(relaxed, planned)) {
		const result = tryGroup(relaxed, planned, group, false);
		if (!result) continue;
		planned = [...result.deletedTargets];
		lastValidated = result;
		if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
	}

	const groupedRetryIds = new Set<string>();
	for (const component of skippedBoundaryRestorationGroups(relaxed, planned, skippedBoundaries)) {
		const entryIds = component.flatMap((group) => group.entryIds);
		for (const entryId of entryIds) groupedRetryIds.add(entryId);
		const combined: EvictionGroup = {
			entryIds,
			order: Math.min(...component.map((group) => group.order)),
			tokens: component.reduce((sum, group) => sum + group.tokens, 0),
			boundary: true,
		};
		const result = tryGroup(relaxed, planned, combined, true);
		if (!result) continue;
		const deleted = getDeletedEntryIds(result.deletedTargets);
		if (!entryIds.every((entryId) => deleted.has(entryId))) continue;
		if (lastValidated && result.stats.tokensAfter >= lastValidated.stats.tokensAfter && !hasFitBudget(result, tokenBudget)) {
			continue;
		}
		planned = [...result.deletedTargets];
		lastValidated = result;
		if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
	}

	for (const group of skippedBoundaries) {
		if (group.entryIds.some((entryId) => groupedRetryIds.has(entryId))) continue;
		const result = tryGroup(relaxed, planned, group, true);
		if (!result || (lastValidated && result.stats.tokensAfter >= lastValidated.stats.tokensAfter)) continue;
		planned = [...result.deletedTargets];
		lastValidated = result;
		if (hasFitBudget(lastValidated, tokenBudget)) return lastValidated;
	}

	const alternate = alternateBoundaryPlan(
		relaxed,
		boundaryBaseTargets,
		boundaryBaseResult,
		boundaries,
		tokenBudget,
	);
	if (alternate) return alternate;

	throw terminalDeterministicEvictionError("candidate sweep exhausted", lastValidated, tokenBudget);
}
