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

/** How many resume admissions this process has made, the last one first numbered 1. */
let resumeAdmissions = 0;
/**
 * By backend, the number of each of its runs' last resume admission that started, or may still start, a replacement.
 * An admission belongs to the journal the backend writes: a run of another journal with the same id is another run.
 * The entries go with the backend.
 */
const lastResumeAdmissions: WeakMap<DurableWorkflowBackend, Map<string, number>> = new WeakMap();
/**
 * By backend, the number of each of its runs' admission in flight: claimed, and its replacement not admitted yet. Until
 * the replacement records its own start, the run still reads as the block or failure that admission replaces.
 */
const inFlightResumeAdmissions: WeakMap<DurableWorkflowBackend, Map<string, number>> = new WeakMap();

function admissionsOf(
	admissions: WeakMap<DurableWorkflowBackend, Map<string, number>>,
	backend: DurableWorkflowBackend,
): Map<string, number> {
	let runs = admissions.get(backend);
	if (runs === undefined) {
		runs = new Map();
		admissions.set(backend, runs);
	}
	return runs;
}

/**
 * The mark a resume request takes of the run it is about to resume, `target` (a run id or its prefix) of `backend`'s
 * journal, before any await (#5534): a resume admitted after the mark replaced what the request saw, so the request
 * resumes nothing more. While a resume of the run is in flight, the run still reads as what that resume replaces, so
 * the mark is taken before it. A request that does not know its backend yet has no claim of this process in flight.
 */
export function resumeAdmissionMark(target?: string, backend?: DurableWorkflowBackend): number {
	let mark = resumeAdmissions;
	if (target !== undefined && backend !== undefined)
		for (const [runId, admission] of inFlightResumeAdmissions.get(backend) ?? [])
			if (runId.startsWith(target)) mark = Math.min(mark, admission - 1);
	return mark;
}

/**
 * Whether a resume of `backend`'s run `runId` was admitted after `mark`: the block or failure seen at the mark was
 * resumed already.
 */
export function resumedSince(backend: DurableWorkflowBackend, runId: string, mark: number): boolean {
	return (lastResumeAdmissions.get(backend)?.get(runId) ?? 0) > mark;
}

/**
 * Records a resume admission of `backend`'s run `runId`; the caller makes it in the same turn as its last
 * {@link resumedSince} check, so of the requests that saw one block exactly one is admitted. The returned `settle` ends
 * the admission's flight once its replacement was admitted (`started`) or not: an admission that started no replacement
 * is withdrawn, as the block it would have replaced is still the run's, and a request that saw that block may resume it.
 */
export function admitResume(backend: DurableWorkflowBackend, runId: string): { settle(started: boolean): void } {
	const last = admissionsOf(lastResumeAdmissions, backend);
	const inFlight = admissionsOf(inFlightResumeAdmissions, backend);
	const previous = last.get(runId);
	const admission = ++resumeAdmissions;
	last.set(runId, admission);
	inFlight.set(runId, admission);
	return {
		settle(started) {
			if (inFlight.get(runId) === admission) inFlight.delete(runId);
			if (started || last.get(runId) !== admission) return;
			if (previous === undefined) last.delete(runId);
			else last.set(runId, previous);
		},
	};
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
	return run !== undefined && !run.restored && run.endedAt === undefined && run.exitReason !== "quit";
}
