import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import type { Api, AssistantMessage, Model } from "@bastani/atomic-ai/compat";
import { clampThinkingLevel, isContextOverflow, modelsAreEqual } from "@bastani/atomic-ai/compat";
import { sleep } from "../utils/sleep.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { isCodexTokenInvalidationError } from "./codex-errors.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import {
	fallbackKey,
	resolveFallbackModel as resolveConfiguredFallbackModel,
	resolveFallbackModelWithoutCredentials,
} from "./fallback-models.ts";
import { selectFirstPromptModel } from "./first-prompt-model.ts";
import { NoUsableModelError, type SkippedModel } from "./model-credential-filter.ts";
import {
	isContentFilterRefusal,
	isProviderCredentialRejection,
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	isSafetyRefusalFailure,
	isUnrecognizedModelFailure,
	normalizeModelFailureSignal,
} from "./model-fallback-failures.ts";
import { isLongStreamCut, LONG_STREAM_CUT_ADVICE, nextRetryDecision, repeatsLongStreamCut } from "./retry-policy.ts";
import { settingsWriteOwner } from "./settings-write-ownership.ts";

export function ensureRetryPromise(session: AgentSession): void {
	session._retryPromise ??= new Promise((resolve) => {
		session._retryResolve = resolve;
	});
}

export function retryIsCurrent(session: AgentSession, generation: number): boolean {
	return !session._agentRunAbortRequested && session._retryGeneration === generation;
}

/** Leave the agent_end handler before starting another run, without giving a cancelled turn a new request. */
function scheduleRetry(session: AgentSession, generation: number, run: () => void): void {
	setTimeout(() => {
		if (retryIsCurrent(session, generation)) run();
	}, 0);
}

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

function resolveFallbackModelLackingCredentials(this: AgentSession, value: string): Model<Api> | undefined {
	return resolveFallbackModelWithoutCredentials(
		value,
		this._modelRuntime,
		this.model?.provider ?? this.settingsManager.getDefaultProvider(),
	)?.model;
}

function noteSkipped(skipped: SkippedModel[], model: Model<Api>, reason: SkippedModel["reason"]): void {
	const label = modelLabel(model);
	if (!skipped.some((entry) => entry.model === label))
		skipped.push({ model: label, provider: model.provider, reason });
}

/** `retry.fallbackOnContentFilter`: a content-filter refusal spends the next fallback candidate, not a retry. */
function fallsBackOnContentFilter(this: AgentSession): boolean {
	return this.settingsManager.getRetrySettings().fallbackOnContentFilter !== false;
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
	if (signal.kind === "content_filter") return fallsBackOnContentFilter.call(this);
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

	// The same request gets the same content-filter refusal, so with `retry.fallbackOnContentFilter` it goes
	// straight to the next fallback candidate. Otherwise safety/refusal errors remain bounded same-model
	// retries that do not spend another provider candidate. The refusal grammar lives in the shared
	// classifier.
	if (isContentFilterRefusal(message) && fallsBackOnContentFilter.call(this)) return false;
	if (isSafetyRefusalFailure(message)) return true;
	if (isRetryableSameModelFailure(message)) return true;
	// A failure nothing recognizes is not retried on its own. With a fallback chain it would spend a candidate, so it
	// gets the same-model retries first: a first unrecognized error never moves the session to another model (#4223).
	return isUnrecognizedModelFailure(message) && this._fallbackModels.length > 0;
}

/**
 * Detect a degenerate empty completion: the provider ended the stream with no
 * usable content and zero output tokens, leaving the turn dead instead of
 * producing the next step. GitHub Copilot reports its empty turns as a typed
 * `empty-response` error instead, which `_isRetryableError` retries.
 *
 * These are treated as retryable so the harness re-issues the request rather than
 * silently stopping mid-task. Guarded tightly (no text, no tool call, no thinking,
 * and output === 0) so legitimate non-empty turns are never matched.
 *
 * Intentionally provider-agnostic: a degenerate empty turn is a transient failure
 * for any provider. It is bounded by `maxRetries` and falls through to normal
 * handling on exhaustion.
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

async function applyFallbackThinkingLevel(this: AgentSession, level: ThinkingLevel): Promise<boolean> {
	const previousLevel = this.agent.state.thinkingLevel ?? this.thinkingLevel;
	if (previousLevel === level) return false;
	await this.sessionManager.appendThinkingLevelChange(level);
	this.agent.state.thinkingLevel = level;
	return true;
}

/** Capture the user-selected model before the first fallback in a turn. */
export function _beginFallbackModelScope(
	this: AgentSession,
	currentModel = this.agent.state.model ?? this.model,
	thinkingLevel = this.agent.state.thinkingLevel ?? this.thinkingLevel,
): void {
	if (this._fallbackOriginModel !== undefined || currentModel === undefined) return;
	this._fallbackScopeGeneration = (this._fallbackScopeGeneration ?? 0) + 1;
	this._fallbackOriginGeneration = this._fallbackScopeGeneration;
	this._fallbackOriginModel = currentModel;
	this._fallbackOriginThinkingLevel = thinkingLevel;
	this._fallbackRestoreError = undefined;
}

function clearFallbackModelScopeState(this: AgentSession): void {
	this._fallbackOriginGeneration = undefined;
	this._fallbackOriginModel = undefined;
	this._fallbackOriginThinkingLevel = undefined;
	this._fallbackRestoreError = undefined;
	this._fallbackAttemptedKeys.clear();
	this._fallbackBlockedModels.length = 0;
	this._fallbackBlockedProviders.clear();
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

/** Finish an active fallback lifecycle before an explicit model choice. */
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

/** Finish an active fallback lifecycle without changing the selected fallback model. */
export async function _settleFallbackModelScope(this: AgentSession): Promise<boolean> {
	const originModel = this._fallbackOriginModel;
	const originGeneration = this._fallbackOriginGeneration;
	const finalError = this._fallbackRestoreError;
	if (originModel === undefined || originGeneration === undefined) {
		clearFallbackModelScopeState.call(this);
		return false;
	}
	if (this._fallbackOriginGeneration !== originGeneration || this._fallbackOriginModel !== originModel) return false;

	const currentModel = this.agent.state.model ?? this.model;
	return finishFallbackModelScope.call(this, {
		success: finalError === undefined,
		from: modelLabel(currentModel),
		...(finalError === undefined ? {} : { finalError }),
	});
}

/** Finish recording a committed model choice even if Esc cancels the request that was going to use it. */
async function selectFallback(
	session: AgentSession,
	from: Model<Api>,
	fromLevel: ThinkingLevel,
	to: Model<Api>,
	toLevel: ThinkingLevel,
	reason: string,
	skipped: SkippedModel[],
	generation: number,
): Promise<void> {
	await session.sessionManager.appendModelChange(to.provider, to.id, {
		requested: modelLabel(session._fallbackOriginModel ?? from),
		from: modelLabel(from),
		reason,
		...(skipped.length ? { skipped } : {}),
	});
	session.agent.state.model = to;
	const thinkingChanged = await applyFallbackThinkingLevel.call(session, toLevel);
	if (session._retryAttempt > 0 && retryIsCurrent(session, generation)) {
		const attempt = Math.max(0, session._retryAttempt - 1);
		session._retryAttempt = 0;
		session._longStreamCutRetries = 0;
		session._emit({ type: "auto_retry_end", success: true, attempt });
	}
	if (retryIsCurrent(session, generation)) {
		_beginFallbackModelScope.call(session, from, fromLevel);
		session._fallbackAttemptedKeys.add(fallbackKey(from, fromLevel));
		session._fallbackAttemptedKeys.add(fallbackKey(to, toLevel));
		session._emit({
			type: "model_fallback_start",
			from: modelLabel(from),
			to: modelLabel(to),
			...(from.reasoning && fromLevel !== undefined ? { fromThinkingLevel: fromLevel } : {}),
			...(to.reasoning ? { toThinkingLevel: toLevel } : {}),
			reason,
			attempt: session._fallbackAttemptedKeys.size - 1,
		});
	}
	if (thinkingChanged) {
		session._emit({ type: "thinking_level_changed", level: toLevel });
		void session._extensionRunner?.emit({ type: "thinking_level_select", level: toLevel, previousLevel: fromLevel });
	}
	session._refreshBaseSystemPromptFromActiveTools();
	session._emitModelChanged(to, from, "fallback");
	await session._emitModelSelect(to, from, "fallback");
	await session._recordSystemPromptForModelSwitch();
}

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
	if (isProviderCredentialRejection(message)) {
		this._fallbackBlockedProviders.add(currentModel.provider);
	}

	const currentThinkingLevel = this.agent.state.thinkingLevel ?? this.thinkingLevel;
	const fromModel = currentModel;
	const skipped: SkippedModel[] = [];
	for (const rawCandidate of this._fallbackModels) {
		const candidate = resolveFallbackModel.call(this, rawCandidate);
		if (!candidate) {
			const lacking = resolveFallbackModelLackingCredentials.call(this, rawCandidate);
			if (lacking && (!this._isFallbackModelAllowed || this._isFallbackModelAllowed(lacking, undefined)))
				noteSkipped(skipped, lacking, "no-credentials");
			continue;
		}
		const nextModel = candidate.model;
		const nextLevel = clampThinkingLevel(
			nextModel,
			candidate.thinkingLevel ??
				this.settingsManager.getDefaultThinkingLevel() ??
				currentThinkingLevel ??
				DEFAULT_THINKING_LEVEL,
		) as ThinkingLevel;
		if (this._isFallbackModelAllowed && !this._isFallbackModelAllowed(nextModel, nextLevel)) continue;
		const key = fallbackKey(nextModel, nextLevel);
		if (this._fallbackAttemptedKeys.has(key)) continue;
		if (modelsAreEqual(nextModel, fromModel) && nextLevel === currentThinkingLevel) continue;
		// Skipped before any lifecycle starts: a blocked variant emits no fallback
		// event and opens no scope.
		if (this._fallbackBlockedModels.some((blocked) => modelsAreEqual(blocked, nextModel))) continue;
		if (this._fallbackBlockedProviders.has(nextModel.provider)) {
			noteSkipped(skipped, nextModel, "auth-failed");
			continue;
		}

		// Do not create a fallback lifecycle until a candidate can actually be
		// selected. An exhausted or unresolvable chain has no start to close.

		// Keep the failed attempt in raw history while durably omitting it from model projection.
		const generation = this._retryGeneration;
		ensureRetryPromise(this); // Unresolved overflow may reach fallback without a same-model retry.
		await this._omitTrailingAssistantAttempt();
		if (!retryIsCurrent(this, generation)) return true;
		await selectFallback(
			this,
			fromModel,
			currentThinkingLevel,
			nextModel,
			nextLevel,
			message.errorMessage || "Retryable model error",
			skipped,
			generation,
		);
		const fallbackGeneration = this._fallbackOriginGeneration;
		scheduleRetry(this, generation, () => {
			void this.agent.continue().catch(async (error: unknown) => {
				const finalError = error instanceof Error ? error.message : String(error);
				if (this._fallbackOriginGeneration === fallbackGeneration) {
					this._fallbackRestoreError = finalError;
					try {
						await this._settleFallbackModelScope();
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
				if (retryIsCurrent(this, generation)) {
					this._retryAttempt = 0;
					this._longStreamCutRetries = 0;
					this._resolveRetry();
				}
			});
		});
		return true;
	}
	if (this._fallbackOriginModel !== undefined) {
		this._fallbackRestoreError = message.errorMessage || "Model fallback exhausted";
	}
	return false;
}

export async function _selectModelWithCredentials(this: AgentSession): Promise<void> {
	const currentModel = this.agent.state.model ?? this.model;
	if (currentModel === undefined || this._modelRuntime.hasConfiguredAuth(currentModel.provider)) return;
	const skipped: SkippedModel[] = [];
	noteSkipped(skipped, currentModel, "no-credentials");
	const currentThinkingLevel = this.agent.state.thinkingLevel ?? this.thinkingLevel;
	for (const rawCandidate of this._fallbackModels) {
		const candidate = resolveFallbackModel.call(this, rawCandidate);
		if (!candidate) {
			const lacking = resolveFallbackModelLackingCredentials.call(this, rawCandidate);
			if (lacking && (!this._isFallbackModelAllowed || this._isFallbackModelAllowed(lacking, undefined)))
				noteSkipped(skipped, lacking, "no-credentials");
			continue;
		}
		const nextModel = candidate.model;
		const nextLevel = clampThinkingLevel(
			nextModel,
			candidate.thinkingLevel ??
				this.settingsManager.getDefaultThinkingLevel() ??
				currentThinkingLevel ??
				DEFAULT_THINKING_LEVEL,
		) as ThinkingLevel;
		if (this._isFallbackModelAllowed && !this._isFallbackModelAllowed(nextModel, nextLevel)) continue;
		if (modelsAreEqual(nextModel, currentModel)) continue;

		const reason = `No API key found for ${currentModel.provider}`;
		const generation = this._retryGeneration;
		ensureRetryPromise(this);
		try {
			await selectFallback(
				this,
				currentModel,
				currentThinkingLevel,
				nextModel,
				nextLevel,
				reason,
				skipped,
				generation,
			);
		} finally {
			if (retryIsCurrent(this, generation)) this._resolveRetry();
		}
		return;
	}
	// No configured model can run this prompt. Only now can the session need its private Copilot lookup.
	const selection = selectFirstPromptModel(this);
	if (selection) {
		const generation = this._retryGeneration;
		const advice = await selection;
		if (this._disposed || !retryIsCurrent(this, generation) || this.model !== currentModel) return;
		if (advice) {
			const error = new NoUsableModelError(skipped);
			error.message = `${advice}\n\n${error.message}`;
			throw error;
		}
	}
	throw new NoUsableModelError(skipped);
}

export async function _handleRetryableError(this: AgentSession, message: AssistantMessage): Promise<boolean> {
	if (this._agentRunAbortRequested) return false;
	const generation = this._retryGeneration;
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
		this._longStreamCutRetries = 0;
		this._resolveRetry();
		return false;
	}

	// Retry promise is created synchronously in _handleAgentEvent for agent_end.
	// Keep a defensive fallback here in case a future refactor bypasses that path.
	ensureRetryPromise(this);

	// One shared policy decides the bounded same-model budget and its backoff, so
	// each session applies the same settings. The
	// counter still advances on the exhausting attempt, so `_trySwitchToFallbackModel`
	// closes the retry lifecycle before the fallback lifecycle opens.
	const decision = nextRetryDecision(
		settings,
		this._retryAttempt,
		canRetrySameModel,
		message,
		this._longStreamCutRetries,
	);
	this._retryAttempt += 1;
	if (decision === undefined) {
		if (canAdvanceToFallback && (await this._trySwitchToFallbackModel(message))) {
			return true;
		}
		// Retries exhausted, or a repeated long stream cut that another attempt would only repeat: emit the final
		// failure and reset. The repeated cut says what to do instead of retrying again.
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt: this._retryAttempt - 1,
			finalError: repeatsLongStreamCut(message, this._longStreamCutRetries)
				? [message.errorMessage, LONG_STREAM_CUT_ADVICE].filter(Boolean).join("\n\n")
				: message.errorMessage,
		});
		this._retryAttempt = 0;
		this._longStreamCutRetries = 0;
		this._resolveRetry(); // Resolve so waitForRetry() completes
		return false;
	}
	if (isLongStreamCut(message)) this._longStreamCutRetries += 1;

	const delayMs = decision.delayMs;

	const backoff = new AbortController();
	this._retryAbortController = backoff;
	this._emit({
		type: "auto_retry_start",
		attempt: this._retryAttempt,
		maxAttempts: settings.maxRetries,
		delayMs,
		errorMessage: message.errorMessage || "Unknown error",
	});

	// Keep the failed attempt in raw history while durably omitting it from model projection.
	await this._omitTrailingAssistantAttempt();

	// Wait with exponential backoff (abortable)
	try {
		await sleep(delayMs, backoff.signal);
	} catch {
		return false;
	} finally {
		if (this._retryAbortController === backoff) this._retryAbortController = undefined;
	}

	scheduleRetry(this, generation, () => {
		this.agent.continue().catch(() => {
			// Retry failed - will be caught by next agent_end
		});
	});

	return true;
}

/**
 * Cancel in-progress retry.
 */

function finishCancelledRetry(this: AgentSession): void {
	if (this._retryAttempt === 0) return;
	const attempt = this._retryAttempt;
	this._retryAttempt = 0;
	this._longStreamCutRetries = 0;
	this._emit({ type: "auto_retry_end", success: false, attempt, finalError: "Retry cancelled" });
}

export function abortRetry(this: AgentSession): void {
	if (this.isRetrying) abortTurnRetries.call(this);
}

/** A whole-turn interrupt also prevents a first request that fails late from starting a retry. */
export function abortTurnRetries(this: AgentSession): void {
	this._retryGeneration = (this._retryGeneration ?? 0) + 1;
	// The next attempt may already be preparing its request when an interactive or RPC interrupt arrives.
	if (this.isRetrying && this.agent.state.isStreaming) this.agent.abort();
	this._retryAbortController?.abort();
	finishCancelledRetry.call(this);
	if (this._fallbackOriginGeneration !== undefined) {
		finishFallbackModelScope.call(this, { success: false, from: modelLabel(this.model) });
	}
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
	settingsWriteOwner.run(this, () => this.settingsManager.setRetryEnabled(enabled));
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
	_selectModelWithCredentials,
	_beginFallbackModelScope,
	_clearFallbackModelScope,
	_settleFallbackModelScope,
	abortRetry,
	waitForRetry,
	setAutoRetryEnabled,
};
