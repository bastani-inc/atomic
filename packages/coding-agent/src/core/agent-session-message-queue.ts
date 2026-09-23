import type { ImageContent, TextContent } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { commitAdmittedCustomMessage, commitAdmittedCustomMessages } from "./agent-session-custom-message-commit.ts";
import { forwardedMessageOptions, resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import {
	isProtectedStreamingCustomMessage,
	restoreProtectedStreamingCustomMessages,
} from "./agent-session-persistent-custom-messages.ts";
import { abort, pauseQueuedMessages, resumeQueuedMessages } from "./agent-session-queue-pause.ts";
import { transferWorkflowStageDeliveriesTo } from "./agent-session-transfer.ts";
import {
	type AgentQueueAccess,
	type ClearQueueOptions,
	customMessageExcludesContext,
	type DrainedAgentQueues,
	drainAgentMessageQueue,
	type InterruptQueueHold,
	normalizeInterruptAbortMessage,
	priorityHoldCounts,
} from "./agent-session-types.js";
import type { SendMessageOptions, SendMessagesOptions } from "./extensions/index.js";
import type { CustomMessage, StageAdmittedCustomMessage } from "./messages.ts";
import { assertSessionOpen, sessionLifetime, trackSessionWork } from "./session-lifecycle-work.ts";
import { settingsWriteOwner } from "./settings-write-ownership.ts";

export { transferWorkflowStageDeliveriesTo };

const interruptMutationQueues = new WeakMap<AgentSession, Promise<void>>();

function serializeInterruptMutation(owner: AgentSession, operation: () => Promise<void>): Promise<void> {
	const previous = interruptMutationQueues.get(owner) ?? Promise.resolve();
	const delivery = previous.then(operation);
	interruptMutationQueues.set(
		owner,
		delivery.catch(() => undefined),
	);
	return delivery;
}

export async function _queueSteer(this: AgentSession, text: string, images?: ImageContent[]): Promise<void> {
	assertSessionOpen(this);
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner._queueSteer(text, images);
	this._steeringMessages.push(text);
	this._emitQueueUpdate();
	const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
	if (images) {
		content.push(...images);
	}
	this._queueAgentMessage(
		{
			role: "user",
			content,
			timestamp: Date.now(),
		},
		"steer",
	);
}

/**
 * Internal: Queue a follow-up message (already expanded, no extension command check).
 */

export async function _queueFollowUp(this: AgentSession, text: string, images?: ImageContent[]): Promise<void> {
	assertSessionOpen(this);
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner._queueFollowUp(text, images);
	this._followUpMessages.push(text);
	this._emitQueueUpdate();
	const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
	if (images) {
		content.push(...images);
	}
	this._queueAgentMessage(
		{
			role: "user",
			content,
			timestamp: Date.now(),
		},
		"followUp",
	);
}

/**
 * Throw an error if the text is an extension command.
 */

export function _throwIfExtensionCommand(this: AgentSession, text: string): void {
	const spaceIndex = text.indexOf(" ");
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const command = this._extensionRunner.getCommand(commandName);

	if (command) {
		throw new Error(
			`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
		);
	}
}

/**
 * Send a custom message to the session. Creates a CustomMessageEntry.
 *
 * Handles five cases:
 * - Streaming + interrupt trigger: aborts the active run and starts an immediate custom-message turn
 * - Streaming + explicit display-only context exclusion: appends to state/session, no turn and no queue
 * - Streaming otherwise: queues message, processed when loop pulls from queue
 * - Not streaming + triggerTurn: appends to state/session, starts new turn
 * - Not streaming + no trigger: appends to state/session, no turn
 *
 * @param message Custom message with customType, content, display, details
 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
 * @param options.deliverAs Delivery mode: "steer", "followUp", "nextTurn", or "interrupt"
 */

export async function sendCustomMessage<T = unknown>(
	this: AgentSession,
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: SendMessageOptions,
): Promise<void> {
	const currentOwner = resolveWorkflowStageDeliveryTarget(this);
	if (currentOwner !== this) return currentOwner.sendCustomMessage(message, options);
	assertSessionOpen(this);
	return trackSessionWork(this, () => admittedCustomMessage.call(this, message, options));
}

async function admittedCustomMessage<T>(
	this: AgentSession,
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: SendMessageOptions,
): Promise<void> {
	const lifetime = sessionLifetime(this);
	const appMessage = {
		role: "custom" as const,
		customType: message.customType,
		content: message.content ?? [],
		display: message.display,
		details: message.details,
		timestamp: Date.now(),
		...(options?.excludeFromContext === true ? { excludeFromContext: true } : {}),
		...(options?.stageAdmissionKey === undefined ? {} : { stageAdmissionKey: options.stageAdmissionKey }),
	} satisfies CustomMessage<T> & { stageAdmissionKey?: string };
	const boundary = this._subagentMessageAdmission ?? this._workflowStageAdmission;
	const commit = async (): Promise<void> => {
		if (boundary && options?.stageAdmissionBarrier) await options.stageAdmissionBarrier();
		assertSessionOpen(this);
		if (lifetime.aborted) throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
		await commitAdmittedCustomMessage(this, appMessage, options);
	};
	// Event hooks may await non-triggering writes while protected input awaits the
	// event writer. Those local writes must not queue behind that external input.
	const deliver = () =>
		boundary && options?.triggerTurn === true ? boundary.serializeMessageDelivery(commit) : commit();
	if (boundary === undefined) return deliver();
	await boundary.admit(options?.stageAdmissionKey, deliver, () => {
		if (this._subagentMessageAdmission) throw new Error("Subagent execution is terminal and cannot accept messages");
		const router = this._orchestrationContext?.lateMessageRouter;
		if (router === undefined) throw new Error("Workflow stage closed without a late-message router");
		return router.routeMessage(message, options);
	}).completion;
}

/** Atomically admits a custom-message batch in array order. */
export async function sendCustomMessages<T = unknown>(
	this: AgentSession,
	messages: Array<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">>,
	options?: SendMessagesOptions,
): Promise<void> {
	const currentOwner = resolveWorkflowStageDeliveryTarget(this);
	if (currentOwner !== this) return currentOwner.sendCustomMessages(messages, options);
	assertSessionOpen(this);
	return trackSessionWork(this, () => admittedCustomMessages.call(this, messages, options));
}

async function admittedCustomMessages<T>(
	this: AgentSession,
	messages: Array<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">>,
	options?: SendMessagesOptions,
): Promise<void> {
	const lifetime = sessionLifetime(this);
	const timestamp = Date.now();
	const appMessages = messages.map(
		(message) =>
			({
				role: "custom" as const,
				customType: message.customType,
				content: message.content ?? [],
				display: message.display,
				details: message.details,
				timestamp,
				...(options?.excludeFromContext === true ? { excludeFromContext: true } : {}),
				...(options?.stageAdmissionKey === undefined ? {} : { stageAdmissionKey: options.stageAdmissionKey }),
			}) satisfies CustomMessage<T> & { stageAdmissionKey?: string },
	);
	if (appMessages.length === 0) return;
	const boundary = this._subagentMessageAdmission ?? this._workflowStageAdmission;
	const commit = async (): Promise<void> => {
		if (boundary && options?.stageAdmissionBarrier) await options.stageAdmissionBarrier();
		assertSessionOpen(this);
		if (lifetime.aborted) throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
		await commitAdmittedCustomMessages(this, appMessages, options);
	};
	const deliver = () =>
		boundary && options?.triggerTurn === true ? boundary.serializeMessageDelivery(commit) : commit();
	if (boundary === undefined) return deliver();
	await boundary.admit(options?.stageAdmissionKey, deliver, () => {
		if (this._subagentMessageAdmission) throw new Error("Subagent execution is terminal and cannot accept messages");
		const router = this._orchestrationContext?.lateMessageRouter;
		if (router === undefined) throw new Error("Workflow stage closed without a late-message router");
		return router.routeMessages(messages, options);
	}).completion;
}

export function sealWorkflowStageGeneration(this: AgentSession): void {
	this._workflowStageAdmission?.seal();
}

export async function closeWorkflowStageGeneration(this: AgentSession): Promise<void> {
	await this._workflowStageAdmission?.close();
	await this.agent?.waitForIdle?.();
	await this._agentEventQueue;
}

export function _appendCustomMessage<T>(this: AgentSession, message: CustomMessage<T>): void {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) {
		owner._appendCustomMessage(message);
		return;
	}
	const stageAdmissionMessage = message as StageAdmittedCustomMessage;
	const entryId = this.sessionManager.appendCustomMessageEntry(
		message.customType,
		message.content,
		message.display,
		message.details,
		customMessageExcludesContext(message),
		undefined,
		stageAdmissionMessage.stageAdmissionKey,
	);
	this._entryIdsByMessage.set(message, entryId);
	this._refreshFinalizedContext();
	this._emit({ type: "message_start", message });
	this._emit({ type: "message_end", message });
}

/** Append context-only custom messages once the current turn's tool results are in history. */
export function _flushPendingCustomMessages(this: AgentSession): void {
	if (this._pendingCustomMessages.length === 0) return;
	const pending = this._pendingCustomMessages;
	this._pendingCustomMessages = [];
	for (const message of pending) this._appendCustomMessage(message);
}
export function _enqueueInterruptCustomMessage<T>(
	this: AgentSession,
	message: CustomMessage<T>,
	options?: SendMessageOptions,
): Promise<void> {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner._enqueueInterruptCustomMessage(message, forwardedMessageOptions(options));
	assertSessionOpen(this);
	this._pendingInterruptDeliveries += 1;
	// Establish the hold synchronously when the interrupt is enqueued, not when
	// the serialized delivery callback later starts. Callers commonly fire and
	// forget sendCustomMessage(), then queue additional steer/follow-up messages
	// before the promise chain gets a microtask; those messages must be captured
	// in the active interrupt hold instead of pi-agent-core's live queues.
	this._ensureActiveInterruptQueueHold();
	const delivery = trackSessionWork(this, () =>
		this._interruptDeliveryQueue.then(async () => {
			try {
				await this._sendInterruptCustomMessageNow(message, options);
			} finally {
				// Retirement moves the pending count and hold synchronously. Settle the
				// same live owner so its queue cannot remain stranded on the replacement.
				const liveOwner = resolveWorkflowStageDeliveryTarget(this);
				liveOwner._pendingInterruptDeliveries -= 1;
				if (liveOwner._pendingInterruptDeliveries === 0) {
					liveOwner._restoreAndClearActiveInterruptQueueHold();
				}
			}
		}),
	);
	this._interruptDeliveryQueue = delivery.catch(() => undefined);
	return delivery;
}

async function sendInterruptCustomMessageUnlocked<T>(
	session: AgentSession,
	message: CustomMessage<T>,
	options?: SendMessageOptions,
): Promise<void> {
	assertSessionOpen(session);
	const lifetime = sessionLifetime(session);
	session.abortRetry();
	session._ensureActiveInterruptQueueHold();
	if (session.isStreaming) {
		const previousAbortMessage = session._activeInterruptAbortMessage;
		session._activeInterruptAbortMessage = normalizeInterruptAbortMessage(options?.interruptAbortMessage);
		try {
			session.agent.abort();
			await session.agent.waitForIdle();
			await session._agentEventQueue;
		} finally {
			session._activeInterruptAbortMessage = previousAbortMessage;
		}
	}
	const owner = resolveWorkflowStageDeliveryTarget(session);
	if (owner !== session) return owner._sendInterruptCustomMessageNow(message, forwardedMessageOptions(options));
	assertSessionOpen(session);
	if (lifetime.aborted) throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
	if (session._queuedMessagesPaused) {
		session._queueAgentMessage(message, "steer");
		return;
	}
	await session.agent.prompt(message);
}

export function _sendInterruptCustomMessageNow<T>(
	this: AgentSession,
	message: CustomMessage<T>,
	options?: SendMessageOptions,
): Promise<void> {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner._sendInterruptCustomMessageNow(message, forwardedMessageOptions(options));
	return serializeInterruptMutation(this, () => sendInterruptCustomMessageUnlocked(this, message, options));
}

export function _ensureActiveInterruptQueueHold(this: AgentSession): InterruptQueueHold {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner._ensureActiveInterruptQueueHold();
	if (this._activeInterruptQueueHold !== undefined) {
		return this._activeInterruptQueueHold;
	}
	const drained = this._drainQueuedAgentMessages();
	this._activeInterruptQueueHold = {
		steering: [...drained.steering],
		followUp: [...drained.followUp],
	};
	return this._activeInterruptQueueHold;
}

export function _restoreAndClearActiveInterruptQueueHold(this: AgentSession): void {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) {
		owner._restoreAndClearActiveInterruptQueueHold();
		return;
	}
	if (this._queuedMessagesPaused) return;
	const hold = this._activeInterruptQueueHold;
	if (hold === undefined) return;
	const currentCoreQueues = this._drainQueuedAgentMessages();
	this._restoreQueuedAgentMessages({
		steering: [...hold.steering, ...currentCoreQueues.steering],
		followUp: [...hold.followUp, ...currentCoreQueues.followUp],
	});
	this._activeInterruptQueueHold = undefined;
}

export function _queueAgentMessage(
	this: AgentSession,
	message: AgentMessage,
	delivery: "steer" | "followUp" | "interrupt",
): void {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) {
		owner._queueAgentMessage(message, delivery);
		return;
	}
	const hold = delivery === "interrupt" ? this._ensureActiveInterruptQueueHold() : this._activeInterruptQueueHold;
	if (hold !== undefined) {
		if (delivery === "followUp") {
			hold.followUp.push(message);
		} else if (delivery === "interrupt") {
			const index = priorityHoldCounts.get(hold) ?? 0;
			hold.steering.splice(index, 0, message);
			priorityHoldCounts.set(hold, index + 1);
		} else {
			hold.steering.push(message);
		}
	} else if (delivery === "followUp") {
		this.agent.followUp(message);
	} else {
		this.agent.steer(message);
	}
	const yieldReason = message.role === "user" ? "input-needed" : "intercom-coordination";
	this._agentTaskHost?.yieldTaskWaits(yieldReason);
	this._childTaskWaits.yieldAll(yieldReason);
}

export function _drainQueuedAgentMessages(this: AgentSession): DrainedAgentQueues {
	// pi-agent-core exposes public clear methods but no public drain/restore pair.
	// Interrupt and pause holds prevent an aborting run from consuming queued raw
	// messages while preserving every entry for the existing resume boundary.
	const agentWithQueues = this.agent as unknown as AgentQueueAccess;
	return {
		steering: drainAgentMessageQueue(agentWithQueues.steeringQueue),
		followUp: drainAgentMessageQueue(agentWithQueues.followUpQueue),
	};
}

export function _restoreQueuedAgentMessages(this: AgentSession, queues: DrainedAgentQueues): void {
	for (const message of queues.steering) {
		this.agent.steer(message);
	}
	for (const message of queues.followUp) {
		this.agent.followUp(message);
	}
}
/**
 * Clear queued text for editor restoration while retaining optional raw custom entries.
 */
export function clearQueue(
	this: AgentSession,
	options?: ClearQueueOptions,
): { steering: string[]; followUp: string[] } {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner.clearQueue(options);
	const steering = [...this._steeringMessages];
	const followUp = [...this._followUpMessages];
	this._steeringMessages = [];
	this._followUpMessages = [];
	const removed = this._drainQueuedAgentMessages();
	const hold = this._activeInterruptQueueHold;
	if (hold !== undefined) {
		removed.steering.push(...hold.steering.splice(0));
		removed.followUp.push(...hold.followUp.splice(0));
		priorityHoldCounts.delete(hold);
	}
	restoreProtectedStreamingCustomMessages(this, removed);
	if (options?.preserveUnprotectedCustomMessages && hold !== undefined) {
		const restoreUnprotectedCustomMessages = (
			removedMessages: AgentMessage[],
			heldMessages: AgentMessage[],
		): void => {
			const currentlyHeld = [...heldMessages];
			const preserved = removedMessages.filter(
				(message): message is Extract<AgentMessage, { role: "custom" }> =>
					message.role === "custom" && !isProtectedStreamingCustomMessage(this, message),
			);
			if (preserved.length === 0) return;
			const preservedReferences = new Set<AgentMessage>(preserved);
			const restoredProtected = new Set(currentlyHeld);
			const ordered = removedMessages.filter(
				(message) => preservedReferences.has(message) || restoredProtected.has(message),
			);
			const unmatched = currentlyHeld.filter((message) => !ordered.includes(message));
			heldMessages.splice(0, heldMessages.length, ...ordered, ...unmatched);
		};
		restoreUnprotectedCustomMessages(removed.steering, hold.steering);
		restoreUnprotectedCustomMessages(removed.followUp, hold.followUp);
	}
	if (
		!this._queuedMessagesPaused &&
		this._pendingInterruptDeliveries === 0 &&
		hold !== undefined &&
		hold.steering.length === 0 &&
		hold.followUp.length === 0
	) {
		this._activeInterruptQueueHold = undefined;
	}
	this._emitQueueUpdate();
	return { steering, followUp };
}

/** Number of pending messages (includes both steering and follow-up) */
export function getSteeringMessages(this: AgentSession): readonly string[] {
	return this._steeringMessages;
}

/** Get pending follow-up messages (read-only) */
export function getFollowUpMessages(this: AgentSession): readonly string[] {
	return this._followUpMessages;
}

// =========================================================================
// Model Management
// =========================================================================

export function setSteeringMode(this: AgentSession, mode: "all" | "one-at-a-time"): void {
	this.agent.steeringMode = mode;
	settingsWriteOwner.run(this, () => this.settingsManager.setSteeringMode(mode));
}

/**
 * Set follow-up message mode.
 * Saves to settings.
 */

export function setFollowUpMode(this: AgentSession, mode: "all" | "one-at-a-time"): void {
	this.agent.followUpMode = mode;
	settingsWriteOwner.run(this, () => this.settingsManager.setFollowUpMode(mode));
}

// =========================================================================
// Queue and delivery settings
// =========================================================================
export const agentSessionMessageQueueMethods = {
	_queueSteer,
	_queueFollowUp,
	_throwIfExtensionCommand,
	transferWorkflowStageDeliveriesTo,
	sealWorkflowStageGeneration,
	sendCustomMessage,
	sendCustomMessages,
	closeWorkflowStageGeneration,
	_appendCustomMessage,
	_flushPendingCustomMessages,
	_enqueueInterruptCustomMessage,
	_sendInterruptCustomMessageNow,
	_ensureActiveInterruptQueueHold,
	_restoreAndClearActiveInterruptQueueHold,
	pauseQueuedMessages,
	resumeQueuedMessages,
	_queueAgentMessage,
	_drainQueuedAgentMessages,
	_restoreQueuedAgentMessages,
	clearQueue,
	getSteeringMessages,
	getFollowUpMessages,
	abort,
	setSteeringMode,
	setFollowUpMode,
};
