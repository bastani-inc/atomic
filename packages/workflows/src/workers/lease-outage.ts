import { setTimeout as delay } from "node:timers/promises";
import { infrastructureFaultOf } from "../shared/workflow-infrastructure-error.js";

/** The first bound on the wait before a request the storage refused is sent again; each later one doubles. */
const OUTAGE_RETRY_BASE_MS = 50;
/** The largest bound on that wait. */
const OUTAGE_RETRY_MAX_MS = 1_000;

/**
 * Sends `send` again while the storage refuses it (`storage_unavailable`: unreachable, or its write lock stayed busy)
 * and `leaseLeft()` says the attempt still holds its lease, waiting a random time up to a bound that doubles from
 * `OUTAGE_RETRY_BASE_MS` to `OUTAGE_RETRY_MAX_MS` between sends (#4768). Contention on a shared store slows a pooled
 * child down this way instead of ending its attempt, which would spend one of the child's retries on a fault that is
 * not its own. Any other failure, or one past the lease, goes to the caller.
 */
export async function retryWithinLease<T>(send: () => Promise<T>, leaseLeft: () => boolean): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await send();
		} catch (error) {
			if (infrastructureFaultOf(error) !== "storage_unavailable" || !leaseLeft()) throw error;
		}
		await delay(Math.random() * Math.min(OUTAGE_RETRY_MAX_MS, OUTAGE_RETRY_BASE_MS * 2 ** Math.min(attempt, 16)));
	}
}
