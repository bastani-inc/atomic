import { isStaleLeaseError } from "../durable/journal/types.js";
import { type SerializedError, serializeError } from "../shared/error-codec.js";
import {
	causedByStaleWorkLease,
	isWorkAttemptFencedError,
	WorkAttemptFencedError,
	type WorkAttemptFencedFields,
} from "../shared/worker-pool-errors.js";
import {
	isAdmissionHolderStoppedError,
	isQuarantinedCapacityError,
	runInfrastructureFault,
} from "../shared/workflow-infrastructure-error.js";
import { typedRunFault } from "./worker-refusal.js";
import type { WorkerReplyState } from "./worker-replies.js";

/**
 * How one attempt of a worker ends without failing the worker: its replies fenced it, or it ran into a fault of the
 * pool, which the `fenced` request then reports typed so the pool can name it when the child runs out of attempts.
 */
export class AttemptFence {
	/** The fault of the pool the attempt ended on, if one did. */
	private fault: Error | undefined;

	constructor(
		private readonly replies: WorkerReplyState,
		private readonly attempt: WorkAttemptFencedFields,
	) {}

	/**
	 * Capacity that only quarantined permits held was refused, or the pool stopped the admission's holder (#4179): a
	 * fault of the pool, so the attempt ends once on it and `controller` aborts its run, whatever the caller does with
	 * the error.
	 */
	refuseAdmission(error: unknown, controller: AbortController): void {
		if (this.replies.attemptFenced || !(isQuarantinedCapacityError(error) || isAdmissionHolderStoppedError(error)))
			return;
		this.end(error);
		controller.abort(new WorkAttemptFencedError(this.attempt, { cause: error }));
	}

	/**
	 * What the attempt ends with instead of completing with `result`: a fence its replies set meanwhile, or the fault of
	 * the pool the run failed on (a stale lease or admission, a lost delivery, refused storage), typed from `classified`,
	 * the errors the run classified as failures. Undefined when `result` is the child's own outcome.
	 */
	instead(
		result: Parameters<typeof runInfrastructureFault>[0],
		classified: readonly unknown[],
	): WorkAttemptFencedError | undefined {
		if (this.replies.attemptFenced) return new WorkAttemptFencedError(this.attempt);
		const recorded = runInfrastructureFault(result);
		if (recorded === undefined) return undefined;
		const fault = typedRunFault(recorded, classified);
		this.end(fault);
		return new WorkAttemptFencedError(this.attempt, { cause: fault });
	}

	/** The request that ends the attempt at the pool, with the fault it ended on. */
	request(): { readonly kind: "fenced"; readonly fault?: SerializedError } {
		return { kind: "fenced", ...(this.fault === undefined ? {} : { fault: serializeError(this.fault) }) };
	}

	private end(fault: Error): void {
		this.fault = fault;
		this.replies.attemptFenced = true;
	}
}

/**
 * Whether a heartbeat refusal is expected while a fenced attempt's stage sessions close: the attempt was fenced, or,
 * once the worker no longer holds it, its work lease or the root's lease is stale.
 */
export function endedAttemptRefusal(error: unknown): boolean {
	return isWorkAttemptFencedError(error) || causedByStaleWorkLease(error) || isStaleLeaseError(error);
}
