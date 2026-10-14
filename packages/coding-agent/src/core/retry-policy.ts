/**
 * The one bounded same-target retry policy.
 *
 * Main chat and workflow stages both retry a failing model before spending a
 * fallback candidate. Keeping the gate and the backoff curve here means the two
 * cannot drift into different budgets for the same `settings.retry` values.
 *
 * Callers keep their own concerns: attempt state, lifecycle events, abort
 * handling, sleeping, and whether the chain may advance afterwards.
 */

import { type AssistantMessage, assistantRetryDelayMs, retryDelayMs, usesRetryTimeBudget } from "@bastani/pi-ai";

export interface RetryPolicySettings {
	readonly enabled: boolean;
	readonly maxRetries: number;
	readonly baseDelayMs: number;
	readonly maxAgentDelayMs?: number;
	readonly maxRetryTimeMs?: number;
	readonly maxRetryDelayMs?: number;
}

export interface RetryDecision {
	/** 1-based number of the retry this decision authorizes. */
	readonly attempt: number;
	/** Backoff, or server retry hint, to wait before that retry. */
	readonly delayMs: number;
}

/**
 * Decide whether one more attempt against the same target is allowed.
 *
 * @param settings retry settings, or `undefined` when the caller has none
 * @param retriesSpent retries already made for this failure
 * @param eligible whether this failure can be repaired by requesting again
 * @param failure the failed message and time spent retrying it; transient provider
 *   errors then retry within `maxRetryTimeMs` and honour the server retry hint
 */
export function nextRetryDecision(
	settings: RetryPolicySettings | undefined,
	retriesSpent: number,
	eligible: boolean,
	failure?: { message: Pick<AssistantMessage, "stopReason" | "errorMessage" | "retryAfterMs">; elapsedMs: number },
): RetryDecision | undefined {
	if (settings === undefined || !settings.enabled || !eligible) {
		return undefined;
	}
	const attempt = retriesSpent + 1;
	if (failure) {
		const delayMs = assistantRetryDelayMs(settings, attempt, failure.message, failure.elapsedMs);
		if (delayMs !== undefined) return { attempt, delayMs };
		if (usesRetryTimeBudget(settings, failure.message)) return undefined;
	}
	return retriesSpent < settings.maxRetries ? { attempt, delayMs: retryDelayMs(settings, attempt) } : undefined;
}
