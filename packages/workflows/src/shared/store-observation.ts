import type { Store } from "./store-public-types.js";
import type { RunSnapshot, StoreSnapshot } from "./store-types.js";

export function readGraphStoreSnapshot(store: Store): StoreSnapshot {
	return store.graphSnapshot();
}

/** The run of `readGraphStoreSnapshot(store)` with this id, projecting no other run. */
export function readGraphStoreRun(store: Store, runId: string): RunSnapshot | undefined {
	return store.graphRun(runId);
}

export function subscribeStoreInvalidation(store: Store, listener: () => void): () => void {
	return store.subscribeInvalidation(listener);
}
