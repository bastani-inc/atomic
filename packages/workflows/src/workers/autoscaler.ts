/**
 * Fleet autoscaling (#4768): the provisioner interface a fleet controller drives, and the policy that decides, from the
 * shared journal's queues and the provider's hosts, how many worker hosts a fleet runs. The policy is a pure function of
 * its inputs and the state it returned last tick, like the Kubernetes HPA's desired-replica computation: it scales on
 * queued demand (Ray's autoscaler), waits out a burst before it adds hosts, and removes only hosts that sat idle, never
 * one that holds work (Buildkite's elastic stack).
 */

import type { ProvisionedHost, WorkerFleetPolicyOptions } from "./fleet-types.js";
import { WorkerPlacementConfigError } from "./placement-errors.js";

export type { ProvisionedHost, WorkerFleetPolicyOptions, WorkerHostProvisioner } from "./fleet-types.js";

export type FleetPolicy = Required<WorkerFleetPolicyOptions>;

/** How long the fleet waits before it replaces a host after the second boot failure in a row, doubling after each. */
export const BOOT_BACKOFF = { firstMs: 30_000, maxMs: 600_000 } as const;

function checkInteger(field: string, value: number, minimum: number): number {
	if (!Number.isSafeInteger(value) || value < minimum)
		throw new WorkerPlacementConfigError(
			"sdk",
			`provisioner.${field}`,
			"invalid-option",
			`must be an integer of at least ${minimum}`,
		);
	return value;
}

/** `options` with their defaults, checked: each a non-negative integer, `workersPerHost` and timeouts positive. */
export function resolveFleetPolicy(options: WorkerFleetPolicyOptions): FleetPolicy {
	const workersPerHost = checkInteger("workersPerHost", options.workersPerHost ?? 4, 1);
	const policy: FleetPolicy = {
		minHosts: checkInteger("minHosts", options.minHosts ?? 0, 0),
		maxHosts: checkInteger("maxHosts", options.maxHosts ?? 10, 0),
		workersPerHost,
		scaleUpQueueDepth: checkInteger("scaleUpQueueDepth", options.scaleUpQueueDepth ?? workersPerHost, 0),
		scaleUpDelayMs: checkInteger("scaleUpDelayMs", options.scaleUpDelayMs ?? 20_000, 0),
		idleDrainMs: checkInteger("idleDrainMs", options.idleDrainMs ?? 300_000, 0),
		bootTimeoutMs: checkInteger("bootTimeoutMs", options.bootTimeoutMs ?? 600_000, 1),
	};
	if (policy.minHosts > policy.maxHosts)
		throw new WorkerPlacementConfigError(
			"sdk",
			"provisioner.minHosts",
			"invalid-option",
			`must not exceed maxHosts (${policy.maxHosts})`,
		);
	return policy;
}

/** One shared root's queue, as the policy counts it. */
export interface FleetRootDemand {
	readonly ready: number;
	readonly leased: number;
	/** The root's `admission.limits.session`: it never runs more children at once. */
	readonly sessionLimit?: number;
	/** The root starts no child now (its budget blocks it, or it is paused): only its running children count. */
	readonly blocked: boolean;
}

/** A provider's host, joined with what the shared journal knows of it. */
export interface FleetHostView {
	readonly id: string;
	readonly state: ProvisionedHost["state"];
	readonly since: number;
	/** It reports itself in the journal's host registry. */
	readonly registered: boolean;
	/** Children it holds. */
	readonly leased: number;
	/** The controller asked it to drain. */
	readonly draining: boolean;
}

export interface FleetObservation {
	/** By `Date.now()`. */
	readonly now: number;
	readonly roots: readonly FleetRootDemand[];
	readonly hosts: readonly FleetHostView[];
	/** Most hosts the fleet's rate limits keep busy, when they bound it. */
	readonly rateCapHosts?: number;
}

/** What the policy remembers from one tick to the next. */
export interface FleetPolicyState {
	/** Since when the queue has been deeper than `scaleUpQueueDepth`, or the fleet empty with work ready. */
	readonly overSince?: number;
	/** Since when each live host has held no child, by provider id. */
	readonly idleSince: Readonly<Record<string, number>>;
	/** Since when each host has been seen not registered, by provider id. */
	readonly unregisteredSince: Readonly<Record<string, number>>;
	/** Hosts that failed to boot in a row; a host that registers resets it. */
	readonly bootFailures: number;
	/** No host is added before this time, after repeated boot failures. */
	readonly holdUntil: number;
}

export const INITIAL_FLEET_STATE: FleetPolicyState = {
	idleSince: {},
	unregisteredSince: {},
	bootFailures: 0,
	holdUntil: 0,
};

export type FleetRemovalReason = "drained" | "boot-timeout" | "failed" | "stopped";

export type FleetAction =
	/** `provisioner.scaleTo(desired)`: `target` serving hosts, plus the hosts the provider keeps that do not serve. */
	| { readonly kind: "scale-up"; readonly target: number; readonly desired: number }
	/** Ask the idle host to drain: it takes no more children and leaves the registry. */
	| { readonly kind: "mark-draining"; readonly id: string }
	/** `provisioner.drain(id)`. */
	| { readonly kind: "remove"; readonly id: string; readonly reason: FleetRemovalReason };

export interface FleetPlan {
	/** Serving hosts the fleet should have. */
	readonly target: number;
	/** Hosts registered and serving, or holding work. */
	readonly live: number;
	/** Hosts started that have not registered yet. */
	readonly pending: number;
	readonly actions: readonly FleetAction[];
	readonly state: FleetPolicyState;
}

/** Children the roots can run at once: ready and running work, each root's capped by its session limit. */
function demand(roots: readonly FleetRootDemand[]): number {
	let total = 0;
	for (const root of roots) {
		const wanted = root.blocked ? root.leased : root.ready + root.leased;
		total += Math.min(wanted, root.sessionLimit ?? wanted);
	}
	return total;
}

/**
 * One tick of the fleet's policy: the serving hosts it should have, and what to do about the difference.
 *
 * - `target = clamp(minHosts, maxHosts, min(ceil(demand / workersPerHost), rateCapHosts))`.
 * - Hosts are added when there are fewer live and pending ones than `target`, and the queue has been deeper than
 *   `scaleUpQueueDepth` (or work is ready with no host at all) for `scaleUpDelayMs`; or at once below `minHosts`.
 * - A host is drained only when it held no child for `idleDrainMs` and the fleet is above `target`, oldest idle first.
 * - A host that does not register within `bootTimeoutMs`, or that its provider reports failed, is removed; the first
 *   such failure is replaced at once, and each further one in a row waits {@link BOOT_BACKOFF}, doubling.
 * - A host that holds a child is never drained or removed, whatever its state.
 */
export function planFleet(policy: FleetPolicy, observation: FleetObservation, state: FleetPolicyState): FleetPlan {
	const { now, hosts } = observation;
	const actions: FleetAction[] = [];
	const idleSince: Record<string, number> = {};
	const unregisteredSince: Record<string, number> = {};
	const removedIds = new Set<string>();
	let bootFailures = state.bootFailures;
	let holdUntil = state.holdUntil;
	const fail = () => {
		bootFailures++;
		holdUntil =
			bootFailures === 1 ? now : now + Math.min(BOOT_BACKOFF.maxMs, BOOT_BACKOFF.firstMs * 2 ** (bootFailures - 2));
	};
	const remove = (id: string, reason: FleetRemovalReason) => {
		actions.push({ kind: "remove", id, reason });
		removedIds.add(id);
	};
	const idle: { readonly id: string; readonly since: number }[] = [];
	let live = 0;
	let pending = 0;
	for (const host of hosts) {
		const draining = host.draining || host.state === "draining";
		// A host that booted since the last tick forgets the failures before it, whether or not it took work at once.
		if (host.registered && state.unregisteredSince[host.id] !== undefined) {
			bootFailures = 0;
			holdUntil = 0;
		}
		if (host.leased > 0) {
			// Busy: never touched. It counts as serving unless it is on its way out.
			if (!draining && host.state !== "stopped" && host.state !== "failed") live++;
			continue;
		}
		if (host.state === "stopped" || host.state === "failed") {
			if (host.state === "failed" && !draining) fail();
			remove(host.id, draining ? "drained" : host.state);
			continue;
		}
		if (draining) {
			// It drained and left the registry: remove it from the provider.
			if (!host.registered) remove(host.id, "drained");
			continue;
		}
		if (host.registered) {
			live++;
			const since = state.idleSince[host.id] ?? now;
			idleSince[host.id] = since;
			idle.push({ id: host.id, since });
			continue;
		}
		const unregistered = state.unregisteredSince[host.id] ?? now;
		if (now - unregistered >= policy.bootTimeoutMs) {
			fail();
			remove(host.id, "boot-timeout");
			continue;
		}
		unregisteredSince[host.id] = unregistered;
		pending++;
	}
	const ready = observation.roots.reduce((total, root) => total + (root.blocked ? 0 : root.ready), 0);
	const wanted = Math.min(
		Math.ceil(demand(observation.roots) / policy.workersPerHost),
		observation.rateCapHosts ?? Infinity,
	);
	const target = Math.max(policy.minHosts, Math.min(policy.maxHosts, wanted));
	const serving = live + pending;
	const over = ready > policy.scaleUpQueueDepth || (ready > 0 && serving === 0);
	const overSince = over ? (state.overSince ?? now) : undefined;
	if (
		serving < target &&
		now >= holdUntil &&
		(serving < policy.minHosts || (overSince !== undefined && now - overSince >= policy.scaleUpDelayMs))
	) {
		// The provider counts every host it lists until `drain` removes it: those that do not serve (draining, or busy
		// and failed or stopped) stay in the count, so the new count only ever adds hosts.
		const kept = hosts.filter((host) => !removedIds.has(host.id)).length;
		actions.push({ kind: "scale-up", target, desired: target + kept - serving });
	} else if (serving > target) {
		const drainable = idle
			.filter((host) => now - host.since >= policy.idleDrainMs)
			.sort((a, b) => a.since - b.since)
			.slice(0, serving - target);
		for (const host of drainable) {
			actions.push({ kind: "mark-draining", id: host.id });
			delete idleSince[host.id];
		}
	}
	return {
		target,
		live,
		pending,
		actions,
		state: {
			...(overSince === undefined ? {} : { overSince }),
			idleSince,
			unregisteredSince,
			bootFailures,
			holdUntil,
		},
	};
}
