import type { RetryDeadline } from "../types.ts";
import { wrapFetchPreservingAdmission } from "./request-admission.ts";
import { findTlsCertificateRefusal } from "./tls-certificate.ts";
import { RetryDeadlineError, retryDeadlineReached, sleepForRetry } from "./retry-sleep.ts";

export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

interface ProviderRetryOptions {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	/** Absolute performance.now() timestamp at or after which no retry may start. */
	retryDeadline?: RetryDeadline;
	signal?: AbortSignal;
	/** HTTP statuses that fail at once although the default policy would retry them. */
	noRetryStatuses?: readonly number[];
	/** Failures that fail at once although the default policy would retry them, for example a 429 for exhausted quota. */
	noRetry?: (error: Error) => boolean;
}

/** An SDK can queue for admission after its retry started. Guard its actual fetch as well. */
export class ProviderRetryTransport {
	readonly fetch: typeof globalThis.fetch;
	retrying = false;
	refusal?: RetryDeadlineError;

	readonly deadline: RetryDeadline;

	private constructor(deadline: RetryDeadline, fetch: typeof globalThis.fetch) {
		this.deadline = deadline;
		this.fetch = wrapFetchPreservingAdmission(fetch, (send) =>
			Object.assign((...args: Parameters<typeof fetch>) => {
				if (this.retrying && retryDeadlineReached(deadline)) {
					this.refusal = new RetryDeadlineError();
					throw this.refusal;
				}
				return send(...args);
			}, send),
		);
	}

	/** Guard even the first SDK fetch when the entire stream is already a retried assistant call. */
	static forRetriedCall(deadline: RetryDeadline, fetch = globalThis.fetch): typeof globalThis.fetch {
		const transport = new ProviderRetryTransport(deadline, fetch);
		transport.retrying = true;
		return transport.fetch;
	}

	static for(
		options: { retryDeadline?: RetryDeadline; maxRetries?: number; fetch?: typeof globalThis.fetch } | undefined,
	) {
		return options?.retryDeadline !== undefined && options.maxRetries !== 0
			? new ProviderRetryTransport(options.retryDeadline, options.fetch ?? globalThis.fetch)
			: undefined;
	}
}

interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

/** Mirrors the pinned OpenAI/Anthropic SDK retry policy; review when either SDK is upgraded. */
function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;

	if (error.status === undefined) return true;
	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		(typeof error.status === "number" && error.status >= 500)
	);
}

function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	error: ProviderError,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		// Keep the server's hint and the original failure so callers can still schedule around the reset.
		throw Object.assign(
			new Error(
				`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${error.message}`,
				{ cause: error },
			),
			{ status: error.status, retryAfterMs: delayMs },
		);
	}
	return delayMs;
}

function getRetryDelayMs(error: ProviderError, retryIndex: number, maxRetryDelayMs: number | undefined): number {
	const retryAfterMs = error.headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs, error);
	}

	const retryAfter = error.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		if (Number.isFinite(delayMs)) return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error);
	}

	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return exponentialDelay * (1 - Math.random() * 0.25);
}

function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 */
export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
	transport?: ProviderRetryTransport,
): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			if (transport) {
				transport.retrying = retriesRemaining < maxRetries;
				transport.refusal = undefined;
			}
			// Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
			return await request();
		} catch (error) {
			// SDKs can wrap a refusal from fetch as a retryable connection error.
			if (transport?.refusal) throw transport.refusal;
			if (options.signal?.aborted) throw createAbortError();
			if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error)) throw error;
			// The certificate is the same on the next attempt (#6114).
			if (findTlsCertificateRefusal(error) !== undefined) throw error;
			if (error.status !== undefined && options.noRetryStatuses?.includes(error.status)) throw error;
			if (options.noRetry?.(error)) throw error;

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			const delayMs = getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs);
			await sleepForRetry(Math.max(0, delayMs), options.signal, createAbortError);
			if (retryDeadlineReached(transport?.deadline ?? options.retryDeadline)) throw new RetryDeadlineError();
		} finally {
			if (transport) transport.retrying = false;
		}
	}
}
