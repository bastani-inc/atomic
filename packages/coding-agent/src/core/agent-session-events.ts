import { disposeSessionAsyncJobManager } from "./async/session-manager.js";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, TextContent } from "@earendil-works/pi-ai/compat";
import { cleanupSessionResources } from "@earendil-works/pi-ai/compat";
import { formatCopilotProviderError } from "./copilot-errors.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { customMessageExcludesContext, isSingleGenericAbortTextContent, replacementAbortContent, type AgentSessionEvent, type AgentSessionEventListener } from "./agent-session-types.ts";
import type { MessageEndEvent, MessageStartEvent, MessageUpdateEvent, ToolExecutionEndEvent, ToolExecutionStartEvent, ToolExecutionUpdateEvent, TurnEndEvent, TurnStartEvent } from "./extensions/index.ts";
import { normalizeMessageContent } from "./messages.ts";

export function _emit(this: AgentSession, event: AgentSessionEvent): void {
	for (const l of this._eventListeners) {
		l(event);
	}
}


export function _emitQueueUpdate(this: AgentSession): void {
	this._emit({
		type: "queue_update",
		steering: [...this._steeringMessages],
		followUp: [...this._followUpMessages],
	});
}

/** Internal handler for agent events - shared by subscribe and reconnect */

export function _handleAgentEvent(this: AgentSession, event: AgentEvent): void {
	// Create retry promise synchronously before queueing async processing.
	// Agent.emit() calls this handler synchronously, and prompt() calls waitForRetry()
	// as soon as agent.prompt() resolves. If _retryPromise is created only inside
	// _processAgentEvent, slow earlier queued events can delay agent_end processing
	// and waitForRetry() can miss the in-flight retry.
	this._createRetryPromiseForAgentEnd(event);

	this._agentEventQueue = this._agentEventQueue.then(
		() => this._processAgentEvent(event),
		() => this._processAgentEvent(event),
	);

	// Keep queue alive if an event handler fails
	this._agentEventQueue.catch(() => {});
}


export function _createRetryPromiseForAgentEnd(this: AgentSession, event: AgentEvent): void {
	if (event.type !== "agent_end" || this._retryPromise) {
		return;
	}

	const settings = this.settingsManager.getRetrySettings();
	if (!settings.enabled && this._fallbackModels.length === 0) {
		return;
	}

	const lastAssistant = this._findLastAssistantInMessages(event.messages);
	if (!lastAssistant) {
		return;
	}

	const shouldRetry = this._isRetryableError(lastAssistant) || this._isEmptyCompletion(lastAssistant) || this._isSafetyRefusal(lastAssistant);
	if (!shouldRetry) {
		return;
	}

	this._retryPromise = new Promise((resolve) => {
		this._retryResolve = resolve;
	});
}


export function _findLastAssistantInMessages(this: AgentSession, messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			return message as AssistantMessage;
		}
	}
	return undefined;
}


export async function _processAgentEvent(this: AgentSession, event: AgentEvent): Promise<void> {
	// When a user message starts, check if it's from either queue and remove it BEFORE emitting
	// This ensures the UI sees the updated queue state
	if (event.type === "message_start" && event.message.role === "user") {
		this._overflowRecoveryAttempted = false;
		this._fallbackAttemptedKeys.clear();
		const messageText = this._getUserMessageText(event.message);
		if (messageText) {
			// Check steering queue first
			const steeringIndex = this._steeringMessages.indexOf(messageText);
			if (steeringIndex !== -1) {
				this._steeringMessages.splice(steeringIndex, 1);
				this._emitQueueUpdate();
			} else {
				// Check follow-up queue
				const followUpIndex = this._followUpMessages.indexOf(messageText);
				if (followUpIndex !== -1) {
					this._followUpMessages.splice(followUpIndex, 1);
					this._emitQueueUpdate();
				}
			}
		}
	}

	this._applyInterruptAbortMessage(event);
	this._applyProviderErrorGuidance(event);

	// Emit to extensions first
	await this._emitExtensionEvent(event);

	// Notify all listeners
	this._emit(event);

	// Handle session persistence
	if (event.type === "message_end") {
		// Check if this is a custom message from extensions
		if (event.message.role === "custom") {
			// Persist as CustomMessageEntry
			this.sessionManager.appendCustomMessageEntry(
				event.message.customType,
				event.message.content,
				event.message.display,
				event.message.details,
				customMessageExcludesContext(event.message),
			);
		} else if (
			event.message.role === "user" ||
			event.message.role === "assistant" ||
			event.message.role === "toolResult"
		) {
			if (event.message.role === "assistant") {
				this._normalizePersistedGeminiToolArgs(event.message);
			}
			// Regular LLM message - persist as SessionMessageEntry
			this.sessionManager.appendMessage(event.message);
		}
		// Other message types (bashExecution, branchSummary) are persisted elsewhere

		// Track assistant message for auto-compaction (checked on agent_end)
		if (event.message.role === "assistant") {
			this._lastAssistantMessage = event.message;

			const assistantMsg = event.message as AssistantMessage;
			// Treat degenerate empty completions (no content, zero output tokens) and
			// intercepted canned safety refusals as failures alongside stopReason ===
			// "error". Otherwise such a turn that stops with reason "stop"/"length"
			// would reset the retry counter on every attempt, causing unbounded
			// retries instead of honoring maxRetries.
			const assistantFailed = assistantMsg.stopReason === "error" || this._isEmptyCompletion(assistantMsg) || this._isSafetyRefusal(assistantMsg);
			if (!assistantFailed) {
				this._fallbackAttemptedKeys.clear();
				this._overflowRecoveryAttempted = false;
				this._outputBudgetErrorContinuationAttempts = 0;
			}

			// A non-truncated assistant response means the length-continuation loop
			// made progress (or the turn completed cleanly), so reset the bounded
			// output-cap continuation counter.
			if (assistantMsg.stopReason !== "length") {
				this._lengthContinuationAttempts = 0;
			}

			// Reset retry counter immediately on successful assistant response
			// This prevents accumulation across multiple LLM calls within a turn
			if (!assistantFailed && this._retryAttempt > 0) {
				this._emit({
					type: "auto_retry_end",
					success: true,
					attempt: this._retryAttempt,
				});
				this._retryAttempt = 0;
			}
		}
	}

	// Check auto-retry and auto-compaction after agent completes
	if (event.type === "agent_end" && this._lastAssistantMessage) {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		const postToolPreflightFailed =
			this._postToolCompactionPreflightError !== undefined &&
			msg.errorMessage === this._postToolCompactionPreflightError;

		// Check for retryable errors first (overloaded, rate limit, server errors,
		// transient provider finish_reason errors, degenerate empty completions,
		// or intercepted canned safety refusals)
		const retryableError = !postToolPreflightFailed && this._isRetryableError(msg);
		const emptyCompletion = !postToolPreflightFailed && !retryableError && this._isEmptyCompletion(msg);
		const safetyRefusal =
			!postToolPreflightFailed && !retryableError && !emptyCompletion && this._isSafetyRefusal(msg);
		if (retryableError || emptyCompletion || safetyRefusal) {
			if (emptyCompletion && !msg.errorMessage) {
				// Surface a clear reason in the retry banner; empty completions carry no
				// provider error message of their own.
				msg.errorMessage = "Provider returned an empty completion";
			} else if (safetyRefusal && !msg.errorMessage) {
				msg.errorMessage = "Provider returned a canned safety refusal";
			}
			const didRetry = await this._handleRetryableError(msg);
			if (didRetry) return; // Retry was initiated, don't proceed to compaction
		}

		this._resolveRetry();
		await this._checkCompaction(msg);
	}
}


export function _applyInterruptAbortMessage(this: AgentSession, event: AgentEvent): void {
	const abortMessage = this._activeInterruptAbortMessage;
	if (!abortMessage) return;

	if (event.type === "tool_execution_end" && event.isError && isSingleGenericAbortTextContent(event.result.content)) {
		event.result.content = replacementAbortContent(abortMessage);
		return;
	}

	if (event.type !== "message_start" && event.type !== "message_end") return;

	if (event.message.role === "toolResult" && event.message.isError && isSingleGenericAbortTextContent(event.message.content)) {
		event.message.content = replacementAbortContent(abortMessage);
		return;
	}

	if (event.message.role === "assistant") {
		const assistantMessage = event.message as AssistantMessage;
		if (assistantMessage.stopReason === "aborted") {
			assistantMessage.errorMessage = abortMessage;
		}
	}
}


export function _applyProviderErrorGuidance(this: AgentSession, event: AgentEvent): void {
	if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return;
	if (event.message.role !== "assistant") return;

	const assistantMessage = event.message as AssistantMessage;
	if (assistantMessage.stopReason !== "error" || !assistantMessage.errorMessage) return;

	assistantMessage.errorMessage = formatCopilotProviderError(
		assistantMessage.provider,
		assistantMessage.errorMessage,
	);
}

/** Resolve the pending retry promise */

export function _resolveRetry(this: AgentSession): void {
	if (this._retryResolve) {
		this._retryResolve();
		this._retryResolve = undefined;
		this._retryPromise = undefined;
	}
}

/** Extract text content from a message */

export function _getUserMessageText(this: AgentSession, message: Message): string {
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	const textBlocks = content.filter((c) => c.type === "text");
	return textBlocks.map((c) => (c as TextContent).text).join("");
}

/** Find the last assistant message in agent state (including aborted ones) */

export function _findLastAssistantMessage(this: AgentSession): AssistantMessage | undefined {
	const messages = this.agent.state.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			return msg as AssistantMessage;
		}
	}
	return undefined;
}


export function _replaceMessageInPlace(this: AgentSession, target: AgentMessage, replacement: AgentMessage): void {
	// Agent-core stores the finalized message object in its state before emitting message_end.
	// SessionManager persistence happens later in _processAgentEvent() with event.message.
	// Mutating this object in place keeps agent state, later turn/agent events, listeners,
	// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
	if (target === replacement) {
		return;
	}

	const targetRecord = target as unknown as Record<string, unknown>;
	for (const key of Object.keys(targetRecord)) {
		delete targetRecord[key];
	}
	Object.assign(targetRecord, replacement);
}

/** Emit extension events based on agent events */

export async function _emitExtensionEvent(this: AgentSession, event: AgentEvent): Promise<void> {
	if (event.type === "agent_start") {
		this._turnIndex = 0;
		await this._extensionRunner.emit({ type: "agent_start" });
	} else if (event.type === "agent_end") {
		await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
	} else if (event.type === "turn_start") {
		const extensionEvent: TurnStartEvent = {
			type: "turn_start",
			turnIndex: this._turnIndex,
			timestamp: Date.now(),
		};
		await this._extensionRunner.emit(extensionEvent);
	} else if (event.type === "turn_end") {
		const extensionEvent: TurnEndEvent = {
			type: "turn_end",
			turnIndex: this._turnIndex,
			message: event.message,
			toolResults: event.toolResults,
		};
		await this._extensionRunner.emit(extensionEvent);
		this._turnIndex++;
	} else if (event.type === "message_start") {
		const extensionEvent: MessageStartEvent = {
			type: "message_start",
			message: event.message,
		};
		await this._extensionRunner.emit(extensionEvent);
	} else if (event.type === "message_update") {
		const extensionEvent: MessageUpdateEvent = {
			type: "message_update",
			message: event.message,
			assistantMessageEvent: event.assistantMessageEvent,
		};
		await this._extensionRunner.emit(extensionEvent);
	} else if (event.type === "message_end") {
		const extensionEvent: MessageEndEvent = {
			type: "message_end",
			message: event.message,
		};
		const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
		if (replacement) {
			this._replaceMessageInPlace(event.message, normalizeMessageContent(replacement));
		}
	} else if (event.type === "tool_execution_start") {
		const extensionEvent: ToolExecutionStartEvent = {
			type: "tool_execution_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
		};
		await this._extensionRunner.emit(extensionEvent);
	} else if (event.type === "tool_execution_update") {
		const extensionEvent: ToolExecutionUpdateEvent = {
			type: "tool_execution_update",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			partialResult: event.partialResult,
		};
		await this._extensionRunner.emit(extensionEvent);
	} else if (event.type === "tool_execution_end") {
		const extensionEvent: ToolExecutionEndEvent = {
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
		};
		await this._extensionRunner.emit(extensionEvent);
	}
}

/**
 * Subscribe to agent events.
 * Session persistence is handled internally (saves messages on message_end).
 * Multiple listeners can be added. Returns unsubscribe function for this listener.
 */

export function subscribe(this: AgentSession, listener: AgentSessionEventListener): () => void {
	this._eventListeners.push(listener);

	// Return unsubscribe function for this specific listener
	return () => {
		const index = this._eventListeners.indexOf(listener);
		if (index !== -1) {
			this._eventListeners.splice(index, 1);
		}
	};
}

/**
 * Temporarily disconnect from agent events.
 * User listeners are preserved and will receive events again after resubscribe().
 * Used internally during operations that need to pause event processing.
 */

export function _disconnectFromAgent(this: AgentSession): void {
	if (this._unsubscribeAgent) {
		this._unsubscribeAgent();
		this._unsubscribeAgent = undefined;
	}
}

/**
 * Reconnect to agent events after _disconnectFromAgent().
 * Preserves all existing listeners.
 */

export function _reconnectToAgent(this: AgentSession): void {
	if (this._unsubscribeAgent) return; // Already connected
	this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
}

/**
 * Remove all listeners and disconnect from agent.
 * Call this when completely done with the session.
 */

export function dispose(this: AgentSession): void {
	this._extensionRunner.invalidate(
		"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
	);
	disposeSessionAsyncJobManager(this._asyncJobManager, this._asyncJobManagerSessionId);
	this._disconnectFromAgent();
	this._eventListeners = [];
	cleanupSessionResources(this.sessionId);
}

// =========================================================================
// Read-only State Access
// =========================================================================

/** Full agent state */

export const agentSessionEventsMethods = {
	_emit,
	_emitQueueUpdate,
	_handleAgentEvent,
	_createRetryPromiseForAgentEnd,
	_findLastAssistantInMessages,
	_processAgentEvent,
	_applyInterruptAbortMessage,
	_applyProviderErrorGuidance,
	_resolveRetry,
	_getUserMessageText,
	_findLastAssistantMessage,
	_replaceMessageInPlace,
	_emitExtensionEvent,
	subscribe,
	_disconnectFromAgent,
	_reconnectToAgent,
	dispose,
};
