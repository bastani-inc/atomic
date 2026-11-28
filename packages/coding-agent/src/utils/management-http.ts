import { createTimeoutSignal } from "@bastani/atomic-timers";

type FetchInput = Parameters<typeof fetch>[0];

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface FetchRetryOptions {
	/** Number of additional attempts after the initial request. Defaults to two. */
	maxRetries?: number;
	/** Retry transient HTTP responses as well as transport failures. Defaults to true. */
	retryOnStatus?: boolean;
	/** Overall timeout shared by all attempts. */
	timeoutMs?: number;
	/** Per-attempt timeout; timed-out attempts remain retryable. */
	attemptTimeoutMs?: number;
}

/**
 * Fetch a management HTTP resource with bounded immediate retry. Only idempotent management requests use this
 * helper; model calls are retried by their semantic caller. If supplied, `read` consumes the accepted response under
 * the same deadlines, but a failed body read does not start another request.
 */
export function fetchWithRetry(input: FetchInput, init?: RequestInit, options?: FetchRetryOptions): Promise<Response>;
export function fetchWithRetry<T>(
	input: FetchInput,
	init: RequestInit | undefined,
	options: FetchRetryOptions,
	read: (response: Response) => Promise<T>,
): Promise<T>;
export async function fetchWithRetry<T>(
	input: FetchInput,
	init: RequestInit | undefined = undefined,
	options: FetchRetryOptions = {},
	read?: (response: Response) => Promise<T>,
): Promise<Response | T> {
	const maxRetries =
		options.maxRetries === undefined || !Number.isFinite(options.maxRetries)
			? 2
			: Math.max(0, Math.floor(options.maxRetries));
	const retryOnStatus = options.retryOnStatus ?? true;
	const parentSignal = init?.signal;
	const timeout =
		options.timeoutMs !== undefined && options.timeoutMs > 0 ? createTimeoutSignal(options.timeoutMs) : undefined;
	const timeoutSignal = timeout?.signal;
	const attemptTimeoutMs =
		options.attemptTimeoutMs && options.attemptTimeoutMs > 0 ? options.attemptTimeoutMs : undefined;

	try {
		for (let attempt = 0; ; attempt += 1) {
			parentSignal?.throwIfAborted();
			timeoutSignal?.throwIfAborted();
			const attemptTimeout = attemptTimeoutMs ? createTimeoutSignal(attemptTimeoutMs) : undefined;
			const signals = [parentSignal, timeoutSignal, attemptTimeout?.signal].filter(
				(signal): signal is AbortSignal => signal !== undefined,
			);
			const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
			try {
				let response: Response;
				try {
					response = await fetch(input, signal ? { ...init, signal } : init);
				} catch (error) {
					const attemptTimedOut =
						attemptTimeout?.signal.aborted === true && !parentSignal?.aborted && !timeoutSignal?.aborted;
					if (
						parentSignal?.aborted ||
						timeoutSignal?.aborted ||
						(error instanceof Error &&
							error.name === "AbortError" &&
							!attemptTimedOut &&
							timeoutSignal === undefined) ||
						attempt >= maxRetries
					)
						throw error;
					continue;
				}
				const shouldRetry = retryOnStatus && RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries;
				if (!shouldRetry) return read ? await read(response) : response;
				try {
					await response.body?.cancel();
				} catch {
					// The response is already being discarded before a retry.
				}
			} finally {
				attemptTimeout?.clear();
			}
		}
	} finally {
		timeout?.clear();
	}
}
