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
The previous model request overflowed its context window. This is a critical LRU-style compaction pass. First delete stale unprotected context. If that is not enough, you may also delete the earliest formerly-protected entries or protected content shown in the manifest. Evict old low-signal context first, then older user/custom/summary context while preserving recent entries, unresolved errors, failed commands, and enough task-bearing context for the assistant to continue.

Safety invariant: each provider-visible user-like input starts a logical assistant tool-use turn: a non-empty user/custom input, a context-eligible bash execution, or a non-empty branch summary. Empty or whitespace-only user/custom inputs and empty branch summaries do not split turns; whitespace-only branch summaries remain visible through their wrapper. Assistant messages and intervening tool results remain in the turn until the next visible input. Never delete a thinking/redacted_thinking-bearing assistant entry from the current final logical turn; a trailing visible input without an assistant response makes the preceding assistant turn historical. For a completed historical turn, retain every thinking/redacted_thinking-bearing assistant entry or delete all of them as whole entries. Never retain a proper subset or partially delete a retained thinking-bearing assistant message.
</critical-overflow-mode>`;
