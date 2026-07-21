import type { RetryCallbacks } from "@earendil-works/pi-ai";
import type { AgentSessionInternalSurface } from "./agent-session-methods.ts";

export type SummarizationRetrySource =
	| { source: "branchSummary" }
	| { source: "compaction"; reason: "manual" | "threshold" | "overflow" };

/** Bridge pi-ai retry lifecycle callbacks into the public AgentSession event stream. */
export function createSummarizationRetryCallbacks(
	session: AgentSessionInternalSurface,
	source: SummarizationRetrySource,
): RetryCallbacks {
	return {
		onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
			session._emit({
				type: "summarization_retry_scheduled",
				attempt,
				maxAttempts,
				delayMs,
				errorMessage,
			});
		},
		onRetryAttemptStart: () => {
			session._emit({ type: "summarization_retry_attempt_start", ...source });
		},
		onRetryFinished: () => {
			session._emit({ type: "summarization_retry_finished" });
		},
	};
}
