import type { PoolWork } from "../durable/journal/sql-pool-queue.js";
import {
	PublicationRejectedError,
	StaleWorkLeaseError,
	type StaleWorkLeaseReason,
} from "../shared/worker-pool-errors.js";

/** The root's view of a work's current attempt, from the coordinator's in-order attempt and fence events. */
export type AttemptView = Pick<PoolWork, "generation" | "worker" | "epoch"> & { readonly fenced: boolean };

/** Refuses `work` unless it is the attempt the root's view holds current, with the reason it is not. */
export function assertAttemptCurrent(
	root: string,
	current: AttemptView | undefined,
	work: Pick<PoolWork, "id" | "generation" | "worker" | "epoch">,
): void {
	const stale = (reason: StaleWorkLeaseReason) =>
		new StaleWorkLeaseError({ root, workId: work.id, generation: work.generation, reason });
	if (current === undefined) throw stale("missing");
	if (current.fenced) throw stale("fenced");
	if (current.generation !== work.generation) throw stale("generation-mismatch");
	if (current.worker !== work.worker) throw stale("worker-mismatch");
	if (current.epoch !== work.epoch) throw stale("epoch-mismatch");
}

/** The coordinator's record of a work's attempt for routing: the runs it published, and whether the root fenced it. */
export interface RouteAttempt {
	readonly generation: number;
	readonly runs: ReadonlySet<string>;
	readonly fenced: boolean;
}

/** Refuses a route to `runId` unless `work`'s current, unfenced attempt published that run. */
export function assertRouteOwned(
	root: string,
	attempt: RouteAttempt | undefined,
	work: Pick<PoolWork, "id" | "generation">,
	runId: string,
): void {
	const stale = (reason: StaleWorkLeaseReason) =>
		new StaleWorkLeaseError({ root, workId: work.id, generation: work.generation, reason });
	if (attempt === undefined) throw stale("missing");
	if (attempt.generation !== work.generation) throw stale("generation-mismatch");
	if (attempt.fenced) throw stale("fenced");
	if (!attempt.runs.has(runId))
		throw new PublicationRejectedError({
			root,
			workId: work.id,
			generation: work.generation,
			reason: "outside-subtree",
			runId,
		});
}
