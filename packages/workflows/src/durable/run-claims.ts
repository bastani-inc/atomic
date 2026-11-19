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

export type ResumeAdmissionMark = (backend: DurableWorkflowBackend, runId: string) => boolean;
const watching = new Set<(backend: DurableWorkflowBackend, runId: string) => void>();

/** Only outstanding requests need to remember replacements. The outer caller watches from before its first await;
 * nested resume paths share its mark. A prefix can watch several runs, but only the resolved journal and id count. */
export async function withResumeAdmissionMark<T>(
	target: string,
	inherited: ResumeAdmissionMark | undefined,
	request: (resumed: ResumeAdmissionMark) => Promise<T>,
): Promise<T> {
	if (inherited !== undefined) return request(inherited);
	const replaced: ClaimSet = new WeakMap();
	const selector = target.toLowerCase();
	const observe = (backend: DurableWorkflowBackend, runId: string): void => {
		if (runId.toLowerCase().startsWith(selector)) claimsOf(replaced, backend).add(runId);
	};
	watching.add(observe);
	try {
		return await request((backend, runId) => replaced.get(backend)?.has(runId) === true);
	} finally {
		watching.delete(observe);
	}
}

/** A pending claim excludes competitors but is not a replacement until an executor actually starts. */
export function recordResumeStart(backend: DurableWorkflowBackend, runId: string): void {
	for (const observe of watching) observe(backend, runId);
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
