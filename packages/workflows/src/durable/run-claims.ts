/**
 * In-process claims on durable runs. A resume and a fork of the same run exclude each other: a run
 * claimed for one is busy for the other until the claim settles.
 */
import type { Store } from "../shared/store.js";
import type { DurableWorkflowBackend } from "./backend.js";

type ClaimSet = WeakMap<DurableWorkflowBackend, Set<string>>;

/** Resumes admitted and not yet launched. */
export const pendingResumes: ClaimSet = new WeakMap();
/** Resume claims whose status transition has not settled. */
export const unsettledResumeClaims: ClaimSet = new WeakMap();
/** Forks reading or copying a source run. */
export const pendingForks: ClaimSet = new WeakMap();

export function claimsOf(claims: ClaimSet, backend: DurableWorkflowBackend): Set<string> {
	let set = claims.get(backend);
	if (set === undefined) {
		set = new Set();
		claims.set(backend, set);
	}
	return set;
}

export function hasResumeClaim(backend: DurableWorkflowBackend, runId: string): boolean {
	return pendingResumes.get(backend)?.has(runId) === true || unsettledResumeClaims.get(backend)?.has(runId) === true;
}

export function hasForkClaim(backend: DurableWorkflowBackend, runId: string): boolean {
	return pendingForks.get(backend)?.has(runId) === true;
}

/**
 * True when the live run store has an actively-executing (not ended, not quit)
 * run for `workflowId`. This is the only reliable signal that a durable
 * `running` handle is genuinely live in THIS process — distinguishing a real
 * double-resume from cross-session crash recovery.
 */
export function hasActiveLiveRun(store: Store | undefined, workflowId: string): boolean {
	if (store === undefined) return false;
	const run = store.run(workflowId);
	return run !== undefined && run.endedAt === undefined && run.exitReason !== "quit";
}
