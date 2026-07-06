import type { CompactableTranscript, CompactableTranscriptEntry, ContextCompactionParameters } from "./context-compaction-types.ts";
import { getTranscriptCompactionParameters } from "./context-compaction-strategy.ts";
import { isTaskBearingEntry } from "./context-deletion-targets.ts";
import { hasAssistantError, hasFailedBashExecution, hasToolResultError } from "./context-transcript-analysis.ts";

export const CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT = 5;

export function criticalCompactionParameters(parameters: ContextCompactionParameters): ContextCompactionParameters {
	return {
		...parameters,
		preserve_recent: Math.max(parameters.preserve_recent, CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT),
	};
}

export function isCriticalOverflowProtectedEntryDeletable(
	entry: CompactableTranscriptEntry,
	transcript: CompactableTranscript,
): boolean {
	if (!entry.protected) return true;
	const entryIndex = transcript.entries.findIndex((candidate) => candidate.entryId === entry.entryId);
	if (entryIndex < 0) return false;
	const recentBoundary = Math.max(0, transcript.entries.length - CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT);
	if (entryIndex >= recentBoundary) return false;
	if (hasAssistantError(entry.message) || hasToolResultError(entry.message) || hasFailedBashExecution(entry.message)) {
		return false;
	}
	return isTaskBearingEntry(entry);
}

/**
 * Return a transcript for critical overflow passes. The effective recent guard is
 * widened to max(configured preserve_recent, 5) over all entries, restoring the
 * pre-#1399 critical-overflow last-5 floor through the existing recent-target
 * validation path. Only stale protected task-bearing entries outside that floor
 * are relaxed; `protectedEntryIds` is rebuilt from still-protected entries so
 * persisted results/events stay disjoint from deleted targets.
 */
export function relaxTranscriptForCriticalEviction(transcript: CompactableTranscript): CompactableTranscript {
	const entries = transcript.entries.map((entry) => {
		if (!entry.protected || !isCriticalOverflowProtectedEntryDeletable(entry, transcript)) return entry;
		return {
			...entry,
			protected: false,
			contentBlocks: entry.contentBlocks.map((block) => ({ ...block, protected: false })),
		};
	});
	const parameters = criticalCompactionParameters(getTranscriptCompactionParameters(transcript));
	return {
		...transcript,
		entries,
		parameters,
		protectedEntryIds: entries.filter((entry) => entry.protected).map((entry) => entry.entryId),
	};
}

export const CONTEXT_COMPACTION_CRITICAL_OVERFLOW_PROMPT = `
<critical-overflow-mode>
The previous model request overflowed its context window. This is a critical LRU-style compaction pass. First delete stale unprotected context. If that is not enough, you may also delete the earliest formerly-protected entries or protected content shown in the manifest. Evict old low-signal context first, including old reasoning/thinking traces when they are not part of the latest retained assistant message, then older user/custom/summary context while preserving recent entries, unresolved errors, failed commands, and enough task-bearing context for the assistant to continue.

Safety invariant: the latest retained assistant message cannot be modified when it contains content blocks with type "thinking" or "redacted_thinking". Do not delete, target, or suggest any content block in that latest thinking-bearing assistant message, including sibling text or tool-call blocks. Older non-latest thinking/redacted_thinking blocks may be deleted during critical overflow when validation allows it.
</critical-overflow-mode>`;
