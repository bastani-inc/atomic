import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { getEffectiveInputBudget } from "./context-window.ts";
import { parseCopilotPromptLimitError } from "./copilot-errors.ts";
import { calculateContextTokens, estimateContextTokens, shouldCompact } from "./compaction/index.ts";
import { getLatestCompactionBoundaryEntry } from "./session-manager.ts";
import { MIN_RESPONSES_MAX_OUTPUT_TOKENS } from "./openai-responses-payload-sanitizer.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { StaleCompactionPlanError } from "./agent-session-compaction.js";

/**
 * Upper bound on consecutive automatic continuations of a response that was
 * truncated at the output-token cap ("length") while the context is still
 * below the compaction budget. Each continuation regenerates the cut-off turn,
 * so a model that insists on emitting more than its per-turn output cap can
 * still terminate instead of looping forever.
 */
export const MAX_LENGTH_CONTINUATION_ATTEMPTS = 3;

export const MAX_OUTPUT_BUDGET_ERROR_CONTINUATION_ATTEMPTS = 1;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ProviderErrorDetails = {
	message?: string;
	code?: string;
	param?: string;
};

const OUTPUT_BUDGET_PARAMETER_PATTERN = /\bmax_output_tokens\b/;
const OUTPUT_BUDGET_UNDERFLOW_PATTERN = new RegExp(
	`(?:integer\\s+below\\s+minimum\\s+value|expected\\s+(?:a\\s+)?value\\s*>=\\s*${MIN_RESPONSES_MAX_OUTPUT_TOKENS}|got\\s+1\\s+instead)`,
);

export async function _checkCompaction(this: AgentSession, assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<void> {
	// The agent_end path passes skipAbortedCheck=true; the pre-prompt path passes
	// false. Only the live turn-completion path may auto-continue a truncated
	// response — before a fresh user prompt we must not resume the old turn.
	const isLiveTurnCompletion = skipAbortedCheck;
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
				unresolvedOverflow: true,
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
		contextTokens = calculateContextTokens(assistantMessage.usage, assistantMessage.api);
	}
	// Compact against the effective input budget (the hard prompt cap for providers like Copilot
	// that advertise a larger total window) so we compact before overrunning the server-side limit
	// rather than relying on reactive overflow recovery near the cap.
	const compactionBudget = this.model ? getEffectiveInputBudget(this.model) : contextWindow;
	if (shouldCompact(contextTokens, compactionBudget, settings)) {
		const willRetry = shouldRetryAfterThresholdCompaction(assistantMessage);
		if (willRetry && isRetryWorthyOutputBudgetError(assistantMessage)) {
			if (this._outputBudgetErrorContinuationAttempts >= MAX_OUTPUT_BUDGET_ERROR_CONTINUATION_ATTEMPTS) {
				this._emit({
					type: "compaction_end",
					reason: "threshold",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Output-budget recovery stopped after a compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return;
			}
			this._outputBudgetErrorContinuationAttempts += 1;
		}
		await this._runAutoCompaction("threshold", willRetry);
		return;
	}

	// A response truncated at the output-token cap ("length") with the context
	// still below the compaction budget is genuine work cut off mid-flight, not a
	// context overflow. Compaction would not free any room, so continue the
	// generation directly instead of dead-ending on the truncation and leaving
	// the task half-finished.
	if (isLiveTurnCompletion && isRetryWorthyLengthStop(assistantMessage)) {
		this._resumeAfterLengthTruncation();
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

export function isRetryWorthyLengthStop(assistantMessage: AssistantMessage): boolean {
	return assistantMessage.stopReason === "length" && assistantMessage.usage.output > 0;
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: { [key: string]: JsonValue }, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function parseProviderErrorDetails(errorMessage: string): ProviderErrorDetails | undefined {
	const start = errorMessage.indexOf("{");
	const end = errorMessage.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;

	try {
		const parsed = JSON.parse(errorMessage.slice(start, end + 1)) as JsonValue;
		if (!isJsonRecord(parsed)) return undefined;

		const nestedError = parsed.error;
		if (nestedError !== undefined && isJsonRecord(nestedError)) {
			return {
				message: stringField(nestedError, "message"),
				code: stringField(nestedError, "code") ?? stringField(parsed, "code"),
				param: stringField(nestedError, "param") ?? stringField(parsed, "param"),
			};
		}

		return {
			message: stringField(parsed, "message"),
			code: stringField(parsed, "code"),
			param: stringField(parsed, "param"),
		};
	} catch {
		return undefined;
	}
}

function isOutputBudgetUnderflowText(text: string): boolean {
	const message = text.toLowerCase();
	return OUTPUT_BUDGET_PARAMETER_PATTERN.test(message) && OUTPUT_BUDGET_UNDERFLOW_PATTERN.test(message);
}

function isStructuredOutputBudgetUnderflow(details: ProviderErrorDetails): boolean {
	const message = details.message?.toLowerCase() ?? "";
	const param = details.param?.toLowerCase();
	if (!OUTPUT_BUDGET_UNDERFLOW_PATTERN.test(message)) return false;
	return param !== undefined ? OUTPUT_BUDGET_PARAMETER_PATTERN.test(param) : OUTPUT_BUDGET_PARAMETER_PATTERN.test(message);
}

export function isRetryWorthyOutputBudgetError(assistantMessage: AssistantMessage): boolean {
	if (assistantMessage.stopReason !== "error" || !assistantMessage.errorMessage) return false;
	if (assistantMessage.api !== "openai-responses") return false;

	const structuredDetails = parseProviderErrorDetails(assistantMessage.errorMessage);
	if (structuredDetails && isStructuredOutputBudgetUnderflow(structuredDetails)) return true;

	return isOutputBudgetUnderflowText(assistantMessage.errorMessage);
}

export function shouldRetryAfterThresholdCompaction(assistantMessage: AssistantMessage): boolean {
	return isRetryWorthyLengthStop(assistantMessage) || isRetryWorthyOutputBudgetError(assistantMessage);
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
	if (willRetry) {
		const token = this._postCompactionContinuationToken + 1;
		this._postCompactionContinuationToken = token;
		let pending: Promise<void>;
		pending = new Promise<void>((resolve) => {
			setTimeout(() => {
				void (async () => {
					try {
						if (this._postCompactionContinuationToken !== token) return;
						if (this.isCompacting || this.isStreaming) return;
						await this._resumeAfterAutoCompaction();
					} finally {
						if (this._pendingPostCompactionContinuation === pending) {
							this._pendingPostCompactionContinuation = undefined;
						}
						resolve();
					}
				})();
			}, 100);
		});
		this._pendingPostCompactionContinuation = pending;
		return;
	}

	setTimeout(() => {
		if (this.isCompacting || this.isStreaming) {
			return;
		}

		if (!this.agent.hasQueuedMessages()) {
			return;
		}

		void this._resumeAfterAutoCompaction();
	}, 100);
}

export async function _awaitPendingPostCompactionContinuation(this: AgentSession): Promise<void> {
	const pending = this._pendingPostCompactionContinuation;
	if (pending === undefined) return;
	await pending;
}

/**
 * Internal: resume generation after successful auto-compaction only when active work remains.
 */

export async function _resumeAfterAutoCompaction(this: AgentSession): Promise<void> {
	try {
		await this._runAgentContinue();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		this._emit({
			type: "agent_continue_error",
			source: "post_compaction",
			errorMessage: `Post-compaction continuation failed: ${message}`,
		});
	}
}

/**
 * Internal: resume a response that was truncated at the output-token cap
 * ("length") when the context does not warrant compaction. The generation is
 * continued directly so the model finishes the work it was cut off from, rather
 * than dead-ending on the truncation. Bounded by MAX_LENGTH_CONTINUATION_ATTEMPTS
 * so a turn that keeps exceeding the per-turn output cap can still terminate.
 */

export function _resumeAfterLengthTruncation(this: AgentSession): void {
	if (this._lengthContinuationAttempts >= MAX_LENGTH_CONTINUATION_ATTEMPTS) return;
	this._lengthContinuationAttempts += 1;
	// agent.continue() rejects an assistant tail; drop the incomplete
	// length-stopped message so the preceding user/tool-result anchors the
	// continuation. It remains persisted in session history.
	this._dropTrailingAutoCompactionRetryAssistantIfPresent();
	this._schedulePostAutoCompactionContinuationProbe("threshold", true);
}



function overflowUnresolved(reason: "overflow" | "threshold", aborted = false): boolean | undefined {
	return reason === "overflow" && !aborted ? true : undefined;
}

export async function _runAutoCompaction(this: AgentSession, reason: "overflow" | "threshold", willRetry: boolean): Promise<void> {
	this._emit({ type: "compaction_start", reason });
	const abortController = new AbortController();
	this._autoCompactionAbortController = abortController;

	try {
		if (!this.model) {
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				unresolvedOverflow: overflowUnresolved(reason),
			});
			return;
		}

		// Resolve auth only after extension hooks have had an opportunity to cancel
		// compaction or provide compacted text, so local extension compaction does not
		// require provider credentials. Missing auth then fails model-driven compaction
		// before persistence or continuation, matching other provider-call failures.
		const model = this.model;
		const createApplyOptions = () => {
			const retryableOverflowAssistantEntryId = reason === "overflow"
				&& willRetry
				&& this._lastAssistantEntryId
				&& this.sessionManager.getLeafId() === this._lastAssistantEntryId
				? this._lastAssistantEntryId
				: undefined;
			return {
				resolvePlannerAuth: async () => {
					const authResult = await this._modelRegistry.getApiKeyAndHeaders(model);
					if (!authResult.ok || !authResult.apiKey) {
						return undefined;
					}
					return { apiKey: authResult.apiKey, headers: authResult.headers };
				},
				abortController,
				backupLabel: reason === "overflow" ? "overflow-auto-compact" : "auto-compact",
				reason,
				...(retryableOverflowAssistantEntryId ? { excludeEntryId: retryableOverflowAssistantEntryId } : {}),
			} as const;
		};
		let result;
		try {
			result = await this._applyVerbatimCompaction(createApplyOptions());
		} catch (error) {
			if (!(error instanceof StaleCompactionPlanError)) throw error;
			result = await this._applyVerbatimCompaction(createApplyOptions());
		}
		if (!result) {
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				unresolvedOverflow: overflowUnresolved(reason),
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
			unresolvedOverflow: overflowUnresolved(reason, aborted),
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
	_awaitPendingPostCompactionContinuation,
	_checkCompaction,
	_isCopilotServerCapBelowSelectedContextWindow,
	_dropTrailingAutoCompactionRetryAssistantIfPresent,
	_schedulePostAutoCompactionContinuationProbe,
	_resumeAfterAutoCompaction,
	_resumeAfterLengthTruncation,
	_runAutoCompaction,
};
