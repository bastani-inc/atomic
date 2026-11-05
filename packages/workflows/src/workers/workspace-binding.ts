import type { WorkspaceBinding } from "@bastani/atomic";
import { WorkspaceRestoreUnavailableError, workspaceBindingIdentity } from "./placement-errors.js";

/**
 * The repository state a pooled child or stage runs against (#4310): #4245's binding. `remotes`, `head`, `tree` and
 * `envHash` are its identity. Affinity matches `tree`, with `remotes` identifying the repository. Shared placement
 * never captures a binding: callers supply one, and work without one has no affinity and no restore requirement.
 */
export type { WorkspaceBinding };

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
