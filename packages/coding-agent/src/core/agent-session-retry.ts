import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import { sleep } from "../utils/sleep.ts";
import { isCopilotGeminiModel } from "./copilot-gemini-payload-sanitizer.ts";
import { normalizeToolArgumentsForModel } from "./copilot-gemini-tool-arguments.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";

export function _isRetryableError(this: AgentSession, message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;

	// Context overflow is handled by compaction, not retry
	const contextWindow = this.model?.contextWindow ?? 0;
	if (isContextOverflow(message, contextWindow)) return false;

	const err = message.errorMessage;

	// A genuine `content_filter` stop is a deliberate safety block: retrying it
	// re-issues the same blocked request up to maxRetries times for no benefit.
	// GitHub Copilot Gemini is the exception — CAPI maps spurious Gemini blocks
	// (RECITATION/safety on MALFORMED_FUNCTION_CALL etc.) to `content_filter`, so
	// only treat `content_filter` as retryable for those models.
	if (
		isCopilotGeminiModel({ provider: message.provider, api: message.api, id: message.model }) &&
		/finish.?reason:?\s*content.?filter/i.test(err)
	) {
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
 * Handle retryable errors with exponential backoff.
 * @returns true if retry was initiated, false if max retries exceeded or disabled
 */

export async function _handleRetryableError(this: AgentSession, message: AssistantMessage): Promise<boolean> {
	const settings = this.settingsManager.getRetrySettings();
	if (!settings.enabled) {
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

	this._retryAttempt++;

	if (this._retryAttempt > settings.maxRetries) {
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
	_handleRetryableError,
	abortRetry,
	waitForRetry,
	setAutoRetryEnabled,
};
