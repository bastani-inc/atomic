import { isBoundWorkspace } from "@bastani/atomic";
import type { PoolClaimCandidate, PoolWork } from "../durable/journal/sql-pool-queue.js";
import type { WorkflowSerializableObject } from "../shared/types.js";
import { bindingIdentity, type WorkspaceBinding } from "./workspace-binding.js";

/** The ready work a worker host claims, and where it runs it: a warm worktree, or one restore resolves (#4310). */
export interface PlacementChoice {
	readonly candidate: PoolClaimCandidate;
	/** The warm worktree the work runs in, when the host has its tree. */
	readonly worktree?: string;
	/** The host restores the work's binding before it runs it. */
	readonly restore: boolean;
}

/**
 * Chooses which of the ready `candidates`, oldest first, a worker host claims: the oldest bound work whose tree it has
 * warm (`warm` returns its worktree), else the oldest work without a binding or bound work it can restore now
 * (`canRestore`). Bound work it can neither find warm nor restore is never chosen, however long it has waited.
 * Undefined when nothing fits.
 */
export async function choosePlacement(
	candidates: readonly PoolClaimCandidate[],
	warm: (binding: WorkspaceBinding) => Promise<string | undefined>,
	canRestore: (binding: WorkspaceBinding) => boolean,
): Promise<PlacementChoice | undefined> {
	let fallback: PlacementChoice | undefined;
	for (const candidate of candidates) {
		const binding = candidate.workspace;
		if (binding === undefined) {
			fallback ??= { candidate, restore: false };
			continue;
		}
		const worktree = await warm(binding);
		if (worktree !== undefined) return { candidate, worktree, restore: false };
		if (fallback === undefined && canRestore(binding)) fallback = { candidate, restore: true };
	}
	return fallback;
}

/**
 * The binding placement matches a pooled child by (#4310, #4416): on a shared pool, the #3109 workspace the child was
 * bound to with `ctx.workflow(child, { workspace })`, or else its root's binding. Its identity alone: the child's
 * bound worktree is a path on its root's host.
 */
export function childPlacement(
	shared: boolean,
	root: WorkspaceBinding | undefined,
	workspace: unknown,
): { readonly workspaceBinding?: WorkspaceBinding } {
	const binding = shared && isBoundWorkspace(workspace) ? bindingIdentity(workspace) : root;
	return binding === undefined ? {} : { workspaceBinding: binding };
}

/**
 * The execution a placed child runs with (#4310, #4416): in the warm or restored `worktree`, and a child bound to a
 * #3109 workspace bound to that worktree on this host, not to the path its root's host bound.
 */
export function placedExecution(execution: WorkflowSerializableObject, worktree: string): WorkflowSerializableObject {
	const workspace = execution.workspace;
	if (!isBoundWorkspace(workspace)) return { ...execution, cwd: worktree };
	return { ...execution, cwd: worktree, workspace: { ...(workspace as WorkflowSerializableObject), worktree } };
}

/** What the root's coordinator of a shared pool does about one work item that other hosts may run. */
export type SharedSettlement = "report-result" | "attempts-exhausted" | "claim-window-passed" | "none";

/**
 * What the root's own coordinator settles for one work item of this incarnation that other hosts may run (#4310): a
 * result another host recorded is reported to the root; a child released as often as its attempt limit allows fails;
 * bound work that waited unclaimed past the claim window is checked against the live hosts that could restore it.
 */
export function sharedSettlement(
	work: Pick<PoolWork, "state" | "epoch" | "execution">,
	context: {
		/** The root reported this work's result already. */
		readonly reported: boolean;
		/** One of this host's workers holds the work: its own completion reports it. */
		readonly heldHere: boolean;
		readonly epoch: number;
		/** Attempts the work had in this incarnation, and how many it may have. */
		readonly attempts: number;
		readonly maxAttempts: number;
		/** How long the work has waited for a host that runs it, as this coordinator saw it (see {@link boundWait}). */
		readonly readyForMs: number;
		readonly claimWindowMs: number;
	},
): SharedSettlement {
	if (work.state === "completed") return context.reported || context.heldHere ? "none" : "report-result";
	if (work.state !== "ready" || work.epoch !== context.epoch) return "none";
	if (context.attempts >= context.maxAttempts) return "attempts-exhausted";
	if (work.execution.workspaceBinding === undefined) return "none";
	return context.readyForMs >= context.claimWindowMs ? "claim-window-passed" : "none";
}

/** Since when, by the root's clock, a bound work item has waited at its `generation` for a host that runs it. */
export interface BoundWait {
	readonly since: number;
	readonly generation: number;
}

/**
 * How long a bound work item has waited for a host that runs it, as the root's coordinator follows it from `previous`
 * (#4416): from when it first saw the item ready at its generation. A claim put back unplaced, as a failed restore puts
 * it, leaves the generation as it was and the wait goes on; an attempt that ran starts it over. Undefined for work
 * without a binding and once the item is neither ready nor held.
 */
export function boundWait(
	previous: BoundWait | undefined,
	work: Pick<PoolWork, "state" | "generation" | "execution">,
	now: number,
): BoundWait | undefined {
	if (work.execution.workspaceBinding === undefined) return undefined;
	if (work.state === "leased") return previous;
	if (work.state !== "ready") return undefined;
	return previous?.generation === work.generation ? previous : { since: now, generation: work.generation };
}

/** How long, by `now`, work has waited as `wait` says; no time for work that waits for no host. */
export function waitedMs(wait: BoundWait | undefined, now: number): number {
	return wait === undefined ? 0 : now - wait.since;
}
