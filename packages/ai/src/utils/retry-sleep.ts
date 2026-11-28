import { sleepFor } from "@bastani/atomic-timers";
import type { RetryDeadline } from "../types.ts";

/** Refuse an expired retry and let the timer owner deliver its usual timeout before returning. */
export function retryDeadlineReached(deadline: RetryDeadline | undefined): boolean {
	const at = typeof deadline === "number" ? deadline : deadline?.at;
	if (typeof at !== "number" || !(performance.now() >= at)) return false;
	if (typeof deadline === "object") deadline.onExpired();
	return true;
}

/** Distinguish a refused retry from an unrelated provider error when no abort event has fired. */
export class RetryDeadlineError extends Error {
	constructor(message = "Request aborted") {
		super(message);
		this.name = "AbortError";
	}
}

/** Resolve directly from the backoff timer; ordinary retries must not yield to other due timers. */
export function sleepForRetry(ms: number, signal: AbortSignal | undefined, abortError: () => Error): Promise<void> {
	if (!signal) return sleepFor(ms);
	return sleepFor(ms, { signal }).catch((error) => {
		throw signal.aborted ? abortError() : error;
	});
}
