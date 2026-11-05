import {
	type BackgroundCompactionState,
	type SerializedBackgroundCompactionState,
	serializeBackgroundCompactionState,
} from "@bastani/atomic";

/**
 * The background compaction state a stage session reports now, ready for stage status. Undefined for a
 * session runtime without background compaction, such as a custom adapter.
 */
export function stageSessionCompaction(session: object | undefined): SerializedBackgroundCompactionState | undefined {
	const compaction = (session as { readonly compaction?: BackgroundCompactionState } | undefined)?.compaction;
	return compaction === undefined ? undefined : serializeBackgroundCompactionState(compaction);
}
