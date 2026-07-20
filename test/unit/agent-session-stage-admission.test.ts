import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { closeWorkflowStageGeneration, sendCustomMessage, transferWorkflowStageDeliveriesTo } from "../../packages/coding-agent/src/core/agent-session-message-queue.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";

function harness(withRouter = true) {
	const stage: string[] = [];
	const external: string[] = [];
	const surface = {
		_workflowStageAdmission: new WorkflowStageAdmissionBoundary(),
		_orchestrationContext: withRouter ? {
			lateMessageRouter: {
				routeMessage(message: { content?: string | object[] }) {
					if (typeof message.content === "string") external.push(message.content);
				},
			},
		} : {},
		isStreaming: true,
		_pendingNextTurnMessages: [],
		_queueAgentMessage(message: { content: string | object[] }) {
			if (typeof message.content === "string") stage.push(message.content);
		},
		_appendCustomMessage() {},
		async _enqueueInterruptCustomMessage() {},
		async _runAgentPrompt() {},
		agent: { async waitForIdle() {} },
		_agentEventQueue: Promise.resolve(),
	};
	const send = (content: string, key: string) => sendCustomMessage.call(surface as never, {
		customType: "intercom_message",
		content,
		display: true,
	}, { triggerTurn: true, deliverAs: "followUp", stageAdmissionKey: key });
	const close = () => closeWorkflowStageGeneration.call(surface as never);
	return { stage, external, send, close };
}

describe("AgentSession workflow-stage admission", () => {
	test("an Intercom message admitted during streaming uses the native stage queue", async () => {
		const current = harness();
		await current.send("received during structured_output", "intercom:message-1");
		await current.close();

		assert.deepEqual(current.stage, ["received during structured_output"]);
		assert.deepEqual(current.external, []);
	});

	test("late detached delivery routes externally without terminal stage mutation or duplication", async () => {
		const current = harness();
		await current.close();
		await current.send("late completion", "async-job:job-1");
		await current.send("late completion", "async-job:job-1");

		assert.deepEqual(current.stage, []);
		assert.deepEqual(current.external, ["late completion"]);
	});

	test("a missing external router fails loudly and leaves the delivery retryable", async () => {
		const current = harness(false);
		await current.close();

		await assert.rejects(current.send("late completion", "async-job:job-1"), /closed without a late-message router/);
		await assert.rejects(current.send("late completion", "async-job:job-1"), /closed without a late-message router/);
		assert.deepEqual(current.stage, []);
	});

	test("idle stage notification starts a native turn and close waits for it", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const processed: string[] = [];
		const surface = {
			_workflowStageAdmission: new WorkflowStageAdmissionBoundary(),
			_orchestrationContext: {},
			isStreaming: false,
			_pendingNextTurnMessages: [],
			_queueAgentMessage() {},
			_appendCustomMessage() {},
			async _enqueueInterruptCustomMessage() {},
			async _runAgentPrompt(message: { content: string | object[] }) {
				started.resolve();
				await release.promise;
				if (typeof message.content === "string") processed.push(message.content);
			},
			agent: { async waitForIdle() {} },
			_agentEventQueue: Promise.resolve(),
		};

		const delivery = sendCustomMessage.call(surface as never, {
			customType: "async-job-result", content: "finished", display: true,
		}, { triggerTurn: true, stageAdmissionKey: "async-job:job-1" });
		await started.promise;
		let closed = false;
		const closing = closeWorkflowStageGeneration.call(surface as never).then(() => { closed = true; });
		await Promise.resolve();
		assert.equal(closed, false);
		release.resolve();
		await Promise.all([delivery, closing]);
		assert.deepEqual(processed, ["finished"]);
	});

	test("custom-message completion is an admission receipt rather than model-turn completion", async () => {
		const turn = Promise.withResolvers<void>();
		const admitted: string[] = [];
		const surface = {
			_workflowStageAdmission: undefined,
			isStreaming: false,
			_pendingNextTurnMessages: [],
			_queueAgentMessage() {}, _appendCustomMessage() {}, async _enqueueInterruptCustomMessage() {},
			_runAgentPrompt(message: { content: string | object[] }, started?: () => void) { if (typeof message.content === "string") admitted.push(message.content); started?.(); return turn.promise; },
		};

		await sendCustomMessage.call(surface as never, {
			customType: "intercom_message", content: "accepted", display: true,
		}, { triggerTurn: true });
		assert.deepEqual(admitted, ["accepted"]);
		turn.reject(new Error("later model turn failure"));
		await Promise.resolve();
	});

	test("persistWhenStreaming persists a streaming custom message instead of a droppable steer", async () => {
		const steered: string[] = [];
		const persisted: string[] = [];
		const surface = {
			_workflowStageAdmission: undefined,
			isStreaming: true,
			_pendingNextTurnMessages: [],
			_queueAgentMessage(message: { content: string | object[] }) { if (typeof message.content === "string") steered.push(message.content); },
			_appendCustomMessage(message: { content: string | object[] }) { if (typeof message.content === "string") persisted.push(message.content); },
			async _enqueueInterruptCustomMessage() {},
			async _runAgentPrompt() {},
		};

		await sendCustomMessage.call(surface as never, {
			customType: "workflows:lifecycle-notice", content: "is blocked", display: true,
		}, { triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true });

		// Persisted to the transcript (durable/visible), not queued as a transient steer.
		assert.deepEqual(persisted, ["is blocked"]);
		assert.deepEqual(steered, []);
	});

	test("fallback replacement transfers already-admitted native queue entries", () => {
		const notification = { role: "custom", customType: "async-job-result", content: "done", display: true, timestamp: 1 };
		const restored: object[] = [];
		let managerTransferred = false;
		const target = {
			_asyncJobManagerSessionId: Symbol("target"),
			_asyncJobManager: {},
			_pendingNextTurnMessages: [] as object[],
			async sendCustomMessage() {},
			_restoreQueuedAgentMessages(queues: { steering: object[]; followUp: object[] }) {
				restored.push(...queues.steering, ...queues.followUp);
			},
		};
		const source = {
			_asyncJobManagerSessionId: Symbol("source"),
			_asyncJobManager: { transferSessionDeliveries() { managerTransferred = true; } },
			_activeInterruptQueueHold: undefined,
			_pendingNextTurnMessages: [notification],
			_drainQueuedAgentMessages: () => ({ steering: [], followUp: [notification] }),
		};

		transferWorkflowStageDeliveriesTo.call(source as never, target);
		assert.deepEqual(restored, [notification]);
		assert.deepEqual(target._pendingNextTurnMessages, [notification]);
		assert.equal(managerTransferred, true);
	});
});
