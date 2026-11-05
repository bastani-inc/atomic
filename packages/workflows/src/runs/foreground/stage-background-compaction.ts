import {
	type BackgroundCompactionState,
	type SerializedBackgroundCompactionState,
	serializeBackgroundCompactionState,
} from "@bastani/atomic";
import type { Store } from "../../shared/store.js";

/**
 * The background compaction state a stage session reports now, ready for stage status. Undefined for a
 * session runtime without background compaction, such as a custom adapter.
 */
export function stageSessionCompaction(session: object | undefined): SerializedBackgroundCompactionState | undefined {
	const compaction = (session as { readonly compaction?: BackgroundCompactionState } | undefined)?.compaction;
	return compaction === undefined ? undefined : serializeBackgroundCompactionState(compaction);
}

/** Record a stage session's current background compaction state, when it has one. */
export function recordStageSessionCompaction(
	store: Pick<Store, "recordStageCompaction">,
	runId: string,
	stageId: string,
	session: object | undefined,
): void {
	const compaction = stageSessionCompaction(session);
	if (compaction !== undefined) store.recordStageCompaction(runId, stageId, compaction);
}
