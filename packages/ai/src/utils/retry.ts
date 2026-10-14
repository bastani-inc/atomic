import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
	"subscription_sharing_usage_limit_exceeded",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"server_busy",
	"servers are currently busy",
	"currently experiencing high demand",
	"model is at capacity",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"520",
	"521",
	"522",
	"523",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?(?:an.?)?error",
	"exceeded request buffer limit while retrying upstream",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"ECONNRESET",
	"connection.?reset",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Response-body decompression failures. Node/Bun zlib rejects a body whose
	// Content-Encoding lied or whose compressed bytes were corrupted, and the
	// fetch/WebSocket layer wraps it with a "Library error:" prefix. GitHub
	// Copilot on the default `transport: "auto"` reports this as
	// "Library error: zlib error: incorrect header check" (#2553). The transfer
	// is already unusable, and a fresh attempt normally succeeds, so treat every
	// variant as a transient transport failure rather than a deterministic error.
	"zlib",
	"incorrect header check",
	"decompress",
	"library error",

	// Idle-stream deadline enforced below the HTTP layer by `withStreamDeadline`
	// so a stream that never settles cannot hang an attempt forever (#2553).
	"stream deadline exceeded",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",
	"pending stream has been canceled",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",
	"subscription_sharing_usage_unavailable",
	"subscription_sharing_user_unavailable",
]);

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`).
 * Each delay is capped by `maxAgentDelayMs` (60 seconds by default).
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/** Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)` before jitter. */
	baseDelayMs: number;
	/** Cap for agent-level retry delays in ms. Defaults to 60 seconds. */
	maxAgentDelayMs?: number;
	/**
	 * Elapsed-time budget for transient provider failures (5xx, overload, connection
	 * resets). While it lasts, those failures retry past `maxRetries` with full-jitter
	 * backoff. 0 or undefined keeps the fixed `maxRetries` limit.
	 */
	maxRetryTimeMs?: number;
	/** Cap for a server retry hint (`Retry-After`, `retry_after`). 0 disables the cap. */
	maxRetryDelayMs?: number;
}

export const DEFAULT_MAX_AGENT_RETRY_DELAY_MS = 60_000;
export const DEFAULT_MAX_RETRY_TIME_MS = 300_000;

export function retryDelayMs(policy: Pick<RetryPolicy, "baseDelayMs" | "maxAgentDelayMs">, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
}

type RetryFailure = Pick<AssistantMessage, "stopReason" | "errorMessage" | "retryAfterMs">;

const RATE_LIMIT_ERROR_PATTERN = /429|rate.?limit|too many requests/i;

/** Whether `message` is a transient failure that retries under `policy.maxRetryTimeMs` instead of `maxRetries`. */
export function usesRetryTimeBudget(policy: Pick<RetryPolicy, "maxRetryTimeMs">, message: RetryFailure): boolean {
	return (
		(policy.maxRetryTimeMs ?? 0) > 0 &&
		isRetryableAssistantError(message) &&
		!RATE_LIMIT_ERROR_PATTERN.test(message.errorMessage ?? "")
	);
}

function serverHintDelayMs(policy: Pick<RetryPolicy, "maxRetryDelayMs">, message: RetryFailure): number {
	const hintMs = message.retryAfterMs;
	if (hintMs === undefined || !Number.isFinite(hintMs) || hintMs <= 0) return 0;
	const capMs = policy.maxRetryDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS;
	return capMs > 0 ? Math.min(hintMs, capMs) : hintMs;
}

/**
 * Delay before retry `attempt` (1-indexed) of a failed assistant call, or `undefined`
 * when it must not be retried. Transient failures retry until `maxRetryTimeMs` has
 * elapsed, using full-jitter exponential backoff; other retryable failures keep the
 * `maxRetries` limit and deterministic backoff. A server retry hint is the minimum
 * delay, capped by `maxRetryDelayMs`; budgeted delays never exceed the remaining budget.
 */
export function assistantRetryDelayMs(
	policy: RetryPolicy,
	attempt: number,
	message: RetryFailure,
	elapsedMs: number,
	random: () => number = Math.random,
): number | undefined {
	if (!policy.enabled || policy.maxRetries <= 0 || !isRetryableAssistantError(message)) return undefined;
	const hintMs = serverHintDelayMs(policy, message);
	if (!usesRetryTimeBudget(policy, message)) {
		return attempt > policy.maxRetries ? undefined : Math.max(retryDelayMs(policy, attempt), hintMs);
	}
	const remainingMs = (policy.maxRetryTimeMs ?? 0) - elapsedMs;
	if (remainingMs <= 0) return undefined;
	const jitteredMs = Math.floor(random() * retryDelayMs(policy, attempt));
	return Math.min(Math.max(jitteredMs, hintMs), remainingMs);
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries per {@link assistantRetryDelayMs} (time budget for transient
 *   failures, `maxRetries` for the rest), emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	const startedAt = Date.now();
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		const delayMs = policy ? assistantRetryDelayMs(policy, attempt + 1, response, Date.now() - startedAt) : undefined;
		if (delayMs === undefined) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				return { ...response, stopReason: "aborted", errorMessage: undefined };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: RetryFailure): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
