import { WorkspaceRestoreUnavailableError, workspaceBindingIdentity } from "./placement-errors.js";

/**
 * The repository state a pooled child or stage runs against (#4310), shared with #4245 and #3109. `remotes`, `head`,
 * `tree` and `envHash` are its identity; `root`, `branch` and `worktree` are informational and never matched. Affinity
 * matches `tree`, with `remotes` identifying the repository. Shared placement never captures a binding: callers supply
 * one, and work without one has no affinity and no restore requirement.
 */
export interface WorkspaceBinding {
	remotes: string[];
	head: string;
	tree: string;
	envHash: string;
	root?: string;
	branch?: string;
	worktree?: string;
}

/** What a worker host passes its placement hooks: `signal` aborts when the host stops waiting for them. */
export interface WorkspaceHookOptions {
	readonly signal: AbortSignal;
}

/**
 * Makes a binding's tree available on this host: resolves the path of a verified worktree whose current tree is
 * `binding.tree`, or rejects with a typed error. Injected on the worker host; shared placement builds no restore of
 * its own. A host that stops aborts `signal` and no longer waits for it.
 */
export type WorkspaceRestore = (binding: WorkspaceBinding, options: WorkspaceHookOptions) => Promise<string>;

/**
 * Where a worker host already has a binding's tree: the path of a local worktree whose current tree equals
 * `binding.tree`, or undefined when it has none. Work it has warm is claimed first and runs there. A host that stops
 * aborts `signal` and no longer waits for it.
 */
export type WorkspacePreference = (
	binding: WorkspaceBinding,
	options: WorkspaceHookOptions,
) => string | undefined | Promise<string | undefined>;

/** The restore port of a host that has none: every bound restore is refused, typed. */
export const restoreUnavailable: WorkspaceRestore = (binding) =>
	Promise.reject(new WorkspaceRestoreUnavailableError("no-restore-port", workspaceBindingIdentity(binding)));

/** The identity of a binding as the queue matches it: its repository's remotes and its tree. */
export function workspaceAffinityKey(binding: Pick<WorkspaceBinding, "remotes" | "tree">): string {
	return JSON.stringify([[...binding.remotes].sort(), binding.tree]);
}

/** Whether `value` is a well-formed binding: the four identity fields, and the optional ones as strings. */
export function isWorkspaceBinding(value: unknown): value is WorkspaceBinding {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const binding = value as Record<string, unknown>;
	return (
		Array.isArray(binding.remotes) &&
		binding.remotes.every((remote) => typeof remote === "string") &&
		typeof binding.head === "string" &&
		typeof binding.tree === "string" &&
		typeof binding.envHash === "string" &&
		["root", "branch", "worktree"].every((key) => binding[key] === undefined || typeof binding[key] === "string")
	);
}
