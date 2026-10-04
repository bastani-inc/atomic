import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { OperationId, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";

for (const restored of [false, true]) {
	test(`${restored ? "restored" : "live"} idle stage completions trigger parent turns without blocking subsequent notices (#3427)`, async () => {
		const manager = SessionManager.inMemory();
		let completionId = "idle-restored-completion";
		if (restored) {
			manager.appendCustomEntry("task-completion-intent", {
				completionId,
				ownerId: "previous-owner",
				taskId: "previous-task",
				terminalSequence: 7,
				result: { kind: "cancelled", cause: "user" },
				display: false,
			});
		}
		const harness = await createHarness({
			sessionManager: manager,
			orchestrationContext: {
				kind: "workflow-stage",
				workflowRunId: "idle-run",
				workflowStageId: "idle-stage",
				workflowStageName: "Idle stage",
				constraints: { disableWorkflowTool: true },
			},
		});
		harness.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("IDLE-PARENT-REPLY")));
		try {
			const host = harness.session.getAgentTaskHost();
			if (!restored) {
				const gate = Promise.withResolvers<TaskResult>();
				const started = await host.startAgentTask(
					{ kind: "agent", agent: "worker", task: "idle background" },
					"idle-launch" as OperationId,
					() => ({ result: gate.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) }),
				);
				assert.ok(started.ok);
				completionId = `completion-${started.value.taskId}`;
				await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
				gate.resolve({ kind: "failed", code: "fixture", message: "idle done" });
				await host.waitForTask(started.value.taskId);
			}
			await vi.waitFor(() => {
				const entries = manager.getEntries();
				const intent = entries.findIndex(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "task-completion-intent" &&
						(entry.data as { completionId: string }).completionId === completionId,
				);
				const card = entries.findIndex(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "task-completion" &&
						entry.stageAdmissionKey === completionId,
				);
				const ack = entries.findIndex(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "task-completion-ack" &&
						(entry.data as { completionId: string }).completionId === completionId,
				);
				assert.ok(intent >= 0 && card > intent && ack > card);
				const cardEntry = entries[card]!;
				assert.ok(cardEntry.type === "custom_message" && cardEntry.display);
				assert.ok(
					entries.some(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "atomic:protected-streaming-reconciliation" &&
							(entry.details as { protectedReconciliationOf: string }).protectedReconciliationOf ===
								cardEntry.id,
					),
				);
				assert.ok(
					harness
						.eventsOfType("message_end")
						.some(
							(event) =>
								event.message.role === "assistant" &&
								event.message.content.some(
									(block) => block.type === "text" && block.text === "IDLE-PARENT-REPLY",
								),
						),
				);
			});
			await harness.session.sendCustomMessage(
				{ customType: "intercom_message", content: "LATER-IDLE-NOTICE", display: true },
				{ triggerTurn: true, persistWhenStreaming: true, stageAdmissionKey: "later-idle-notice" },
			);
			await vi.waitFor(() =>
				assert.ok(
					manager
						.getEntries()
						.some(
							(entry) =>
								entry.type === "custom_message" &&
								entry.customType === "atomic:protected-streaming-reconciliation" &&
								entry.content.toString().includes("LATER-IDLE-NOTICE"),
						),
				),
			);
		} finally {
			await harness.cleanup();
		}
	});
}

for (const triggerTurn of [false, undefined]) {
	test(`idle stage keyed notices with triggerTurn=${triggerTurn} do not start parent turns (#3427)`, async () => {
		const harness = await createHarness({
			orchestrationContext: {
				kind: "workflow-stage",
				workflowRunId: "display-run",
				workflowStageId: "display-stage",
				workflowStageName: "Display stage",
				constraints: { disableWorkflowTool: true },
			},
		});
		harness.setResponses([fauxAssistantMessage("UNEXPECTED-TURN")]);
		try {
			await harness.session.sendCustomMessage(
				{ customType: "display-notice", content: "display only", display: true },
				{
					persistWhenStreaming: true,
					stageAdmissionKey: "display-only",
					...(triggerTurn === undefined ? {} : { triggerTurn }),
				},
			);
			const card = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "custom_message" && entry.stageAdmissionKey === "display-only");
			assert.ok(card?.type === "custom_message");
			assert.equal(card.protectedReconciliation, undefined);
			assert.equal(harness.session.agent.hasQueuedMessages(), false);
			assert.equal(harness.eventsOfType("agent_start").length, 0);
		} finally {
			await harness.cleanup();
		}
	});
}
