import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { clampThinkingLevel, isContextOverflow, modelsAreEqual } from "@earendil-works/pi-ai/compat";
import { sleep } from "../utils/sleep.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { isCodexTokenInvalidationError } from "./codex-errors.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { fallbackKey, resolveFallbackModel as resolveConfiguredFallbackModel } from "./fallback-models.ts";
import {
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	isSafetyRefusalFailure,
	normalizeModelFailureSignal,
} from "./model-fallback-failures.ts";
import { nextRetryDecision } from "./retry-policy.ts";

function modelLabel(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "unknown model";
}

function containsCodexTokenInvalidation(provider: string, value: unknown, seen = new Set<unknown>()): boolean {
	if (value === null || value === undefined || seen.has(value)) return false;
	if (typeof value === "string") return isCodexTokenInvalidationError(provider, value);
	if (typeof value !== "object") return false;
	seen.add(value);
	const record = value as Record<string, unknown>;
	for (const field of [record.errorMessage, record.message, record.statusText]) {
		if (typeof field === "string" && isCodexTokenInvalidationError(provider, field)) return true;
	}
	for (const nested of [
		record.error,
		record.cause,
		...(Array.isArray(record.diagnostics) ? record.diagnostics : []),
	]) {
		if (containsCodexTokenInvalidation(provider, nested, seen)) return true;
	}
	return false;
}

function resolveFallbackModel(
	this: AgentSession,
	value: string,
): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined {
	return resolveConfiguredFallbackModel(
		value,
		this._modelRuntime,
		this.model?.provider ?? this.settingsManager.getDefaultProvider(),
	);
}

/** Whether an assistant error may advance the configured fallback chain. */
export function _isFallbackableError(this: AgentSession, message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const contextWindow = this.model?.contextWindow ?? 0;
	if (isContextOverflow(message, contextWindow)) return false;
	const provider = message.provider || this.model?.provider;
	if (provider && containsCodexTokenInvalidation(provider, message)) return true;
	const signal = normalizeModelFailureSignal(message);
	if (signal.kind === "cancelled" || signal.kind === "task_failure") return false;
	return isRetryableModelFailure(message);
}

/**
 * Whether the current model should be requested again.
 *
 * Fallback eligibility is broader than same-model retry eligibility. Auth and
 * request-incompatible failures should spend a fallback candidate, but cannot
 * be repaired by sending the same request again. Codex token invalidation is
 * also terminal for the current model while remaining fallbackable.
 */
export function _isRetryableError(this: AgentSession, message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;

	// Context overflow is handled by compaction, not retry.
	const contextWindow = this.model?.contextWindow ?? 0;
	if (isContextOverflow(message, contextWindow)) return false;

	const provider = message.provider || this.model?.provider;
	if (provider && containsCodexTokenInvalidation(provider, message)) return false;

	// Safety/refusal errors remain bounded same-model retries, but do not spend
	// another provider candidate. The refusal grammar lives in the shared
	// classifier so this decision cannot drift from workflow fallback handling.
	if (isSafetyRefusalFailure(message)) return true;
	return isRetryableSameModelFailure(message);
}

/**
 * Detect a degenerate empty completion: the provider ended the stream with no
 * usable content and zero output tokens. Seen with github-copilot Gemini models
 * that emit finish_reason "stop" (or a tool-use stop) with an empty content array
 * and 0 output tokens, leaving the turn dead instead of producing the next step.
 *
 * These are treated as retryable so the harness re-issues the request rather than
 * silently stopping mid-task. Guarded tightly (no text, no tool call, no thinking,
 * and output === 0) so legitimate non-empty turns are never matched.
 *
 * Intentionally provider-agnostic (not gated to Copilot Gemini): a degenerate
 * empty turn is a transient failure for any provider. It is bounded by
 * `maxRetries` and falls through to normal handling on exhaustion.
 */

export function _isEmptyCompletion(this: AgentSession, message: AssistantMessage): boolean {
	// Only "completed" stop reasons can be deceptively empty. Real errors are handled
	// by _isRetryableError; aborted/length turns are intentional outcomes.
	if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return false;

	const content = message.content;
	if (Array.isArray(content)) {
		const hasContent = content.some((part) => {
			if (part.type === "text") return part.text.trim().length > 0;
			if (part.type === "toolCall") return true;
			if (part.type === "thinking") return part.redacted === true || part.thinking.trim().length > 0;
			return true; // unknown part types count as content
		});
		if (hasContent) return false;
	}

	// A turn that produced output tokens but no surfaced content is not "empty"
	// (e.g. reasoning-only responses); leave those alone. Note: a provider that
	// fails to report `usage` (output defaults to 0) would make every
	// content-less turn match here; the dual requirement (empty content AND zero
	// output) keeps that false-positive risk low in practice.
	return (message.usage?.output ?? 0) === 0;
}

/**
 * Detect a canned provider-side safety refusal that arrives as a *successful*
 * completion instead of an error. Seen with github-copilot GPT models under
 * heavy contexts: the endpoint intercepts the request and returns exactly
 * "I'm sorry, but I cannot assist with that request." with zero usage and a
 * spurious stopReason of "length" (or "stop"), which the agent would otherwise
 * accept as the final answer and dead-end the turn (issue #1608).
 *
 * A text heuristic is unavoidable here: the OpenAI Responses API does signal
 * these interceptions structurally (`refusal` content parts plus
 * `incomplete_details.reason: "content_filter"`), but pi-ai's normalization
 * folds refusal parts into plain text blocks and collapses the `incomplete`
 * status to stopReason "length", discarding the reason — so no structured
 * refusal marker survives on the AssistantMessage. Providers whose safety
 * signals DO survive as structured errors (Anthropic refusal stops, OpenAI
 * `finish_reason: content_filter`) are matched in _isRetryableError instead.
 *
 * Guarded tightly so legitimate turns are never matched:
 * - only non-error completion stops ("stop" | "length" | "toolUse");
 * - content must be a single short canned refusal text — any tool call,
 *   thinking block, or additional prose disqualifies the message;
 * - usage.output must be 0: a genuine model-authored refusal bills output
 *   tokens, while the intercepted canned refusal reports zero usage.
 *
 * Treated as retryable so the harness re-requests the model call rather than
 * accepting the refusal; bounded by `maxRetries` like every other retry path.
 */

const CANNED_SAFETY_REFUSAL_PATTERN =
	/^(?:i['’]?m sorry[,.]?\s+(?:but\s+)?|sorry[,.]?\s+(?:but\s+)?)?i\s+(?:cannot|can['’]?t|can\s+not|am\s+unable\s+to|am\s+not\s+able\s+to)\s+(?:assist|help|comply|continue)(?:\s+with)?(?:\s+(?:that|this))?(?:\s+(?:request|task))?\.?$/i;

const CANNED_SAFETY_REFUSAL_MAX_LENGTH = 120;

export function _isSafetyRefusal(this: AgentSession, message: AssistantMessage): boolean {
	// Real errors are handled by _isRetryableError; aborts are user-initiated.
	if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") {
		return false;
	}

	const content = message.content;
	if (!Array.isArray(content) || content.length === 0) return false;

	let text = "";
	for (const part of content) {
		if (part.type === "toolCall") return false;
		if (part.type === "thinking" && (part.redacted === true || part.thinking.trim().length > 0)) return false;
		if (part.type === "text") text += part.text;
	}
	text = text.trim();
	if (text.length === 0 || text.length > CANNED_SAFETY_REFUSAL_MAX_LENGTH) return false;
	if (!CANNED_SAFETY_REFUSAL_PATTERN.test(text)) return false;

	// Zero billed output distinguishes a provider interception from legitimate
	// model-authored refusal prose, which is never auto-retried.
	return (message.usage?.output ?? 0) === 0;
}

function applyFallbackThinkingLevel(this: AgentSession, level: ThinkingLevel): boolean {
	const previousLevel = this.agent.state.thinkingLevel ?? this.thinkingLevel;
	this.agent.state.thinkingLevel = level;
	if (previousLevel === level) return false;
	this.sessionManager.appendThinkingLevelChange(level);
	this._emit({ type: "thinking_level_changed", level });
	void this._extensionRunner?.emit({
		type: "thinking_level_select",
		level,
		previousLevel,
	});
	return true;
}

/** Capture the user-selected model before the first fallback in a turn. */
export function _beginFallbackModelScope(this: AgentSession): void {
	const currentModel = this.agent.state.model ?? this.model;
	if (this._fallbackOriginModel !== undefined || currentModel === undefined) return;
	this._fallbackScopeGeneration = (this._fallbackScopeGeneration ?? 0) + 1;
	this._fallbackOriginGeneration = this._fallbackScopeGeneration;
	this._fallbackOriginModel = currentModel;
	this._fallbackOriginThinkingLevel = this.agent.state.thinkingLevel ?? this.thinkingLevel;
	this._fallbackRestoreError = undefined;
}

function clearFallbackModelScopeState(this: AgentSession): void {
	this._fallbackOriginGeneration = undefined;
	this._fallbackOriginModel = undefined;
	this._fallbackOriginThinkingLevel = undefined;
	this._fallbackRestoreError = undefined;
	this._fallbackAttemptedKeys.clear();
	this._fallbackBlockedModels.length = 0;
}

function finishFallbackModelScope(
	this: AgentSession,
	options: {
		readonly success: boolean;
		readonly from?: string;
		readonly to?: string;
		readonly finalError?: string;
	},
): boolean {
	if (this._fallbackOriginModel === undefined || this._fallbackOriginGeneration === undefined) return false;
	this._fallbackScopeGeneration = (this._fallbackScopeGeneration ?? 0) + 1;
	clearFallbackModelScopeState.call(this);
	this._emit({
		type: "model_fallback_end",
		success: options.success,
		...(options.from === undefined ? {} : { from: options.from }),
		...(options.to === undefined ? {} : { to: options.to }),
		...(options.finalError === undefined ? {} : { finalError: options.finalError }),
	});
	return true;
}

/** Cancel a pending fallback restore after an explicit model/effort choice. */
export function _clearFallbackModelScope(this: AgentSession): void {
	const currentModel = this.agent.state.model ?? this.model;
	const finalError = this._fallbackRestoreError;
	if (this._fallbackOriginModel !== undefined && this._fallbackOriginGeneration !== undefined) {
		finishFallbackModelScope.call(this, {
			success: finalError === undefined,
			from: modelLabel(currentModel),
			...(finalError === undefined ? {} : { finalError }),
		});
		return;
	}
	this._fallbackScopeGeneration = (this._fallbackScopeGeneration ?? 0) + 1;
	clearFallbackModelScopeState.call(this);
}

/** Restore the model that was active before this turn spent a fallback. */
export async function _restoreFallbackModel(this: AgentSession): Promise<boolean> {
	const originModel = this._fallbackOriginModel;
	const originGeneration = this._fallbackOriginGeneration;
	const finalError = this._fallbackRestoreError;
	if (originModel === undefined || originGeneration === undefined) {
		clearFallbackModelScopeState.call(this);
		return false;
	}

	const previousModel = this.agent.state.model ?? this.model;
	const previousThinkingLevel = this.agent.state.thinkingLevel ?? this.thinkingLevel;
	const originThinkingLevel = clampThinkingLevel(
		originModel,
		this._fallbackOriginThinkingLevel ?? DEFAULT_THINKING_LEVEL,
	) as ThinkingLevel;
	const modelChanged = !modelsAreEqual(previousModel, originModel);
	const thinkingChanged = previousThinkingLevel !== originThinkingLevel;
	if (!modelChanged && !thinkingChanged) {
		return finishFallbackModelScope.call(this, {
			success: finalError === undefined,
			from: modelLabel(previousModel),
			to: modelLabel(originModel),
			...(finalError === undefined ? {} : { finalError }),
		});
	}

	const stillOwnsRestore = (): boolean =>
		this._fallbackOriginGeneration === originGeneration &&
		this._fallbackOriginModel === originModel &&
		modelsAreEqual(this.agent.state.model ?? this.model, originModel) &&
		(this.agent.state.thinkingLevel ?? this.thinkingLevel) === originThinkingLevel;

	this.agent.state.model = originModel;
	if (modelChanged) this.sessionManager.appendModelChange(originModel.provider, originModel.id);
	applyFallbackThinkingLevel.call(this, originThinkingLevel);
	this._refreshBaseSystemPromptFromActiveTools();
	this._emitModelChanged(originModel, previousModel, "restore");
	if (!stillOwnsRestore()) return false;
	await this._emitModelSelect(originModel, previousModel, "restore");
	if (!stillOwnsRestore()) return false;

	return finishFallbackModelScope.call(this, {
		success: finalError === undefined,
		from: modelLabel(previousModel),
		to: modelLabel(originModel),
		...(finalError === undefined ? {} : { finalError }),
	});
}

/** Handle retryable errors with exponential backoff. */
export async function _trySwitchToFallbackModel(this: AgentSession, message: AssistantMessage): Promise<boolean> {
	const currentModel = this.agent.state.model ?? this.model;
	if (this._fallbackModels.length === 0 || currentModel === undefined) return false;

	// A failure the chain may spend a candidate on, but that requesting the same
	// model again cannot repair — a rejected credential, an unavailable model, a
	// request this model cannot serve — condemns that model for the rest of the
	// turn. Reasoning level does not change any of those answers, so every
	// reasoning variant of it is blocked too. Transient rate-limit and transport
	// failures stay same-model retryable and keep their reasoning variants.
	if (isRetryableModelFailure(message) && !isRetryableSameModelFailure(message)) {
		if (!this._fallbackBlockedModels.some((blocked) => modelsAreEqual(blocked, currentModel))) {
			this._fallbackBlockedModels.push(currentModel);
		}
	}

	const currentThinkingLevel = this.agent.state.thinkingLevel ?? this.thinkingLevel;
	const fromModel = currentModel;
	for (const rawCandidate of this._fallbackModels) {
		const candidate = resolveFallbackModel.call(this, rawCandidate);
		if (!candidate) continue;
		const nextModel = candidate.model;
		const nextLevel = clampThinkingLevel(
			nextModel,
			candidate.thinkingLevel ??
				this.settingsManager.getDefaultThinkingLevel() ??
				currentThinkingLevel ??
				DEFAULT_THINKING_LEVEL,
		) as ThinkingLevel;
		const key = fallbackKey(nextModel, nextLevel);
		if (this._fallbackAttemptedKeys.has(key)) continue;
		if (modelsAreEqual(nextModel, fromModel) && nextLevel === currentThinkingLevel) continue;
		// Skipped before any lifecycle starts: a blocked variant emits no fallback
		// event and opens no scope.
		if (this._fallbackBlockedModels.some((blocked) => modelsAreEqual(blocked, nextModel))) continue;

		// Do not create a fallback lifecycle until a candidate can actually be
		// selected. An exhausted or unresolvable chain has no start to close.
		_beginFallbackModelScope.call(this);
		this._fallbackAttemptedKeys.add(fallbackKey(currentModel, currentThinkingLevel));
		if (this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: true,
				attempt: Math.max(0, this._retryAttempt - 1),
			});
		}
		this._fallbackAttemptedKeys.add(key);
		this._emit({
			type: "model_fallback_start",
			from: modelLabel(fromModel),
			to: `${nextModel.provider}/${nextModel.id}`,
			reason: message.errorMessage || "Retryable model error",
			attempt: this._fallbackAttemptedKeys.size - 1,
		});

		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		applyFallbackThinkingLevel.call(this, nextLevel);
		this._refreshBaseSystemPromptFromActiveTools();
		this._emitModelChanged(nextModel, fromModel, "fallback");
		await this._emitModelSelect(nextModel, fromModel, "fallback");
		this._retryAttempt = 0;

		const fallbackGeneration = this._fallbackOriginGeneration;
		setTimeout(() => {
			void this.agent.continue().catch(async (error: unknown) => {
				const finalError = error instanceof Error ? error.message : String(error);
				if (this._fallbackOriginGeneration === fallbackGeneration) {
					this._fallbackRestoreError = finalError;
					try {
						await this._restoreFallbackModel();
					} catch {
						if (this._fallbackOriginGeneration === fallbackGeneration) {
							finishFallbackModelScope.call(this, {
								success: false,
								from: modelLabel(this.agent.state.model ?? this.model),
								finalError,
							});
						}
					}
				}
				this._retryAttempt = 0;
				this._resolveRetry();
			});
		}, 0);
		return true;
	}
	if (this._fallbackOriginModel !== undefined) {
		this._fallbackRestoreError = message.errorMessage || "Model fallback exhausted";
	}
	return false;
}

export async function _handleRetryableError(this: AgentSession, message: AssistantMessage): Promise<boolean> {
	const settings = this.settingsManager.getRetrySettings();
	const retryableError = this._isRetryableError?.(message) ?? true;
	const fallbackableError = this._isFallbackableError?.(message) ?? retryableError;
	const emptyCompletion = this._isEmptyCompletion?.(message) ?? false;
	const safetyRefusal = this._isSafetyRefusal?.(message) ?? false;
	const canRetrySameModel = retryableError || emptyCompletion || safetyRefusal;
	// Empty completions have historically been allowed to spend a fallback after
	// same-model retries. Provider safety refusals stay on the same model.
	const canAdvanceToFallback = fallbackableError || emptyCompletion;
	if (!settings.enabled || !canRetrySameModel) {
		if (canAdvanceToFallback && (await this._trySwitchToFallbackModel(message))) return true;
		if (this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
		}
		this._retryAttempt = 0;
		this._resolveRetry();
		return false;
	}

	// Retry promise is created synchronously in _handleAgentEvent for agent_end.
	// Keep a defensive fallback here in case a future refactor bypasses that path.
	if (!this._retryPromise) {
		this._retryPromise = new Promise((resolve) => {
			this._retryResolve = resolve;
		});
	}

	// One shared policy decides the bounded same-model budget and its backoff, so
	// main chat and workflow stages cannot drift apart on the same settings. The
	// counter still advances on the exhausting attempt, so `_trySwitchToFallbackModel`
	// closes the retry lifecycle before the fallback lifecycle opens.
	const decision = nextRetryDecision(settings, this._retryAttempt, canRetrySameModel);
	this._retryAttempt += 1;
	if (decision === undefined) {
		if (canAdvanceToFallback && (await this._trySwitchToFallbackModel(message))) {
			return true;
		}
		// Max retries exceeded, emit final failure and reset
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt: this._retryAttempt - 1,
			finalError: message.errorMessage,
		});
		this._retryAttempt = 0;
		this._resolveRetry(); // Resolve so waitForRetry() completes
		return false;
	}

	const delayMs = decision.delayMs;

	this._emit({
		type: "auto_retry_start",
		attempt: this._retryAttempt,
		maxAttempts: settings.maxRetries,
		delayMs,
		errorMessage: message.errorMessage || "Unknown error",
	});

	// Remove error message from agent state (keep in session for history)
	const messages = this.agent.state.messages;
	if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
		this.agent.state.messages = messages.slice(0, -1);
	}

	// Wait with exponential backoff (abortable)
	this._retryAbortController = new AbortController();
	try {
		await sleep(delayMs, this._retryAbortController.signal);
	} catch {
		// Aborted during sleep - emit end event so UI can clean up
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
		this._retryAbortController = undefined;
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
		this._resolveRetry();
		return false;
	}
	this._retryAbortController = undefined;

	// Retry via continue() - use setTimeout to break out of event handler chain
	setTimeout(() => {
		this.agent.continue().catch(() => {
			// Retry failed - will be caught by next agent_end
		});
	}, 0);

	return true;
}

/**
 * Cancel in-progress retry.
 */

export function abortRetry(this: AgentSession): void {
	this._retryAbortController?.abort();
	// Note: _retryAttempt is reset in the catch block of _autoRetry
	this._resolveRetry();
}

/**
 * Wait for any in-progress retry to complete.
 * Returns immediately if no retry is in progress.
 */

export async function waitForRetry(this: AgentSession): Promise<void> {
	if (!this._retryPromise) {
		return;
	}

	await this._retryPromise;
	await this.agent.waitForIdle();
}

/** Whether auto-retry is currently in progress */

export function setAutoRetryEnabled(this: AgentSession, enabled: boolean): void {
	this.settingsManager.setRetryEnabled(enabled);
}

// =========================================================================
// Bash Execution
// =========================================================================

/**
 * Execute a bash command.
 * Adds result to agent context and session.
 * @param command The bash command to execute
 * @param onChunk Optional streaming callback for output
 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
 * @param options.operations Custom BashOperations for remote execution
 */

export const agentSessionRetryMethods = {
	_isRetryableError,
	_isFallbackableError,
	_isEmptyCompletion,
	_isSafetyRefusal,
	_handleRetryableError,
	_trySwitchToFallbackModel,
	_beginFallbackModelScope,
	_clearFallbackModelScope,
	_restoreFallbackModel,
	abortRetry,
	waitForRetry,
	setAutoRetryEnabled,
};
