import { sleep } from "./sleep.ts";

type FetchInput = Parameters<typeof fetch>[0];

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Whether a response status is one this helper treats as transient and retries. */
export function isRetryableStatus(status: number): boolean {
	return RETRYABLE_STATUS_CODES.has(status);
}

export interface FetchRetryOptions {
	/** Number of additional attempts after the initial request. Defaults to two. */
	maxRetries?: number;
	/** Retry transient HTTP responses as well as transport failures. Defaults to true. */
	retryOnStatus?: boolean;
	/** Overall timeout shared by all attempts. */
	timeoutMs?: number;
	/** Per-attempt timeout; timed-out attempts remain retryable. */
	attemptTimeoutMs?: number;
	/**
	 * Wait before a retry, in milliseconds. Called once per failed attempt that
	 * will be retried, with the zero-based attempt index and what failed it: a
	 * retryable HTTP response (body already cancelled; headers such as Retry-After
	 * are still readable) or the thrown transport error. The wait is abandoned by
	 * caller cancellation and by the overall timeout. A callback that throws ends
	 * the loop with that error, so a caller can stop retrying on its own terms.
	 * Default: no wait, which is what the management callers expect.
	 */
	retryDelayMs?: (attempt: number, response: Response | undefined, error: unknown) => number;
}

/**
 * Fetch a management HTTP resource with a bounded immediate retry.
 *
 * This is intentionally a transport-level helper for idempotent management
 * requests (version checks, catalogs, and downloads). It must not be used for
 * agent/model operations: those can fail after the HTTP request starts and are
 * retried by their semantic caller instead.
 *
 * Caller cancellation is terminal. When timeoutMs is supplied, it is the
 * overall time budget shared by all attempts.
 */
export async function fetchWithRetry(
	input: FetchInput,
	init: RequestInit | undefined = undefined,
	options: FetchRetryOptions = {},
): Promise<Response> {
	const maxRetries =
		options.maxRetries === undefined || !Number.isFinite(options.maxRetries)
			? 2
			: Math.max(0, Math.floor(options.maxRetries));
	const retryOnStatus = options.retryOnStatus ?? true;
	const parentSignal = init?.signal;
	const timeoutSignal =
		options.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
	const attemptTimeoutMs =
		options.attemptTimeoutMs && options.attemptTimeoutMs > 0 ? options.attemptTimeoutMs : undefined;

	for (let attempt = 0; ; attempt += 1) {
		parentSignal?.throwIfAborted();
		timeoutSignal?.throwIfAborted();
		const attemptTimeoutSignal = attemptTimeoutMs ? AbortSignal.timeout(attemptTimeoutMs) : undefined;
		const signals = [parentSignal, timeoutSignal, attemptTimeoutSignal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
		let retryResponse: Response | undefined;
		let retryError: unknown;
		try {
			const response = await fetch(input, signal ? { ...init, signal } : init);
			const shouldRetry = retryOnStatus && RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries;
			if (!shouldRetry) return response;
			retryResponse = response;
			try {
				await response.body?.cancel();
			} catch {
				// The response is being discarded before a retry. Nothing useful remains
				// to do if cancelling its body also fails.
			}
		} catch (error) {
			const attemptTimedOut =
				attemptTimeoutSignal?.aborted === true && !parentSignal?.aborted && !timeoutSignal?.aborted;
			if (
				parentSignal?.aborted ||
				timeoutSignal?.aborted ||
				(error instanceof Error &&
					error.name === "AbortError" &&
					!attemptTimedOut &&
					timeoutSignal === undefined) ||
				attempt >= maxRetries
			) {
				throw error;
			}
			retryError = error;
		}
		const delayMs = options.retryDelayMs?.(attempt, retryResponse, retryError) ?? 0;
		await waitBeforeRetry(delayMs, parentSignal, timeoutSignal);
	}
}

/**
 * Sleep for a retry delay unless the caller or the overall budget aborts first,
 * in which case the abort reason is thrown, exactly as the next attempt would
 * have thrown it.
 */
async function waitBeforeRetry(delayMs: number, ...signals: (AbortSignal | null | undefined)[]): Promise<void> {
	if (!(delayMs > 0)) return;
	const active = signals.filter((signal): signal is AbortSignal => signal !== undefined && signal !== null);
	const signal = active.length > 1 ? AbortSignal.any(active) : active[0];
	try {
		await sleep(delayMs, signal);
	} catch (error) {
		for (const candidate of active) candidate.throwIfAborted();
		throw error;
	}
}
