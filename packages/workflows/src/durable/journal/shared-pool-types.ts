/** Types of a shared pool's state (#4310), with no runtime dependencies: the public SDK types import them. */

/** How a worker host's git is available to restore bindings: its own, provisioned by Atomic, or none. */
export type WorkerHostGitSource = "system" | "provisioned" | "unavailable";

/** One worker host in the pool's registry, as it last reported itself. */
export interface SharedPoolHost {
	readonly host: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly git: WorkerHostGitSource;
	readonly restore: boolean;
	readonly workers: number;
	readonly maxWorkers: number;
	/** The roots this host serves. */
	readonly roots: readonly string[];
	readonly heartbeatAgoMs: number;
}

/** Queue depth, hosts and leases of one root's shared pool. */
export interface SharedPoolStats {
	readonly root: string;
	readonly ready: number;
	readonly leased: number;
	readonly completed: number;
	readonly failed: number;
	readonly pendingStageInputs: number;
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
}

/** Every worker host registered in a journal, and the pool stats of each running or paused root they serve (#4768). */
export interface SharedPoolFleet {
	readonly hosts: readonly SharedPoolHost[];
	readonly roots: readonly SharedPoolStats[];
}
