import type { SendMessageOptions, SendMessagesOptions } from "./extensions/index.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import type { CustomMessage } from "./messages.ts";
import { resolveWorkflowStageDeliveryTarget } from "./agent-session-delivery-forwarding.ts";
import {
	admitProtectedStreamingCustomMessage,
	queueProtectedStreamingCustomMessage,
} from "./agent-session-persistent-custom-messages.ts";

/** Commit one delivery whose source generation already granted admission. */
export async function commitAdmittedCustomMessage<T>(
  session: AgentSession,
  appMessage: CustomMessage<T>,
  options?: SendMessageOptions,
): Promise<void> {
	const owner = resolveWorkflowStageDeliveryTarget(session);
	if (owner !== session) return commitAdmittedCustomMessage(owner, appMessage, options);
	const self = session;
	const useProtectedReconciliation = options?.persistWhenStreaming === true &&
		options.triggerTurn === true &&
		options.excludeFromContext !== true;
	if (options?.deliverAs === "nextTurn") {
		self._pendingNextTurnMessages.push(appMessage);
	} else if (self._queuedMessagesPaused) {
		if (options?.triggerTurn === true) {
			const delivery = options.deliverAs === "followUp" ? "followUp" : "steer";
			const heldMessage = useProtectedReconciliation
				? await admitProtectedStreamingCustomMessage(self, appMessage, delivery)
				: appMessage;
			self._queueAgentMessage(heldMessage, delivery);
		} else {
			self._appendCustomMessage(appMessage);
		}
	} else if (options?.deliverAs === "interrupt" && options.triggerTurn) {
		const interrupt = self._enqueueInterruptCustomMessage(appMessage, options);
		self._workflowStageAdmission?.trackAdmittedWork(interrupt);
		void interrupt.catch(() => {});
	} else if (self.isStreaming && options?.excludeFromContext === true && options.triggerTurn !== true && options.deliverAs === undefined) {
		self._appendCustomMessage(appMessage);
	} else if (self.isStreaming && useProtectedReconciliation) {
		await queueProtectedStreamingCustomMessage(
			self,
			appMessage,
			options?.deliverAs === "followUp" ? "followUp" : "steer",
		);
	} else if (self.isStreaming && options?.persistWhenStreaming === true) {
		self._appendCustomMessage(appMessage);
	} else if (self.isStreaming) {
		self._queueAgentMessage(appMessage, options?.deliverAs === "followUp" ? "followUp" : "steer");
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
			self._queueAgentMessage(
				promptMessage,
				options.deliverAs === "followUp" ? "followUp" : "steer",
			);
			return;
		}
		let resolveAdmission!: () => void;
		const admission = new Promise<void>((resolve) => { resolveAdmission = resolve; });
		const turn = self._runAgentPrompt(promptMessage, resolveAdmission);
		await Promise.race([admission, turn]);
	} else {
		self._appendCustomMessage(appMessage);
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
	if (options?.deliverAs === "nextTurn") {
		self._pendingNextTurnMessages.push(...appMessages);
	} else if (self._queuedMessagesPaused) {
		if (options?.triggerTurn === true) {
			const delivery = options.deliverAs === "followUp" ? "followUp" : "steer";
			for (const item of appMessages) self._queueAgentMessage(item, delivery);
		} else {
			for (const item of appMessages) self._appendCustomMessage(item);
		}
	} else if (self.isStreaming && options?.excludeFromContext === true && options.triggerTurn !== true && options.deliverAs === undefined) {
		for (const item of appMessages) self._appendCustomMessage(item);
	} else if (self.isStreaming) {
		const delivery = options?.deliverAs === "followUp" ? "followUp" : "steer";
		for (const item of appMessages) self._queueAgentMessage(item, delivery);
	} else if (options?.triggerTurn) {
		const turn = self._runAgentPrompt(appMessages);
		void turn.catch(() => {});
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
