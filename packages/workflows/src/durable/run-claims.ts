/**
 * In-process claims on durable runs. A resume and a fork of the same run exclude each other: a run
 * claimed for one is busy for the other until the claim settles.
 */
import { RUN_ID_PREFIX_LENGTH } from "../shared/run-id.js";
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

/** All requests for one exact ID or one short selector. A start stamps the resolved (ID, journal) once,
 * without visiting any callers, including callers whose journal is not known until after their first read. */
class ResumeWatch {
	private latest = 0n;
	private readonly readers = new Set<bigint>();
	private readonly starts = new Map<string, { latest: bigint; journals: WeakMap<DurableWorkflowBackend, bigint> }>();

	enter(): bigint {
		const ticket = ++this.latest;
		this.readers.add(ticket);
		return ticket;
	}

	start(backend: DurableWorkflowBackend, id: string): void {
		const journals = this.starts.get(id)?.journals ?? new WeakMap<DurableWorkflowBackend, bigint>();
		journals.set(backend, this.latest);
		// Keep IDs in order of last start so retirement only walks entries it can discard.
		this.starts.delete(id);
		this.starts.set(id, { latest: this.latest, journals });
	}

	observed(ticket: bigint, backend: DurableWorkflowBackend, id: string): boolean {
		return (this.starts.get(id)?.journals.get(backend) ?? 0n) >= ticket;
	}

	leave(ticket: bigint): boolean {
		this.readers.delete(ticket);
		const oldest = this.readers.values().next().value;
		if (oldest === undefined) return true;
		// Even when short-ID requests overlap continuously, keep only IDs a current request could have seen start.
		for (const [id, start] of this.starts) {
			if (start.latest >= oldest) break;
			this.starts.delete(id);
		}
		return false;
	}
}

const watching = new Map<string, ResumeWatch>();

/** Only outstanding requests need to remember replacements. The outer caller watches from before its first await;
 * nested resume paths share its mark. A prefix can watch several runs, but only the resolved journal and id count. */
export async function withResumeAdmissionMark<T>(
	target: string,
	inherited: ResumeAdmissionMark | undefined,
	request: (resumed: ResumeAdmissionMark) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (inherited !== undefined) return request(inherited);
	const selector = target.toLowerCase();
	let watch = watching.get(selector);
	if (watch === undefined) {
		watch = new ResumeWatch();
		watching.set(selector, watch);
	}
	const ticket = watch.enter();
	const release = (): void => {
		if (watch?.leave(ticket)) watching.delete(selector);
		watch = undefined;
	};
	if (signal?.aborted) release();
	else signal?.addEventListener("abort", release, { once: true });
	try {
		return await request((backend, id) => watch?.observed(ticket, backend, id) === true);
	} finally {
		signal?.removeEventListener("abort", release);
		release();
	}
}

/** A pending claim excludes competitors but is not a replacement until an executor actually starts. */
export function recordResumeStart(backend: DurableWorkflowBackend, runId: string): void {
	const id = runId.toLowerCase();
	watching.get(id)?.start(backend, runId);
	watching.get(id.slice(0, RUN_ID_PREFIX_LENGTH))?.start(backend, runId);
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
