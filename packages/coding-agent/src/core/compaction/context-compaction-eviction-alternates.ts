import type { ContextDeletionTarget } from "../session-manager.js";
import { analyzeCompactableAssistantTurns } from "./context-assistant-turns.js";
import type { CompactableTranscript, ValidatedContextDeletionResult } from "./context-compaction-types.js";
import { reconcileToolDependencies, validateContextDeletionRequest } from "./context-deletion-application.js";
import {
	canDeleteTarget,
	deletionRequestFromTargets,
	getDeletedEntryIds,
} from "./context-deletion-targets.js";

export interface EvictionGroup {
	entryIds: string[];
	order: number;
	tokens: number;
	boundary: boolean;
}

export function hasFitBudget(
	result: ValidatedContextDeletionResult | undefined,
	tokenBudget: number,
): result is ValidatedContextDeletionResult {
	return result !== undefined && result.deletedTargets.length > 0 && result.stats.tokensAfter <= tokenBudget;
}

export function assistantTurnsForTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
) {
	return analyzeCompactableAssistantTurns(transcript, targets).turns;
}

export function repairSignedTurnTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): ContextDeletionTarget[] {
	const reconciled = reconcileToolDependencies(transcript, targets);
	const deletedEntryIds = getDeletedEntryIds(reconciled);
	const restoredSignedIds = new Set<string>();
	for (const turn of assistantTurnsForTargets(transcript, reconciled)) {
		const deleted = turn.signedThinkingEntryIds.filter((entryId) => deletedEntryIds.has(entryId));
		if (deleted.length === 0) continue;
		if (!turn.active && deleted.length === turn.signedThinkingEntryIds.length) continue;
		for (const entryId of turn.signedThinkingEntryIds) restoredSignedIds.add(entryId);
	}
	if (restoredSignedIds.size === 0) return reconciled;

	const restoredCallIds = new Set<string>();
	for (const entry of transcript.entries) {
		if (!restoredSignedIds.has(entry.entryId)) continue;
		for (const callId of entry.toolCallIds) restoredCallIds.add(callId);
	}
	const restoredResultIds = new Set(
		transcript.entries
			.filter((entry) => entry.toolResultFor && restoredCallIds.has(entry.toolResultFor))
			.map((entry) => entry.entryId),
	);
	return reconcileToolDependencies(
		transcript,
		reconciled.filter((target) => !restoredSignedIds.has(target.entryId) && !restoredResultIds.has(target.entryId)),
	);
}

export function targetsWithGroup(
	planned: readonly ContextDeletionTarget[],
	entryIds: readonly string[],
): ContextDeletionTarget[] {
	const deleted = getDeletedEntryIds(planned);
	return [
		...planned,
		...entryIds
			.filter((entryId) => !deleted.has(entryId))
			.map((entryId): ContextDeletionTarget => ({ kind: "entry", entryId })),
	];
}

export function validateTargets(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): ValidatedContextDeletionResult | undefined {
	try {
		const result = validateContextDeletionRequest(deletionRequestFromTargets(targets), transcript);
		const order = new Map(transcript.entries.map((entry, index) => [entry.entryId, index]));
		return {
			...result,
			deletedTargets: [...result.deletedTargets].sort((left, right) => {
				const entryDelta =
					(order.get(left.entryId) ?? Number.MAX_SAFE_INTEGER) -
					(order.get(right.entryId) ?? Number.MAX_SAFE_INTEGER);
				if (entryDelta !== 0) return entryDelta;
				const leftBlock = left.kind === "content_block" ? left.blockIndex : -1;
				const rightBlock = right.kind === "content_block" ? right.blockIndex : -1;
				return leftBlock - rightBlock;
			}),
		};
	} catch {
		return undefined;
	}
}

export function tryGroup(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	group: EvictionGroup,
	repairBoundary: boolean,
): ValidatedContextDeletionResult | undefined {
	const directTargets = targetsWithGroup(planned, group.entryIds);
	const direct = validateTargets(transcript, directTargets);
	if (direct) return direct;
	if (!repairBoundary) return undefined;
	const repaired = repairSignedTurnTargets(transcript, directTargets);
	const result = validateTargets(transcript, repaired);
	if (!result) return undefined;
	const deleted = getDeletedEntryIds(result.deletedTargets);
	return group.entryIds.every((entryId) => deleted.has(entryId)) ? result : undefined;
}

export function currentHistoricalSignedGroups(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
): EvictionGroup[] {
	const deleted = getDeletedEntryIds(planned);
	const order = new Map(transcript.entries.map((entry, index) => [entry.entryId, index]));
	const tokens = new Map(transcript.entries.map((entry) => [entry.entryId, entry.tokenEstimate]));
	return assistantTurnsForTargets(transcript, planned)
		.filter((turn) => !turn.active)
		.map((turn) => turn.signedThinkingEntryIds.filter((entryId) => !deleted.has(entryId)))
		.filter((entryIds) => entryIds.length > 0)
		.filter((entryIds) => entryIds.every((entryId) => canDeleteTarget(transcript, { kind: "entry", entryId })))
		.map((entryIds) => ({
			entryIds,
			order: order.get(entryIds[0]!) ?? Number.MAX_SAFE_INTEGER,
			tokens: entryIds.reduce((sum, entryId) => sum + (tokens.get(entryId) ?? 0), 0),
			boundary: false,
		}));
}

function targetIdentity(target: ContextDeletionTarget): string {
	return target.kind === "entry"
		? `entry:${target.entryId}`
		: `content_block:${target.entryId}:${target.blockIndex}`;
}

function boundaryRestorationSignature(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	group: EvictionGroup,
): string | undefined {
	try {
		const repaired = repairSignedTurnTargets(transcript, targetsWithGroup(planned, group.entryIds));
		const retainedKeys = new Set(repaired.map(targetIdentity));
		const restoredKeys = planned
			.map(targetIdentity)
			.filter((key) => !retainedKeys.has(key))
			.sort();
		return restoredKeys.length > 0 ? restoredKeys.join("|") : undefined;
	} catch {
		return undefined;
	}
}

export function skippedBoundaryRestorationGroups(
	transcript: CompactableTranscript,
	planned: readonly ContextDeletionTarget[],
	skipped: readonly EvictionGroup[],
): EvictionGroup[][] {
	const bySignature = new Map<string, EvictionGroup[]>();
	for (const group of skipped) {
		const signature = boundaryRestorationSignature(transcript, planned, group);
		if (!signature) continue;
		const matches = bySignature.get(signature) ?? [];
		matches.push(group);
		bySignature.set(signature, matches);
	}
	return [...bySignature.values()].filter((groups) => groups.length > 1);
}

interface AlternateBoundaryState {
	targets: ContextDeletionTarget[];
	tokensAfter: number;
	signature: string;
}

function deletionPlanSignature(targets: readonly ContextDeletionTarget[]): string {
	return targets.map(targetIdentity).sort().join("|");
}

const ALTERNATE_BOUNDARY_STATE_LIMIT = 16;

function retainBoundedAlternateStates(states: readonly AlternateBoundaryState[]): AlternateBoundaryState[] {
	const deduplicated = [...new Map(states.map((state) => [state.signature, state])).values()].sort(
		(left, right) => left.tokensAfter - right.tokensAfter || left.signature.localeCompare(right.signature),
	);
	// Retain both near-fit and less-committed plans so different turn topologies survive the bounded search.
	if (deduplicated.length <= ALTERNATE_BOUNDARY_STATE_LIMIT) return deduplicated;

	const retained: AlternateBoundaryState[] = [];
	for (let index = 0; index < ALTERNATE_BOUNDARY_STATE_LIMIT / 2; index++) {
		retained.push(deduplicated[index]!, deduplicated[deduplicated.length - 1 - index]!);
	}
	return retained.sort(
		(left, right) => left.tokensAfter - right.tokensAfter || left.signature.localeCompare(right.signature),
	);
}

export function alternateBoundaryPlan(
	transcript: CompactableTranscript,
	initialTargets: readonly ContextDeletionTarget[],
	initialResult: ValidatedContextDeletionResult | undefined,
	groups: readonly EvictionGroup[],
	tokenBudget: number,
): ValidatedContextDeletionResult | undefined {
	let states: AlternateBoundaryState[] = [
		{
			targets: [...initialTargets],
			tokensAfter: initialResult?.stats.tokensAfter ?? transcript.tokensBefore,
			signature: deletionPlanSignature(initialTargets),
		},
	];

	for (const group of groups) {
		const expanded = [...states];
		let fitting: ValidatedContextDeletionResult | undefined;
		for (const state of states) {
			const result = tryGroup(transcript, state.targets, group, true);
			if (!result) continue;
			if (result.deletedTargets.length > 0 && result.stats.tokensAfter <= tokenBudget) {
				if (!fitting || result.stats.tokensAfter > fitting.stats.tokensAfter) fitting = result;
				continue;
			}
			expanded.push({
				targets: [...result.deletedTargets],
				tokensAfter: result.stats.tokensAfter,
				signature: deletionPlanSignature(result.deletedTargets),
			});
		}
		if (fitting) return fitting;
		states = retainBoundedAlternateStates(expanded);
	}

	for (const state of states) {
		let targets = state.targets;
		for (const group of currentHistoricalSignedGroups(transcript, targets)) {
			const result = tryGroup(transcript, targets, group, false);
			if (!result) continue;
			targets = [...result.deletedTargets];
			if (hasFitBudget(result, tokenBudget)) return result;
		}
	}
	return undefined;
}
