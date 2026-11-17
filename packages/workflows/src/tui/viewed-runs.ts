import { store as defaultStore } from "../shared/store.js";
import { currentWorkflowStore } from "../shared/store-factory.js";

const viewedRunsByStore = new WeakMap<object, Set<string>>();
const viewedListenersByStore = new WeakMap<object, Set<() => void>>();

function resolveStoreKey(store: object = defaultStore): object {
	return store === defaultStore ? currentWorkflowStore() : store;
}

export function viewedWorkflowRuns(store: object = defaultStore): Set<string> {
	const key = resolveStoreKey(store);
	let viewed = viewedRunsByStore.get(key);
	if (viewed === undefined) {
		viewed = new Set();
		viewedRunsByStore.set(key, viewed);
	}
	return viewed;
}

export function resolveViewedWorkflowRuns(scope?: Set<string> | object): Set<string> {
	if (scope instanceof Set) return scope;
	return viewedWorkflowRuns(scope ?? defaultStore);
}

export function subscribeViewedWorkflowRuns(store: object = defaultStore, listener: () => void): () => void {
	const key = resolveStoreKey(store);
	let listeners = viewedListenersByStore.get(key);
	if (listeners === undefined) {
		listeners = new Set();
		viewedListenersByStore.set(key, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) viewedListenersByStore.delete(key);
	};
}

export function markWorkflowRunViewed(runId: string | null | undefined, store: object = defaultStore): void {
	if (!runId) return;
	const key = resolveStoreKey(store);
	const viewed = viewedWorkflowRuns(key);
	if (viewed.has(runId)) return;
	viewed.add(runId);
	const listeners = viewedListenersByStore.get(key);
	if (listeners === undefined) return;
	for (const listener of [...listeners]) listener();
}
