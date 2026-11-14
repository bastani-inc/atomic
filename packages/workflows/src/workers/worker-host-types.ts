import type { RunJournalOption } from "../durable/journal/resolution.js";
import type { SharedPoolStats, WorkerHostGitSource } from "../durable/journal/shared-pool-types.js";
import type { SerializedWorkerPlacementError } from "./placement-errors.js";
import type { WorkspacePreference, WorkspaceRestore } from "./workspace-binding.js";

/** A journal selected through a storage adapter, which every host opens the same way. */
export type SharedJournalSelection = Extract<RunJournalOption, { readonly adapter: string }>;

/** A git executable a worker host runs instead of the one `resolveGit()` from `@bastani/atomic` resolves. */
export interface WorkerHostGit {
	readonly path: string;
	readonly env: Readonly<Record<string, string>>;
}

export interface WorkflowWorkerHostOptions {
	/**
	 * The shared journal, selected as every host selects it: a storage adapter such as libSQL/Turso. Default: the
	 * journal this machine selects for workflow runs (`workflows.journal` or `storage` in settings, or the environment),
	 * for example after `atomic team join`.
	 */
	readonly journal?: SharedJournalSelection;
	/** The agent directory the journal's secrets and this host's local pool state resolve against. */
	readonly agentDir?: string;
	/** Most workers this host runs at once, across every root it serves. */
	readonly maxWorkers: number;
	/** Free-form labels this host reports in the pool's host registry and stats. */
	readonly labels?: Readonly<Record<string, string>>;
	/** This host's id in the pool's registry. Default: the id this machine keeps in its pool state directory. */
	readonly hostId?: string;
	readonly placement?: {
		/**
		 * The path of a worktree on this host whose current tree is `binding.tree`, or undefined. Work whose tree this host
		 * has warm is claimed first and runs there.
		 */
		readonly prefer?: WorkspacePreference;
	};
	/**
	 * Makes a binding's tree available on this host and resolves a verified worktree path, or rejects typed. Default:
	 * the worktree snapshot restore, which rebuilds the tree, uncommitted and unpushed content included, from the snapshot
	 * the work carries (`options.snapshot`, captured by its root when it dispatched the work), or else from the snapshots
	 * recorded in the shared journal and the binding's remotes, and runs only where this host has git already. `false`:
	 * none. Without a restore, or without git, this host takes bound work only when its tree is warm here. A binding
	 * whose restore fails waits a backoff before this host tries it again.
	 */
	readonly restore?: WorkspaceRestore | false;
	/**
	 * How this host runs git. Default: the git `resolveGit()` from `@bastani/atomic` resolves. A host given a `restore`
	 * function is provisioned a portable git when this machine has none; any other host never downloads one.
	 */
	readonly git?: WorkerHostGit;
	/**
	 * Drains and stops this host by itself once none of its workers ran a child for this many milliseconds (#4768), for
	 * a group of hosts that scales to zero without a controller. `closed` settles when it has stopped. Unset: never.
	 */
	readonly idleExitMs?: number;
	/** Receives what this host does as it happens: children claimed and released, journal outages, idle exit (#4768). */
	readonly onEvent?: (event: WorkflowWorkerHostEvent) => void;
	/** Internal, tests only: the module forked for each worker instead of the shipped worker entry. */
	readonly workerEntry?: string;
}

/**
 * What a worker host reports as it happens (#4768). `claimed` and `released` follow the children its workers hold:
 * a released child finished, or went back to the queue for another host. `degraded` is a poll of the shared journal
 * that failed: the host keeps its running children and polls again after `retryInMs`, waiting longer after each
 * failure in a row. `recovered` is the first poll that succeeded after one or more failed. `idle-exit` starts the
 * drain `idleExitMs` asks for.
 */
export type WorkflowWorkerHostEvent =
	| {
			readonly kind: "claimed" | "released";
			readonly root: string;
			readonly childRunId: string;
			readonly work: string;
			readonly generation: number;
	  }
	| {
			readonly kind: "degraded";
			readonly failures: number;
			readonly retryInMs: number;
			readonly error: WorkerHostFailure;
	  }
	| { readonly kind: "recovered"; readonly failures: number }
	| { readonly kind: "idle-exit"; readonly idleMs: number };

/** A failure a worker host recorded instead of throwing, as the error it was. */
export type WorkerHostFailure = SerializedWorkerPlacementError | { readonly name: string; readonly message: string };

export interface WorkflowWorkerHostStats {
	readonly hostId: string;
	readonly labels: Readonly<Record<string, string>>;
	/** Where this host's git comes from, so placement can tell whether it can restore a binding. */
	readonly git: WorkerHostGitSource;
	/** Whether this host takes bound work it does not have warm: it has a restore port and git. */
	readonly restore: boolean;
	readonly maxWorkers: number;
	/** Workers this host runs now, and how many of them run a child. */
	readonly workers: number;
	readonly busy: number;
	/** Queue depth, per-host workers and lease ages of each root this host serves. */
	readonly roots: readonly SharedPoolStats[];
	/** The last placement failure (a `prefer` or `restore` that failed), and why this host last stopped serving a root. */
	readonly lastPlacementFailure?: WorkerHostFailure;
	readonly lastDetach?: WorkerHostFailure;
	/** The last health warning of this host's workers, such as a worker cleanup it could not confirm. */
	readonly lastHealth?: string;
	/**
	 * Set while the host's polls of the shared journal fail (#4768): how many failed in a row, the last failure, and
	 * when, by `Date.now()`, the first of them failed. Its running children keep running.
	 */
	readonly degraded?: {
		readonly failures: number;
		readonly since: number;
		readonly error: WorkerHostFailure;
	};
}

export interface WorkflowWorkerHost {
	readonly hostId: string;
	/** Stops at once: every worker stops, and the work they held goes back to the queue for other hosts. */
	stop(): Promise<void>;
	/** Takes no more work, lets every running child finish, then stops. */
	drain(): Promise<void>;
	stats(): Promise<WorkflowWorkerHostStats>;
	/**
	 * Settles once the host has stopped, whichever way: `stop()`, `drain()` or `idleExitMs`. It never rejects; the
	 * failure of a stop is that call's own.
	 */
	readonly closed: Promise<void>;
}
