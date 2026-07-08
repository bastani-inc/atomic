import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { clampThinkingLevel, isContextOverflow, modelsAreEqual } from "@earendil-works/pi-ai/compat";
import { sleep } from "../utils/sleep.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { isCopilotGeminiModel } from "./copilot-gemini-payload-sanitizer.ts";
import { normalizeToolArgumentsForModel } from "./copilot-gemini-tool-arguments.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";


const THINKING_SUFFIXES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];
const THINKING_SUFFIX_SET: ReadonlySet<string> = new Set(THINKING_SUFFIXES);

function modelLabel(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "unknown model";
}

function splitFallbackModel(value: string): { modelId: string; thinkingLevel?: ThinkingLevel } {
	const trimmed = value.trim();
	const index = trimmed.lastIndexOf(":");
	if (index < 0) return { modelId: trimmed };
	const suffix = trimmed.slice(index + 1);
	if (!THINKING_SUFFIX_SET.has(suffix)) return { modelId: trimmed };
	return { modelId: trimmed.slice(0, index), thinkingLevel: suffix as ThinkingLevel };
}

function resolveFallbackModel(this: AgentSession, value: string): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined {
	const parsed = splitFallbackModel(value);
	if (!parsed.modelId.includes("/")) {
		const available = this._modelRegistry.getAvailable().filter((model) => model.id === parsed.modelId);
		const preferredProvider = this.model?.provider ?? this.settingsManager.getDefaultProvider();
		const model = available.find((candidate) => candidate.provider === preferredProvider) ?? (available.length === 1 ? available[0] : undefined);
		return model ? { model, thinkingLevel: parsed.thinkingLevel } : undefined;
	}
	const slash = parsed.modelId.indexOf("/");
	const provider = parsed.modelId.slice(0, slash);
	const modelId = parsed.modelId.slice(slash + 1);
	const model = this._modelRegistry.find(provider, modelId);
	if (!model || !this._modelRegistry.hasConfiguredAuth(model)) return undefined;
	return { model, thinkingLevel: parsed.thinkingLevel };
}

function fallbackKey(model: Model<Api>, thinkingLevel: ThinkingLevel | undefined): string {
	return `${model.provider}/${model.id}:${thinkingLevel ?? ""}`;
}

function hasProviderTransportDiagnostic(value: unknown, seen = new Set<unknown>(), includeMessageFields = false): boolean {
	if (value === null || value === undefined || seen.has(value)) return false;
	if (typeof value !== "object") {
		return /provider_transport_failure|websocket.*error|sse.*404/i.test(String(value));
	}
	seen.add(value);
	const record = value as Record<string, unknown>;
	const fields = includeMessageFields
		? [record.type, record.code, record.name, record.message, record.errorMessage, record.status, record.statusCode]
		: [record.type, record.code, record.name, record.status, record.statusCode];
	for (const field of fields) {
		 if (typeof field === "string" || typeof field === "number") {
			if (/provider_transport_failure|websocket.*error|sse.*404|\b404\b/i.test(String(field))) return true;
		}
	}
	for (const nested of [record.error, record.cause, ...(Array.isArray(record.diagnostics) ? record.diagnostics : [])]) {
		if (hasProviderTransportDiagnostic(nested, seen, true)) return true;
	}
	return false;
}

function hasProviderModelUnavailableDiagnostic(value: unknown, seen = new Set<unknown>(), includeMessageFields = false): boolean {
	if (value === null || value === undefined || seen.has(value)) return false;
	if (typeof value !== "object") return false;
	seen.add(value);
	const record = value as Record<string, unknown>;
	const fields = includeMessageFields
		? [record.type, record.code, record.name, record.message, record.errorMessage]
		: [record.type, record.code, record.name, record.errorMessage];
	for (const field of fields) {
		if (typeof field === "string" && /model(?:[_\s-].*)?(?:not[_\s-]?found|unavailable|unknown|disabled)|model[_-]?not[_-]?found/i.test(field)) return true;
	}
	for (const nested of [record.error, record.cause, ...(Array.isArray(record.diagnostics) ? record.diagnostics : [])]) {
		if (hasProviderModelUnavailableDiagnostic(nested, seen, true)) return true;
	}
	return false;
}
export function _isRetryableError(this: AgentSession, message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;

	// Context overflow is handled by compaction, not retry
	const contextWindow = this.model?.contextWindow ?? 0;
	if (isContextOverflow(message, contextWindow)) return false;

	if (hasProviderTransportDiagnostic(message) || hasProviderModelUnavailableDiagnostic(message)) return true;
	if (!message.errorMessage) return false;

	const err = message.errorMessage;

	// Safety triggers surface through structured API signals that pi-ai maps to
	// stopReason "error":
	// - Anthropic `refusal` stops become pi-ai's canned "The model refused to
	//   complete the request" error message;
	// - OpenAI-style APIs (and github-copilot CAPI, which also maps spurious
	//   Gemini RECITATION/safety blocks this way) surface
	//   `finish_reason: content_filter`.
	// Spurious safety triggers are common in agentic settings, so these are
	// re-requested like transient failures, bounded by maxRetries (issue #1608).
	if (/refused to complete the request|finish.?reason:?\s*content.?filter/i.test(err)) {
		return true;
	}

	// Match: overloaded_error, provider returned error, rate limit, 429, 500, 502, 503, 504, service unavailable, network/connection errors (including connection lost), WebSocket transport closes/errors, fetch failed, premature stream endings, HTTP/2 closed before response, terminated, retry delay exceeded, and a bare/transient provider finish_reason "error" (e.g. github-copilot Gemini's CAPI mapping of MALFORMED_FUNCTION_CALL/OTHER/UNEXPECTED_TOOL_CALL). These are provider-agnostic transient failures.
	return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay|finish.?reason:?\s*error/i.test(
		err,
	);
}

/**
 * For GitHub Copilot Gemini, reconstruct flattened tool-call arguments
 * (for example `edits[0].newText`) into the nested arrays/objects Gemini
 * produced before the assistant message is persisted, so saved transcripts
 * never carry the flattened CAPI wire shape and replays loaded from disk match
 * the structure Gemini signed. In-place, gated to Copilot Gemini, and a no-op
 * for well-formed arguments or any other provider/model. The outbound replay
 * normalizer still heals already-persisted (legacy) sessions on the wire.
 */

export function _normalizePersistedGeminiToolArgs(this: AgentSession, message: AssistantMessage): void {
	const model = this.model;
	if (!model || !isCopilotGeminiModel(model)) return;
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const tool = this._toolRegistry.get(block.name);
		const normalized = normalizeToolArgumentsForModel(block.arguments, model, tool?.parameters);
		if (normalized !== block.arguments && normalized !== null && typeof normalized === "object") {
			block.arguments = normalized as Record<string, unknown>;
		}
	}
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

/**
 * Handle retryable errors with exponential backoff.
 * @returns true if retry was initiated, false if max retries exceeded or disabled
 */

export async function _trySwitchToFallbackModel(this: AgentSession, message: AssistantMessage): Promise<boolean> {
	if (this._fallbackModels.length === 0 || !this.model) return false;

	this._fallbackAttemptedKeys.add(fallbackKey(this.model, this.thinkingLevel));
	const fromModel = this.model;
	for (const rawCandidate of this._fallbackModels) {
		const candidate = resolveFallbackModel.call(this, rawCandidate);
		if (!candidate) continue;
		const key = fallbackKey(candidate.model, candidate.thinkingLevel);
		if (this._fallbackAttemptedKeys.has(key)) continue;
		const nextModel = this._withContextWindowForModelSwitch(candidate.model);
		const nextLevel = clampThinkingLevel(
			nextModel,
			candidate.thinkingLevel ?? this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
		) as ThinkingLevel;
		if (modelsAreEqual(candidate.model, fromModel) && nextLevel === this.thinkingLevel) continue;
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
		this._appendContextWindowChangeIfChanged(fromModel, nextModel);
		this.agent.state.thinkingLevel = nextLevel;
		this.sessionManager.appendThinkingLevelChange(nextLevel);
		this._refreshBaseSystemPromptFromActiveTools();
		this._emitModelChanged(nextModel, fromModel, "fallback");
		await this._emitModelSelect(nextModel, fromModel, "fallback");
		this._retryAttempt = 0;

		setTimeout(() => {
			this.agent.continue().then(
				() => {
					// A resolved continuation may still have produced an assistant
					// error that will be classified by agent_end and may advance to
					// the next fallback. Do not emit a successful fallback end here;
					// agent_end/turn_end clear UI state for successful turns, while
					// fallback exhaustion emits the failure end event.
				},
				(error: unknown) => {
					const finalError = error instanceof Error ? error.message : String(error);
					this._emit({ type: "model_fallback_end", success: false, from: modelLabel(fromModel), to: modelLabel(nextModel), finalError });
					this._retryAttempt = 0;
					this._resolveRetry();
				},
			);
		}, 0);
		return true;
	}
	this._emit({ type: "model_fallback_end", success: false, from: modelLabel(fromModel), finalError: message.errorMessage });
	return false;
}

export async function _handleRetryableError(this: AgentSession, message: AssistantMessage): Promise<boolean> {
	const settings = this.settingsManager.getRetrySettings();
	if (!settings.enabled) {
		return this._trySwitchToFallbackModel(message);
	}

	// Retry promise is created synchronously in _handleAgentEvent for agent_end.
	// Keep a defensive fallback here in case a future refactor bypasses that path.
	if (!this._retryPromise) {
		this._retryPromise = new Promise((resolve) => {
			this._retryResolve = resolve;
		});
	}

	this._retryAttempt++;

	if (this._retryAttempt > settings.maxRetries) {
		if (await this._trySwitchToFallbackModel(message)) {
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

	const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

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
	_normalizePersistedGeminiToolArgs,
	_isEmptyCompletion,
	_isSafetyRefusal,
	_handleRetryableError,
	_trySwitchToFallbackModel,
	abortRetry,
	waitForRetry,
	setAutoRetryEnabled,
};
