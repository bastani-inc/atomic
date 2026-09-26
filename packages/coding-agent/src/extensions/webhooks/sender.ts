/**
 * Delivers one rendered request body to one destination, with bounded retries.
 *
 * Transport is `fetchWithRetry` from utils/management-http, the package's
 * helper for idempotent management requests: it owns the attempt loop, the
 * per-attempt and overall timeouts, body cancellation before a retry, and the
 * rule that caller cancellation is terminal. This module adds what a webhook
 * needs on top: how long to wait between attempts (Retry-After when the server
 * sends one, a fixed backoff otherwise), a stop when the delivery window
 * cannot fit another attempt, and an outcome the notice can describe without
 * ever quoting the URL, a header, or the server's response body.
 *
 * Redirects are not followed. A destination URL is a bearer secret and its
 * Authorization header must not travel to wherever a 3xx points, so a redirect
 * is a permanent rejection carrying its status.
 *
 * A timed-out attempt may have been accepted by the receiver before the
 * response arrived, so an exhausted outcome says whether its last attempt
 * timed out; the notice then reads "may have been delivered" rather than
 * "failed", and the docs explain why a duplicate is possible.
 */
import { redactCredentialShapes } from "../../cli/credential-print.ts";
import { getErrnoCode } from "../../core/tools/errno.ts";
import { fetchWithRetry, isRetryableStatus } from "../../utils/management-http.ts";
import {
	WEBHOOK_DELIVERY_WINDOW_MS,
	WEBHOOK_RETRY_AFTER_MAX_MS,
	WEBHOOK_RETRY_BACKOFF_MS,
	WEBHOOK_SEND_ATTEMPTS,
	WEBHOOK_TIMEOUT_MS_DEFAULT,
} from "./constants.ts";
import type { WebhookDestination } from "./types.ts";

/** The parts of a destination the transport needs; the rest is routing and templating. */
export type WebhookSendTarget = Pick<WebhookDestination, "url" | "method" | "headers" | "timeoutMs">;

/**
 * What one delivery came to. `accepted` is any 2xx. `rejected` is a response
 * the sender will not retry: a 3xx (never followed) or a 4xx other than 408
 * and 429. `exhausted` is every attempt used, or the window used up, with the
 * last failure described safely. `cancelled` is the caller's own abort.
 */
export type WebhookSendOutcome =
	| { readonly kind: "accepted"; readonly status: number; readonly attempts: number }
	| { readonly kind: "rejected"; readonly status: number; readonly attempts: number }
	| {
			readonly kind: "exhausted";
			readonly attempts: number;
			/** Safe to show: a status, an errno code, or a redacted message. Never a URL or a header value. */
			readonly lastFailure: string;
			/** The last attempt hit its timeout, so the receiver may have accepted it. */
			readonly lastAttemptTimedOut: boolean;
	  }
	| { readonly kind: "cancelled" };

export interface WebhookSendOptions {
	/** Caller cancellation: a config change, a disabled destination, shutdown. Terminal. */
	readonly signal?: AbortSignal;
	/** Waits between attempts, indexed by the attempt that failed. Tests pass zeros to stay under the budget. */
	readonly backoffMs?: readonly number[];
	/** Overall window; tests shrink it to prove the stop. */
	readonly windowMs?: number;
	/** Clock for Retry-After dates and the window. */
	readonly now?: () => number;
}

/** What one attempt failed with, in words a notice may show. */
interface Failure {
	readonly text: string;
	/** The attempt hit its timeout, so the receiver may have accepted it. */
	readonly timedOut: boolean;
}

/** Thrown from the delay callback to end the loop before a wait that would outrun the window. */
class DeliveryWindowExhausted extends Error {
	readonly failure: Failure;
	constructor(failure: Failure) {
		super("delivery window exhausted");
		this.name = "DeliveryWindowExhausted";
		this.failure = failure;
	}
}

export async function sendWebhook(
	target: WebhookSendTarget,
	body: string,
	options: WebhookSendOptions = {},
): Promise<WebhookSendOutcome> {
	const backoff = options.backoffMs ?? WEBHOOK_RETRY_BACKOFF_MS;
	const now = options.now ?? Date.now;
	const attemptTimeoutMs = target.timeoutMs ?? WEBHOOK_TIMEOUT_MS_DEFAULT;
	const deadline = now() + (options.windowMs ?? WEBHOOK_DELIVERY_WINDOW_MS);
	// Every failed attempt that will be retried passes through the delay
	// callback, so counting there keeps the number exact even when the loop
	// ends in a wait rather than in an attempt.
	let attempts = 1;
	try {
		const response = await fetchWithRetry(target.url, requestInit(target, body, options.signal), {
			maxRetries: WEBHOOK_SEND_ATTEMPTS - 1,
			attemptTimeoutMs,
			timeoutMs: deadline - now(),
			retryDelayMs: (attempt, response, error) => {
				const delay = retryWaitMs(attempt, response?.headers.get("retry-after") ?? null, backoff, now());
				// Another attempt needs the wait plus a full attempt inside the window;
				// otherwise stop here, on the failure that just happened.
				if (now() + delay + attemptTimeoutMs > deadline) {
					throw new DeliveryWindowExhausted(
						response === undefined ? describeError(error) : statusFailure(response.status),
					);
				}
				attempts += 1;
				return delay;
			},
		});
		// The receiver's body is never read: a server's response can be sensitive
		// and it has no bearing on the outcome beyond the status.
		await response.body?.cancel().catch(() => undefined);
		if (response.ok) return { kind: "accepted", status: response.status, attempts };
		if (isRetryableStatus(response.status)) return exhausted(attempts, statusFailure(response.status));
		return { kind: "rejected", status: response.status, attempts };
	} catch (error) {
		if (options.signal?.aborted) return { kind: "cancelled" };
		return exhausted(attempts, error instanceof DeliveryWindowExhausted ? error.failure : describeError(error));
	}
}

function requestInit(target: WebhookSendTarget, body: string, signal: AbortSignal | undefined): RequestInit {
	return {
		method: target.method,
		headers: { "content-type": "application/json", ...target.headers },
		body,
		// A destination URL is a bearer secret and its Authorization header must
		// not travel to wherever a 3xx points; a redirect comes back as a response.
		redirect: "manual",
		...(signal === undefined ? {} : { signal }),
	};
}

function exhausted(attempts: number, failure: Failure): WebhookSendOutcome {
	return { kind: "exhausted", attempts, lastFailure: failure.text, lastAttemptTimedOut: failure.timedOut };
}

function statusFailure(status: number): Failure {
	return { text: `HTTP ${status}`, timedOut: false };
}

/**
 * How long to wait before the next attempt. A Retry-After wins over the fixed
 * backoff, parsed as seconds or as an HTTP date the way packages/ai's OAuth
 * client does it, clamped to [0, WEBHOOK_RETRY_AFTER_MAX_MS]; an unparseable
 * header falls back to the backoff for that attempt, and attempts past the end
 * of the backoff table reuse its last entry.
 */
export function retryWaitMs(
	attempt: number,
	retryAfter: string | null,
	backoff: readonly number[],
	now: number,
): number {
	if (retryAfter !== null) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - now : seconds * 1000;
		if (Number.isFinite(delayMs)) return Math.min(Math.max(0, delayMs), WEBHOOK_RETRY_AFTER_MAX_MS);
	}
	return backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
}

/** Anything that looks like a URL in a transport error; fetch errors can embed the host. */
const URL_PATTERN = /https?:\/\/\S+/gi;

/**
 * A failure in words a notice may show. A timeout is named as such because it
 * changes the advice. An errno code (ECONNREFUSED, ENOTFOUND) is the useful
 * part of a transport error and carries nothing secret. Anything else goes
 * through the credential redactor and loses any URL.
 */
function describeError(error: unknown): Failure {
	if (isTimeoutError(error)) return { text: "timed out", timedOut: true };
	const cause = error instanceof Error ? error.cause : undefined;
	const code = getErrnoCode(error) ?? getErrnoCode(cause);
	if (code !== undefined) return { text: `network error (${code})`, timedOut: false };
	const message = error instanceof Error ? error.message : String(error);
	return { text: redactCredentialShapes(message).replace(URL_PATTERN, "<url>"), timedOut: false };
}

/** `AbortSignal.timeout` aborts with a DOMException named TimeoutError; that is the whole test. */
function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}
