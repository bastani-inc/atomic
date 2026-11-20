import { holdsTurnsForDetachedResults } from "./agent-session-detached-tools.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { keepRefusedInput } from "./agent-session-persistence-failures.ts";
import {
	admitProtectedStreamingCustomMessage,
	customMessageOccurrences,
	hasUncertainCustomMessageWrite,
	queueHeldCustomMessages,
	queueProtectedStreamingCustomMessage,
	queueProtectedStreamingCustomMessages,
	refreshFailedCustomMessageWrites,
	triggerProtectedStreamingCustomMessages,
} from "./agent-session-persistent-custom-messages.ts";
import { deliverQueuedInputIfIdle } from "./agent-session-prompt.ts";
import { abortTurnRetries } from "./agent-session-retry.ts";
import type { SendMessageOptions, SendMessagesOptions } from "./extensions/index.js";
import type { CustomMessage, StageAdmittedCustomMessage } from "./messages.ts";

/**
 * Saves messages that nothing else holds. #5135: those that the halt after another writer's entries refuses stay
 * shown and recoverable in the session, not only with their sender.
 */
async function appendSentCustomMessages(session: AgentSession, messages: readonly CustomMessage[]): Promise<void> {
	for (const [index, message] of messages.entries()) {
		try {
			await session._appendCustomMessage(message);
		} catch (error) {
			const halt = session.sessionManager.getAppendHalt();
			if (halt !== undefined && error === halt) {
				for (const refused of messages.slice(index)) keepRefusedInput(session, refused, halt);
			}
			throw error;
		}
	}
}

async function appendDurableStageAdmission<T>(session: AgentSession, message: CustomMessage<T>): Promise<void> {
	await appendSentCustomMessages(session, [message]);
}

const pendingCustomMessageRetries = new WeakMap<AgentSession["sessionManager"], Map<string, Promise<void>>>();

function coalesceUncertainCustomMessageCommit(
	session: AgentSession,
	messages: CustomMessage[],
	commit: () => Promise<void>,
): Promise<void> | undefined {
	const keys = messages.flatMap((message) => {
		const key = (message as StageAdmittedCustomMessage).stageAdmissionKey;
		return key === undefined ? [] : [key];
	});
	if (keys.length === 0 || keys.length !== messages.length) return undefined;
	const manager = session.sessionManager;
	const signature = JSON.stringify(keys);
	const pending = pendingCustomMessageRetries.get(manager) ?? new Map<string, Promise<void>>();
	const existing = pending.get(signature);
	if (existing !== undefined) return existing;
	if (!keys.some((key) => hasUncertainCustomMessageWrite(manager, key))) return undefined;
	const completion = commit();
	pending.set(signature, completion);
	pendingCustomMessageRetries.set(manager, pending);
	const clear = () => {
		if (pending.get(signature) === completion) pending.delete(signature);
		if (pending.size === 0) pendingCustomMessageRetries.delete(manager);
	};
	void completion.then(clear, clear);
	return completion;
}

function recoverUncertainCustomMessage<T>(
	session: AgentSession,
	message: CustomMessage<T>,
): Promise<boolean> | undefined {
	const key = (message as StageAdmittedCustomMessage).stageAdmissionKey;
	if (key === undefined || !hasUncertainCustomMessageWrite(session.sessionManager, key)) return undefined;
	return (async () => {
		await refreshFailedCustomMessageWrites(session);
		const stored = session.sessionManager
			.getBranch()
			.some(
				(entry) =>
					entry.type === "custom_message" &&
					entry.stageAdmissionKey === key &&
					entry.protectedReconciliation === undefined,
			);
		if (!stored) return false;
		await session._appendCustomMessage(message);
		return true;
	})();
}

/** Cancel only the receiver's native operation; its original prompt owns continuation. */
async function commitPriorityMessage(session: AgentSession, message: CustomMessage): Promise<void> {
	session._priorityInterruptPending = true;
	session._ensureActiveInterruptQueueHold();
	if (!session._queuedMessagesPaused) {
		abortTurnRetries.call(session);
		session.agent.abort();
	}
	await queueProtectedStreamingCustomMessage(session, message, "steer", true);
	startTurnAfterInterrupt(session, message);
}

/**
 * A protected delivery accepted while queued input is paused writes its durable card before it queues the hidden
 * turn. A resume during that write releases a hold that does not contain it yet and reports no released work, so
 * nothing would ever start the turn. Start it here, as an idle delivery after the resume would have.
 */
function startTurnIfPauseReleasedDuringAdmission(session: AgentSession, starter: CustomMessage): void {
	if (session._queuedMessagesPaused || session._subagentPolicy?.executionEnded !== undefined) return;
	if (session.isStreaming || session._isPreparingRun || session._activePromptCount > 0) return;
	const turn = session._runAgentPrompt([], undefined, undefined, false, starter);
	void turn.catch(() => {});
}

/**
 * #5224: a child whose turn the user interrupted from its chat waits for their next message, and that message starts
 * its next turn instead of only queueing for a task prompt that has already ended.
 */
function startTurnAfterInterrupt(session: AgentSession, starter: CustomMessage): void {
	if (!session._awaitingMessageAfterInterrupt || session._queuedMessagesPaused) return;
	if (session.isStreaming || session._isPreparingRun || session._activePromptCount > 0) return;
	session._awaitingMessageAfterInterrupt = false;
	const turn = session._runAgentPrompt([], undefined, undefined, false, starter);
	void turn.catch(() => {});
}

/** Commit one delivery whose source generation already granted admission. */
/** Starts a turn this commit awaits, so its preparation does not wait for the commit's own message delivery. */
function startAwaitedTurn(session: AgentSession, start: () => Promise<void>): Promise<void> {
	const boundary = session._subagentMessageAdmission;
	return boundary ? boundary.runAwaitedTurn(start) : start();
}

export function commitAdmittedCustomMessage<T>(
	session: AgentSession,
	appMessage: CustomMessage<T>,
	options?: SendMessageOptions,
): Promise<void> {
	const commit = () => commitCustomMessage(session, appMessage, options);
	return coalesceUncertainCustomMessageCommit(session, [appMessage], commit) ?? commit();
}

async function commitCustomMessage<T>(
	self: AgentSession,
	appMessage: CustomMessage<T>,
	options?: SendMessageOptions,
): Promise<void> {
	const recovery = recoverUncertainCustomMessage(self, appMessage);
	if (recovery !== undefined && (await recovery)) return;
	const useProtectedReconciliation =
		options?.persistWhenStreaming === true &&
		options.excludeFromContext !== true &&
		(options.triggerTurn === true || options.stageAdmissionKey !== undefined);
	if (
		useProtectedReconciliation &&
		options?.triggerTurn &&
		options.deliverAs === "interrupt" &&
		self._subagentMessageAdmission
	) {
		await commitPriorityMessage(self, appMessage);
		return;
	}
	if (options?.deliverAs === "nextTurn") {
		self._pendingNextTurnMessages.push(appMessage);
	} else if (
		self._queuedMessagesPaused ||
		// A child has one host-owned task prompt, including its asynchronous preflight.
		// Inbound context joins that execution; an idle SDK gap is not a new task.
		(self._subagentPolicy?.executionEnded !== undefined && options?.triggerTurn && options.deliverAs !== "interrupt")
	) {
		if (options?.triggerTurn === true) {
			const delivery = options.deliverAs === "followUp" ? "followUp" : "steer";
			let queued = true;
			if (useProtectedReconciliation || holdsTurnsForDetachedResults(self) || options.excludeFromContext === true) {
				queued = (await queueHeldCustomMessages(self, [appMessage], delivery)) > 0;
				if (queued) startTurnIfPauseReleasedDuringAdmission(self, appMessage);
			} else {
				self._queueAgentMessage(appMessage, delivery);
			}
			if (queued) startTurnAfterInterrupt(self, appMessage);
		} else if (self.isStreaming || self._isPreparingRun) {
			self._pendingCustomMessages.push(appMessage);
		} else {
			await appendDurableStageAdmission(self, appMessage);
		}
	} else if (options?.deliverAs === "interrupt" && options.triggerTurn) {
		const interrupt = self._enqueueInterruptCustomMessage(appMessage, options);
		void interrupt.catch(() => {});
	} else if (
		(self.isStreaming || self._isPreparingRun) &&
		options?.excludeFromContext === true &&
		options.triggerTurn !== true &&
		options.deliverAs === undefined
	) {
		await appendDurableStageAdmission(self, appMessage);
	} else if ((self.isStreaming || self._isPreparingRun) && options?.triggerTurn === false) {
		self._pendingCustomMessages.push(appMessage);
	} else if ((self.isStreaming || self._isPreparingRun) && useProtectedReconciliation) {
		await queueProtectedStreamingCustomMessage(
			self,
			appMessage,
			options?.deliverAs === "followUp" ? "followUp" : "steer",
		);
		// The durable card append can yield past the run's last queue drain.
		if (!self.isStreaming) deliverQueuedInputIfIdle(self);
	} else if ((self.isStreaming || self._isPreparingRun) && options?.persistWhenStreaming === true) {
		await appendDurableStageAdmission(self, appMessage);
	} else if ((self.isStreaming || self._isPreparingRun) && options?.triggerTurn !== false) {
		self._queueAgentMessage(appMessage, options?.deliverAs === "followUp" ? "followUp" : "steer");
	} else if (options?.triggerTurn) {
		const promptMessage = useProtectedReconciliation
			? await admitProtectedStreamingCustomMessage(
					self,
					appMessage,
					options?.deliverAs === "followUp" ? "followUp" : "steer",
				)
			: appMessage;
		if (promptMessage === undefined) return;
		// Durable admission may yield while another turn takes ownership.
		if (useProtectedReconciliation && (self.isStreaming || self._isPreparingRun)) {
			self._queueAgentMessage(promptMessage, options.deliverAs === "followUp" ? "followUp" : "steer");
			return;
		}
		let resolveAdmission!: () => void;
		const admission = new Promise<void>((resolve) => {
			resolveAdmission = resolve;
		});
		const turn = startAwaitedTurn(self, () => self._runAgentPrompt(promptMessage, resolveAdmission));
		try {
			await Promise.race([admission, turn]);
		} catch (error) {
			if (!useProtectedReconciliation) throw error;
			// The visible card is already durable. Retry only its hidden turn so
			// lifecycle delivery never appends a second card for this occurrence.
			self._queueAgentMessage(promptMessage, options?.deliverAs === "followUp" ? "followUp" : "steer");
			void self._continueQueuedAgentMessages().catch(() => {});
		}
	} else {
		await appendDurableStageAdmission(self, appMessage);
	}
}

export function _commitAdmittedCustomMessage<T>(
	this: AgentSession,
	appMessage: CustomMessage<T>,
	options?: SendMessageOptions,
): Promise<void> {
	return commitAdmittedCustomMessage(this, appMessage, options);
}

/** Commit a batch whose source generation already granted atomic admission. */
export function commitAdmittedCustomMessages<T>(
	session: AgentSession,
	appMessages: CustomMessage<T>[],
	options?: SendMessagesOptions,
): Promise<void> {
	appMessages = customMessageOccurrences(appMessages);
	const commit = () => commitCustomMessages(session, appMessages, options);
	return coalesceUncertainCustomMessageCommit(session, appMessages, commit) ?? commit();
}

async function commitCustomMessages<T>(
	self: AgentSession,
	appMessages: CustomMessage<T>[],
	options?: SendMessagesOptions,
): Promise<void> {
	const unrecovered: CustomMessage<T>[] = [];
	for (const message of appMessages) {
		const recovery = recoverUncertainCustomMessage(self, message);
		if (recovery === undefined || !(await recovery)) unrecovered.push(message);
	}
	appMessages = unrecovered;
	const useProtectedReconciliation =
		options?.persistWhenStreaming === true && options.triggerTurn === true && options.excludeFromContext !== true;
	const holdsTurn =
		self._queuedMessagesPaused ||
		(self._subagentPolicy?.executionEnded !== undefined && options?.triggerTurn === true);
	const usesHeldCards =
		options?.triggerTurn === true &&
		(holdsTurnsForDetachedResults(self) || (holdsTurn && options.excludeFromContext === true));
	const stored = new Set(
		self.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "custom_message" &&
				entry.stageAdmissionKey !== undefined &&
				((entry.protectedReconciliation === undefined && entry.excludeFromContext !== true) ||
					(!useProtectedReconciliation && !usesHeldCards))
					? [entry.stageAdmissionKey]
					: [],
			),
	);
	appMessages = appMessages.filter((message) => {
		const key = (message as StageAdmittedCustomMessage).stageAdmissionKey;
		return key === undefined || !stored.has(key) || hasUncertainCustomMessageWrite(self.sessionManager, key);
	});
	if (appMessages.length === 0) return;
	const delivery = options?.deliverAs === "followUp" ? "followUp" : "steer";
	if (options?.deliverAs === "nextTurn") {
		self._pendingNextTurnMessages.push(...appMessages);
	} else if (holdsTurn) {
		if (options?.triggerTurn === true) {
			if (useProtectedReconciliation || holdsTurnsForDetachedResults(self) || options.excludeFromContext === true) {
				let queued = false;
				try {
					await queueHeldCustomMessages(self, appMessages, delivery, {
						onQueued: () => {
							queued = true;
						},
						// A held batch that no turn reads now leaves a failed write's saved prefix to its retry or to recovery.
						queuesSavedPrefix: () =>
							self.isStreaming ||
							self._isPreparingRun !== false ||
							!(self._queuedMessagesPaused || self._subagentPolicy?.executionEnded !== undefined),
					});
				} finally {
					// A later card's failed write still wakes the saved prefix it queued.
					if (queued) {
						startTurnIfPauseReleasedDuringAdmission(self, appMessages[0]!);
						startTurnAfterInterrupt(self, appMessages[0]!);
					}
				}
			} else {
				for (const item of appMessages) self._queueAgentMessage(item, delivery);
				startTurnAfterInterrupt(self, appMessages[0]!);
			}
		} else if (self.isStreaming || self._isPreparingRun) {
			self._pendingCustomMessages.push(...appMessages);
		} else {
			await appendSentCustomMessages(self, appMessages);
		}
	} else if (
		(self.isStreaming || self._isPreparingRun) &&
		options?.excludeFromContext === true &&
		options.triggerTurn !== true &&
		options.deliverAs === undefined
	) {
		await appendSentCustomMessages(self, appMessages);
	} else if ((self.isStreaming || self._isPreparingRun) && options?.triggerTurn === false) {
		self._pendingCustomMessages.push(...appMessages);
	} else if ((self.isStreaming || self._isPreparingRun) && useProtectedReconciliation) {
		await queueProtectedStreamingCustomMessages(self, appMessages, delivery, {
			onQueued: () => {
				if (!self.isStreaming) deliverQueuedInputIfIdle(self);
			},
		});
	} else if ((self.isStreaming || self._isPreparingRun) && options?.persistWhenStreaming === true) {
		await appendSentCustomMessages(self, appMessages);
	} else if ((self.isStreaming || self._isPreparingRun) && options?.triggerTurn !== false) {
		for (const item of appMessages) self._queueAgentMessage(item, delivery);
	} else if (options?.triggerTurn) {
		if (useProtectedReconciliation) {
			await triggerProtectedStreamingCustomMessages(self, appMessages, delivery);
		} else {
			const held = holdsTurnsForDetachedResults(self);
			const turn = held
				? startAwaitedTurn(self, () => self._runAgentPrompt(appMessages))
				: self._runAgentPrompt(appMessages);
			if (held) await turn;
			else void turn.catch(() => {});
		}
	} else {
		await appendSentCustomMessages(self, appMessages);
	}
}

export function _commitAdmittedCustomMessages<T>(
	this: AgentSession,
	appMessages: CustomMessage<T>[],
	options?: SendMessagesOptions,
): Promise<void> {
	return commitAdmittedCustomMessages(this, appMessages, options);
}

export const agentSessionCustomMessageCommitMethods = {
	_commitAdmittedCustomMessage,
	_commitAdmittedCustomMessages,
};
