import { isStaleLeaseError } from "../durable/journal/types.js";
import { WorkAttemptFencedError, type WorkAttemptFencedFields } from "../shared/worker-pool-errors.js";
import {
	infrastructureFaultOf,
	isWorkflowInfrastructureError,
	WorkflowInfrastructureError,
} from "../shared/workflow-infrastructure-error.js";

/**
 * What a worker does with a refusal of one of its requests, decided by the refusal's type, never its text.
 * `root-lease-lost`: the root no longer holds its lease (`StaleLeaseError`), so the worker ends cleanly.
 * `fenced`: a fault of the pool, a stale work lease among them, ends the attempt, and the child replays.
 * `refused`: anything else is the request's own failure.
 */
export interface WorkerRefusal {
	readonly kind: "root-lease-lost" | "fenced" | "refused";
	/** What the request rejects with: a {@link WorkAttemptFencedError} caused by the refusal when an attempt ends. */
	readonly error: Error;
}

export function workerRefusal(refusal: Error, attempt: WorkAttemptFencedFields | undefined): WorkerRefusal {
	const kind = isStaleLeaseError(refusal)
		? "root-lease-lost"
		: infrastructureFaultOf(refusal) !== undefined
			? "fenced"
			: "refused";
	return {
		kind,
		error:
			kind === "refused" || attempt === undefined
				? refusal
				: new WorkAttemptFencedError(attempt, { cause: refusal }),
	};
}

/**
 * The fault a failed run ended its attempt on, as typed as the worker can make it. `recorded` is what the run's result
 * kept (its fault code, run and stage); `thrown` are the errors the run classified as failures. The first thrown error
 * with that fault code is the fault itself when it is a {@link WorkflowInfrastructureError}, or the `cause` of one
 * that names the recorded run and stage. Without one, `recorded` stands.
 */
export function typedRunFault(
	recorded: WorkflowInfrastructureError,
	thrown: readonly unknown[],
): WorkflowInfrastructureError {
	const fault = thrown.find((error) => infrastructureFaultOf(error) === recorded.code);
	if (fault === undefined) return recorded;
	if (isWorkflowInfrastructureError(fault)) return fault;
	return new WorkflowInfrastructureError(recorded.code, {
		runId: recorded.runId,
		stageId: recorded.stageId,
		cause: fault,
	});
}
