import type { ContextCompactionStats, ContextDeletionTarget } from "../session-manager.ts";
import type {
	CompactableTranscript,
	CompactableTranscriptEntry,
	ContextDeletionRequest,
	ValidatedContextDeletionResult,
} from "./context-compaction-types.ts";
import { assistantEntryHasThinkingContentBlock } from "./context-assistant-turns.js";
import {
	addToolCallDeletion,
	assertIdOnlyDeletionTarget,
	assertNoAssistantThinkingContentBlockDeletionTargets,
	assertNoLatestAssistantThinkingDeletionTargets,
	assertNoRecentContextDeletionTargets,
	canonicalizeEntryTargets,
	canDeleteTarget,
	deleteEntryTarget,
	firstToolCallBlockTarget,
	formatProtectedDeletionError,
	formatProtectedToolDependencyError,
	formatRecentContextDeletionError,
	getDeletedContentBlocks,
	getDeletedEntryIds,
	getRecentContextEntryIds,
	isRecentTarget,
	isTaskBearingEntry,
	isToolCallBlockDeleted,
	normalizeRawTarget,
	rawTargetKey,
	targetKey,
} from "./context-deletion-targets.ts";

let warnedReconciliationNonConvergence = false;

export function reconcileToolDependencies(
	transcript: CompactableTranscript,
	initialTargets: readonly ContextDeletionTarget[],
): ContextDeletionTarget[] {
	const targets = [...initialTargets];
	const callEntries = new Map<string, CompactableTranscriptEntry>();
	const entriesWithToolCalls = new Set<CompactableTranscriptEntry>();
	const resultEntries = new Map<string, CompactableTranscriptEntry[]>();

	for (const entry of transcript.entries) {
		for (const callId of entry.toolCallIds) {
			callEntries.set(callId, entry);
			entriesWithToolCalls.add(entry);
		}
		if (entry.toolResultFor) {
			const results = resultEntries.get(entry.toolResultFor) ?? [];
			results.push(entry);
			resultEntries.set(entry.toolResultFor, results);
		}
	}

	// Bounded fixpoint repair: each pass can add/remove paired call/result targets. In practice this
	// converges within one or two passes; the cap protects against accidental oscillation.
	let changed = true;
	let remainingPasses = Math.max(1, transcript.entries.length * 2);
	while (changed && remainingPasses > 0) {
		changed = false;
		remainingPasses -= 1;
		let deletedEntryIds = getDeletedEntryIds(targets);
		let deletedContentBlocks = getDeletedContentBlocks(targets);
		const recordChange = (nextChanged: boolean): void => {
			if (!nextChanged) return;
			changed = true;
			deletedEntryIds = getDeletedEntryIds(targets);
			deletedContentBlocks = getDeletedContentBlocks(targets);
		};

		for (const [callId, callEntry] of callEntries) {
			const callDeleted = isToolCallBlockDeleted(callEntry, callId, deletedEntryIds, deletedContentBlocks);
			const results = resultEntries.get(callId) ?? [];

			if (callDeleted) {
				const retainedProtectedResult = results.find(
					(entry) =>
						!deletedEntryIds.has(entry.entryId) &&
						!canDeleteTarget(transcript, { kind: "entry", entryId: entry.entryId }),
				);
				if (retainedProtectedResult) {
					const retainedResultTarget: ContextDeletionTarget = { kind: "entry", entryId: retainedProtectedResult.entryId };
					if (isRecentTarget(transcript, retainedResultTarget)) {
						throw new Error(formatRecentContextDeletionError(transcript, retainedResultTarget));
					}
					throw new Error(
						formatProtectedToolDependencyError(
							transcript,
							retainedResultTarget,
							`Cannot delete tool call ${callId} because its paired tool result entry ${retainedProtectedResult.entryId} is protected.`,
						),
					);
				} else {
					for (const result of results) {
						recordChange(deleteEntryTarget(targets, result.entryId));
					}
				}
			}

			if (isToolCallBlockDeleted(callEntry, callId, deletedEntryIds, deletedContentBlocks)) continue;

			for (const result of results) {
				if (!deletedEntryIds.has(result.entryId)) continue;
				recordChange(deleteEntryTarget(targets, result.entryId));
				const callEntryTarget: ContextDeletionTarget = { kind: "entry", entryId: callEntry.entryId };
				const callBlockTarget = assistantEntryHasThinkingContentBlock(callEntry)
					? callEntryTarget
					: firstToolCallBlockTarget(callEntry, callId) ?? callEntryTarget;
				if (!canDeleteTarget(transcript, callBlockTarget)) {
					if (isRecentTarget(transcript, callBlockTarget)) {
						throw new Error(formatRecentContextDeletionError(transcript, callBlockTarget));
					}
					throw new Error(
						formatProtectedToolDependencyError(
							transcript,
							callBlockTarget,
							`Cannot delete tool result entry ${result.entryId} because that would require deleting protected tool block for tool call ${callId}.`,
						),
					);
				}
				recordChange(addToolCallDeletion(transcript, targets, callEntry, callId));
			}
		}

		for (const entry of entriesWithToolCalls) {
			recordChange(canonicalizeEntryTargets(transcript, targets, entry));
		}
	}

	if (changed && !warnedReconciliationNonConvergence) {
		warnedReconciliationNonConvergence = true;
		console.warn(
			`Context compaction tool dependency reconciliation did not converge within the bounded pass limit; validation will continue with the last reconciled target set. entries=${transcript.entries.length} callEntries=${callEntries.size} targets=${targets.length}`,
		);
	}

	return targets;
}

function validateToolDependencies(transcript: CompactableTranscript, targets: readonly ContextDeletionTarget[]): void {
	const deletedEntryIds = getDeletedEntryIds(targets);
	const deletedContentBlocks = getDeletedContentBlocks(targets);
	const callEntries = new Map<string, CompactableTranscriptEntry>();
	const resultEntries = new Map<string, CompactableTranscriptEntry[]>();

	for (const entry of transcript.entries) {
		for (const callId of entry.toolCallIds) {
			callEntries.set(callId, entry);
		}
		if (entry.toolResultFor) {
			const results = resultEntries.get(entry.toolResultFor) ?? [];
			results.push(entry);
			resultEntries.set(entry.toolResultFor, results);
		}
	}

	for (const [callId, callEntry] of callEntries) {
		const callDeleted = isToolCallBlockDeleted(callEntry, callId, deletedEntryIds, deletedContentBlocks);
		const results = resultEntries.get(callId) ?? [];
		if (callDeleted) {
			const danglingResult = results.find((entry) => !deletedEntryIds.has(entry.entryId));
			if (danglingResult) {
				throw new Error(`Deleting tool call ${callId} would leave tool result entry ${danglingResult.entryId} orphaned`);
			}
			continue;
		}

		const deletedResult = results.find((entry) => deletedEntryIds.has(entry.entryId));
		if (deletedResult) {
			throw new Error(`Deleting tool result entry ${deletedResult.entryId} would leave tool call ${callId} dangling`);
		}
	}
}

export function computeContextCompactionStats(
	transcript: CompactableTranscript,
	targets: readonly ContextDeletionTarget[],
): ContextCompactionStats {
	const entryById = new Map(transcript.entries.map((entry) => [entry.entryId, entry]));
	const deletedEntryIds = getDeletedEntryIds(targets);
	let deletedTokens = 0;
	let objectsDeleted = 0;

	for (const entryId of deletedEntryIds) {
		const entry = entryById.get(entryId);
		if (!entry) continue;
		deletedTokens += entry.tokenEstimate;
		objectsDeleted += 1 + entry.contentBlocks.length;
	}

	const deletedContentBlocks = getDeletedContentBlocks(targets);
	for (const [entryId, blockIndexes] of deletedContentBlocks) {
		if (deletedEntryIds.has(entryId)) continue;
		const entry = entryById.get(entryId);
		if (!entry) continue;
		const deletedBlocks = entry.contentBlocks.filter((block) => blockIndexes.has(block.blockIndex));
		objectsDeleted += deletedBlocks.length;
		deletedTokens +=
			isTaskBearingEntry(entry) && !isTaskBearingEntry(entry, blockIndexes)
				? entry.tokenEstimate
				: deletedBlocks.reduce((total, block) => total + block.tokenEstimate, 0);
	}

	const objectsBefore = transcript.entries.length + transcript.entries.reduce((total, entry) => total + entry.contentBlocks.length, 0);
	const tokensBefore = transcript.tokensBefore;
	const tokensAfter = Math.max(0, tokensBefore - deletedTokens);
	const percentReduction = tokensBefore > 0 ? Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 1000) / 10 : 0;
	return {
		objectsBefore,
		objectsAfter: Math.max(0, objectsBefore - objectsDeleted),
		objectsDeleted,
		tokensBefore,
		tokensAfter,
		percentReduction,
	};
}

/**
 * A provider-visible task entry carries session intent through a real `user` message,
 * extension-injected `custom` message, or branch summary. Proposed block deletions count,
 * so an entry with only omitted whitespace remaining cannot satisfy the task floor.
 *
 * Verbatim compaction must always leave at least one provider-visible task entry in context.
 */
export function validateContextDeletionRequest(
	request: ContextDeletionRequest,
	transcript: CompactableTranscript,
): ValidatedContextDeletionResult {
	if (!request || typeof request !== "object" || !Array.isArray(request.deletions)) {
		throw new Error("Context deletion request must be an object with a deletions array");
	}

	const entryById = new Map(transcript.entries.map((entry) => [entry.entryId, entry]));
	const recentEntryIds = getRecentContextEntryIds(transcript);
	const seen = new Set<string>();
	const deletedTargets: ContextDeletionTarget[] = [];

	for (const deletion of request.deletions) {
		if (!deletion || typeof deletion !== "object") {
			throw new Error("Deletion target must be an object");
		}
		if (deletion.kind !== "entry" && deletion.kind !== "content_block") {
			throw new Error(`Unsupported deletion target kind: ${String((deletion as { kind?: unknown }).kind)}`);
		}
		assertIdOnlyDeletionTarget(deletion as Record<string, unknown>);
		if (typeof deletion.entryId !== "string" || deletion.entryId.length === 0) {
			throw new Error("Deletion target entryId must be a non-empty string");
		}
		const entry = entryById.get(deletion.entryId);
		if (!entry) {
			throw new Error(`Unknown deletion target entryId: ${deletion.entryId}`);
		}
		const normalized = normalizeRawTarget(deletion);
		if (deletion.kind === "entry") {
			if (recentEntryIds.has(deletion.entryId)) {
				throw new Error(formatRecentContextDeletionError(transcript, normalized));
			}
			if (!canDeleteTarget(transcript, normalized)) {
				throw new Error(formatProtectedDeletionError(transcript, normalized));
			}
		}
		if (deletion.kind === "content_block") {
			if (typeof deletion.blockIndex !== "number" || !Number.isInteger(deletion.blockIndex) || deletion.blockIndex < 0) {
				throw new Error(`Invalid content block index for entry ${deletion.entryId}`);
			}
			if (recentEntryIds.has(deletion.entryId)) {
				throw new Error(formatRecentContextDeletionError(transcript, normalized));
			}
			const block = entry.contentBlocks.find((item) => item.blockIndex === deletion.blockIndex);
			if (!block) {
				if (entry.protected) {
					throw new Error(formatProtectedDeletionError(transcript, normalized));
				}
				throw new Error(`Unknown content block ${deletion.blockIndex} for entry ${deletion.entryId}`);
			}
			if (!canDeleteTarget(transcript, normalized)) {
				throw new Error(formatProtectedDeletionError(transcript, normalized));
			}
			if (entry.contentBlocks.length <= 1) {
				throw new Error(`Deleting the only content block of ${deletion.entryId} must be an entry deletion`);
			}
		}

		const key = rawTargetKey(deletion);
		if (seen.has(key)) {
			throw new Error(`Duplicate deletion target: ${key}`);
		}
		seen.add(key);
		deletedTargets.push(normalized);
	}

	const reconciledTargets = reconcileToolDependencies(transcript, deletedTargets);
	// Tool reconciliation can add targets after the per-request checks above, so
	// these post-reconcile assertions remain authoritative.
	assertNoRecentContextDeletionTargets(transcript, reconciledTargets);
	assertNoAssistantThinkingContentBlockDeletionTargets(transcript, reconciledTargets);
	assertNoLatestAssistantThinkingDeletionTargets(transcript, reconciledTargets);
	const reconciledDeletedEntryIds = getDeletedEntryIds(reconciledTargets);

	for (const target of reconciledTargets) {
		if (target.kind === "content_block" && reconciledDeletedEntryIds.has(target.entryId)) {
			throw new Error(`Deletion target ${targetKey(target)} overlaps with entry deletion`);
		}
	}

	const deletedContentBlocks = getDeletedContentBlocks(reconciledTargets);
	for (const [entryId, blockIndexes] of deletedContentBlocks) {
		const entry = entryById.get(entryId);
		if (entry?.contentBlocks.every((block) => blockIndexes.has(block.blockIndex))) {
			throw new Error(`Content-block deletions for ${entryId} would remove every content block`);
		}
	}

	validateToolDependencies(transcript, reconciledTargets);

	const remainingEntries = transcript.entries.filter((entry) => !reconciledDeletedEntryIds.has(entry.entryId));
	if (remainingEntries.length === 0) {
		throw new Error("Deletion request would remove all context entries");
	}
	const hasTaskBearingContext = remainingEntries.some((entry) =>
		isTaskBearingEntry(entry, deletedContentBlocks.get(entry.entryId)),
	);
	if (!hasTaskBearingContext) {
		throw new Error("Deletion request would leave no user task in context");
	}

	return {
		deletedTargets: reconciledTargets,
		protectedEntryIds: [...transcript.protectedEntryIds],
		stats: computeContextCompactionStats(transcript, reconciledTargets),
	};
}

export function contextDeletionRequestFromObject(value: unknown, source: string): ContextDeletionRequest {
	if (!value || typeof value !== "object" || !Array.isArray((value as { deletions?: unknown }).deletions)) {
		throw new Error(`${source} must contain a deletions array`);
	}
	return value as ContextDeletionRequest;
}

