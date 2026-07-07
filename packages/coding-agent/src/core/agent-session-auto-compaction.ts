import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { getEffectiveInputBudget } from "./context-window.ts";
import { parseCopilotPromptLimitError } from "./copilot-errors.ts";
import { calculateContextTokens, estimateContextTokens, shouldCompact } from "./compaction/index.ts";
import { getLatestCompactionBoundaryEntry } from "./session-manager.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";

export async function _checkCompaction(this: AgentSession, assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
	const settings = this.settingsManager.getCompactionSettings();
	if (!settings.enabled) return;

	// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
	if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;

	const contextWindow = this.model?.contextWindow ?? 0;

	// Skip overflow check if the message came from a different model.
	// This handles the case where user switched from a smaller-context model (e.g. opus)
	// to a larger-context model (e.g. codex) - the overflow error from the old model
	// shouldn't trigger compaction for the new model.
	const sameModel =
		this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

	// Skip compaction checks if this assistant message is older than the latest
	// compaction boundary. This prevents a stale pre-compaction usage/error
	// from retriggering compaction on the first prompt after compaction.
	const compactionBoundaryEntry = getLatestCompactionBoundaryEntry(this.sessionManager.getBranch());
	const assistantIsFromBeforeCompactionBoundary =
		compactionBoundaryEntry !== null &&
		assistantMessage.timestamp <= new Date(compactionBoundaryEntry.timestamp).getTime();
	if (assistantIsFromBeforeCompactionBoundary) {
		return;
	}

	// Case 1: Overflow - LLM returned context overflow error
	// When Copilot rejects a 1m client-budget prompt at a lower server cap (for example
	// because long-context/usage-based billing entitlement is missing), leave the friendly
	// error visible instead of auto-compacting down to a smaller server tier silently.
	if (sameModel && this._isCopilotServerCapBelowSelectedContextWindow(assistantMessage)) {
		return;
	}
	if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
		const willRetry = assistantMessage.stopReason !== "stop";
		if (!willRetry) {
			await this._runAutoCompaction("overflow", false);
			return;
		}

		if (this._overflowRecoveryAttempted) {
			this._emit({
				type: "compaction_end",
				reason: "overflow",
				result: undefined,
				aborted: false,
				willRetry: false,
				errorMessage:
					"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
			});
			return;
		}

		this._overflowRecoveryAttempted = true;
		// Remove the error message from agent state (it IS saved to session for history,
		// but we don't want it in context for the retry)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}
		await this._runAutoCompaction("overflow", willRetry);
		return;
	}

	// Case 2: Threshold - context is getting large
	// For error messages (no usage data), estimate from last successful response.
	// This ensures sessions that hit persistent API errors (e.g. 529) can still compact.
	let contextTokens: number;
	if (assistantMessage.stopReason === "error") {
		const messages = this.agent.state.messages;
		const estimate = estimateContextTokens(messages);
		if (estimate.lastUsageIndex === null) return; // No usage data at all
		// Verify the usage source is post-compaction. Kept pre-compaction messages
		// have stale usage reflecting the old (larger) context and would falsely
		// trigger compaction right after one just finished.
		const usageMsg = messages[estimate.lastUsageIndex];
		if (
			compactionBoundaryEntry &&
			usageMsg.role === "assistant" &&
			(usageMsg as AssistantMessage).timestamp <= new Date(compactionBoundaryEntry.timestamp).getTime()
		) {
			return;
		}
		contextTokens = estimate.tokens;
	} else {
		contextTokens = calculateContextTokens(assistantMessage.usage);
	}
	// Compact against the effective input budget (the hard prompt cap for providers like Copilot
	// that advertise a larger total window) so we compact before overrunning the server-side limit
	// rather than relying on reactive overflow recovery near the cap.
	const compactionBudget = this.model ? getEffectiveInputBudget(this.model) : contextWindow;
	if (shouldCompact(contextTokens, compactionBudget, settings)) {
		await this._runAutoCompaction("threshold", shouldRetryAfterThresholdCompaction(assistantMessage));
	}
}


export function _isCopilotServerCapBelowSelectedContextWindow(this: AgentSession, assistantMessage: AssistantMessage): boolean {
	if (!this.model || this.model.provider !== "github-copilot" || !assistantMessage.errorMessage) return false;
	const promptLimitError = parseCopilotPromptLimitError(assistantMessage.errorMessage);
	// Compare against the effective input budget (the model's real prompt cap), not the displayed
	// total window. A rejection at the prompt cap is a normal overflow we should compact-and-retry;
	// only a rejection *below* the cap (e.g. a missing long-context entitlement dropping the account
	// to a lower server tier) keeps the friendly error visible instead of silently compacting down.
	return promptLimitError !== undefined && getEffectiveInputBudget(this.model) > promptLimitError.limitTokens;
}

export function shouldRetryAfterThresholdCompaction(assistantMessage: AssistantMessage): boolean {
	return assistantMessage.stopReason === "length" && assistantMessage.usage.output > 0;
}

/**
 * Internal: remove an incomplete assistant from retry context before auto-continuing after compaction.
 */

export function _dropTrailingAutoCompactionRetryAssistantIfPresent(this: AgentSession): void {
	const messages = this.agent.state.messages;
	const lastMsg = messages[messages.length - 1];
	if (lastMsg?.role !== "assistant") return;
	const stopReason = (lastMsg as AssistantMessage).stopReason;
	if (stopReason === "error" || stopReason === "length") {
		this.agent.state.messages = messages.slice(0, -1);
	}
}

/**
 * Internal: schedule a live post-event continuation probe after compaction_end listeners can flush queues.
 */

export function _schedulePostAutoCompactionContinuationProbe(this: AgentSession,
	_reason: "overflow" | "threshold",
	willRetry: boolean,
): void {
	setTimeout(() => {
		if (this.isCompacting || this.isStreaming) {
			return;
		}

		if (willRetry) {
			this._resumeAfterAutoCompaction();
			return;
		}

		if (!this.agent.hasQueuedMessages()) {
			return;
		}

		this._resumeAfterAutoCompaction();
	}, 100);
}

/**
 * Internal: resume generation after successful auto-compaction only when active work remains.
 */

export function _resumeAfterAutoCompaction(this: AgentSession): void {
	void this._runAgentContinue().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		this._emit({
			type: "agent_continue_error",
			source: "post_compaction",
			errorMessage: `Post-compaction continuation failed: ${message}`,
		});
	});
}

/**
 * Internal: Run auto-compaction with events.
 */

export async function _runAutoCompaction(this: AgentSession, reason: "overflow" | "threshold", willRetry: boolean): Promise<void> {
	this._emit({ type: "compaction_start", reason });
	this._autoCompactionAbortController = new AbortController();

	try {
		if (!this.model) {
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
			});
			return;
		}

		// Auth is resolved lazily: only called when the planner fallback is needed.
		// This allows extension-provided deletion requests to run before auth is checked,
		// enabling local extension compaction even when API credentials are unavailable.
		// Auto-mode resolver returns undefined (rather than throwing) when auth is missing;
		// overflow recovery then falls back to deterministic no-auth eviction, while
		// threshold compaction keeps the previous no-op behavior.
		const model = this.model;
		const result = await this._applyContextVerbatimCompaction({
			resolvePlannerAuth: async () => {
				const authResult = await this._modelRegistry.getApiKeyAndHeaders(model);
				if (!authResult.ok || !authResult.apiKey) {
					return undefined;
				}
				return { apiKey: authResult.apiKey, headers: authResult.headers };
			},
			abortController: this._autoCompactionAbortController,
			backupLabel: reason === "overflow" ? "overflow-auto-compact" : "auto-compact",
			reason,
		});
		if (!result) {
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
			});
			return;
		}

		if (willRetry) {
			this._dropTrailingAutoCompactionRetryAssistantIfPresent();
		}

		this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
		this._schedulePostAutoCompactionContinuationProbe(reason, willRetry);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : "compaction failed";
		const aborted = errorMessage === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
		this._emit({
			type: "compaction_end",
			reason,
			result: undefined,
			aborted,
			willRetry: false,
			errorMessage: aborted
				? undefined
				: reason === "overflow"
					? `Context overflow recovery failed: ${errorMessage}`
					: `Auto-compaction failed: ${errorMessage}`,
		});
	} finally {
		this._autoCompactionAbortController = undefined;
	}
}

/**
 * Toggle auto-compaction setting.
 */

export const agentSessionAutoCompactionMethods = {
	_checkCompaction,
	_isCopilotServerCapBelowSelectedContextWindow,
	_dropTrailingAutoCompactionRetryAssistantIfPresent,
	_schedulePostAutoCompactionContinuationProbe,
	_resumeAfterAutoCompaction,
	_runAutoCompaction,
};
