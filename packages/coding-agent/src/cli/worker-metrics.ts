/**
 * `atomic worker metrics` (#4768): the fleet's scaling signal over HTTP, for any autoscaler to act on. `/metrics` is
 * Prometheus text; `/scaling` is the JSON a KEDA `metrics-api` trigger reads (`valueLocation: desiredHosts`). Both give
 * counts only, never a host, root, URL or token, and read the shared store at most once per {@link READ_INTERVAL_MS}
 * however often they are scraped.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** The scaling signal, as the workflows package's `SharedPoolFleetScaling`. */
export interface WorkerFleetScaling {
	readonly desiredHosts: number;
	readonly desiredWorkers: number;
	readonly demand: number;
	readonly queueDepth: number;
	readonly running: number;
	readonly hosts: number;
	readonly busySlots: number;
	readonly idleSlots: number;
	readonly minHosts: number;
	readonly maxHosts: number;
	readonly workersPerHost: number;
}

/** What the metrics read of a fleet: the store's state, and the scaling signal once the store was read. */
export interface WorkerMetricsFleet {
	readonly fleet: { readonly store: { readonly state: "ok" | "degraded" | "unknown" } };
	readonly scaling?: WorkerFleetScaling;
}

/** The longest the metrics serve one read of the store: scrapes in between get the same answer. */
export const READ_INTERVAL_MS = 5_000;

const GAUGES: readonly (readonly [keyof WorkerFleetScaling, string, string])[] = [
	["desiredHosts", "atomic_fleet_desired_hosts", "Worker hosts the fleet's autoscaling policy wants."],
	[
		"desiredWorkers",
		"atomic_fleet_desired_workers",
		"Worker slots the policy wants: desired hosts times workers per host.",
	],
	[
		"demand",
		"atomic_fleet_demand",
		"Children the shared roots can run at once, each root capped by its session limit.",
	],
	["queueDepth", "atomic_fleet_queue_depth", "Ready children of shared roots that can start them now."],
	["running", "atomic_fleet_running", "Children running on worker hosts."],
	["hosts", "atomic_fleet_hosts", "Registered worker hosts that reported within 15 seconds."],
	["minHosts", "atomic_fleet_min_hosts", "The policy's minimum hosts."],
	["maxHosts", "atomic_fleet_max_hosts", "The policy's maximum hosts."],
	["workersPerHost", "atomic_fleet_workers_per_host", "The policy's workers per host."],
];

/** The fleet as Prometheus text exposition. Without a scaling signal, only the store's state. */
export function prometheusText(fleet: WorkerMetricsFleet): string {
	const state = fleet.fleet.store.state;
	const lines = [
		"# HELP atomic_fleet_store_up Whether the shared store answered the last read and took writes.",
		"# TYPE atomic_fleet_store_up gauge",
		`atomic_fleet_store_up ${state === "ok" ? 1 : 0}`,
	];
	const scaling = fleet.scaling;
	if (scaling !== undefined) {
		for (const [field, name, help] of GAUGES)
			lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${scaling[field]}`);
		lines.push(
			"# HELP atomic_fleet_slots Worker slots of live hosts, busy running a child or idle on hosts not draining.",
			"# TYPE atomic_fleet_slots gauge",
			`atomic_fleet_slots{state="busy"} ${scaling.busySlots}`,
			`atomic_fleet_slots{state="idle"} ${scaling.idleSlots}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

export interface WorkerMetricsServer {
	/** `host:port` it listens on. */
	readonly address: string;
	close(): Promise<void>;
}

/**
 * Serves `read`'s fleet on `host`:`port` (port 0 picks one). Reads are shared: a scrape within
 * {@link READ_INTERVAL_MS} of the last read, or while one runs, gets its answer. A read that throws answers 503.
 */
export async function serveWorkerMetrics(options: {
	readonly host: string;
	readonly port: number;
	readonly read: () => Promise<WorkerMetricsFleet>;
	readonly now?: () => number;
}): Promise<WorkerMetricsServer> {
	const now = options.now ?? Date.now;
	let last: { readonly at: number; readonly fleet: Promise<WorkerMetricsFleet> } | undefined;
	const current = (): Promise<WorkerMetricsFleet> => {
		if (last === undefined || now() - last.at >= READ_INTERVAL_MS) {
			const fleet = options.read();
			const entry = { at: now(), fleet };
			last = entry;
			// A failed read is not kept: the next scrape tries again.
			fleet.catch(() => {
				if (last === entry) last = undefined;
			});
		}
		return last.fleet;
	};
	const send = (response: ServerResponse, status: number, type: string, body: string) => {
		response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
		response.end(body);
	};
	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		const path = new URL(request.url ?? "/", "http://metrics").pathname;
		if (path !== "/metrics" && path !== "/scaling") return send(response, 404, "text/plain", "Not found\n");
		if (request.method !== "GET" && request.method !== "HEAD") {
			response.setHeader("allow", "GET, HEAD");
			return send(response, 405, "text/plain", "Method not allowed\n");
		}
		let fleet: WorkerMetricsFleet;
		try {
			fleet = await current();
		} catch {
			return send(response, 503, "text/plain", "The shared store could not be read.\n");
		}
		if (path === "/metrics")
			return send(response, 200, "text/plain; version=0.0.4; charset=utf-8", prometheusText(fleet));
		if (fleet.scaling === undefined)
			return send(
				response,
				503,
				"application/json",
				`${JSON.stringify({ error: "The shared store could not be read.", store: fleet.fleet.store.state })}\n`,
			);
		return send(response, 200, "application/json", `${JSON.stringify(fleet.scaling)}\n`);
	};
	const server = createServer((request, response) => {
		void handle(request, response);
	});
	// Bounded: a client that sends nothing, or reads slowly, is cut off.
	server.requestTimeout = 10_000;
	server.headersTimeout = 5_000;
	server.keepAliveTimeout = 5_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	return {
		address: `${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
