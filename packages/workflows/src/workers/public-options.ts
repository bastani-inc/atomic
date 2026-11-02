export interface WorkflowAdmissionOptions {
	readonly limits?: { readonly session?: number; readonly process?: number };
	readonly userLimits?: { readonly session?: number; readonly process?: number };
	readonly userDatabase?: string;
	readonly host?: { readonly maxLoadPerCpu?: number; readonly minFreeMemoryBytes?: number };
}

export interface LocalWorkerOptions {
	readonly count: number;
	readonly definitions: readonly { readonly path: string; readonly exportName: string }[];
	readonly startupTimeoutMs?: number;
	readonly leaseMs?: number;
	/**
	 * Load per CPU (the one-minute load average divided by the CPU count) above which the stages of pooled children start
	 * one at a time, at most one every five seconds and in the order they asked, so an overloaded machine is not given
	 * a burst of stage starts while earlier ones are still starting. Running stages, the subagents they start and their
	 * tool processes are not held. Default {@link DEFAULT_POOLED_STAGE_START_MAX_LOAD_PER_CPU}; `0` turns the pacing
	 * off. Not saved with the root.
	 */
	readonly maxLoadPerCpu?: number;
	/**
	 * Resident memory, in bytes, past which a local worker is replaced once the child it runs ends: the worker exits
	 * cleanly between children and the pool starts a fresh one in its place, so whatever memory a long-lived worker
	 * accumulated goes back to the system. A running child is never interrupted. Unset: workers are never replaced for
	 * their memory. Not saved with the root.
	 */
	readonly maxWorkerRssBytes?: number;
}

/** Load per CPU above which pooled stages wait to start, unless `localWorkers.maxLoadPerCpu` says otherwise. */
export const DEFAULT_POOLED_STAGE_START_MAX_LOAD_PER_CPU = 3;

export interface WorkflowExecutionResources {
	readonly localWorkers?: LocalWorkerOptions;
	/**
	 * Set when the root's journal is in another database than the pool's: the machine whose pool database holds the
	 * root's work queue and leases, which only that machine's coordinator can see, and the name of that database.
	 */
	readonly coordinator?: { readonly host: string; readonly database: string };
	readonly admission?: WorkflowAdmissionOptions;
	readonly definitions?: readonly { readonly path: string; readonly exportName: string; readonly digest: string }[];
}
