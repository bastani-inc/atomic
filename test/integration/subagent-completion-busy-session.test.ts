import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import { PROTECTED_RECONCILIATION_CUSTOM_TYPE } from "../../packages/coding-agent/src/core/agent-session-persistent-custom-messages.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";

test("busy stage sessions commit visible subagent completions and parent turns before acknowledging them (#3427)", async () => {
	const release = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name: "hold",
		label: "Hold",
		description: "Hold the parent turn while external notices arrive",
		parameters: Type.Object({}),
		execute: async () => {
			await release.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [tool] });
	const boundary = new WorkflowStageAdmissionBoundary();
	(
		harness.session as AgentSession & { _workflowStageAdmission?: WorkflowStageAdmissionBoundary }
	)._workflowStageAdmission = boundary;
	boundary.bindTaskIdentity(harness.sessionManager.getSessionId(), "busy-run", "busy-stage");
	try {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 30 }, () => fauxAssistantMessage("Parent processed incoming notices")),
		]);
		const startedTool = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const prompt = harness.session.prompt("start busy turn");
		await startedTool;
		const host = harness.session.getAgentTaskHost();
		const completions: string[] = [];
		const gates: PromiseWithResolvers<TaskResult>[] = [];
		for (let index = 0; index < 3; index++) {
			const gate = Promise.withResolvers<TaskResult>();
			gates.push(gate);
			const started = await host.startAgentTask(
				{ kind: "agent", agent: "worker", task: `busy task ${index}` },
				`busy-${index}` as OperationId,
				() => ({ result: gate.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) }),
			);
			assert.ok(started.ok);
			completions.push(`completion-${started.value.taskId}`);
			await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
		}
		const notices: Promise<void>[] = [];
		for (let index = 0; index < 6; index++) {
			for (const customType of ["workflow-heartbeat", "intercom_message"]) {
				notices.push(
					harness.session.sendCustomMessage(
						{ customType, content: `${customType} ${index}`, display: true, details: { index } },
						{ triggerTurn: true, persistWhenStreaming: true, stageAdmissionKey: `${customType}:${index}` },
					),
				);
			}
			if (index === 2)
				for (const gate of gates) gate.resolve({ kind: "failed", code: "fixture", message: "completed busy task" });
		}
		await Promise.all(notices);
		await vi.waitFor(() =>
			assert.equal(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "task-completion-ack").length,
				completions.length,
			),
		);
		const entries = harness.sessionManager.getEntries();
		for (const completionId of completions) {
			const intentIndex = entries.findIndex(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "task-completion-intent" &&
					(entry.data as { completionId: string }).completionId === completionId,
			);
			const cardIndex = entries.findIndex(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "task-completion" &&
					entry.stageAdmissionKey === completionId,
			);
			const ackIndex = entries.findIndex(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "task-completion-ack" &&
					(entry.data as { completionId: string }).completionId === completionId,
			);
			assert.ok(intentIndex >= 0, "completion intent is retained");
			assert.ok(cardIndex > intentIndex, "visible completion must be committed after intent");
			assert.ok(ackIndex > cardIndex, "acknowledgment must follow the visible completion");
			const card = entries[cardIndex]!;
			assert.ok(card.type === "custom_message" && card.display && card.protectedReconciliation);
			assert.equal(
				harness
					.eventsOfType("message_end")
					.filter(
						(event) =>
							event.message.role === "custom" &&
							event.message.customType === "task-completion" &&
							(event.message.details as { completionId: string }).completionId === completionId,
					).length,
				1,
			);
		}
		release.resolve();
		await prompt;
		await vi.waitFor(() => {
			const persisted = harness.sessionManager.getEntries();
			for (const completionId of completions) {
				const card = persisted.find(
					(entry) => entry.type === "custom_message" && entry.stageAdmissionKey === completionId,
				);
				assert.ok(card);
				assert.ok(
					persisted.some(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === PROTECTED_RECONCILIATION_CUSTOM_TYPE &&
							(entry.details as { protectedReconciliationOf: string }).protectedReconciliationOf === card.id,
					),
					"parent turn consumed the completion context",
				);
			}
		});
		assert.ok(
			harness
				.eventsOfType("message_end")
				.some(
					(event) =>
						event.message.role === "assistant" &&
						event.message.content.some(
							(block) => block.type === "text" && block.text === "Parent processed incoming notices",
						),
				),
		);
	} finally {
		release.resolve();
		await harness.cleanup();
	}
});
