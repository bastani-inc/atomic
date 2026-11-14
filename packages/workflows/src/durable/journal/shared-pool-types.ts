/** Types of a shared pool's state (#4310), with no runtime dependencies: the public SDK types import them. */

/** How a worker host's git is available to restore bindings: its own, provisioned by Atomic, or none. */
export type WorkerHostGitSource = "system" | "provisioned" | "unavailable";

/** A failure as status shows it: its error's name and message. */
export interface SharedPoolFailure {
	readonly name: string;
	readonly message: string;
}

/**
 * How a worker host reads in fleet status (#4768), first match wins: `stale` when it has not reported for 15 s,
 * `degraded` while its polls of the journal fail, `draining` while it lets its running children finish before it stops,
 * `busy` or `idle` by whether a worker runs a child, and `live` for a host of an older version, which does not report
 * that.
 */
export type SharedPoolHostState = "stale" | "degraded" | "draining" | "busy" | "idle" | "live";

/** What a worker host reports of itself on each heartbeat. */
export interface SharedPoolHostReport {
	readonly host: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly git: WorkerHostGitSource;
	readonly restore: boolean;
	readonly workers: number;
	/** The host's slots: how many workers it may run. */
	readonly maxWorkers: number;
	/** The roots this host serves. */
	readonly roots: readonly string[];
	/** Workers running a child (#4768). */
	readonly busy?: number;
	/** Whether the host takes no more work and stops once its running children finish (#4768). */
	readonly draining?: boolean;
	/** Set while the host's polls of the journal fail: how many in a row, and the last failure (#4768). */
	readonly degraded?: { readonly failures: number; readonly error: SharedPoolFailure };
}

/**
 * One worker host in the pool's registry, as it last reported itself. A host of an older version reports neither
 * `busy` nor `draining`; its state reads `live`.
 */
export interface SharedPoolHost extends SharedPoolHostReport {
	readonly heartbeatAgoMs: number;
	readonly state: SharedPoolHostState;
	/** How far the host's checkpoint shipping lags behind its children, once hosts ship checkpoints in the background. */
	readonly shipping?: {
		readonly lagMs: number;
		readonly pending: number;
		readonly error?: SharedPoolFailure;
	};
}

/**
 * The shared store as fleet status sees it (#4768). `ok`: it answered. `degraded`: it answered reads, but stopped
 * committing this process's writes; `message` says so and how to recover. `unknown`: the status read itself failed or
 * did not finish in time; `message` says why, and `hint` how to recover from a store that stopped taking writes.
 */
export interface SharedStoreHealth {
	readonly state: "ok" | "degraded" | "unknown";
	readonly message?: string;
	readonly hint?: string;
}

/** The autoscaling controller that holds the fleet's lease, once a fleet runs one. */
export interface SharedPoolFleetController {
	readonly holder: string;
	readonly epoch: number;
	readonly renewedAgoMs: number;
}

/** One decision or provider error of the autoscaling controller, once a fleet runs one. */
export interface SharedPoolScaleEvent {
	readonly seq: number;
	readonly agoMs: number;
	readonly kind: string;
	readonly target: number;
	readonly live: number;
	readonly reason: string;
	readonly error?: SharedPoolFailure;
}

/** A fleet-wide rate limit of one provider or model, once a fleet shares them. */
export interface SharedPoolRateLimit {
	readonly scope: string;
	/** How long every host still waits after a 429 of this scope; 0 when it does not. */
	readonly cooldownInMs: number;
}

/**
 * The state of the fleet a shared pool runs on (#4768): the shared store, and the queue of every running or paused
 * shared root. The fleet's hosts are the pool's `hosts`. Later fields stay absent until the fleet runs what fills them.
 */
export interface SharedPoolFleetStatus {
	readonly store: SharedStoreHealth;
	/** Ready and leased children of every running or paused shared root, and how many such roots there are. */
	readonly queue?: { readonly roots: number; readonly ready: number; readonly leased: number };
	readonly controller?: SharedPoolFleetController;
	/** The controller's latest decisions, newest first. */
	readonly scaleEvents?: readonly SharedPoolScaleEvent[];
	readonly rateLimits?: readonly SharedPoolRateLimit[];
}

/** Queue depth, hosts and leases of one root's shared pool, and the state of the fleet it runs on. */
export interface SharedPoolStats {
	readonly root: string;
	readonly ready: number;
	readonly leased: number;
	readonly completed: number;
	readonly failed: number;
	readonly pendingStageInputs: number;
	/** Every registered worker host, with the leases it holds of this root. */
	readonly hosts: readonly (SharedPoolHost & { readonly leased: number })[];
	readonly leases: readonly {
		readonly work: string;
		readonly childRunId: string;
		readonly worker: string;
		readonly host: string;
		readonly generation: number;
		readonly renewedAgoMs: number;
		readonly expiresInMs: number;
	}[];
	readonly fleet: SharedPoolFleetStatus;
}

/**
 * Every worker host registered in a journal, the pool stats of each running or paused root they serve, and the state of
 * the fleet (#4768). A store that could not be read gives no hosts and no roots, and says why in `fleet.store`.
 */
export interface SharedPoolFleet {
	readonly hosts: readonly SharedPoolHost[];
	readonly roots: readonly SharedPoolStats[];
	readonly fleet: SharedPoolFleetStatus;
}
