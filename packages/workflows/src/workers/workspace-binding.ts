import type { WorkspaceBinding, WorktreeSnapshot } from "@bastani/atomic";
import type { WorkflowWorktreeRestoreOutcome } from "../shared/worktree-restore-outcome.js";
import type { WorkerHostGit } from "./worker-host-types.js";

/**
 * The repository state a pooled child or stage runs against (#4310): #4245's binding. `remotes`, `head`, `tree` and
 * `envHash` are its identity. Affinity matches `tree`, with `remotes` identifying the repository. Shared placement
 * never captures a binding: callers supply one, and work without one has no affinity and no restore requirement.
 */
export type { WorkspaceBinding };

/** What a worker host passes its placement hooks: `signal` aborts when the host stops waiting for them. */
export interface WorkspaceHookOptions {
	readonly signal: AbortSignal;
	/** The git this host runs, as it was given or resolved: run it, with its environment, for the hook's git commands. */
	readonly git?: WorkerHostGit;
	/**
	 * For `restore`: the worktree snapshot the root captured of the work's bound worktree on its own host when it
	 * dispatched the work (#4492), uncommitted and unpushed content included. Restoring it, for example with
	 * `restoreWorktree(snapshot)`, rebuilds the tree the work runs on. Absent when the root had no worktree to capture.
	 */
	readonly snapshot?: WorktreeSnapshot;
}

/**
 * A worktree a restore made of a binding's tree with less than its recorded snapshot (#4738): `partial` says what it
 * holds and what is missing. The work runs there, and its stages are told.
 */
export interface RestoredWorkspace {
	readonly path: string;
	readonly partial?: WorkflowWorktreeRestoreOutcome;
}

/**
 * Makes a binding's tree available on this host: resolves the path of a verified worktree whose current tree is
 * `binding.tree`, or the tree of `options.snapshot` when the work carries one, or rejects with a typed error. A worker
 * host without one of its own restores the carried snapshot, or else from the worktree snapshots recorded in its
 * shared journal (#4416, #4492); when it cannot restore that exactly, it restores the best state it can reach and
 * resolves a {@link RestoredWorkspace} that says so (#4738). A host that stops aborts `signal` and no longer waits for
 * it.
 */
export type WorkspaceRestore = (
	binding: WorkspaceBinding,
	options: WorkspaceHookOptions,
) => Promise<string | RestoredWorkspace>;

/**
 * Where a worker host already has a binding's tree: the path of a local worktree whose current tree equals
 * `binding.tree`, or undefined when it has none. Work it has warm is claimed first and runs there. A host that stops
 * aborts `signal` and no longer waits for it.
 */
export type WorkspacePreference = (
	binding: WorkspaceBinding,
	options: WorkspaceHookOptions,
) => string | undefined | Promise<string | undefined>;

/** The identity of a binding as the queue matches it: its repository's remotes and its tree. */
export function workspaceAffinityKey(binding: Pick<WorkspaceBinding, "remotes" | "tree">): string {
	return JSON.stringify([[...binding.remotes].sort(), binding.tree]);
}

/** Whether `value` is a well-formed binding: the four identity fields. A #3109 bound workspace is one. */
export function isWorkspaceBinding(value: unknown): value is WorkspaceBinding {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const binding = value as Record<string, unknown>;
	return (
		Array.isArray(binding.remotes) &&
		binding.remotes.every((remote) => typeof remote === "string") &&
		typeof binding.head === "string" &&
		typeof binding.tree === "string" &&
		typeof binding.envHash === "string"
	);
}

/** The binding's identity fields alone, as a root records them: a #3109 bound workspace carries more. */
export function bindingIdentity(binding: WorkspaceBinding): WorkspaceBinding {
	return { remotes: [...binding.remotes], head: binding.head, tree: binding.tree, envHash: binding.envHash };
}
