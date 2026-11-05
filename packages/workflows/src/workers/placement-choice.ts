import type { PoolClaimCandidate, PoolWork } from "../durable/journal/sql-pool-queue.js";
import type { WorkspaceBinding } from "./workspace-binding.js";

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
 * warm (`warm` returns its worktree), else the oldest work without a binding or bound work it can restore. Bound work it
 * can neither find warm nor restore is never chosen, however long it has waited. Undefined when nothing fits.
 */
export async function choosePlacement(
	candidates: readonly PoolClaimCandidate[],
	warm: (binding: WorkspaceBinding) => Promise<string | undefined>,
	canRestore: boolean,
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
		if (canRestore) fallback ??= { candidate, restore: true };
	}
	return fallback;
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
		/** How long the work has waited ready and unclaimed, as this coordinator saw it. */
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
