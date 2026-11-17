import { resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import { holdsTurnsForDetachedResults } from "./agent-session-detached-tools.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import {
	admitProtectedStreamingCustomMessage,
	customMessageOccurrences,
	queueHeldCustomMessages,
	queueProtectedStreamingCustomMessage,
	queueProtectedStreamingCustomMessages,
	triggerProtectedStreamingCustomMessages,
} from "./agent-session-persistent-custom-messages.ts";
import { deliverQueuedInputIfIdle } from "./agent-session-prompt.ts";
import type { SendMessageOptions, SendMessagesOptions } from "./extensions/index.js";
import type { CustomMessage, StageAdmittedCustomMessage } from "./messages.ts";
import { TASK_COMPLETION_MESSAGE_TYPE } from "./tasks/completion.js";

async function appendDurableStageAdmission<T>(session: AgentSession, message: CustomMessage<T>): Promise<void> {
	await session._appendCustomMessage(message);
}

/** Cancel only the receiver's native operation; its original prompt owns continuation. */
async function commitPriorityMessage(session: AgentSession, message: CustomMessage): Promise<void> {
	session._priorityInterruptPending = true;
	session._ensureActiveInterruptQueueHold();
	if (!session._queuedMessagesPaused) {
		session.abortRetry();
		session.agent.abort();
	}
	await queueProtectedStreamingCustomMessage(session, message, "steer", true);
	if (
		!session.isStreaming &&
		session._activePromptCount === 0 &&
		!session._queuedMessagesPaused &&
		!session._subagentMessageAdmission
	) {
		// Idle stage chat has no original prompt awaiter. Start one owned drain,
		// without replaying the stage task or a completed tool call.
		const turn = session._runAgentPrompt([], undefined, undefined, false, message);
		session._workflowStageAdmission?.trackAdmittedWork(turn);
		void turn.catch(() => {});
	}
	startTurnAfterInterrupt(session, message);
}

/**
 * #3919: before a fresh stage's own prompt is submitted, turn-starting input is that prompt's startup context.
 * Once the prompt is in preflight, a run has started, or queued input is paused, the ordinary admission paths
 * own ordering. The stage's own task completions follow its own work, so they never precede its prompt.
 */
function holdsForFirstStagePrompt<T>(
	session: AgentSession,
	message: CustomMessage<T>,
	options: SendMessageOptions | undefined,
): boolean {
	return (
		session._workflowStageAwaitingFirstPrompt &&
		session._activePromptCount === 0 &&
		!session._queuedMessagesPaused &&
		message.customType !== TASK_COMPLETION_MESSAGE_TYPE &&
		options?.triggerTurn === true &&
		options.excludeFromContext !== true &&
		options.deliverAs !== "nextTurn"
	);
}

/**
 * #3919: once the stage prompt is submitted but before it owns a run (its input hooks), a turn-starting
 * message must not start a competing turn. It queues behind the pending prompt; interrupts keep their own path.
 */
function queuesBehindFirstStagePrompt(session: AgentSession, options: SendMessageOptions | undefined): boolean {
	return (
		session._workflowStageAwaitingFirstPrompt &&
		session._activePromptCount > 0 &&
		!session._queuedMessagesPaused &&
		options?.triggerTurn === true &&
		options.excludeFromContext !== true &&
		options.deliverAs !== "nextTurn" &&
		options.deliverAs !== "interrupt"
	);
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
	session._workflowStageAdmission?.trackAdmittedWork(turn);
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
export async function commitAdmittedCustomMessage<T>(
	session: AgentSession,
	appMessage: CustomMessage<T>,
	options?: SendMessageOptions,
): Promise<void> {
	const owner = resolveWorkflowStageDeliveryTarget(session);
	if (owner !== session) return commitAdmittedCustomMessage(owner, appMessage, options);
	const self = session;
	if (holdsForFirstStagePrompt(self, appMessage, options)) {
		await appendDurableStageAdmission(self, appMessage);
		return;
	}
	const useProtectedReconciliation =
		options?.persistWhenStreaming === true &&
		options.excludeFromContext !== true &&
		(options.triggerTurn === true || options.stageAdmissionKey !== undefined);
	if (queuesBehindFirstStagePrompt(self, options)) {
		const delivery = options?.deliverAs === "followUp" ? "followUp" : "steer";
		if (useProtectedReconciliation) await queueProtectedStreamingCustomMessage(self, appMessage, delivery);
		else self._queueAgentMessage(appMessage, delivery);
		return;
	}
	if (
		useProtectedReconciliation &&
		options?.triggerTurn &&
		options.deliverAs === "interrupt" &&
		(self._subagentMessageAdmission || self._workflowStageAdmission)
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
		self._workflowStageAdmission?.trackAdmittedWork(interrupt);
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
	} else if (useProtectedReconciliation && options?.triggerTurn === true && self._workflowStageAdmission) {
		await queueProtectedStreamingCustomMessage(
			self,
			appMessage,
			options?.deliverAs === "followUp" ? "followUp" : "steer",
		);
		const turn = self._runAgentPrompt([], undefined, undefined, false, appMessage);
		self._workflowStageAdmission.trackAdmittedWork(turn);
		void turn.catch(() => {});
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
		const turn = self._runAgentPrompt(promptMessage, resolveAdmission);
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
export async function commitAdmittedCustomMessages<T>(
	session: AgentSession,
	appMessages: CustomMessage<T>[],
	options?: SendMessagesOptions,
): Promise<void> {
	const owner = resolveWorkflowStageDeliveryTarget(session);
	if (owner !== session) return commitAdmittedCustomMessages(owner, appMessages, options);
	const self = session;
	appMessages = customMessageOccurrences(appMessages);
	const useProtectedReconciliation =
		options?.persistWhenStreaming === true && options.triggerTurn === true && options.excludeFromContext !== true;
	const holdsTurn =
		self._queuedMessagesPaused ||
		(self._subagentPolicy?.executionEnded !== undefined && options?.triggerTurn === true);
	const usesHeldCards =
		options?.triggerTurn === true &&
		(holdsTurnsForDetachedResults(self) || (holdsTurn && options.excludeFromContext === true));
	const holdsStartupCards = appMessages.every((item) => holdsForFirstStagePrompt(self, item, options));
	if (holdsStartupCards || (!useProtectedReconciliation && !usesHeldCards)) {
		const stored = new Set(
			self.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom_message" && entry.stageAdmissionKey !== undefined
						? [entry.stageAdmissionKey]
						: [],
				),
		);
		appMessages = appMessages.filter((message) => {
			const key = (message as StageAdmittedCustomMessage).stageAdmissionKey;
			return key === undefined || !stored.has(key);
		});
	}
	if (appMessages.length === 0) return;
	if (holdsStartupCards) {
		for (const item of appMessages) await appendDurableStageAdmission(self, item);
		return;
	}
	const delivery = options?.deliverAs === "followUp" ? "followUp" : "steer";
	if (queuesBehindFirstStagePrompt(self, options)) {
		if (useProtectedReconciliation) await queueProtectedStreamingCustomMessages(self, appMessages, delivery);
		else for (const item of appMessages) self._queueAgentMessage(item, delivery);
		return;
	}
	if (options?.deliverAs === "nextTurn") {
		self._pendingNextTurnMessages.push(...appMessages);
	} else if (holdsTurn) {
		if (options?.triggerTurn === true) {
			let queued = true;
			if (useProtectedReconciliation || holdsTurnsForDetachedResults(self) || options.excludeFromContext === true) {
				queued = (await queueHeldCustomMessages(self, appMessages, delivery)) > 0;
				if (queued) startTurnIfPauseReleasedDuringAdmission(self, appMessages[0]!);
			} else {
				for (const item of appMessages) self._queueAgentMessage(item, delivery);
			}
			if (queued) startTurnAfterInterrupt(self, appMessages[0]!);
		} else if (self.isStreaming || self._isPreparingRun) {
			self._pendingCustomMessages.push(...appMessages);
		} else {
			for (const item of appMessages) await self._appendCustomMessage(item);
		}
	} else if (
		(self.isStreaming || self._isPreparingRun) &&
		options?.excludeFromContext === true &&
		options.triggerTurn !== true &&
		options.deliverAs === undefined
	) {
		for (const item of appMessages) await self._appendCustomMessage(item);
	} else if ((self.isStreaming || self._isPreparingRun) && options?.triggerTurn === false) {
		self._pendingCustomMessages.push(...appMessages);
	} else if ((self.isStreaming || self._isPreparingRun) && useProtectedReconciliation) {
		await queueProtectedStreamingCustomMessages(self, appMessages, delivery);
		if (!self.isStreaming) deliverQueuedInputIfIdle(self);
	} else if ((self.isStreaming || self._isPreparingRun) && options?.persistWhenStreaming === true) {
		for (const item of appMessages) await self._appendCustomMessage(item);
	} else if ((self.isStreaming || self._isPreparingRun) && options?.triggerTurn !== false) {
		for (const item of appMessages) self._queueAgentMessage(item, delivery);
	} else if (options?.triggerTurn) {
		if (useProtectedReconciliation) {
			await triggerProtectedStreamingCustomMessages(self, appMessages, delivery);
		} else {
			const held = holdsTurnsForDetachedResults(self);
			const turn = self._runAgentPrompt(appMessages);
			if (held) await turn;
			else void turn.catch(() => {});
		}
	} else {
		for (const item of appMessages) await self._appendCustomMessage(item);
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
