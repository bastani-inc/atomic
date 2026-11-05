import type { SharedPoolStats } from "../durable/journal/sql-shared-pool.js";

/** What workflow status shows of a root's shared pool (#4310): its stats, or why they could not be read. */
export type SharedPoolStatus =
	| { readonly sharedPool: SharedPoolStats }
	| { readonly sharedPoolUnavailable: { readonly name: string; readonly message: string } };

function seconds(ms: number): string {
	return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** A shared pool's status as lines of text: queue depth, then each host, then each lease. */
export function sharedPoolStatusLines(status: SharedPoolStatus): string[] {
	if ("sharedPoolUnavailable" in status)
		return [`Shared pool stats unavailable: ${status.sharedPoolUnavailable.message}`];
	const stats = status.sharedPool;
	return [
		`${stats.ready} ready · ${stats.leased} leased · ${stats.completed} completed · ${stats.failed} failed · ${stats.pendingStageInputs} stage input${stats.pendingStageInputs === 1 ? "" : "s"} waiting`,
		...stats.hosts.map(
			(host) =>
				`host ${host.host}: ${host.workers} of ${host.maxWorkers} workers, ${host.leased} lease${host.leased === 1 ? "" : "s"}, git ${host.git}${host.restore ? ", restores" : ""}, seen ${seconds(host.heartbeatAgoMs)} ago`,
		),
		...stats.leases.map(
			(lease) =>
				`child ${lease.childRunId} on ${lease.host === "" ? "the root's host" : `host ${lease.host}`}: renewed ${seconds(lease.renewedAgoMs)} ago, expires in ${seconds(lease.expiresInMs)}`,
		),
	];
}
