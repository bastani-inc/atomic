import type {
	SharedPoolFleet,
	SharedPoolFleetStatus,
	SharedPoolHost,
	SharedPoolStats,
} from "../durable/journal/shared-pool-types.js";

/** What workflow status shows of a root's shared pool (#4310): its stats, or why they could not be read. */
export type SharedPoolStatus =
	| { readonly sharedPool: SharedPoolStats }
	| {
			readonly sharedPoolUnavailable: { readonly name: string; readonly message: string; readonly hint?: string };
	  };

function seconds(ms: number): string {
	return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A shared pool's queue depth on one line. */
function queueLine(stats: SharedPoolStats): string {
	return `${stats.ready} ready · ${stats.leased} leased · ${stats.completed} completed · ${stats.failed} failed · ${plural(stats.pendingStageInputs, "stage input")} waiting`;
}

/** One worker host on one line: its state, workers, busy workers and leases when known, git, and its last report. */
function hostLine(host: SharedPoolHost & { readonly leased?: number }): string {
	const parts: string[] = [host.state, `${host.workers} of ${host.maxWorkers} workers`];
	if (host.busy !== undefined) parts.push(`${host.busy} busy`);
	if (host.leased !== undefined) parts.push(plural(host.leased, "lease"));
	parts.push(`git ${host.git}`);
	if (host.restore) parts.push("restores");
	const labels = Object.entries(host.labels).map(([key, value]) => `${key}=${value}`);
	if (labels.length > 0) parts.push(`labels ${labels.join(",")}`);
	if (host.degraded !== undefined)
		parts.push(`${plural(host.degraded.failures, "poll")} failed: ${host.degraded.error.message}`);
	if (host.shipping !== undefined)
		parts.push(
			`shipping ${seconds(host.shipping.lagMs)} behind, ${host.shipping.pending} pending${host.shipping.error === undefined ? "" : `, ${host.shipping.error.message}`}`,
		);
	parts.push(`seen ${seconds(host.heartbeatAgoMs)} ago`);
	return `host ${host.host}: ${parts.join(", ")}`;
}

/**
 * The fleet's state as lines (#4768): the shared store when it is not `ok`, with the hint to recover it, the queue of
 * every shared root, and the controller, scale events and rate limits of a fleet that runs them.
 */
export function sharedFleetLines(fleet: SharedPoolFleetStatus): string[] {
	const lines: string[] = [];
	if (fleet.store.state !== "ok") {
		lines.push(
			`shared store ${fleet.store.state}${fleet.store.message === undefined ? "" : `: ${fleet.store.message}`}`,
		);
		if (fleet.store.hint !== undefined) lines.push(fleet.store.hint);
	}
	if (fleet.queue !== undefined)
		lines.push(
			`fleet: ${plural(fleet.queue.roots, "root")} · ${fleet.queue.ready} ready · ${fleet.queue.leased} leased`,
		);
	if (fleet.controller !== undefined)
		lines.push(
			`controller ${fleet.controller.holder} (epoch ${fleet.controller.epoch}), renewed ${seconds(fleet.controller.renewedAgoMs)} ago`,
		);
	for (const event of fleet.scaleEvents ?? [])
		lines.push(
			`scale ${event.kind}: target ${event.target}, live ${event.live}, ${event.reason}${event.error === undefined ? "" : `, ${event.error.message}`}, ${seconds(event.agoMs)} ago`,
		);
	for (const limit of fleet.rateLimits ?? [])
		lines.push(
			`rate limit ${limit.scope}: ${limit.cooldownInMs > 0 ? `cooling down for ${seconds(limit.cooldownInMs)}` : "open"}`,
		);
	return lines;
}

/** A shared pool's status as lines of text: queue depth, then the fleet, then each host, then each lease. */
export function sharedPoolStatusLines(status: SharedPoolStatus): string[] {
	if ("sharedPoolUnavailable" in status) {
		const { message, hint } = status.sharedPoolUnavailable;
		return [`Shared pool stats unavailable: ${message}`, ...(hint === undefined ? [] : [hint])];
	}
	const stats = status.sharedPool;
	return [
		queueLine(stats),
		...sharedFleetLines(stats.fleet),
		...stats.hosts.map(hostLine),
		...stats.leases.map(
			(lease) =>
				`child ${lease.childRunId} on ${lease.host === "" ? "the root's host" : `host ${lease.host}`}: renewed ${seconds(lease.renewedAgoMs)} ago, expires in ${seconds(lease.expiresInMs)}`,
		),
	];
}

/**
 * A shared journal's fleet as `atomic worker status` prints it (#4768): the fleet, then each registered host, then each
 * running or paused root with its queue and the hosts that hold its children. A store that could not be read shows
 * only why, and how to recover it.
 */
export function workflowWorkerFleetLines(fleet: SharedPoolFleet): string[] {
	const lines = sharedFleetLines(fleet.fleet);
	if (fleet.fleet.store.state === "unknown") return lines;
	lines.push(`Hosts: ${fleet.hosts.length}`, ...fleet.hosts.map((host) => `  ${hostLine(host)}`));
	lines.push(`Roots: ${fleet.roots.length}`);
	for (const root of fleet.roots) {
		const holders = root.hosts.filter((host) => host.leased > 0).map((host) => `${host.host}(${host.leased})`);
		lines.push(`  root ${root.root}: ${queueLine(root)}${holders.length === 0 ? "" : `, on ${holders.join(", ")}`}`);
	}
	return lines;
}
