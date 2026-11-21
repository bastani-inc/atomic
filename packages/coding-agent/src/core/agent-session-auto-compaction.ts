import type { AgentMessage } from "@bastani/atomic-agent-core";
import { getCurrentSystemMessage } from "@bastani/atomic-ai";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { isContextOverflow, isRecoverableLength } from "@bastani/atomic-ai/compat";
import { automaticBoundaryText, emitSessionCompactFailed } from "./agent-session-compaction.ts";
import type {
	AgentSessionInternalSurface as AgentSession,
	AutoCompactionRunOutcome,
	AutoCompactionUrgency as CompactionUrgency,
} from "./agent-session-methods.ts";
import { pendingResumeUpdate } from "./agent-session-state.ts";
import type { AgentQueueAccess } from "./agent-session-types.js";
import {
	calculateContextTokens,
	estimateContextTokens,
	estimateProjectedContextTokens,
	shouldCompact,
} from "./compaction/index.ts";
import { MIN_RESPONSES_MAX_OUTPUT_TOKENS } from "./openai-responses-payload-sanitizer.ts";
import { clearsForResumedBudget, isAddedByResume } from "./resume-cache-checkpoint.ts";
import { type ContextEditEntry, getLatestCompactionBoundaryEntry } from "./session-manager.ts";

/**
 * Upper bound on direct continuations after a response reaches its requested
 * output cap. Context-limited truncations use one compact-and-retry attempt
 * instead; this bound preserves Atomic's separate output-cap continuation.
 */
export const MAX_LENGTH_CONTINUATION_ATTEMPTS = 3;

export const MAX_OUTPUT_BUDGET_ERROR_CONTINUATION_ATTEMPTS = 1;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ProviderErrorDetails = {
	message?: string;
	code?: string;
	param?: string;
};

/** Create the settlement boundary for a regular automatic compaction run. */
export function createAutoCompactionCompletion(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const OUTPUT_BUDGET_PARAMETER_PATTERN = /\bmax_output_tokens\b/;
const OUTPUT_BUDGET_UNDERFLOW_PATTERN = new RegExp(
	`(?:integer\\s+below\\s+minimum\\s+value|expected\\s+(?:a\\s+)?value\\s*>=\\s*${MIN_RESPONSES_MAX_OUTPUT_TOKENS}|got\\s+1\\s+instead)`,
);

export async function _checkCompaction(
	this: AgentSession,
	assistantMessage: AssistantMessage,
	skipAbortedCheck = true,
): Promise<void> {
	if (this._agentRunAbortRequested) return;
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
			...(hasPendingManualCompactionTakeover.call(this) ? { manualTakeoverPending: true } : {}),
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
	const settings = this.settingsManager.getCompactionSettings(this.model);
	const contextWindow = this.model?.contextWindow ?? 0;
	// Skip overflow handling if the message came from a different model.
	// This handles the case where user switched from a smaller-context model (e.g. opus)
	// to a larger-context model (e.g. codex) - the overflow error from the old model
	// shouldn't trigger compaction for the new model.
	const sameModel =
		this.model !== undefined &&
		assistantMessage.provider === this.model.provider &&
		assistantMessage.model === this.model.id;
	// Usage and overflow signals belong to the request that produced this assistant.
	// A later context edit or compaction changes what the next request contains, so
	// only a projected, unedited assistant may drive usage-based decisions; an explicit
	// provider overflow error still recovers while its attempt is retained.
	// Guarded because fallback suites drive this function on a synthetic session.
	const projectionAware =
		typeof this.sessionManager?.buildSessionProjection === "function" &&
		typeof this._findPersistedMessageEntryId === "function";
	const currentProjection = projectionAware ? this.sessionManager.buildSessionProjection() : undefined;
	const branch = projectionAware ? this.sessionManager.getBranch() : [];
	const assistantEntryId = projectionAware ? this._findPersistedMessageEntryId(assistantMessage) : undefined;
	const assistantIsProjected =
		assistantEntryId === undefined ||
		currentProjection?.entries.some(
			(entry) =>
				entry.sourceEntry.id === assistantEntryId && entry.messages.some((message) => message.role === "assistant"),
		) === true;
	const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
	const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
	const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
	const latestAssistantEdit = entriesAfterAssistant
		.filter(
			(entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId,
		)
		.at(-1);
	const assistantRetainedForExplicitRecovery =
		assistantEntryId === undefined ||
		(!entriesAfterAssistant.some((entry) => entry.type === "compaction") &&
			latestAssistantEdit?.replacement !== null);
	const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
	const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
	const contextOverflow =
		sameModel &&
		((explicitOverflow && assistantRetainedForExplicitRecovery) ||
			(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
	if (!settings.enabled) {
		// Compaction cannot recover this turn, so a configured fallback chain may
		// advance to a larger-context candidate instead of dead-ending.
		if (contextOverflow) this._contextOverflowUnresolved = true;
		return;
	}

	// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
	if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;

	// Skip compaction checks if this assistant message is older than the latest
	// compaction boundary. This prevents a stale pre-compaction usage/error
	// from retriggering compaction on the first prompt after compaction.
	const compactionBoundaryEntry = getLatestCompactionBoundaryEntry(this.sessionManager.getBranch());
	// Branch order decides, not wall-clock time: a provider overflow on the request right after a
	// boundary often shares its millisecond and must still recover (#4977). An assistant that is not
	// persisted yet is newer than every boundary.
	const isFromBeforeCompactionBoundary = (message: AssistantMessage): boolean => {
		if (compactionBoundaryEntry === null) return false;
		if (!projectionAware) return message.timestamp <= new Date(compactionBoundaryEntry.timestamp).getTime();
		const entryId = this._findPersistedMessageEntryId(message);
		if (entryId === undefined) return false;
		const boundaryIndex = branch.findIndex((entry) => entry.id === compactionBoundaryEntry.id);
		return branch.findIndex((entry) => entry.id === entryId) < boundaryIndex;
	};
	if (isFromBeforeCompactionBoundary(assistantMessage)) return;

	// Case 1: Recoverable failure. Explicit/silent context overflow still uses
	// context metadata. A length stop below the model's original requested output
	// cap instead receives one compact-and-retry independent of context metadata.
	const desiredMaxOutput = this.model?.maxTokens ?? 0;
	const recoverableLength =
		isLiveTurnCompletion &&
		sameModel &&
		assistantIsProjected &&
		isRecoverableLength(assistantMessage, desiredMaxOutput);
	if (contextOverflow || recoverableLength) {
		const willRetry = assistantMessage.stopReason !== "stop";
		if (!willRetry) {
			// A complete answer stays the session's last answer for its readers; the clear runs before the next request.
			if (isLiveTurnCompletion) return;
			await this._runAutoCompaction("overflow", false);
			return;
		}

		const recoveryAttempted = contextOverflow
			? this._overflowRecoveryAttempted
			: this._recoverableLengthRecoveryAttempted;
		if (recoveryAttempted) {
			// One recovery of this kind has already been spent on this turn. A real
			// context overflow may now advance to a larger-context fallback; a
			// recoverable output truncation stops without claiming overflow.
			if (contextOverflow) this._contextOverflowUnresolved = true;
			const errorMessage = contextOverflow
				? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
				: "Response truncation recovery stopped after one retry.";
			this._emit({
				type: "compaction_end",
				reason: "overflow",
				result: undefined,
				aborted: false,
				willRetry: false,
				...(contextOverflow ? { unresolvedOverflow: true } : {}),
				errorMessage,
			});
			await emitSessionCompactFailed(this, {
				reason: "overflow",
				errorMessage,
				aborted: false,
				willRetry: false,
				fromExtension: false,
			});
			return;
		}

		if (contextOverflow) this._overflowRecoveryAttempted = true;
		else this._recoverableLengthRecoveryAttempted = true;
		let outcome: AutoCompactionRunOutcome;
		try {
			outcome = contextOverflow
				? await this._runAutoCompaction("overflow", willRetry)
				: await this._runAutoCompaction("overflow", willRetry, "recoverable");
		} catch (error) {
			if (contextOverflow) this._overflowRecoveryAttempted = false;
			else this._recoverableLengthRecoveryAttempted = false;
			throw error;
		}
		if (outcome === "compacted" || outcome === "failed") return;
		// No boundary means there is no context to free. Keep this recovery
		// attempt spent while its one direct continuation is pending, so another
		// below-cap stop cannot start a new compaction cycle.
		if (
			recoverableLength &&
			outcome === "not_compactable" &&
			this._compactionAbortController === undefined &&
			this._manualCompactionPromise === undefined
		) {
			await this._resumeAfterLengthTruncation();
			return;
		}
		if (contextOverflow) this._overflowRecoveryAttempted = false;
		else this._recoverableLengthRecoveryAttempted = false;
		return;
	}

	// Case 2: Threshold - context is getting large
	// For errors or all-zero provider usage, estimate from message content.
	let contextTokens = calculateContextTokens(assistantMessage.usage, assistantMessage.api);
	const hasContextEdits =
		currentProjection?.entries.some((entry) => entry.sourceEntry.type === "context_edit") === true;
	if (currentProjection && hasContextEdits) {
		// Edited context invalidates usage captured before the edit; estimate the projection.
		contextTokens = estimateProjectedContextTokens(currentProjection, branch).tokens;
	} else if (assistantMessage.stopReason === "error" || contextTokens === 0) {
		const messages = this.agent.state.messages;
		const estimate = estimateContextTokens(messages);
		// Without provider usage, estimate.tokens is the pure message-size estimate.
		// Only usage-backed estimates need the stale pre-compaction check.
		if (estimate.lastUsageIndex !== null) {
			const usageMsg = messages[estimate.lastUsageIndex];
			if (usageMsg.role === "assistant" && isFromBeforeCompactionBoundary(usageMsg as AssistantMessage)) return;
		}
		contextTokens = estimate.tokens;
	}
	if (shouldCompact(contextTokens, contextWindow, settings)) {
		const willRetry = shouldRetryAfterThresholdCompaction(assistantMessage, desiredMaxOutput, isLiveTurnCompletion);
		// A turn that is not retried keeps its answer as the session's last answer for its readers (the caller, RPC,
		// a child session). The clear runs just before the next model request instead.
		if (!willRetry && isLiveTurnCompletion) return;
		if (willRetry && isRetryWorthyOutputBudgetError(assistantMessage)) {
			if (this._outputBudgetErrorContinuationAttempts >= MAX_OUTPUT_BUDGET_ERROR_CONTINUATION_ATTEMPTS) {
				const errorMessage =
					"Output-budget recovery stopped after a compact-and-retry attempt. Try reducing context or switching to a larger-context model.";
				this._emit({
					type: "compaction_end",
					reason: "threshold",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await emitSessionCompactFailed(this, {
					reason: "threshold",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return;
			}
			this._outputBudgetErrorContinuationAttempts += 1;
		}
		await this._runAutoCompaction("threshold", willRetry);
		return;
	}
	// A length stop that reached its requested output cap is not the
	// context-limited truncation recovered above. Preserve Atomic's bounded
	// direct-continuation policy for that distinct case.
	if (
		isLiveTurnCompletion &&
		isOutputCappedLengthStop(assistantMessage, desiredMaxOutput) &&
		this._compactionAbortController === undefined &&
		this._manualCompactionPromise === undefined
	) {
		await this._resumeAfterLengthTruncation();
	}
}

export function isRetryWorthyLengthStop(assistantMessage: AssistantMessage): boolean {
	return assistantMessage.stopReason === "length" && assistantMessage.usage.output > 0;
}

export function isOutputCappedLengthStop(assistantMessage: AssistantMessage, desiredMaxOutput: number): boolean {
	return isRetryWorthyLengthStop(assistantMessage) && !isRecoverableLength(assistantMessage, desiredMaxOutput);
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

export function shouldRetryAfterThresholdCompaction(
	assistantMessage: AssistantMessage,
	desiredMaxOutput: number,
	isLiveTurnCompletion: boolean,
): boolean {
	return (
		isRetryWorthyOutputBudgetError(assistantMessage) ||
		(isLiveTurnCompletion && isOutputCappedLengthStop(assistantMessage, desiredMaxOutput))
	);
}

/**
 * Internal: remove an incomplete assistant from retry context before auto-continuing after compaction.
 */

export async function _dropTrailingAutoCompactionRetryAssistantIfPresent(this: AgentSession): Promise<void> {
	// The attempt stays in raw session history; a durable context edit omits it from
	// the model projection so the continuation resumes from the preceding input.
	await this._omitTrailingAssistantAttempt(
		(assistant) => assistant.stopReason === "error" || assistant.stopReason === "length",
	);
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
	if (this._agentRunAbortRequested) return;
	const token = this._postCompactionContinuationToken + 1;
	this._postCompactionContinuationToken = token;
	const fallbackScopeGeneration = this._fallbackOriginGeneration;
	let pending: Promise<void>;
	pending = new Promise<void>((resolve) => {
		setTimeout(() => {
			void (async () => {
				const settleIfOwned = async (): Promise<void> => {
					if (
						fallbackScopeGeneration === undefined ||
						this._fallbackOriginGeneration !== fallbackScopeGeneration ||
						typeof this._settleFallbackModelScope !== "function"
					)
						return;
					try {
						await this._settleFallbackModelScope();
					} catch {
						// A listener must not strand the continuation waiter. The fallback
						// state was already settled before lifecycle notifications ran.
					}
				};
				try {
					if (this._agentRunAbortRequested) return;
					if (willRetry) {
						if (this._postCompactionContinuationToken !== token) return;
						if (this.isCompacting || this.isStreaming) return;
					} else {
						await this.agent.waitForIdle();
						if (this._postCompactionContinuationToken !== token) return;
						if (this.isCompacting || this.isStreaming) return;
						if (!this.agent.hasQueuedMessages()) {
							await settleIfOwned();
							return;
						}
						// A queued message starts the next user turn. Settle before Agent
						// snapshots the next request's model.
						await settleIfOwned();
					}

					if (this._pendingPostCompactionContinuation !== pending) return;
					// Clear this probe before entering the next run. Its promise is
					// still awaited by _awaitPendingPostCompactionContinuation, but
					// the nested agent_end must be free to schedule a new probe.
					this._pendingPostCompactionContinuation = undefined;
					await this._resumeAfterAutoCompaction();
					if (willRetry && this._pendingPostCompactionContinuation === undefined) {
						await settleIfOwned();
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
	// A continuation can schedule another probe (for example a second output-cap
	// stop). Keep the owning prompt alive until the whole automatic chain drains.
	while (this._pendingPostCompactionContinuation !== undefined) {
		await this._pendingPostCompactionContinuation;
	}
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
 * Internal: resume a response that reached its requested output cap when the
 * context does not warrant compaction. Bounded so a model that repeatedly
 * stops at that cap can still terminate.
 */

export async function _resumeAfterLengthTruncation(this: AgentSession): Promise<void> {
	if (this._lengthContinuationAttempts >= MAX_LENGTH_CONTINUATION_ATTEMPTS) return;
	this._lengthContinuationAttempts += 1;
	// agent.continue() rejects an assistant tail; drop the incomplete
	// length-stopped message so the preceding user/tool-result anchors the
	// continuation. It remains persisted in session history.
	await this._dropTrailingAutoCompactionRetryAssistantIfPresent();
	this._schedulePostAutoCompactionContinuationProbe("threshold", true);
}

/**
 * Whether an overflow turn is now unrecoverable by compaction, recording it on
 * the session so a configured fallback chain may advance to another candidate.
 */
function overflowUnresolved(this: AgentSession, loadBearing: boolean, aborted = false): boolean | undefined {
	if (!loadBearing || aborted) return undefined;
	this._contextOverflowUnresolved = true;
	return true;
}

export function hasPendingManualCompactionTakeover(this: AgentSession): boolean {
	return this._compactionReason === "manual" && this._compactionAbortController !== undefined;
}

function autoCompactionFailureMessage(
	reason: "overflow" | "threshold",
	urgency: CompactionUrgency,
	error: unknown,
): string {
	const message = error instanceof Error ? error.message : "compaction failed";
	if (reason !== "overflow") return `Auto-compaction failed: ${message}`;
	return urgency === "recoverable"
		? `Response truncation recovery failed: ${message}`
		: `Context overflow recovery failed: ${message}`;
}

export async function _runAutoCompaction(
	this: AgentSession,
	reason: "overflow" | "threshold",
	willRetry: boolean,
	urgency: CompactionUrgency = reason === "overflow" ? "load_bearing" : "recoverable",
	coveredThroughEntryId?: string,
): Promise<AutoCompactionRunOutcome> {
	if (
		this._compactionAbortController !== undefined ||
		this._manualCompactionPromise !== undefined ||
		this._autoCompactionAbortController !== undefined
	)
		return "deferred";

	const controller = new AbortController();
	const completion = createAutoCompactionCompletion();
	this._autoCompactionAbortController = controller;
	this._autoCompactionCompletion = completion.promise;
	this._compactionReason = reason;
	this._compactionStartedAt = Date.now();
	let fromExtension = false;
	try {
		this._emit({ type: "compaction_start", reason });
	} catch (error) {
		// A throwing start listener still propagates, matching current behavior,
		// but must not leave ownership published with no owner running.
		if (this._autoCompactionAbortController === controller) this._autoCompactionAbortController = undefined;
		if (this._compactionReason === reason) {
			this._compactionReason = undefined;
			this._compactionStartedAt = undefined;
		}
		completion.resolve();
		if (this._autoCompactionCompletion === completion.promise) this._autoCompactionCompletion = undefined;
		throw error;
	}

	try {
		controller.signal.throwIfAborted();
		if (!this.model) {
			const manualTakeoverPending = hasPendingManualCompactionTakeover.call(this);
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				unresolvedOverflow: overflowUnresolved.call(this, urgency === "load_bearing"),
				...(manualTakeoverPending ? { manualTakeoverPending: true } : {}),
			});
			await emitSessionCompactFailed(this, {
				reason,
				aborted: false,
				willRetry: false,
				fromExtension: false,
			});
			return manualTakeoverPending ? "deferred" : "failed";
		}

		const result = await this._applyVerbatimCompaction({
			abortController: controller,
			...(coveredThroughEntryId ? { coveredThroughEntryId } : {}),
			backupLabel: urgency === "load_bearing" ? "overflow-auto-compact" : "auto-compact",
			reason,
			onCompactionSource: (value) => {
				fromExtension = value;
			},
		});
		if (!result) {
			const manualTakeoverPending = hasPendingManualCompactionTakeover.call(this);
			this._emit({
				type: "compaction_end",
				reason,
				result: undefined,
				aborted: false,
				willRetry: false,
				unresolvedOverflow: overflowUnresolved.call(this, urgency === "load_bearing"),
				...(manualTakeoverPending ? { manualTakeoverPending: true } : {}),
			});
			await emitSessionCompactFailed(this, {
				reason,
				aborted: false,
				willRetry: false,
				fromExtension,
			});
			return manualTakeoverPending ? "deferred" : "not_compactable";
		}

		if (willRetry) {
			this._dropTrailingAutoCompactionRetryAssistantIfPresent();
		}

		this._emit({
			type: "compaction_end",
			reason,
			result,
			aborted: false,
			willRetry,
			...(hasPendingManualCompactionTakeover.call(this) ? { manualTakeoverPending: true } : {}),
		});
		if (!hasPendingManualCompactionTakeover.call(this)) {
			this._schedulePostAutoCompactionContinuationProbe(reason, willRetry);
		}
		return "compacted";
	} catch (error) {
		const aborted = controller.signal.aborted;
		const manualTakeoverPending = hasPendingManualCompactionTakeover.call(this);
		const formattedErrorMessage = aborted ? undefined : autoCompactionFailureMessage(reason, urgency, error);
		this._emit({
			type: "compaction_end",
			reason,
			result: undefined,
			aborted,
			willRetry: false,
			unresolvedOverflow: overflowUnresolved.call(this, urgency === "load_bearing", aborted),
			...(manualTakeoverPending ? { manualTakeoverPending: true } : {}),
			errorMessage: formattedErrorMessage,
		});
		await emitSessionCompactFailed(this, {
			reason,
			errorMessage: formattedErrorMessage,
			aborted,
			willRetry: false,
			fromExtension,
		});
		return manualTakeoverPending ? "deferred" : "failed";
	} finally {
		if (this._autoCompactionAbortController === controller) this._autoCompactionAbortController = undefined;
		if (this._compactionReason === reason) {
			this._compactionReason = undefined;
			this._compactionStartedAt = undefined;
		}
		completion.resolve();
		if (this._autoCompactionCompletion === completion.promise) this._autoCompactionCompletion = undefined;
	}
}

/**
 * Toggle auto-compaction setting.
 */

/**
 * Clear the context just before a continuation sends its next request, when it is over the automatic trigger. A turn
 * that ended over the trigger left its answer in context for its readers; this is where that clear happens for queued
 * messages and for a detached tool's result, as the prompt check does for a new prompt. Resolves whether it cleared.
 *
 * Below the trigger, the first request after a resume is checked as a prompt is ({@link _compactBeforeResumedPrompt}),
 * with `input`, the messages the continuation starts with (by default the queued ones its first request takes). That
 * clear keeps what the resume added as the context's last messages, so the continuation goes on as it would have and
 * this resolves false.
 */
export async function _compactBeforeContinuation(
	this: AgentSession,
	input?: readonly AgentMessage[],
): Promise<boolean> {
	const model = this.model;
	if (!model) return false;
	const settings = this.settingsManager.getCompactionSettings(model);
	if (!settings.enabled) return false;
	if (
		this._compactionAbortController !== undefined ||
		this._manualCompactionPromise !== undefined ||
		this._autoCompactionAbortController !== undefined
	)
		return false;
	if (shouldCompact(estimateContextTokens(this.agent.state.messages).tokens, model.contextWindow, settings))
		return (await this._runAutoCompaction("threshold", false)) === "compacted";
	if (this._resumeBudgetCheckpoint)
		await this._compactBeforeResumedPrompt(undefined, input ?? continuationInput(this), false);
	return false;
}

/**
 * The queued messages a continuation's first request takes: after a reply, the next queued steering or follow-up
 * input (`promptQueuedMessages()`); after other input, only steering, which the continued turn polls first.
 */
function continuationInput(session: AgentSession): AgentMessage[] {
	if (session.agent.state.messages.at(-1)?.role === "assistant") return session.agent.peekQueuedMessages();
	return (session.agent as unknown as AgentQueueAccess).steeringQueue?.peek() ?? [];
}

/**
 * Clear the context before the first request after a resume when what only the resume added (blueprint context,
 * recovery notices, the prompt `update` the resume brings) would otherwise lower the thinking budget the restored
 * history was sent with ({@link clearsForResumedBudget}). Runs once the request's `input` and `update` are final,
 * through the automatic compaction, whose boundary covers the restored history only. What was added after the session
 * opened counts with the input: a session that kept running would have sent it too. Resolves whether it cleared.
 *
 * The check runs again for a later run when no request followed this one (the run stopped before its request, or the
 * request's provider setup failed): the first request the provider gets is checked with its own input. A run that does
 * not send the session's prompt as it is now (`sendsPrompt` false: an interrupt, or a continuation of queued input)
 * sends no `update`, so the run that sends it is checked again. Only a request whose transcript holds the `update` a
 * run that sends the prompt was checked with (any request once that run found no update), or this clear, retires the
 * checkpoint.
 */
export async function _compactBeforeResumedPrompt(
	this: AgentSession,
	update: AgentMessage | undefined,
	input: readonly AgentMessage[],
	sendsPrompt = true,
): Promise<boolean> {
	const checkpoint = this._resumeBudgetCheckpoint;
	const model = this.model;
	if (checkpoint && sendsPrompt) this._resumePromptUpdate = update ?? null;
	else if (checkpoint && this._resumePromptUpdate === undefined && this._resumeHeldUpdate === undefined) {
		// With no prompt update pending, this run's request ends the check, as a prompt's would; otherwise its turns
		// hold back what the update adds until a request sends it through the check (see withoutResumeUpdate).
		const pending = pendingResumeUpdate(this);
		if (pending) this._resumeHeldUpdate = pending;
		else this._resumePromptUpdate = null;
	}
	if (!checkpoint || !model || !this.settingsManager.getCompactionSettings(model).enabled) return false;
	if (
		this._compactionAbortController !== undefined ||
		this._manualCompactionPromise !== undefined ||
		this._autoCompactionAbortController !== undefined
	)
		return false;
	// A forced system prompt or an extension's context handler changes what the request sends from what the
	// transcript holds, so the transcript cannot tell what the resume's additions cost.
	const forced = this._runSystemPromptOptions?.forceSystemPrompt ?? this._baseSystemPromptOptions.forceSystemPrompt;
	const runner = this._extensionRunner;
	if (forced !== undefined || runner.hasHandlers("context") || runner.hasHandlers("context_with_system")) return false;
	const messages = this.agent.state.messages;
	const at = messages.indexOf(checkpoint);
	const entryId = at === -1 ? undefined : this._findPersistedMessageEntryId(checkpoint);
	if (entryId === undefined) return false;
	const history = messages.slice(0, at + 1);
	// The boundary records the prompt as the restored history ends; a prompt change after it replays after it and
	// counts with the conversation's own input.
	const unsent = messages.slice(at + 1);
	const resumeOnly = unsent.filter(isAddedByResume);
	const added = update ? [...resumeOnly, update] : resumeOnly;
	const head = getCurrentSystemMessage(history);
	const boundary: AgentMessage = { role: "user", content: automaticBoundaryText(this), timestamp: 0 };
	const clears = clearsForResumedBudget({
		model,
		thinkingLevel: this.thinkingLevel,
		thinkingBudgets: this.agent.thinkingBudgets,
		blockImages: this.settingsManager.getBlockImages(),
		history,
		resumeOnly: added,
		prompt: [...unsent.filter((message) => !isAddedByResume(message)), ...input],
		cleared: [...(head ? [head] : []), boundary, ...added],
	});
	// The boundary covers the restored history only, so what the resume added stays in the context as it was.
	if (!clears || (await this._runAutoCompaction("threshold", false, "recoverable", entryId)) !== "compacted")
		return false;
	if (this._resumeBudgetCheckpoint === checkpoint) {
		this._resumeBudgetCheckpoint = undefined;
		this._resumePromptUpdate = undefined;
		this._resumeHeldUpdate = undefined;
	}
	return true;
}

/**
 * Continue the agent after the pre-request check. After a clear, queued input is the next request's prompt, as a new
 * prompt would be, rather than waiting behind a turn over the cleared context.
 */
export async function _continueAgentAfterCompactionCheck(this: AgentSession): Promise<void> {
	if ((await this._compactBeforeContinuation()) && (await this.agent.promptQueuedMessages())) return;
	await this.agent.continue();
}

export const agentSessionAutoCompactionMethods = {
	_compactBeforeContinuation,
	_compactBeforeResumedPrompt,
	_continueAgentAfterCompactionCheck,
	_awaitPendingPostCompactionContinuation,
	_checkCompaction,
	_dropTrailingAutoCompactionRetryAssistantIfPresent,
	_schedulePostAutoCompactionContinuationProbe,
	_resumeAfterAutoCompaction,
	_resumeAfterLengthTruncation,
	_runAutoCompaction,
};
