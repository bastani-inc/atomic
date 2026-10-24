import type { Store } from "./store.js";

/**
 * Intercom routes for runs whose broker connection lives outside this event loop.
 *
 * A local worker pool announces the pending-stage routes of its pooled runs from its
 * coordinator process, so the root's own pending-stage bridge must neither announce
 * those runs nor open broker clients for them. Their queued messages stay in the
 * root's store: a message that reaches the coordinator's route is handed to the
 * bridge registered for that store, and an undeliverable notice for a pooled run is
 * sent through the route that owns it.
 */
export interface ExternalRunRouteOwner {
	notifyUndeliverable(payload: Record<string, unknown>): Promise<boolean>;
}

/** Entry points of the pending-stage bridge registered for one store. */
export interface PendingStageMessageRouter {
	/** Routes one pending-stage message event; sets `handled` and `completion` when it claims the event. */
	route(payload: Record<string, unknown>): void;
	/** Records one broker notice of sticky live deliveries; sets `handled` and `completion` when it claims it. */
	sticky(payload: Record<string, unknown>): void;
}

interface Registry {
	readonly owners: WeakMap<Store, Map<string, ExternalRunRouteOwner>>;
	readonly routers: WeakMap<Store, PendingStageMessageRouter>;
}

// Shared across module copies: the extension bundle registers the bridge, the SDK bundle may own the pool.
const registryKey = Symbol.for("atomic-workflows/external-run-routes@1");
const processState = globalThis as typeof globalThis & Record<symbol, Registry | undefined>;
const registry: Registry = processState[registryKey] ?? { owners: new WeakMap(), routers: new WeakMap() };
processState[registryKey] = registry;

/** Marks `runId` as announced by `owner`; the store's bridge stops announcing it. */
export function claimExternalRunRoute(store: Store, runId: string, owner: ExternalRunRouteOwner): void {
	let owners = registry.owners.get(store);
	if (owners === undefined) {
		owners = new Map();
		registry.owners.set(store, owners);
	}
	owners.set(runId, owner);
}

export function externalRunRouteOwner(store: Store, runId: string): ExternalRunRouteOwner | undefined {
	return registry.owners.get(store)?.get(runId);
}

export function registerPendingStageMessageRouter(store: Store, router: PendingStageMessageRouter): () => void {
	registry.routers.set(store, router);
	return () => {
		if (registry.routers.get(store) === router) registry.routers.delete(store);
	};
}

export function pendingStageMessageRouter(store: Store): PendingStageMessageRouter | undefined {
	return registry.routers.get(store);
}
