import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { CustomMessage } from "./messages.ts";
import type { SendMessageOptions, SendMessagesOptions } from "./extensions/index.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { customMessageExcludesContext, drainAgentMessageQueue, normalizeInterruptAbortMessage, type AgentQueueAccess, type DrainedAgentQueues, type InterruptQueueHold } from "./agent-session-types.ts";
import { forwardedMessageOptions, resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import { transferWorkflowStageDeliveriesTo } from "./agent-session-transfer.ts";
import { abort, pauseQueuedMessages, resumeQueuedMessages } from "./agent-session-queue-pause.ts";
import { restoreProtectedStreamingCustomMessages } from "./agent-session-persistent-custom-messages.ts";
import { commitAdmittedCustomMessage, commitAdmittedCustomMessages } from "./agent-session-custom-message-commit.ts";
export { transferWorkflowStageDeliveriesTo };

const interruptMutationQueues = new WeakMap<AgentSession, Promise<void>>();

function serializeInterruptMutation(owner: AgentSession, operation: () => Promise<void>): Promise<void> {
	const previous = interruptMutationQueues.get(owner) ?? Promise.resolve();
	const delivery = previous.then(operation);
	interruptMutationQueues.set(owner, delivery.catch(() => undefined));
	return delivery;
}

export async function _queueSteer(this: AgentSession, text: string, images?: ImageContent[]): Promise<void> {
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

export async function sendCustomMessage<T = unknown>(this: AgentSession,
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: SendMessageOptions,
): Promise<void> {
	const currentOwner = resolveWorkflowStageDeliveryTarget(this);
	if (currentOwner !== this) return currentOwner.sendCustomMessage(message, options);
	const appMessage = {
		role: "custom" as const,
		customType: message.customType,
		content: message.content ?? [],
		display: message.display,
		details: message.details,
		timestamp: Date.now(),
		...(options?.excludeFromContext === true ? { excludeFromContext: true } : {}),
	} satisfies CustomMessage<T>;
	const boundary = this._workflowStageAdmission;
	const deliver = async (): Promise<void> => {
		if (boundary && options?.stageAdmissionBarrier) await options.stageAdmissionBarrier();
		await commitAdmittedCustomMessage(this, appMessage, options);
	};
	if (boundary === undefined) return deliver();
	await boundary.admit(
		options?.stageAdmissionKey,
		deliver,
		() => {
			const router = this._orchestrationContext?.lateMessageRouter;
			if (router === undefined) throw new Error("Workflow stage closed without a late-message router");
			return router.routeMessage(message, options);
		},
	).completion;
}

/** Atomically admits a custom-message batch in array order. */
export async function sendCustomMessages<T = unknown>(this: AgentSession,
	messages: Array<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">>,
	options?: SendMessagesOptions,
): Promise<void> {
	const currentOwner = resolveWorkflowStageDeliveryTarget(this);
	if (currentOwner !== this) return currentOwner.sendCustomMessages(messages, options);
	const timestamp = Date.now();
	const appMessages = messages.map((message) => ({
		role: "custom" as const,
		customType: message.customType,
		content: message.content ?? [],
		display: message.display,
		details: message.details,
		timestamp,
		...(options?.excludeFromContext === true ? { excludeFromContext: true } : {}),
	} satisfies CustomMessage<T>));
	if (appMessages.length === 0) return;
	const boundary = this._workflowStageAdmission;
	const deliver = async (): Promise<void> => {
		if (boundary && options?.stageAdmissionBarrier) await options.stageAdmissionBarrier();
		await commitAdmittedCustomMessages(this, appMessages, options);
	};
	if (boundary === undefined) return deliver();
	await boundary.admit(
		options?.stageAdmissionKey,
		deliver,
		() => {
			const router = this._orchestrationContext?.lateMessageRouter;
			if (router === undefined) throw new Error("Workflow stage closed without a late-message router");
			return router.routeMessages(messages, options);
		},
	).completion;
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
	if (owner !== this) return owner._appendCustomMessage(message);
	this.agent.state.messages.push(message);
	this.sessionManager.appendCustomMessageEntry(
		message.customType,
		message.content,
		message.display,
		message.details,
		customMessageExcludesContext(message),
	);
	this._emit({ type: "message_start", message });
	this._emit({ type: "message_end", message });
}

export function _enqueueInterruptCustomMessage<T>(this: AgentSession, message: CustomMessage<T>, options?: SendMessageOptions): Promise<void> {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner._enqueueInterruptCustomMessage(message, forwardedMessageOptions(options));
	this._pendingInterruptDeliveries += 1;
	// Establish the hold synchronously when the interrupt is enqueued, not when
	// the serialized delivery callback later starts. Callers commonly fire and
	// forget sendCustomMessage(), then queue additional steer/follow-up messages
	// before the promise chain gets a microtask; those messages must be captured
	// in the active interrupt hold instead of pi-agent-core's live queues.
	this._ensureActiveInterruptQueueHold();
	const delivery = this._interruptDeliveryQueue.then(async () => {
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
	});
	this._interruptDeliveryQueue = delivery.catch(() => undefined);
	return delivery;
}


async function sendInterruptCustomMessageUnlocked<T>(
	session: AgentSession,
	message: CustomMessage<T>,
	options?: SendMessageOptions,
): Promise<void> {
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
	if (session._queuedMessagesPaused) {
		session._queueAgentMessage(message, "steer");
		return;
	}
	await session.agent.prompt(message);
}

export function _sendInterruptCustomMessageNow<T>(this: AgentSession,
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
	if (owner !== this) return owner._restoreAndClearActiveInterruptQueueHold();
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


export function _queueAgentMessage(this: AgentSession, message: AgentMessage, delivery: "steer" | "followUp"): void {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner._queueAgentMessage(message, delivery);
	const hold = this._activeInterruptQueueHold;
	if (hold !== undefined) {
		if (delivery === "followUp") {
			hold.followUp.push(message);
		} else {
			hold.steering.push(message);
		}
		return;
	}
	if (delivery === "followUp") {
		this.agent.followUp(message);
	} else {
		this.agent.steer(message);
	}
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
 * Send a user message to the agent. Always triggers a turn.
 * When the agent is streaming, use deliverAs to specify how to queue the message.
 *
 * @param content User message content (string or content array)
 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
 */
export function clearQueue(this: AgentSession): { steering: string[]; followUp: string[] } {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner.clearQueue();
	const steering = [...this._steeringMessages];
	const followUp = [...this._followUpMessages];
	this._steeringMessages = [];
	this._followUpMessages = [];
	const removed = this._drainQueuedAgentMessages();
	if (this._activeInterruptQueueHold !== undefined) {
		removed.steering.push(...this._activeInterruptQueueHold.steering.splice(0));
		removed.followUp.push(...this._activeInterruptQueueHold.followUp.splice(0));
	}
	restoreProtectedStreamingCustomMessages(this, removed);
	const hold = this._activeInterruptQueueHold;
	if (!this._queuedMessagesPaused && this._pendingInterruptDeliveries === 0 && hold !== undefined
		&& hold.steering.length === 0 && hold.followUp.length === 0) {
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
	this.settingsManager.setSteeringMode(mode);
}

/**
 * Set follow-up message mode.
 * Saves to settings.
 */

export function setFollowUpMode(this: AgentSession, mode: "all" | "one-at-a-time"): void {
	this.agent.followUpMode = mode;
	this.settingsManager.setFollowUpMode(mode);
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
