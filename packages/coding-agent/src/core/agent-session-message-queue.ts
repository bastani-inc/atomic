import type { ImageContent, TextContent } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { commitAdmittedCustomMessage, commitAdmittedCustomMessages } from "./agent-session-custom-message-commit.ts";
import { forwardedMessageOptions, resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import { holdsTurnsForDetachedResults } from "./agent-session-detached-tools.ts";
import { wakeIdleSessionForHeartbeat } from "./agent-session-heartbeat-wake.ts";
import { cancelHeldInput, heldInputView } from "./agent-session-held-input.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { recordPersistenceFailure } from "./agent-session-persistence-failures.ts";
import {
	isProtectedStreamingCustomMessage,
	restoreProtectedStreamingCustomMessages,
} from "./agent-session-persistent-custom-messages.ts";
import { markQueuedMessageImages, waitForCustomMessagePreparation } from "./agent-session-prompt.ts";
import { abort, pauseQueuedMessages, resumeQueuedMessages } from "./agent-session-queue-pause.ts";
import { transferWorkflowStageDeliveriesTo } from "./agent-session-transfer.ts";
import {
	forgetAllTypedQueuedTexts,
	forgetTypedQueuedText,
	rememberTypedQueuedText,
} from "./agent-session-typed-queue.ts";
import {
	type AgentQueueAccess,
	type ClearedQueue,
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
import { withOwnResourceAdmission } from "./resource-admission-scope.ts";
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

const laneImages = new WeakMap<AgentMessage, ImageContent[] | undefined>();

function rememberLaneMessage(message: AgentMessage, images: ImageContent[] | undefined): void {
	laneImages.set(message, images?.length ? [...images] : undefined);
}

function queuedTextImages(texts: readonly string[], removed: readonly AgentMessage[]): (ImageContent[] | undefined)[] {
	const images = removed.flatMap((message) => (laneImages.has(message) ? [laneImages.get(message)] : []));
	const firstQueuedIndex = images.length - texts.length;
	return texts.map((_, index) => images[firstQueuedIndex + index]);
}

/**
 * Queue a steering message (already expanded, no extension command check). `typed` is the text that was submitted,
 * when an `input` hook or an expansion may have changed it; `clearQueue()` gives it back.
 */
export async function _queueSteer(
	this: AgentSession,
	text: string,
	images?: ImageContent[],
	typed?: string,
): Promise<void> {
	assertSessionOpen(this);
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner._queueSteer(text, images, typed);
	this._steeringMessages.push(text);
	rememberTypedQueuedText(this, "steer", text, typed);
	this._emitQueueUpdate();
	const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
	if (images) {
		content.push(...images);
	}
	const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
	if (images?.length) markQueuedMessageImages(message);
	rememberLaneMessage(message, images);
	this._queueAgentMessage(message, "steer");
}

/**
 * Internal: Queue a follow-up message (already expanded, no extension command check). `typed` is as for `_queueSteer`.
 */
export async function _queueFollowUp(
	this: AgentSession,
	text: string,
	images?: ImageContent[],
	typed?: string,
): Promise<void> {
	assertSessionOpen(this);
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner._queueFollowUp(text, images, typed);
	this._followUpMessages.push(text);
	rememberTypedQueuedText(this, "followUp", text, typed);
	this._emitQueueUpdate();
	const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
	if (images) {
		content.push(...images);
	}
	const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
	if (images?.length) markQueuedMessageImages(message);
	rememberLaneMessage(message, images);
	this._queueAgentMessage(message, "followUp");
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
	return deliveredMessageTurn(this, () => {
		const waking = wakeIdleSessionForHeartbeat(this, options);
		return waking
			? waking.then(() => admittedCustomMessage.call(this, message, options))
			: admittedCustomMessage.call(this, message, options);
	});
}

/**
 * A delivered message starts this session's turn, so the turn runs under this session's own resource admission, or
 * none: never under the scope its sender runs in, such as the workflow run whose notice or stage message it is.
 */
function deliveredMessageTurn<T>(session: AgentSession, deliver: () => Promise<T>): Promise<T> {
	return withOwnResourceAdmission(session._resourceAdmission, () => trackSessionWork(session, deliver));
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
	return deliveredMessageTurn(this, () => {
		const waking = wakeIdleSessionForHeartbeat(this, options);
		return waking
			? waking.then(() => admittedCustomMessages.call(this, messages, options))
			: admittedCustomMessages.call(this, messages, options);
	});
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

export async function _appendCustomMessage<T>(this: AgentSession, message: CustomMessage<T>): Promise<void> {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) {
		await owner._appendCustomMessage(message);
		return;
	}
	const stageAdmissionMessage = message as StageAdmittedCustomMessage;
	const entryId = await this.sessionManager.appendCustomMessageEntry(
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

const pendingCustomMessageDrains = new WeakMap<AgentSession, Promise<void>>();

/**
 * Append context-only custom messages once the current turn's tool results are in history. Within a run, a message
 * that cannot be saved stops the run like any other unsaved message (#4254): it is reported once and stays buffered
 * for the next prompt, and the stopped run saves nothing more.
 */
export function _flushPendingCustomMessages(this: AgentSession, withinRun = false): Promise<void> {
	const pending = pendingCustomMessageDrains.get(this);
	if (pending) return pending;
	if (this._pendingCustomMessages.length === 0) return Promise.resolve();
	if (withinRun && this._persistenceFailure !== undefined) return Promise.resolve();

	const drain = (async () => {
		while (this._pendingCustomMessages.length > 0) {
			const message = this._pendingCustomMessages[0];
			try {
				await this._appendCustomMessage(message);
			} catch (error) {
				// A listener that throws after the message was saved is no save failure; it still fails the turn.
				if (!withinRun || this._entryIdsByMessage.has(message)) throw error;
				recordPersistenceFailure(this, message, error);
				return;
			}
			this._pendingCustomMessages.shift();
		}
	})();
	pendingCustomMessageDrains.set(this, drain);
	void drain.then(
		() => pendingCustomMessageDrains.delete(this),
		() => pendingCustomMessageDrains.delete(this),
	);
	return drain;
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
	await waitForCustomMessagePreparation(session);
	if (session.isStreaming || session._isPreparingRun) {
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
	if (session._queuedMessagesPaused || holdsTurnsForDetachedResults(session)) {
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
export function clearQueue(this: AgentSession, options?: ClearQueueOptions): ClearedQueue {
	const owner = resolveWorkflowStageDeliveryTarget(this);
	if (owner !== this) return owner.clearQueue(options);
	// Input held while the session compacts goes back to the caller too, and is never sent. It is held as typed.
	const held = cancelHeldInput(this);
	const steering = [...this._steeringMessages, ...held.steering];
	const followUp = [...this._followUpMessages, ...held.followUp];
	const typed = {
		steering: [...this._steeringMessages.map((text) => forgetTypedQueuedText(this, "steer", text)), ...held.steering],
		followUp: [
			...this._followUpMessages.map((text) => forgetTypedQueuedText(this, "followUp", text)),
			...held.followUp,
		],
	};
	const retyped =
		typed.steering.some((text, index) => text !== steering[index]) ||
		typed.followUp.some((text, index) => text !== followUp[index]);
	forgetAllTypedQueuedTexts(this);
	const queuedSteering = this._steeringMessages;
	const queuedFollowUp = this._followUpMessages;
	this._steeringMessages = [];
	this._followUpMessages = [];
	const removed = this._drainQueuedAgentMessages();
	const hold = this._activeInterruptQueueHold;
	if (hold !== undefined) {
		removed.steering.push(...hold.steering.splice(0));
		removed.followUp.push(...hold.followUp.splice(0));
		priorityHoldCounts.delete(hold);
	}
	const images = {
		steering: [...queuedTextImages(queuedSteering, removed.steering), ...held.images.steering],
		followUp: [...queuedTextImages(queuedFollowUp, removed.followUp), ...held.images.followUp],
	};
	const withImages = [...images.steering, ...images.followUp].some((entry) => entry !== undefined);
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
	return {
		steering,
		followUp,
		...(retyped ? { typed } : {}),
		...(withImages ? { images } : {}),
	};
}

/** Number of pending messages (includes both steering and follow-up) */
export function getSteeringMessages(this: AgentSession): readonly string[] {
	const held = heldInputView(this).steering;
	return held.length === 0 ? this._steeringMessages : [...this._steeringMessages, ...held];
}

/** Get pending follow-up messages (read-only) */
export function getFollowUpMessages(this: AgentSession): readonly string[] {
	const held = heldInputView(this).followUp;
	return held.length === 0 ? this._followUpMessages : [...this._followUpMessages, ...held];
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
