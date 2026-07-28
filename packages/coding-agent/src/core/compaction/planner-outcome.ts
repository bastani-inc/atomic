/**
 * Typed outcomes for one compaction planner attempt.
 *
 * `planDeletedLineRanges` used to collapse ranked success, silent partial
 * recovery, reasoning starvation, rate limiting, malformed output, and context
 * overflow into "ranges or throw". Callers could not tell a throttle from
 * garbage without string-matching an error message. This module makes each
 * outcome a distinct value so the rung ladder, the `0600` diagnostic sidecar,
 * and the UI can separate them.
 *
 * Cancellation is deliberately NOT a variant: an abort still throws.
 */

import type { Api, AssistantMessage } from "@earendil-works/pi-ai/compat";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import type { RawLineRange } from "./compaction-types.js";
import type { DiagnosticFailureCategory } from "./range-planner-diagnostics.js";

/** Every way one planner attempt can end. */
export type PlannerOutcome =
	| { kind: "ranked"; ranges: RawLineRange[] }
	| { kind: "recovered"; ranges: RawLineRange[]; recoveredCount: number }
	| { kind: "rateLimited"; exhausted: boolean; message: string; diagnosticPath?: string }
	| { kind: "unusable"; category: DiagnosticFailureCategory; excerpt: string; diagnosticPath?: string }
	| { kind: "overflowed"; diagnosticPath?: string }
	| { kind: "providerError"; message: string; diagnosticPath?: string };

/** A planner outcome that cannot produce a boundary and must advance the ladder. */
export type TerminalPlannerOutcome = Extract<
	PlannerOutcome,
	{ kind: "rateLimited" | "unusable" | "overflowed" | "providerError" }
>;

/** Whether this outcome produced validated deletion ranges. */
export function isPlannerSuccess(outcome: PlannerOutcome): outcome is Extract<PlannerOutcome, { kind: "ranked" | "recovered" }> {
	return outcome.kind === "ranked" || outcome.kind === "recovered";
}

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

/**
 * Quota/billing exhaustion. Mirrors pi-ai's
 * `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` (`utils/retry.js`), which takes
 * precedence over the transient patterns and never spends backoff.
 */
const QUOTA_EXHAUSTED_PATTERN = buildProviderErrorPattern([
	"GoUsageLimitError",
	"FreeUsageLimitError",
	"Monthly usage limit reached",
	"available balance",
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

/**
 * Transient throttling and provider-load failures. This is the rate-limit
 * subset of pi-ai's `RETRYABLE_PROVIDER_ERROR_PATTERN`: reaching this classifier
 * means `retryAssistantCall` already spent the configured backoff budget.
 */
const RATE_LIMITED_PATTERN = buildProviderErrorPattern([
	"overloaded",
	"rate.?limit",
	"usage.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",
	"ResourceExhausted",
]);

/** How a failed planner response is classified before an outcome is built. */
export type PlannerFailureClass = "overflow" | "quota" | "rate_limited" | "provider_error";

/**
 * Classify one failed planner response.
 *
 * Context overflow wins first because pi-ai's `isContextOverflow` already
 * excludes rate/throttle text, and overflow is recoverable by trimming.
 * Quota/billing exhaustion then wins over transient throttling, matching pi-ai's
 * own precedence.
 */
export function classifyPlannerFailure(response: AssistantMessage, contextWindow: number): PlannerFailureClass {
	if (isContextOverflow(response, contextWindow)) return "overflow";
	const message = response.errorMessage ?? "";
	if (QUOTA_EXHAUSTED_PATTERN.test(message)) return "quota";
	if (RATE_LIMITED_PATTERN.test(message)) return "rate_limited";
	return "provider_error";
}

/** Build a synthetic error response so a thrown transport failure classifies identically. */
export function syntheticErrorResponse(
	model: { api: Api; provider: string; id: string },
	errorMessage: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	} as AssistantMessage;
}

/**
 * Reasoning starvation fingerprint: the response stopped at the output limit,
 * produced no usable deletion record, and billed reasoning tokens.
 *
 * This is a diagnostic category only. Codex has no starvation concept and never
 * retries one; neither does Atomic. A starved outcome advances the ladder
 * exactly like any other `unusable` output.
 */
export function isReasoningStarved(response: AssistantMessage, hasUsableRanges: boolean): boolean {
	return response.stopReason === "length" && !hasUsableRanges && (response.usage?.reasoning ?? 0) > 0;
}
