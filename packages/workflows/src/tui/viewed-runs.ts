import { store as defaultStore } from "../shared/store.js";
import { currentWorkflowStore } from "../shared/store-factory.js";

const viewedRunsByStore = new WeakMap<object, Set<string>>();

export function viewedWorkflowRuns(store: object = defaultStore): Set<string> {
	const key = store === defaultStore ? currentWorkflowStore() : store;
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

export function markWorkflowRunViewed(runId: string | null | undefined, store: object = defaultStore): void {
	if (!runId) return;
	viewedWorkflowRuns(store).add(runId);
}
