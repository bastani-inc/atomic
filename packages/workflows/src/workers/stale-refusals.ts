import { isStaleLeaseError } from "../durable/journal/types.js";
import { isStaleWorkLeaseError } from "../shared/worker-pool-errors.js";

/** A `catch` handler that lets a stale work lease end the step quietly and rethrows anything else. */
export function ignoreStaleWorkLease(error: unknown): void {
	if (!isStaleWorkLeaseError(error)) throw error;
}

/** A `catch` handler that lets a lost journal lease end the step quietly and rethrows anything else. */
export function ignoreStaleLease(error: unknown): void {
	if (!isStaleLeaseError(error)) throw error;
}
