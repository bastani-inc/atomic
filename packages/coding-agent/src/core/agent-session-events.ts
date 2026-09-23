import type { AssistantMessage, Message, TextContent } from "@bastani/pi-ai/compat";
import { cleanupSessionResources } from "@bastani/pi-ai/compat";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { abortBash } from "./agent-session-bash.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import {
	isProtectedStreamingCustomMessage,
	markProtectedStreamingCustomMessageConsumed,
	markProtectedStreamingCustomMessagePersistenceFailed,
	persistProtectedStreamingCustomMessage,
	prepareProtectedStreamingCustomMessagesForDisposal,
	retryConsumedProtectedStreamingCustomMessages,
} from "./agent-session-persistent-custom-messages.ts";
import { abortCurrentGeneration } from "./agent-session-queue-pause.ts";
import {
	type AgentSessionEvent,
	type AgentSessionEventListener,
	customMessageExcludesContext,
	isSingleGenericAbortTextContent,
	replacementAbortContent,
} from "./agent-session-types.js";
import { formatCodexProviderError } from "./codex-errors.ts";
import type {
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnStartEvent,
} from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import { STALE_EXTENSION_CONTEXT_MESSAGE } from "./extensions/stale-context.ts";
import type { SessionShutdownEvent } from "./extensions/types.ts";
import type { StageAdmittedCustomMessage } from "./messages.ts";
import { normalizeMessageContent } from "./messages.ts";
import {
	abortSessionWork,
	drainSessionReload,
	drainSessionWork,
	hasCallingSessionWork,
} from "./session-lifecycle-work.ts";
import { assertSettingsWrites, ownedSettingsManagers } from "./settings-write-ownership.ts";

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

const consumedQueuedMessageEvents = new WeakSet<object>();

/** Internal handler for agent events - shared by subscribe and reconnect */

export function _handleAgentEvent(this: AgentSession, event: AgentEvent): Promise<void> | void {
	// Create retry promise synchronously before queueing async processing.
	// Agent.emit() calls this handler synchronously, and prompt() calls waitForRetry()
	// as soon as agent.prompt() resolves. If _retryPromise is created only inside
	// _processAgentEvent, slow earlier queued events can delay agent_end processing
	// and waitForRetry() can miss the in-flight retry.
	this._createRetryPromiseForAgentEnd(event);
	// Agent-core has already consumed this message. Reflect admission before an
	// Escape/abort can restore it from a stale queue while earlier hooks settle.
	if (event.type === "message_start" && event.message.role === "user") {
		const text = this._getUserMessageText(event.message);
		if (text) {
			const queue = [this._steeringMessages, this._followUpMessages].find((messages) => messages.includes(text));
			if (queue) {
				queue.splice(queue.indexOf(text), 1);
				this._admittedQueuedMessageAwaitingReply = text;
				consumedQueuedMessageEvents.add(event);
			}
		}
	}
	const awaitProtectedPersistence =
		event.type === "message_end" && event.message.role === "custom"
			? markProtectedStreamingCustomMessageConsumed(this, event.message)
			: false;
	if (event.type === "message_end") this._messagesAwaitingPersistence.add(event.message);

	const processing = this._agentEventQueue.then(
		() => this._processAgentEvent(event),
		() => this._processAgentEvent(event),
	);
	this._agentEventQueue = processing;

	// Keep queue alive if an event handler fails. Per event, agent-core awaits only
	// protected persistence and fallback reconciliation; other listener work is
	// nonblocking for that event. The queue as a whole is still drained before each
	// provider request (`prepareRequest` in agent-session-boundaries.ts): message_end
	// handlers may replace the message that gets persisted, and the request is built
	// from the persisted canonical projection, so every queued handler gates the next
	// request rather than only the persistence step.
	processing.catch((error) => {
		// #3105: callbacks interrupted by terminal disposal remain observable at shutdown.
		if (this._disposed) {
			const failures = shutdownEventFailures.get(this) ?? [];
			failures.push(error instanceof Error ? error : new Error(String(error)));
			shutdownEventFailures.set(this, failures);
		}
	});
	if (
		awaitProtectedPersistence ||
		// #3105: only queued custom input needs this boundary; ordinary turn listeners
		// must remain nonblocking during fallback settlement.
		(event.type === "turn_end" && this._pendingCustomMessages.length > 0) ||
		(event.type === "agent_end" && (this._fallbackModels.length > 0 || this._fallbackOriginModel !== undefined))
	)
		return processing.catch(() => {});
}

export function _createRetryPromiseForAgentEnd(this: AgentSession, event: AgentEvent): void {
	if (event.type !== "agent_end" || this._retryPromise || this._agentRunAbortRequested) {
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

	const fallbackable =
		typeof this._isFallbackableError === "function"
			? this._isFallbackableError(lastAssistant)
			: this._isRetryableError(lastAssistant);
	const retryable = this._isRetryableError(lastAssistant);
	const shouldRetry =
		retryable || fallbackable || this._isEmptyCompletion(lastAssistant) || this._isSafetyRefusal(lastAssistant);
	if (!shouldRetry) {
		return;
	}

	this._retryPromise = new Promise((resolve) => {
		this._retryResolve = resolve;
	});
}

export function _findLastAssistantInMessages(
	this: AgentSession,
	messages: AgentMessage[],
): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			return message as AssistantMessage;
		}
	}
	return undefined;
}

export async function _processAgentEvent(this: AgentSession, event: AgentEvent): Promise<void> {
	const protectedMessage =
		event.type === "message_end" &&
		event.message.role === "custom" &&
		isProtectedStreamingCustomMessage(this, event.message)
			? event.message
			: undefined;
	// Public notifications remain serialized behind extension events.
	if (event.type === "agent_start") {
		// A caller replacement prepared for a turn that never reached its provider
		// request must not leak into this run's first request. `prepareRequest`
		// awaits this queue, so the reset lands before the run's first projection.
		this._callerReplacedNextRequestContext = false;
	}
	if (event.type === "message_start" && event.message.role === "user") {
		this._overflowRecoveryAttempted = false;
		this._recoverableLengthRecoveryAttempted = false;
		this._fallbackAttemptedKeys.clear();
		this._fallbackBlockedModels.length = 0;
		if (consumedQueuedMessageEvents.delete(event)) this._emitQueueUpdate();
	}

	this._applyInterruptAbortMessage(event);
	this._applyProviderErrorGuidance(event);

	try {
		// Emit to extensions first, then notify all public listeners.
		await this._emitExtensionEvent(event);
		this._emit(event);
	} finally {
		// Agent-core has consumed this protected input already. Its durability
		// boundary cannot be skipped by a fallible extension or session listener.
		if (protectedMessage !== undefined) {
			try {
				persistProtectedStreamingCustomMessage(this, protectedMessage);
			} catch {
				markProtectedStreamingCustomMessagePersistenceFailed(this, protectedMessage);
			}
			retryConsumedProtectedStreamingCustomMessages(this);
		}
		if (event.type === "message_end") this._messagesAwaitingPersistence.delete(event.message);
	}
	if (event.type === "turn_end") {
		this._lastAssistantToolResults = event.toolResults;
		this._flushPendingCustomMessages();
	}

	// Handle session persistence
	if (event.type === "message_end") {
		let entryId: string | undefined;
		// Check if this is a custom message from extensions
		if (event.message.role === "custom") {
			const admitted = event.message as StageAdmittedCustomMessage;
			if (protectedMessage === undefined) {
				entryId = this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
					customMessageExcludesContext(event.message),
					undefined,
					admitted.stageAdmissionKey,
				);
			}
		} else if (
			event.message.role === "system" ||
			event.message.role === "user" ||
			event.message.role === "assistant" ||
			event.message.role === "toolResult"
		) {
			// Regular LLM message - persist as SessionMessageEntry
			entryId = this.sessionManager.appendMessage(event.message);
		}
		if (entryId) this._entryIdsByMessage.set(event.message, entryId);
		// Other message types (bashExecution, branchSummary) are persisted elsewhere

		// Track assistant message for auto-compaction (checked on agent_end)
		if (event.message.role === "assistant") {
			this._lastAssistantMessage = event.message;

			const assistantMsg = event.message as AssistantMessage;
			// A length stop preserves its one-shot recovery budget. Reset both
			// recovery kinds only once a non-truncated response completes.
			const assistantFailed =
				assistantMsg.stopReason === "error" ||
				this._isEmptyCompletion(assistantMsg) ||
				this._isSafetyRefusal(assistantMsg);
			if (!assistantFailed && assistantMsg.stopReason !== "length") {
				this._overflowRecoveryAttempted = false;
				this._recoverableLengthRecoveryAttempted = false;
			}
			if (!assistantFailed) {
				this._contextOverflowUnresolved = false;
				this._outputBudgetErrorContinuationAttempts = 0;
			}
			if (!assistantFailed && assistantMsg.stopReason === "stop") {
				this._fallbackAttemptedKeys.clear();
				this._fallbackBlockedModels.length = 0;
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

	// A transient hidden-reconciliation write failure retries independently of
	// provider/card delivery and can never create another visible lifecycle card.
	retryConsumedProtectedStreamingCustomMessages(this);

	// Check auto-retry and auto-compaction after agent completes
	if (event.type === "agent_end" && this._lastAssistantMessage) {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (this._agentRunAbortRequested) {
			this._resolveRetry();
			return;
		}
		const postToolPreflightFailed =
			this._postToolCompactionPreflightError !== undefined &&
			msg.errorMessage === this._postToolCompactionPreflightError;

		// Check provider/model failures before compaction. Fallback eligibility is
		// broader than same-model retry eligibility: auth and request-incompatible
		// failures advance without re-requesting the failed model.
		const fallbackableError =
			!postToolPreflightFailed &&
			(typeof this._isFallbackableError === "function"
				? this._isFallbackableError(msg)
				: this._isRetryableError(msg));
		const retryableError = !postToolPreflightFailed && this._isRetryableError(msg);
		const emptyCompletion =
			!postToolPreflightFailed && !retryableError && !fallbackableError && this._isEmptyCompletion(msg);
		const safetyRefusal =
			!postToolPreflightFailed &&
			!retryableError &&
			!fallbackableError &&
			!emptyCompletion &&
			this._isSafetyRefusal(msg);
		const modelFailure = retryableError || fallbackableError || emptyCompletion || safetyRefusal;
		let settleAfterTurn = !modelFailure;
		if (modelFailure) {
			if (emptyCompletion && !msg.errorMessage) {
				// Surface a clear reason in the retry banner; empty completions carry no
				// provider error message of their own.
				msg.errorMessage = "Provider returned an empty completion";
			} else if (safetyRefusal && !msg.errorMessage) {
				msg.errorMessage = "Provider returned a canned safety refusal";
			}
			const didRetry = await this._handleRetryableError(msg);
			if (didRetry) return; // Retry was initiated, don't proceed to compaction
			settleAfterTurn = true;
		}
		if (this._agentRunAbortRequested) return;

		this._resolveRetry();
		this._contextOverflowUnresolved = false;
		await this._checkCompaction(msg);
		if (this._agentRunAbortRequested) return;

		// Compaction owns context overflow first. Only once it is disabled, fails,
		// or reports the overflow unresolved may the chain spend a candidate on a
		// larger-context model, so a compactable first overflow costs nothing.
		if (this._contextOverflowUnresolved) {
			this._contextOverflowUnresolved = false;
			if (typeof this._trySwitchToFallbackModel === "function" && (await this._trySwitchToFallbackModel(msg)))
				return;
			settleAfterTurn = true;
		}
		// Keep a fallback lifecycle open across the compact-and-continue probe that
		// belongs to this user turn, then settle it without changing the active model.
		if (settleAfterTurn && this._pendingPostCompactionContinuation === undefined) {
			if (typeof this._settleFallbackModelScope === "function") await this._settleFallbackModelScope();
		}
		// Launched last so the fallback lifecycle wins: a switch above returns before
		// this line. Guarded like the fallback methods above because fallback suites
		// drive this function on a synthetic session.
		if (event.type === "agent_end" && typeof this._maybeGenerateSessionSummary === "function")
			void this._maybeGenerateSessionSummary();
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

	if (
		event.message.role === "toolResult" &&
		event.message.isError &&
		isSingleGenericAbortTextContent(event.message.content)
	) {
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

	assistantMessage.errorMessage = formatCodexProviderError(assistantMessage.provider, assistantMessage.errorMessage);
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
		await this._extensionRunner.emit({ type: "agent_start" }, undefined, true);
	} else if (event.type === "agent_end") {
		await this._extensionRunner.emit({ type: "agent_end", messages: event.messages }, undefined, true);
	} else if (event.type === "turn_start") {
		const extensionEvent: TurnStartEvent = {
			type: "turn_start",
			turnIndex: this._turnIndex,
			timestamp: Date.now(),
		};
		await this._extensionRunner.emit(extensionEvent, undefined, true);
	} else if (event.type === "turn_end") {
		// finishTurn already dispatched the actionable boundary for loop-driven turns.
		// Synthetic turns (for example a run that fails before the loop's finishTurn)
		// still reach extensions here.
		if (event.message.role === "assistant" && !this._boundaryDispatchedMessages.delete(event.message)) {
			await this._dispatchTurnEndBoundary(event.message, event.toolResults);
		}
		this._turnIndex++;
	} else if (event.type === "message_start") {
		const extensionEvent: MessageStartEvent = {
			type: "message_start",
			message: event.message,
		};
		await this._extensionRunner.emit(extensionEvent, undefined, true);
	} else if (event.type === "message_update") {
		const extensionEvent: MessageUpdateEvent = {
			type: "message_update",
			assistantMessageEvent: event.assistantMessageEvent,
		};
		await this._extensionRunner.emit(extensionEvent, undefined, true);
	} else if (event.type === "message_end") {
		const extensionEvent: MessageEndEvent = {
			type: "message_end",
			message: event.message,
		};
		// Agent-core already completed this message; closing must drain its hooks and persistence.
		const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent, true);
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
		await this._extensionRunner.emit(extensionEvent, undefined, true);
	} else if (event.type === "tool_execution_update") {
		const extensionEvent: ToolExecutionUpdateEvent = {
			type: "tool_execution_update",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			partialResult: event.partialResult,
		};
		await this._extensionRunner.emit(extensionEvent, undefined, true);
	} else if (event.type === "tool_execution_end") {
		const extensionEvent: ToolExecutionEndEvent = {
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: event.result,
			isError: event.isError,
		};
		await this._extensionRunner.emit(extensionEvent, undefined, true);
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

/** Disconnect from agent events during disposal. */
export function _disconnectFromAgent(this: AgentSession): void {
	if (this._unsubscribeAgent) {
		this._unsubscribeAgent();
		this._unsubscribeAgent = undefined;
	}
}

/**
 * Remove all listeners and disconnect from agent.
 * Call this when completely done with the session.
 */

const shutdownEventFailures = new WeakMap<AgentSession, Error[]>();
const sessionClosures = new WeakMap<AgentSession, Promise<void>>();
const sessionRetirements = new WeakMap<AgentSession, Promise<void>>();

/** Shared terminal boundary for direct SDK disposal and runtime replacement. */
export function closeAgentSession(
	session: AgentSession,
	event: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" },
	beforeInvalidate?: () => void,
): Promise<void> {
	const handoff = event.reason !== "quit" && hasCallingSessionWork(session);
	const existing = sessionClosures.get(session);
	if (existing) return (handoff && sessionRetirements.get(session)) || existing;
	let resolveRetired!: () => void;
	let rejectRetired!: (error: Error) => void;
	const retirement = new Promise<void>((resolve, reject) => {
		resolveRetired = resolve;
		rejectRetired = reject;
	});
	const retired = { promise: retirement, resolve: resolveRetired, reject: rejectRetired };
	session._disposed = true;
	session._cacheWarmer?.cancel();
	const closing = Promise.resolve().then(async () => {
		const errors: Error[] = [];
		const attempt = async (component: string, cleanup: () => void | Promise<void>) => {
			try {
				await cleanup();
			} catch (cause) {
				if (cause instanceof AggregateError)
					errors.push(...cause.errors.map((error) => new Error(component, { cause: error })));
				else errors.push(new Error(component, { cause }));
			}
		};
		await attempt("lifetime", () => abortSessionWork(session));
		await attempt("shell abort", () => abortBash.call(session));
		await attempt("abort", () => abortCurrentGeneration.call(session));
		await attempt("reload rollback", () => drainSessionReload(session));
		await attempt("tasks", () => session.closeSessionTasks());
		await attempt("summary", () => session.abortSessionSummary());
		if (handoff) {
			await attempt("peer work", () => drainSessionWork(session, true, true));
			await attempt("retired authority", () => session._extensionRunner.revokeAuthority());
			if (errors.length)
				retired.reject(
					Object.assign(new AggregateError(errors, "Session retirement failed"), { code: "ShutdownFailed" }),
				);
			else retired.resolve();
		}
		await attempt("active work", () => drainSessionWork(session));
		await attempt("events", async () => {
			await session._agentEventQueue.catch(() => {});
			const failures = shutdownEventFailures.get(session);
			if (failures?.length) throw new AggregateError(failures, "Session event callbacks failed");
		});
		await attempt("extensions", async () => {
			await emitSessionShutdownEvent(session._extensionRunner, event);
		});
		await attempt("messages", () => prepareProtectedStreamingCustomMessagesForDisposal(session));
		await attempt("shell persistence", () => session._flushPendingBashMessages());
		await attempt("settings", async () => {
			await session.settingsManager.flush();
			assertSettingsWrites(session);
		});
		await attempt("session persistence", () => session.sessionManager.flush());
		if (ownedSettingsManagers.get(session.settingsManager) === session)
			ownedSettingsManagers.delete(session.settingsManager);
		await attempt("host subscriptions", () => beforeInvalidate?.());
		await attempt("generation", () => session._extensionRunner.invalidate(STALE_EXTENSION_CONTEXT_MESSAGE));
		await attempt("subscriptions", () => {
			session._disconnectFromAgent();
			session._eventListeners = [];
		});
		await attempt("provider", () => cleanupSessionResources(session.sessionId));
		await attempt("storage", () => {
			session._tempStorageLease?.release();
			session._tempStorageLease = undefined;
		});
		if (errors.length)
			throw Object.assign(new AggregateError(errors, "Session shutdown failed"), { code: "ShutdownFailed" });
	});
	sessionClosures.set(session, closing);
	if (handoff) {
		sessionRetirements.set(session, retired.promise);
		void closing.catch(() => {});
	}
	session._extensionRunner.sealHostInput();
	return handoff ? retired.promise : closing;
}

export function dispose(this: AgentSession): Promise<void> {
	return closeAgentSession(this);
}

// =========================================================================
// Read-only State Access
// =========================================================================

/** Full agent state */

export const agentSessionEventsMethods = {
	_close(this: AgentSession, event: SessionShutdownEvent, beforeInvalidate?: () => void) {
		return closeAgentSession(this, event, beforeInvalidate);
	},
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
	dispose,
};
