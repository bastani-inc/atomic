import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type {
	OperationId,
	Result,
	TaskResult,
	WaitError,
	WaitOutcome,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { createHarness, getMessageText } from "../../packages/coding-agent/test/suite/harness.js";
import { createIncomingMessageSender } from "../../packages/intercom/incoming-message-delivery.js";

for (const scope of ["session", "workflow-stage"] as const) {
	for (const mode of ["explicit wait"] as const) {
		test.each(["steer", "prompt", "Intercom ask", "Intercom send"] as const)(
			`${scope} ${mode} yields for %s while its child keeps running`,
			async (messageKind) => {
				const result = Promise.withResolvers<TaskResult>();
				const waiting = Promise.withResolvers<void>();
				let host!: AgentTaskHost;
				let signal: AbortSignal | undefined;
				let observation: Result<WaitOutcome, WaitError> | undefined;
				let starts = 0;
				const tool: AgentTool = {
					name: "wait-child",
					label: "Wait for child",
					description: "Observe an owner-bound child",
					parameters: Type.Object({}),
					async execute() {
						const started = await host.startAgentTask(
							{ kind: "agent", agent: "worker", task: "Keep working" },
							randomUUID() as OperationId,
							(context) => {
								starts++;
								signal = context.signal;
								return {
									result: result.promise,
									cleanup: result.promise.then(() => ({ kind: "reaped" as const })),
								};
							},
						);
						assert.ok(started.ok);
						await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
						const pending = host.waitForTask(started.value.taskId, 60_000);
						waiting.resolve();
						observation = await pending;
						return { content: [{ type: "text", text: JSON.stringify(observation) }], details: {} };
					},
				};
				const harness = await createHarness({ tools: [tool] });
				let boundary: WorkflowStageAdmissionBoundary | undefined;
				if (scope === "workflow-stage") {
					boundary = new WorkflowStageAdmissionBoundary();
					boundary.bindTaskIdentity(harness.sessionManager.getSessionId(), randomUUID(), "waiting-parent");
					(
						harness.session as AgentSession & { _workflowStageAdmission?: WorkflowStageAdmissionBoundary }
					)._workflowStageAdmission = boundary;
				}
				host = harness.session.getAgentTaskHost();
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("wait-child", {}), { stopReason: "toolUse" }),
					fauxAssistantMessage("Message handled while child runs"),
					fauxAssistantMessage("Message handled while child runs"),
				]);
				const turn = harness.session.prompt("Start a child and wait for it");
				try {
					await waiting.promise;
					const isIntercom = messageKind.startsWith("Intercom");
					if (isIntercom) {
						// Exercise the actual Intercom -> pi.sendMessage -> session admission path.
						// The sender is an unrelated peer: no child-side detach handshake can rescue the wait.
						const send = createIncomingMessageSender({
							pi: { sendMessage: (message, options) => harness.session.sendCustomMessage(message, options) },
							currentGeneration: () => 1,
							canDeliver: () => true,
							queueTurnContext() {},
						});
						await send(
							{
								from: { id: "peer", cwd: "/peer", model: "test", pid: 1, startedAt: 1, lastActivity: 1 },
								message: {
									id: randomUUID(),
									timestamp: 1,
									expectsReply: messageKind === "Intercom ask",
									content: { text: "Change direction now" },
								},
								bodyText: "Change direction now",
							},
							messageKind === "Intercom ask" ? "trigger" : "followUp",
						);
					} else if (messageKind === "prompt") {
						await harness.session.prompt("Change direction now", { streamingBehavior: "steer" });
					} else {
						await harness.session.steer("Change direction now");
					}
					await vi.waitFor(() =>
						assert.ok(observation, "parent must return from observation before child completes"),
					);
					assert.ok(observation?.ok && observation.value.kind === "yielded");
					assert.equal(observation.value.reason, isIntercom ? "intercom-coordination" : "input-needed");
					await turn;
					assert.equal(signal?.aborted, false);
					assert.equal(starts, 1);
					const input = harness.session.messages.filter(
						(message) =>
							getMessageText(message).includes("Change direction now") &&
							!("excludeFromContext" in message && message.excludeFromContext === true),
					);
					assert.equal(input.length, 1, "incoming message remains available to the parent exactly once");
					assert.equal(getMessageText(harness.session.messages.at(-1)), "Message handled while child runs");
					if (isIntercom) {
						assert.equal(
							harness.sessionManager
								.getEntries()
								.filter((entry) => entry.type === "custom_message" && entry.customType === "intercom_message")
								.length,
							1,
						);
					}
					const watched = host.watchOwnerTasks();
					assert.ok(watched.ok);
					try {
						assert.equal(watched.value.snapshot.state, "open");
						assert.equal(watched.value.snapshot.scope.kind, scope);
						assert.equal(watched.value.snapshot.tasks[0].execution.kind, "running");
						const terminal: TaskResult = { kind: "completed", output: watched.value.snapshot.tasks[0].output };
						harness.session.pauseQueuedMessages();
						result.resolve(terminal);
						const settled = await host.waitForTask(observation.value.taskId);
						assert.ok(settled.ok && settled.value.kind === "settled");
						assert.deepEqual(settled.value.result, terminal);
					} finally {
						watched.value.dispose();
					}
				} finally {
					harness.session.pauseQueuedMessages();
					result.resolve({ kind: "cancelled", cause: "user" });
					if (boundary) await boundary.close();
					else await host.close("session-close");
					await turn;
					harness.cleanup();
				}
			},
		);
	}
}
