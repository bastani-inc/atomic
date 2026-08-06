import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { calculateContextTokens, estimateContextTokens, shouldCompact } from "./compaction/index.ts";
import { MIN_RESPONSES_MAX_OUTPUT_TOKENS } from "./openai-responses-payload-sanitizer.ts";
import { getLatestCompactionBoundaryEntry } from "./session-manager.ts";

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

export async function _checkCompaction(
	this: AgentSession,
	assistantMessage: AssistantMessage,
	skipAbortedCheck = true,
): Promise<void> {
	if (this._pendingPostToolCompactionGuard) {
		const { result } = this._pendingPostToolCompactionGuard;
		this._pendingPostToolCompactionGuard = undefined;
		this._emit({
			type: "compaction_end",
			reason: "threshold",
			result,
			aborted: true,
			willRetry: false,
			midTurn: true,
		});
	}
	if (
		this._postToolCompactionPreflightError !== undefined &&
		assistantMessage.errorMessage === this._postToolCompactionPreflightError
	) {
		this._postToolCompactionPreflightError = undefined;
		return;
	}
	// The agent_end path passes skipAbortedCheck=true; the pre-prompt path passes
	// false. Only the live turn-completion path may auto-continue a truncated
	// response — before a fresh user prompt we must not resume the old turn.
	const isLiveTurnCompletion = skipAbortedCheck;
	const settings = this.settingsManager.getCompactionSettings();
	const contextWindow = this.model?.contextWindow ?? 0;
	// Skip overflow handling if the message came from a different model.
	// This handles the case where user switched from a smaller-context model (e.g. opus)
	// to a larger-context model (e.g. codex) - the overflow error from the old model
	// shouldn't trigger compaction for the new model.
	const sameModel =
		this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;
	if (!settings.enabled) {
		// Compaction cannot recover this turn, so a configured fallback chain may
		// advance to a larger-context candidate instead of dead-ending.
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) this._contextOverflowUnresolved = true;
		return;
	}

	// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
	if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;

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
	if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
		const willRetry = assistantMessage.stopReason !== "stop";
		if (!willRetry) {
			await this._runAutoCompaction("overflow", false);
			return;
		}

		if (this._overflowRecoveryAttempted) {
			// One compact-and-retry has already been spent on this turn; a configured
			// fallback chain may now advance to a larger-context candidate.
			this._contextOverflowUnresolved = true;
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
	if (shouldCompact(contextTokens, contextWindow, settings)) {
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
	return param !== undefined
		? OUTPUT_BUDGET_PARAMETER_PATTERN.test(param)
		: OUTPUT_BUDGET_PARAMETER_PATTERN.test(message);
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
 * Internal: schedule a live post-event continuation after compaction_end listeners can flush queues.
 * The grace period preserves listener ordering. Queue-only probes wait for transient work to become
 * idle, while retry probes remain tied to the turn that scheduled them and are abandoned if another
 * turn owns the agent when the grace period ends.
 */

export function _schedulePostAutoCompactionContinuationProbe(
	this: AgentSession,
	_reason: "overflow" | "threshold",
	willRetry: boolean,
): void {
	const token = this._postCompactionContinuationToken + 1;
	this._postCompactionContinuationToken = token;
	const fallbackScopeGeneration = this._fallbackOriginGeneration;
	let pending: Promise<void>;
	pending = new Promise<void>((resolve) => {
		setTimeout(() => {
			void (async () => {
				const restoreIfOwned = async (): Promise<void> => {
					if (
						fallbackScopeGeneration === undefined ||
						this._fallbackOriginGeneration !== fallbackScopeGeneration ||
						typeof this._restoreFallbackModel !== "function"
					)
						return;
					try {
						await this._restoreFallbackModel();
					} catch {
						// A listener must not strand the continuation waiter. The model
						// state was already restored before lifecycle notifications ran.
					}
				};
				try {
					if (willRetry) {
						if (this._postCompactionContinuationToken !== token) return;
						if (this.isCompacting || this.isStreaming) return;
					} else {
						await this.agent.waitForIdle();
						if (this._postCompactionContinuationToken !== token) return;
						if (this.isCompacting || this.isStreaming) return;
						if (!this.agent.hasQueuedMessages()) {
							await restoreIfOwned();
							return;
						}
						// A queued message starts the next user turn. Restore before
						// Agent snapshots the next request's model.
						await restoreIfOwned();
					}

					if (this._pendingPostCompactionContinuation !== pending) return;
					// Clear this probe before entering the next run. Its promise is
					// still awaited by _awaitPendingPostCompactionContinuation, but
					// the nested agent_end must be free to schedule a new probe.
					this._pendingPostCompactionContinuation = undefined;
					await this._resumeAfterAutoCompaction();
					if (willRetry && this._pendingPostCompactionContinuation === undefined) {
						await restoreIfOwned();
					}
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

/**
 * Whether an overflow turn is now unrecoverable by compaction, recording it on
 * the session so a configured fallback chain may advance to another candidate.
 */
function overflowUnresolved(
	this: AgentSession,
	reason: "overflow" | "threshold",
	aborted = false,
): boolean | undefined {
	if (reason !== "overflow" || aborted) return undefined;
	this._contextOverflowUnresolved = true;
	return true;
}

export async function _runAutoCompaction(
	this: AgentSession,
	reason: "overflow" | "threshold",
	willRetry: boolean,
): Promise<void> {
	// Publish automatic ownership before notifying listeners. `_emit()` invokes
	// public listeners synchronously, so a `compaction_start` listener that calls
	// `compact()` must already observe this controller and be rejected rather than
	// racing the run that was just announced.
	this._autoCompactionAbortController = new AbortController();
	this._compactionReason = reason;
	try {
		this._emit({ type: "compaction_start", reason });
	} catch (error) {
		// A throwing start listener still propagates, matching current behavior,
		// but must not leave ownership published with no owner running.
		this._autoCompactionAbortController = undefined;
		if (this._compactionReason === reason) this._compactionReason = undefined;
		throw error;
	}

	try {
		if (!this.model) {
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				unresolvedOverflow: overflowUnresolved.call(this, reason),
			});
			return;
		}

		// Resolve auth only after extension hooks have had an opportunity to cancel
		// compaction or provide compacted text, so local extension compaction does not
		// require provider credentials. Missing auth then fails model-driven compaction
		// before persistence or continuation, matching other provider-call failures.
		const result = await this._applyVerbatimCompaction({
			resolvePlannerAuth: async (candidate) => {
				const authResult = await this._getRequiredRequestAuth(candidate);
				return authResult.apiKey || authResult.headers ? authResult : undefined;
			},
			abortController: this._autoCompactionAbortController,
			backupLabel: reason === "overflow" ? "overflow-auto-compact" : "auto-compact",
			reason,
			// Overflow recovery is load-bearing: the turn cannot continue without it.
			// A threshold crossing has already passed its turn boundary, so failing is safe.
			urgency: reason === "overflow" ? "load_bearing" : "recoverable",
			// A real provider overflow already proved the context does not fit, so a
			// sub-minimum region may reach the fresh rung.
			...(reason === "overflow" ? { allowSmallRegion: true } : {}),
		});
		if (!result) {
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				unresolvedOverflow: overflowUnresolved.call(this, reason),
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
		const aborted =
			errorMessage === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
		this._emit({
			type: "compaction_end",
			reason,
			result: undefined,
			aborted,
			willRetry: false,
			unresolvedOverflow: overflowUnresolved.call(this, reason, aborted),
			errorMessage: aborted
				? undefined
				: reason === "overflow"
					? `Context overflow recovery failed: ${errorMessage}`
					: `Auto-compaction failed: ${errorMessage}`,
		});
	} finally {
		this._autoCompactionAbortController = undefined;
		if (this._compactionReason === reason) this._compactionReason = undefined;
	}
}

/**
 * Toggle auto-compaction setting.
 */

export const agentSessionAutoCompactionMethods = {
	_awaitPendingPostCompactionContinuation,
	_checkCompaction,
	_dropTrailingAutoCompactionRetryAssistantIfPresent,
	_schedulePostAutoCompactionContinuationProbe,
	_resumeAfterAutoCompaction,
	_resumeAfterLengthTruncation,
	_runAutoCompaction,
};
