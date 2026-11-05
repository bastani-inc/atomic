import { isDecisionProviderError } from "../decision/errors.js";
import { normalizeModelFailureSignal } from "../model-fallback-failures.ts";
import { providerRetryHint } from "../provider-rate-limits.js";

/**
 * What a structured-output request's provider failure says without its text, which can echo private state:
 * its HTTP status, a fixed failure code and the server's retry hint. It lets the stage, the workflow and
 * provider cooldowns tell a rate limit or an exhausted quota from any other failed request.
 */
export interface ProviderFailureSignal {
	readonly status: number;
	readonly code: "rate_limit_exceeded" | "insufficient_quota";
	readonly retryAfterMs?: number;
}

const carried = new WeakMap<Error, ProviderFailureSignal>();

/** The signal of a rate limit or exhausted quota in `failure`, if it is one. */
export function providerFailureSignal(failure: unknown): ProviderFailureSignal | undefined {
	const kind = normalizeModelFailureSignal(failure).kind;
	if (kind !== "rate_limit" && kind !== "quota_exhausted") return undefined;
	const retryAfterMs = providerRetryHint(failure).retryAfterMs;
	return {
		...(kind === "rate_limit"
			? { status: 429, code: "rate_limit_exceeded" as const }
			: { status: 402, code: "insufficient_quota" as const }),
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	};
}

/** Puts the signal's status, code and retry hint on `error`, which keeps its own message. Returns `error`. */
export function withProviderFailure<T extends Error>(error: T, signal: ProviderFailureSignal | undefined): T {
	if (signal === undefined) return error;
	carried.set(error, signal);
	return Object.assign(error, signal);
}

/** The signal an error from this module, or a decision provider error, carries, for an error that wraps it. */
export function carriedProviderFailure(error: unknown): ProviderFailureSignal | undefined {
	if (!(error instanceof Error)) return undefined;
	const signal = carried.get(error);
	if (signal !== undefined || !isDecisionProviderError(error)) return signal;
	if (error.providerStatus === undefined || error.providerCode === undefined) return undefined;
	return {
		status: error.providerStatus,
		code: error.providerCode,
		...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
	};
}
