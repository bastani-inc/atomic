/**
 * What a stage keeps once its session is released (#4309): a detached call's work, the stage's task host and its
 * admission boundary hold nothing of the closed session, and what they hold for the stage carries over to the session
 * the stage reopens.
 */
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import type { DetachedToolCall } from "../src/core/agent-session-detached-tools.js";
import type { ToolDefinition, WorkflowStageOrchestrationContext } from "../src/core/extensions/index.js";
import { SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { AgentTaskHost } from "../src/core/tasks/agent-adapter.js";
import { TASK_COMPLETION_MESSAGE_TYPE } from "../src/core/tasks/completion.js";
import type { WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.js";
import { isToolDetachmentError, parkWorkflowStageForRelease } from "../src/index.js";
import { waitTool } from "./helpers/detached-tools.js";
import { createHarness, getMessageText, type Harness } from "./suite/harness.js";

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const collect = resolveCollect();

/** Whether `released` is collected once collections and the finalizers they schedule have settled. */
async function collected(released: WeakRef<object>): Promise<boolean> {
	// Dereferencing keeps the target alive until the current job ends, so each check runs in a later job.
	for (let round = 0; round < 10; round++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		collect();
		await new Promise((resolve) => setTimeout(resolve, 10));
		if (released.deref() === undefined) return true;
	}
	return false;
}

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

function stageContext(): WorkflowStageOrchestrationContext {
	return {
		kind: "workflow-stage",
		workflowRunId: crypto.randomUUID(),
		workflowStageId: "stage-a",
		workflowStageName: "Stage A",
		constraints: { disableWorkflowTool: true },
	};
}

function boundaryOf(context: WorkflowStageOrchestrationContext): WorkflowStageAdmissionBoundary {
	const boundary = context.messageAdmission?.boundary;
	assert.ok(boundary !== undefined, "the stage's first session gave the stage its admission boundary");
	return boundary;
}

describe("a detached call's work (#4309)", () => {
	test("that reports progress and holds its context keeps no closed session reachable (#4309)", async () => {
		const work = Promise.withResolvers<void>();
		let lateUse: unknown;
		const tool: ToolDefinition = {
			name: "wait_for_ci",
			label: "Wait for CI",
			description: "Waits for a CI run",
			parameters: Type.Object({ run: Type.String() }),
			detachable: true,
			execute: async (_toolCallId, _params, _signal, onUpdate, ctx) => {
				onUpdate?.({ content: [{ type: "text", text: "queued" }], details: undefined });
				await work.promise;
				onUpdate?.({ content: [{ type: "text", text: "finished" }], details: undefined });
				try {
					void ctx.model;
				} catch (error) {
					lateUse = error;
				}
				return { content: [{ type: "text", text: `passed in ${ctx.cwd}` }], details: undefined };
			},
		};

		/** Detach the call, close its session, and keep only a weak reference to the session. */
		async function detachThenClose(): Promise<{
			readonly released: WeakRef<object>;
			readonly call: DetachedToolCall;
			readonly cwd: string;
			readonly updates: string[];
		}> {
			const harness = await createHarness({ customTools: [tool] });
			harness.session.setToolDetachment({ afterMs: 0 });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" })], {
					stopReason: "toolUse",
				}),
			]);
			await harness.session.prompt("watch ci");
			const [call] = harness.session.takeDetachedToolCalls();
			assert.ok(call !== undefined, "the call detached");
			const updates = harness
				.eventsOfType("tool_execution_update")
				.map((event) => getMessageText(event.partialResult));
			const released = new WeakRef<object>(harness.session);
			await harness.cleanup();
			return { released, call, cwd: harness.tempDir, updates };
		}

		const { released, call, cwd, updates } = await detachThenClose();

		assert.deepEqual(updates, ["queued"], "progress reported while the call ran inline reached the session");
		assert.equal(await collected(released), true, "the closed session was collected while its call went on");
		work.resolve();
		const result = await call.result;
		assert.deepEqual(result.result.content, [{ type: "text", text: `passed in ${cwd}` }]);
		assert.ok(isToolDetachmentError(lateUse));
		assert.equal(lateUse.code, "context-detached");
		assert.equal(lateUse.fields.toolCallId, "ci-1");
	});
});

describe("a released stage's task host (#4309)", () => {
	test("keeps no session of a stage that ran bash reachable once the stage is parked and the session closed (#4309)", async () => {
		const context = stageContext();

		async function ranBashThenReleased(): Promise<WeakRef<object>> {
			const harness = await createHarness({ orchestrationContext: context });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo stage" }, { id: "bash-1" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run it");
			assert.equal(boundaryOf(context).hasAgentTaskHost(), true, "bash bound the stage's task host");
			parkWorkflowStageForRelease(context);
			const released = new WeakRef<object>(harness.session);
			await harness.cleanup();
			return released;
		}

		const released = await ranBashThenReleased();

		assert.equal(await collected(released), true, "the released stage session was collected");
		await boundaryOf(context).close();
	});

	test("delivers the completion of a task that settled while the stage was released to the session it reopens (#4309)", async () => {
		const context = stageContext();
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, process.cwd());
		const first = await createHarness({ orchestrationContext: context, sessionManager: manager });
		first.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"bash",
						{ command: "sleep 0.3; echo settled-while-released", wait: { kind: "background" } },
						{ id: "bash-1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("started it"),
		]);
		await first.session.prompt("start the build");
		const host: AgentTaskHost = first.session.getAgentTaskHost();
		parkWorkflowStageForRelease(context);
		await first.session.dispose();
		harnesses.push(first);

		await vi.waitFor(
			() => {
				const watched = host.watchOwnerTasks();
				assert.ok(watched.ok);
				const { tasks } = watched.value.snapshot;
				const settled = tasks.length > 0 && tasks.every((task) => task.execution.kind === "settled");
				watched.value.dispose();
				assert.equal(settled, true);
			},
			{ timeout: 10_000, interval: 20 },
		);

		const reopened = await createHarness({
			orchestrationContext: context,
			sessionManager: await SessionManager.open(store, manager.getSessionId()),
		});
		harnesses.push(reopened);

		await vi.waitFor(
			() => {
				const entries = reopened.sessionManager.getEntries();
				const notice = entries.find(
					(entry) => entry.type === "custom_message" && entry.customType === TASK_COMPLETION_MESSAGE_TYPE,
				);
				assert.ok(notice?.type === "custom_message", "the completion reached the reopened session");
				assert.match(String(notice.content), /settled-while-released/);
				assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === "task-completion-ack"));
			},
			{ timeout: 5_000, interval: 20 },
		);
		assert.equal(reopened.getPendingResponseCount(), 0, "the notice started no turn of its own");
		await boundaryOf(context).close();
	});
});

describe("a task completion while the transcript waits on a detached call (#4309)", () => {
	test("waits for the detached turn to resume, so nothing comes between the call and its result (#4309)", async () => {
		const ci = waitTool();
		const harness = await createHarness({ customTools: [ci.definition] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"bash",
						{ command: "sleep 0.2; echo built", wait: { kind: "background" } },
						{ id: "bash-1" },
					),
					fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		harness.session.setToolDetachment({ afterMs: 0 });
		await harness.session.prompt("build, then watch ci");
		const [detached] = harness.session.takeDetachedToolCalls();
		assert.ok(detached !== undefined, "the ci call detached");
		const host = harness.session.getAgentTaskHost();
		await vi.waitFor(
			() => {
				const watched = host.watchOwnerTasks();
				assert.ok(watched.ok);
				const { tasks } = watched.value.snapshot;
				watched.value.dispose();
				assert.ok(tasks.length > 0 && tasks.every((task) => task.execution.kind === "settled"));
			},
			{ timeout: 10_000, interval: 20 },
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const roles = () =>
			harness.sessionManager
				.buildSessionProjection()
				.messages.map((message) =>
					message.role === "custom" ? `custom:${message.customType}` : `${message.role}`,
				);
		assert.deepEqual(roles().slice(-2), ["assistant", "toolResult"], "only the bash result follows the call yet");
		assert.ok(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "task-completion-intent"),
			"the completion is saved while it waits",
		);

		harness.setResponses([fauxAssistantMessage("ci passed"), fauxAssistantMessage("noted the build")]);
		ci.finish(0, "passed");
		await harness.session.resumeDetachedTurn([await detached.result]);

		await vi.waitFor(() => assert.equal(harness.getPendingResponseCount(), 0), { timeout: 5_000, interval: 20 });
		await vi.waitFor(() => assert.equal(harness.session.isStreaming, false));
		const after = roles();
		const call = after.lastIndexOf("toolResult") - 2;
		assert.deepEqual(after.slice(call, call + 4), ["assistant", "toolResult", "toolResult", "assistant"]);
		assert.ok(after.indexOf(`custom:${TASK_COMPLETION_MESSAGE_TYPE}`) > call + 3, "the notice follows the answer");
		assert.equal(after.at(-1), "assistant");
	});
});

describe("a released stage's admission boundary (#4309)", () => {
	test("forgets admission keys while released and takes back only those the reopened transcript records (#4309)", async () => {
		const context = stageContext();
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, process.cwd());
		const first = await createHarness({ orchestrationContext: context, sessionManager: manager });
		const boundary = boundaryOf(context);
		await first.session.sendCustomMessage(
			{ customType: "note", content: "saved with its key", display: true },
			{ triggerTurn: false, stageAdmissionKey: "saved-key" },
		);
		await boundary.admit(
			"unsaved-key",
			() => {},
			() => {},
		).completion;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(
			boundary.admit(
				"saved-key",
				() => {},
				() => {},
			).decision,
			"duplicate",
		);
		assert.equal(
			boundary.admit(
				"unsaved-key",
				() => {},
				() => {},
			).decision,
			"duplicate",
		);

		for (let release = 0; release < 3; release++) {
			parkWorkflowStageForRelease(context);
			const current = release === 0 ? first : harnesses.pop();
			await current?.cleanup();
			const reopened = await createHarness({
				orchestrationContext: context,
				sessionManager: await SessionManager.open(store, manager.getSessionId()),
			});
			harnesses.push(reopened);

			assert.equal(context.messageAdmission?.boundary, boundary, "the stage keeps one boundary");
			assert.equal(
				boundary.admit(
					"saved-key",
					() => {},
					() => {},
				).decision,
				"duplicate",
			);
		}
		assert.equal(
			boundary.admit(
				"unsaved-key",
				() => {},
				() => {},
			).decision,
			"admitted",
			"a key no transcript records is not carried across a release",
		);
		await boundary.close();
	});
});
