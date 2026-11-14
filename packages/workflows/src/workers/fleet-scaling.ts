/**
 * The fleet's scaling signal (#4768): the autoscaling policy's target and the queue and slots behind it, computed from a
 * shared journal's queues and registered hosts. `atomic worker status --json` and `atomic worker metrics` export it, so
 * KEDA, a cloud's scaling group or a script can scale worker hosts without a fleet controller.
 */

import type { SharedPoolFleetScaling, SharedPoolHost } from "../durable/journal/shared-pool-types.js";
import { type FleetRootDemand, fleetDemand, fleetTarget, resolveFleetPolicy } from "./autoscaler.js";
import type { WorkerFleetPolicyOptions } from "./fleet-types.js";

/** The scaling signal of `roots` and `hosts` under `policy` (defaults as a fleet controller's). */
export function fleetScaling(
	roots: readonly FleetRootDemand[],
	hosts: readonly SharedPoolHost[],
	policy: WorkerFleetPolicyOptions = {},
): SharedPoolFleetScaling {
	const resolved = resolveFleetPolicy(policy);
	const desiredHosts = fleetTarget(resolved, roots);
	let live = 0;
	let busySlots = 0;
	let idleSlots = 0;
	for (const host of hosts) {
		if (host.state === "stale") continue;
		live++;
		const busy = Math.min(host.maxWorkers, host.busy ?? 0);
		busySlots += busy;
		if (host.state !== "draining") idleSlots += host.maxWorkers - busy;
	}
	return {
		desiredHosts,
		desiredWorkers: desiredHosts * resolved.workersPerHost,
		demand: fleetDemand(roots),
		queueDepth: roots.reduce((total, root) => total + (root.blocked ? 0 : root.ready), 0),
		running: roots.reduce((total, root) => total + root.leased, 0),
		hosts: live,
		busySlots,
		idleSlots,
		minHosts: resolved.minHosts,
		maxHosts: resolved.maxHosts,
		workersPerHost: resolved.workersPerHost,
	};
}
