import type { Workspace } from "@bastani/atomic";
import type { WorkspaceBinding } from "./workspace-binding.js";

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
	 * How often, in milliseconds, each worker's heartbeat renews its child's lease, reports its usage and reads pool
	 * control, in one request. An integer from 100 to half of `leaseMs`; a quarter of `leaseMs` when unset. Not saved
	 * with the root.
	 */
	readonly heartbeatMs?: number;
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

/** How long bound work may wait unclaimed before it fails, unless `workers.claimWindowMs` says otherwise. */
export const DEFAULT_PLACEMENT_CLAIM_WINDOW_MS = 60_000;

/**
 * Where a root's pooled children run (#4310). `placement: "shared"` keeps the pool's work queue, leases, admission state
 * and stage inputs in the root's journal, which must be a shared journal every host opens through a storage adapter
 * (libSQL/Turso), so worker hosts started with `startWorkflowWorkerHost` on other machines run the root's children, and
 * the root can resume on any host that opens the journal. Requires `localWorkers`. Saved with the root.
 */
export interface WorkflowWorkerPlacementOptions {
	readonly placement: "shared";
	/**
	 * The repository state the root's pooled children run against: a binding, a bound workspace, or a `workspace({ … })`
	 * value, which the root resolves when it starts and records as its binding. Work with a binding runs only on a host
	 * that has its tree warm or can restore it, never in the root's directory on another host. Unset: no affinity, and
	 * any host runs the children in the root's recorded working directory.
	 */
	readonly workspace?: WorkspaceBinding | Workspace;
	/**
	 * How long, in milliseconds, bound work may wait unclaimed while no live host can restore it, before the child fails
	 * with `WorkspaceRestoreUnavailableError`. Default {@link DEFAULT_PLACEMENT_CLAIM_WINDOW_MS}.
	 */
	readonly claimWindowMs?: number;
}

/** Shared placement as a root records it: its workspace resolved to the binding's identity. */
export type RecordedWorkerPlacement = Omit<WorkflowWorkerPlacementOptions, "workspace"> & {
	readonly workspace?: WorkspaceBinding;
};

export interface WorkflowExecutionResources {
	readonly localWorkers?: LocalWorkerOptions;
	/** Shared placement of the root's pooled children, its workspace resolved to a binding (#4310). */
	readonly workers?: RecordedWorkerPlacement;
	/**
	 * Set when the root's journal is in another database than the pool's: the machine whose pool database holds the
	 * root's work queue and leases, which only that machine's coordinator can see, and the name of that database.
	 */
	readonly coordinator?: { readonly host: string; readonly database: string };
	readonly admission?: WorkflowAdmissionOptions;
	readonly definitions?: readonly { readonly path: string; readonly exportName: string; readonly digest: string }[];
}
