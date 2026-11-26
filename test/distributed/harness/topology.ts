import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One database endpoint as the host sees it: Compose publishes each on 127.0.0.1. */
export interface Endpoint {
	readonly host: string;
	readonly port: number;
}

export interface RoleCredentials {
	readonly user: string;
	/** A file holding only the password, mode 600. */
	readonly passwordFile: string;
}

/**
 * What `test/distributed/run.mjs` started for a run, written to `<run dir>/topology.json` and named by
 * `ATOMIC_DISTRIBUTED_TOPOLOGY` for the scenario files.
 */
export interface DistributedTopology {
	readonly schemaVersion: 1;
	readonly runId: string;
	readonly runDir: string;
	readonly compose: {
		readonly project: string;
		readonly file: string;
		readonly envFile: string;
		readonly profiles: readonly string[];
	};
	readonly database: string;
	readonly primary: Endpoint;
	readonly pgbouncer: Endpoint;
	/** Undefined when the run has no replica (`--no-replica`). */
	readonly replica?: Endpoint;
	/** The CA that signed the servers' certificates, and one that did not. */
	readonly tls: { readonly ca: string; readonly decoyCa: string };
	readonly roles: {
		readonly owner: RoleCredentials;
		readonly runtime: RoleCredentials;
		readonly superuser: RoleCredentials;
		readonly pgbouncerAuth: RoleCredentials;
	};
	/** How many Atomic nodes the multi-node scenarios start. */
	readonly nodes: number;
	/** The seed of the run's random choices, so `--replay` makes the same ones. */
	readonly seed: number;
	/** The faults the database-fault scenario injects, in order. */
	readonly faults: readonly string[];
}

const topologyPath = process.env.ATOMIC_DISTRIBUTED_TOPOLOGY || undefined;

/** The run's topology, or undefined outside `test/distributed/run.mjs`. */
export const topology: DistributedTopology | undefined =
	topologyPath === undefined ? undefined : (JSON.parse(readFileSync(topologyPath, "utf8")) as DistributedTopology);

/** Why the distributed scenarios do not run here, or undefined when they do. */
export const distributedSkipReason =
	topology === undefined ? "ATOMIC_DISTRIBUTED_TOPOLOGY is not set: run test/distributed/run.mjs" : undefined;

export function requireTopology(): DistributedTopology {
	if (topology === undefined) throw new Error(distributedSkipReason);
	return topology;
}

/** A role's password, read from its file. */
export function passwordOf(role: RoleCredentials): string {
	return readFileSync(role.passwordFile, "utf8").trim();
}

/** `postgresql://<user>@<host>:<port>/<database>` with full TLS verification against the run's CA, or `ca`. */
export function postgresUrl(
	endpoint: Endpoint,
	user: string,
	options: { readonly ca?: string; readonly sslmode?: string } = {},
): string {
	const current = requireTopology();
	const query = new URLSearchParams({ sslmode: options.sslmode ?? "verify-full" });
	if (query.get("sslmode") !== "disable") query.set("sslrootcert", options.ca ?? current.tls.ca);
	return `postgresql://${user}@${endpoint.host}:${endpoint.port}/${current.database}?${query}`;
}

/**
 * Appends one event to the run's `events.jsonl`, which the report lists: faults as they start and end, and what each
 * scenario observed while they lasted.
 */
export function recordEvent(scenario: string, event: Record<string, unknown>): void {
	const current = topology;
	if (current === undefined) return;
	appendFileSync(
		join(current.runDir, "events.jsonl"),
		`${JSON.stringify({ at: new Date().toISOString(), scenario, ...event })}\n`,
	);
}
