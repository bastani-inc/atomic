import { resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import {
	admitProtectedStreamingCustomMessage,
	queueProtectedStreamingCustomMessage,
	queueProtectedStreamingCustomMessages,
	triggerProtectedStreamingCustomMessages,
} from "./agent-session-persistent-custom-messages.ts";
import type { SendMessageOptions, SendMessagesOptions } from "./extensions/index.js";
import type { CustomMessage, StageAdmittedCustomMessage } from "./messages.ts";

function appendDurableStageAdmission<T>(session: AgentSession, message: CustomMessage<T>): void {
	session._appendCustomMessage(message);
	if ((message as StageAdmittedCustomMessage).stageAdmissionKey !== undefined) session.sessionManager?.flush();
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
		const turn = session._runAgentPrompt([]);
		session._workflowStageAdmission?.trackAdmittedWork(turn);
		void turn.catch(() => {});
	}
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
	const useProtectedReconciliation =
		options?.persistWhenStreaming === true &&
		options.excludeFromContext !== true &&
		(options.triggerTurn === true || options.stageAdmissionKey !== undefined);
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
			if (useProtectedReconciliation) {
				await queueProtectedStreamingCustomMessage(self, appMessage, delivery);
			} else {
				self._queueAgentMessage(appMessage, delivery);
			}
		} else if (self.isStreaming) {
			self._pendingCustomMessages.push(appMessage);
		} else {
			appendDurableStageAdmission(self, appMessage);
		}
	} else if (options?.deliverAs === "interrupt" && options.triggerTurn) {
		const interrupt = self._enqueueInterruptCustomMessage(appMessage, options);
		self._workflowStageAdmission?.trackAdmittedWork(interrupt);
		void interrupt.catch(() => {});
	} else if (
		self.isStreaming &&
		options?.excludeFromContext === true &&
		options.triggerTurn !== true &&
		options.deliverAs === undefined
	) {
		appendDurableStageAdmission(self, appMessage);
	} else if (self.isStreaming && options?.triggerTurn === false) {
		self._pendingCustomMessages.push(appMessage);
	} else if (self.isStreaming && useProtectedReconciliation) {
		await queueProtectedStreamingCustomMessage(
			self,
			appMessage,
			options?.deliverAs === "followUp" ? "followUp" : "steer",
		);
	} else if (self.isStreaming && options?.persistWhenStreaming === true) {
		appendDurableStageAdmission(self, appMessage);
	} else if (self.isStreaming && options?.triggerTurn !== false) {
		self._queueAgentMessage(appMessage, options?.deliverAs === "followUp" ? "followUp" : "steer");
	} else if (useProtectedReconciliation && options?.triggerTurn === true && self._workflowStageAdmission) {
		await queueProtectedStreamingCustomMessage(
			self,
			appMessage,
			options?.deliverAs === "followUp" ? "followUp" : "steer",
		);
		const turn = self._runAgentPrompt([]);
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
		// Durable admission may yield while another turn takes ownership.
		if (useProtectedReconciliation && self.isStreaming) {
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
		appendDurableStageAdmission(self, appMessage);
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
	const useProtectedReconciliation =
		options?.persistWhenStreaming === true && options.triggerTurn === true && options.excludeFromContext !== true;
	const delivery = options?.deliverAs === "followUp" ? "followUp" : "steer";
	if (options?.deliverAs === "nextTurn") {
		self._pendingNextTurnMessages.push(...appMessages);
	} else if (
		self._queuedMessagesPaused ||
		(self._subagentPolicy?.executionEnded !== undefined && options?.triggerTurn)
	) {
		if (options?.triggerTurn === true) {
			if (useProtectedReconciliation) {
				await queueProtectedStreamingCustomMessages(self, appMessages, delivery);
			} else {
				for (const item of appMessages) self._queueAgentMessage(item, delivery);
			}
		} else if (self.isStreaming) {
			self._pendingCustomMessages.push(...appMessages);
		} else {
			for (const item of appMessages) self._appendCustomMessage(item);
		}
	} else if (
		self.isStreaming &&
		options?.excludeFromContext === true &&
		options.triggerTurn !== true &&
		options.deliverAs === undefined
	) {
		for (const item of appMessages) self._appendCustomMessage(item);
	} else if (self.isStreaming && options?.triggerTurn === false) {
		self._pendingCustomMessages.push(...appMessages);
	} else if (self.isStreaming && useProtectedReconciliation) {
		await queueProtectedStreamingCustomMessages(self, appMessages, delivery);
	} else if (self.isStreaming && options?.persistWhenStreaming === true) {
		for (const item of appMessages) self._appendCustomMessage(item);
	} else if (self.isStreaming && options?.triggerTurn !== false) {
		for (const item of appMessages) self._queueAgentMessage(item, delivery);
	} else if (options?.triggerTurn) {
		if (useProtectedReconciliation) {
			await triggerProtectedStreamingCustomMessages(self, appMessages, delivery);
		} else {
			const turn = self._runAgentPrompt(appMessages);
			void turn.catch(() => {});
		}
	} else {
		for (const item of appMessages) self._appendCustomMessage(item);
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
