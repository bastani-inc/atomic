import { randomUUID } from "node:crypto";
import type { Store } from "./store.js";

const routeCapabilitiesKey = Symbol.for("atomic-workflows/pending-stage-route-capabilities@1");
const processState = globalThis as typeof globalThis & Record<symbol, WeakMap<Store, Map<string, string>> | undefined>;
const routeCapabilities = processState[routeCapabilitiesKey] ?? new WeakMap<Store, Map<string, string>>();
processState[routeCapabilitiesKey] = routeCapabilities;

function capabilitiesFor(store: Store): Map<string, string> {
	let capabilities = routeCapabilities.get(store);
	if (capabilities === undefined) {
		capabilities = new Map();
		routeCapabilities.set(store, capabilities);
	}
	return capabilities;
}

/** Process-private authority shared only by one workflow owner and its stage sessions. */
export function workflowPendingStageRouteCapability(store: Store, runId: string): string {
	const capabilities = capabilitiesFor(store);
	let capability = capabilities.get(runId);
	if (capability === undefined) {
		capability = randomUUID();
		capabilities.set(runId, capability);
	}
	return capability;
}

export function rotateWorkflowPendingStageRouteCapability(store: Store, runId: string): string {
	const capability = randomUUID();
	capabilitiesFor(store).set(runId, capability);
	return capability;
}
