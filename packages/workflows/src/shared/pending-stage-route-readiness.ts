import { raceAbort } from "./abort.js";
import type { Store } from "./store.js";

export interface WorkflowPendingStageRouteReadiness {
	readonly completion: Promise<void>;
	/** Recheck at admission: retirement may race an already fulfilled completion. */
	assertCurrent(): void;
}

type RouteReadiness = (runId: string) => Promise<void> | undefined;
const owners = new WeakMap<
	Store,
	{
		ready: (runId: string) => WorkflowPendingStageRouteReadiness | undefined;
		retire: () => void;
	}
>();

/** Private bridge lease: replacement must settle old waiters, never lend them new authority. */
export function registerWorkflowPendingStageRouteReadiness(store: Store, ready: RouteReadiness): () => void {
	owners.get(store)?.retire();
	const controller = new AbortController();
	const owner = {
		ready(runId: string) {
			const completion = ready(runId);
			return completion === undefined
				? undefined
				: {
						completion: raceAbort(completion, controller.signal),
						assertCurrent: () => controller.signal.throwIfAborted(),
					};
		},
		retire() {
			controller.abort(new Error("atomic-workflows: Intercom route authority owner retired before stage startup"));
		},
	};
	owners.set(store, owner);
	return () => {
		owner.retire();
		if (owners.get(store) === owner) owners.delete(store);
	};
}

/** Snapshot only this run's current publication; future roster updates never extend the wait. */
export function workflowPendingStageRouteReady(
	store: Store,
	runId: string,
): WorkflowPendingStageRouteReadiness | undefined {
	return owners.get(store)?.ready(runId);
}
