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
import { streamCutDurationMs } from "./model-fallback-failures.ts";

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
 * An attempt whose response stream ended early after at least this long ran long enough that a repeat is likely to be
 * cut again (#4626). A stream cut sooner keeps the ordinary retry budget.
 */
export const LONG_STREAM_CUT_MS = 300_000;

/** Same-model retries allowed after an attempt whose stream was cut after `LONG_STREAM_CUT_MS`. */
export const MAX_LONG_STREAM_CUT_RETRIES = 1;

/** Whether the failure is a stream that ended early after an attempt that ran at least `LONG_STREAM_CUT_MS`. */
export function isLongStreamCut(failure: unknown): boolean {
	return (streamCutDurationMs(failure) ?? 0) >= LONG_STREAM_CUT_MS;
}

/**
 * Whether the failure is a long stream cut after the model's long stream cuts have already been retried
 * `MAX_LONG_STREAM_CUT_RETRIES` times: another attempt is likely to be cut again, so the same model is not retried.
 */
export function repeatsLongStreamCut(failure: unknown, longStreamCutRetriesSpent: number): boolean {
	return longStreamCutRetriesSpent >= MAX_LONG_STREAM_CUT_RETRIES && isLongStreamCut(failure);
}

/** What to do when the same model keeps being cut after long attempts and is no longer retried. */
export const LONG_STREAM_CUT_ADVICE = `Atomic stopped retrying this model after its stream was cut again after ${LONG_STREAM_CUT_MS / 60_000} minutes or more, because another attempt is likely to be cut too. Split the work into smaller steps, lower the thinking effort, or switch to another model; the fallbackModels setting switches models automatically.`;

/**
 * Decide whether one more attempt against the same target is allowed.
 *
 * @param settings retry settings, or `undefined` when the caller has none
 * @param retriesSpent retries already made for this failure
 * @param eligible whether this failure can be repaired by requesting again
 * @param failure the failed message, whose server retry hint replaces the backoff
 * @param longStreamCutRetriesSpent retries already made after an attempt whose stream was cut after
 * `LONG_STREAM_CUT_MS`; a caller that does not track them gets no limit on long stream cuts
 */
export function nextRetryDecision(
	settings: RetryPolicySettings | undefined,
	retriesSpent: number,
	eligible: boolean,
	failure: Pick<AssistantMessage, "retryAfterMs" | "diagnostics"> = {},
	longStreamCutRetriesSpent = 0,
): RetryDecision | undefined {
	if (settings === undefined || !settings.enabled || !eligible || retriesSpent >= settings.maxRetries) {
		return undefined;
	}
	if (repeatsLongStreamCut(failure, longStreamCutRetriesSpent)) return undefined;
	const attempt = retriesSpent + 1;
	return { attempt, delayMs: failureRetryDelayMs(settings, attempt, failure) };
}
