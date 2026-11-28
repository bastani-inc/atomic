import { createTimeoutSignal } from "@bastani/atomic-timers";
import { raceWithAbortSignal } from "./abort.js";

const SDK_TIMER_MAX_MS = 2_147_483_647;

/** The OpenAI and Anthropic SDKs always arm a timer; never pass a delay that their timer interprets as 1 ms. */
export function sdkTimerBackstop(timeoutMs: number | undefined): { timeout?: number } {
	return timeoutMs === undefined ? {} : { timeout: Math.min(SDK_TIMER_MAX_MS, Math.ceil(timeoutMs)) };
}

/** Apply an explicit request deadline for one SDK attempt, not the retry sleep or the life of a returned stream. */
export async function withSdkRequestTimeout<T>(
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	request: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
	if (timeoutMs === undefined) return request(signal);
	const deadline = createTimeoutSignal(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
	try {
		requestSignal.throwIfAborted();
		return await raceWithAbortSignal(request(requestSignal), requestSignal);
	} catch (error) {
		if (deadline.signal.aborted && !signal?.aborted) {
			// Preserve the shape that makes a connection timeout retryable inside our SDK retry loop.
			throw Object.assign(new Error(`Provider request timed out after ${timeoutMs}ms`, { cause: error }), {
				name: "TimeoutError",
				status: undefined,
				headers: undefined,
			});
		}
		throw error;
	} finally {
		deadline.clear();
	}
}
