/**
 * In-process claims on durable runs. A resume and a fork of the same run exclude each other: a run
 * claimed for one is busy for the other until the claim settles.
 */
import { isRunIdPrefix, RUN_ID_PREFIX_LENGTH } from "../shared/run-id.js";
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

type Observer = (journal: DurableWorkflowBackend, row: object) => void;
// These indexes route only current callers. In particular the cold index owns no journal, run or start history.
const cold = new Map<string, Set<Observer>>();
const journals = new WeakMap<DurableWorkflowBackend, Map<string, Set<Observer>>>();

function subscribe(backend: DurableWorkflowBackend | undefined, target: string, observe: Observer): () => void {
	let routes = backend === undefined ? cold : journals.get(backend);
	if (routes === undefined) {
		routes = new Map();
		journals.set(backend!, routes);
	}
	const bucket = routes.get(target) ?? new Set<Observer>();
	routes.set(target, bucket);
	bucket.add(observe);
	return () => {
		bucket.delete(observe);
		if (bucket.size === 0) {
			routes.delete(target);
			if (backend !== undefined && routes.size === 0) journals.delete(backend);
		}
	};
}

const bindings = new WeakMap<ResumeAdmissionMark, (backend: DurableWorkflowBackend, target: string) => void>();

/** Narrow a pending selector as soon as its journal or canonical ID becomes known, without losing a start it saw. */
export function bindResumeAdmission(mark: ResumeAdmissionMark, backend: DurableWorkflowBackend, target: string): void {
	bindings.get(mark)?.(backend, target);
}

/** The caller owns its receipts, weakly keyed by the actual journal row. Leaving drops them all in one operation;
 * retiring a row invalidates only its own receipts, without visiting even another caller sharing its prefix. */
export async function withResumeAdmissionMark<T>(
	target: string,
	inherited: ResumeAdmissionMark | undefined,
	request: (resumed: ResumeAdmissionMark) => Promise<T>,
	signal?: AbortSignal,
	backend?: DurableWorkflowBackend,
): Promise<T> {
	if (inherited !== undefined) {
		if (backend !== undefined) bindResumeAdmission(inherited, backend, target);
		return request(inherited);
	}
	if (backend && typeof backend.resumeObservationKey !== "function") return request(() => false);
	let selected = target.toLowerCase();
	// Key by row first: a long-lived journal must not keep an empty receipt bucket after its run ends.
	let receipts: WeakMap<object, WeakSet<DurableWorkflowBackend>> | undefined;
	const observe: Observer = (journal, row) => {
		receipts ??= new WeakMap();
		let owners = receipts.get(row);
		if (!owners) {
			owners = new WeakSet();
			receipts.set(row, owners);
		}
		owners.add(journal);
	};
	const observedRow = (journal: DurableWorkflowBackend, id: string) => {
		if (!receipts || (backend !== undefined && backend !== journal)) return undefined;
		const row = journal.resumeObservationKey?.(id);
		return row && receipts.get(row)?.has(journal) ? row : undefined;
	};
	const mark: ResumeAdmissionMark = (journal, id) => observedRow(journal, id) !== undefined;
	let unsubscribe: (() => void) | undefined = subscribe(backend, selected, observe);
	bindings.set(mark, (journal, id) => {
		// A nested adapter may still receive the original prefix after its outer lookup resolved it.
		const requested = id.toLowerCase();
		const selector = selected.startsWith(requested) ? selected : requested;
		if (!unsubscribe || (journal === backend && selector === selected)) return;
		if (typeof journal.resumeObservationKey !== "function") {
			release();
			return;
		}
		unsubscribe();
		if (backend !== undefined && backend !== journal) receipts = undefined;
		else if (selector !== selected || !isRunIdPrefix(selector)) {
			const row = observedRow(journal, id);
			receipts = undefined;
			if (row) observe(journal, row);
		}
		backend = journal;
		selected = selector;
		unsubscribe = subscribe(journal, selector, observe);
	});
	const release = (): void => {
		unsubscribe?.();
		unsubscribe = undefined;
		receipts = undefined;
		backend = undefined;
		bindings.delete(mark);
	};
	if (signal?.aborted) release();
	else signal?.addEventListener("abort", release, { once: true });
	try {
		return await request(mark);
	} finally {
		signal?.removeEventListener("abort", release);
		release();
	}
}

/** A pending claim excludes competitors but is not a replacement until an executor actually starts. */
export function recordResumeStart(backend: DurableWorkflowBackend, runId: string): void {
	if (typeof backend.resumeObservationKey !== "function") return;
	const row = backend.resumeObservationKey(runId);
	if (!row) return;
	const id = runId.toLowerCase();
	const prefix = id.slice(0, RUN_ID_PREFIX_LENGTH);
	for (const routes of [journals.get(backend), cold]) {
		for (const selector of [id, prefix]) {
			const observers = routes?.get(selector);
			if (observers) for (const observe of observers) observe(backend, row);
		}
	}
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
