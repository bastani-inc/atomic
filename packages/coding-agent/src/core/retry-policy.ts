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

import { type AssistantMessage, failureRetryDelayMs } from "@bastani/pi-ai";

export interface RetryPolicySettings {
	readonly enabled: boolean;
	readonly maxRetries: number;
	readonly baseDelayMs: number;
	readonly maxAgentDelayMs?: number;
	readonly maxRetryDelayMs?: number;
}

export interface RetryDecision {
	/** 1-based number of the retry this decision authorizes. */
	readonly attempt: number;
	/** Server retry hint, capped by `maxRetryDelayMs`, or else the exponential backoff to wait before that retry. */
	readonly delayMs: number;
}

/**
 * Decide whether one more attempt against the same target is allowed.
 *
 * @param settings retry settings, or `undefined` when the caller has none
 * @param retriesSpent retries already made for this failure
 * @param eligible whether this failure can be repaired by requesting again
 * @param failure the failed message, whose server retry hint replaces the backoff
 */
export function nextRetryDecision(
	settings: RetryPolicySettings | undefined,
	retriesSpent: number,
	eligible: boolean,
	failure: Pick<AssistantMessage, "retryAfterMs"> = {},
): RetryDecision | undefined {
	if (settings === undefined || !settings.enabled || !eligible || retriesSpent >= settings.maxRetries) {
		return undefined;
	}
	const attempt = retriesSpent + 1;
	return { attempt, delayMs: failureRetryDelayMs(settings, attempt, failure) };
}
