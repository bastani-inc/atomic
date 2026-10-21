import { describeErrorWithCauses } from "../../shared/error-with-causes.js";
import { topLevelWorkflowRuns } from "../../shared/run-visibility.js";
import type { Store } from "../../shared/store.js";
import type { JobEntry, JobTracker } from "./job-tracker.js";

/**
 * Longest a closing session waits for runs that already ended in memory to finish recording their
 * ending. A journal that never answers must not hold the session open for ever.
 */
export const ENDED_RUN_SETTLEMENT_TIMEOUT_MS = 10_000;

export interface EndedRunSettlementFailure {
	readonly runId: string;
	readonly reason: "timed_out" | "failed";
	readonly message: string;
}

/** Settles when the run's executor has retired, which is after its ending reached the durable journal. */
export function awaitJobSettlement(job: JobEntry): Promise<void> {
	return job.outcome ?? job.promise;
}

/**
 * Wait, bounded, for the top-level runs whose ending the store already shows but whose executor is
 * still recording it durably. Runs still in flight are the quit path's business and are not awaited.
 */
export async function settleEndedRuns(opts: {
	readonly store: Pick<Store, "runs">;
	readonly jobs: JobTracker;
	readonly timeoutMs?: number;
}): Promise<readonly EndedRunSettlementFailure[]> {
	const timeoutMs = opts.timeoutMs ?? ENDED_RUN_SETTLEMENT_TIMEOUT_MS;
	const ending = topLevelWorkflowRuns(opts.store.runs()).flatMap((run) => {
		const job = run.endedAt === undefined ? undefined : opts.jobs.get(run.id);
		return job === undefined ? [] : [{ runId: run.id, job }];
	});
	if (ending.length === 0) return [];
	const deadline = Promise.withResolvers<void>();
	const timer = setTimeout(deadline.resolve, timeoutMs);
	// A closing session must not stay alive just to time out a journal that never answers.
	(timer as { unref?: () => void }).unref?.();
	try {
		const settled = await Promise.all(
			ending.map(({ runId, job }) =>
				Promise.race<EndedRunSettlementFailure | undefined>([
					awaitJobSettlement(job).then(
						() => undefined,
						(error: unknown) => ({
							runId,
							reason: "failed",
							message: describeErrorWithCauses(error),
						}),
					),
					deadline.promise.then(() => ({
						runId,
						reason: "timed_out",
						message: `still recording its ending after ${timeoutMs} ms`,
					})),
				]),
			),
		);
		return settled.filter((failure) => failure !== undefined);
	} finally {
		clearTimeout(timer);
	}
}
