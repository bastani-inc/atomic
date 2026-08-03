import type { Store } from "./store-public-types.js";
import type { StoreSnapshot } from "./store-types.js";

export function readGraphStoreSnapshot(store: Store): StoreSnapshot {
	return store.graphSnapshot();
}

export function subscribeStoreInvalidation(store: Store, listener: () => void): () => void {
	return store.subscribeInvalidation(listener);
}
