/**
 * A workflow stage that is released while it waits (#4309) lets go of its session but keeps its task host: the host
 * refuses launches until the stage's next session binds it, tasks that settle meanwhile reach that session's transcript
 * without starting a turn, and the next session launches tasks as any other does.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import type { WorkflowStageOrchestrationContext } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.ts";
import type { AgentTaskHost } from "../src/core/tasks/agent-adapter.ts";
import { TASK_COMPLETION_MESSAGE_TYPE } from "../src/core/tasks/completion.ts";
import type { Cleanup, OperationId, TaskResult } from "../src/core/tasks/contracts.ts";
import type { ParkedTaskSettlement, WorkflowStageAdmissionBoundary } from "../src/core/workflow-stage-admission.ts";
import { isToolDetachmentError, parkWorkflowStageForRelease, ToolDetachmentError } from "../src/index.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

/** Removed after each test, once the stage's tasks have ended: Windows refuses to remove files a task still holds. */
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

async function stageSession(
	context: WorkflowStageOrchestrationContext,
	store: MemorySessionStore,
	sessionId?: string,
): Promise<Harness> {
	const manager =
		sessionId === undefined
			? await SessionManager.create(store, process.cwd())
			: await SessionManager.open(store, sessionId);
	const harness = await createHarness({ orchestrationContext: context, sessionManager: manager });
	harnesses.push(harness);
	return harness;
}

const bashTurn = (command: string, id: string, extra: Record<string, unknown> = {}) =>
	fauxAssistantMessage([fauxToolCall("bash", { command, ...extra }, { id })], { stopReason: "toolUse" });

function toolResultsOf(harness: Harness): { readonly text: string; readonly isError: boolean }[] {
	return harness.sessionManager
		.buildSessionProjection()
		.messages.flatMap((message) =>
			message.role === "toolResult" ? [{ text: getMessageText(message), isError: message.isError }] : [],
		);
}

async function untilCommandsSettled(host: AgentTaskHost): Promise<void> {
	await vi.waitFor(
		() => {
			const watched = host.watchOwnerTasks();
			assert.ok(watched.ok);
			const commands = watched.value.snapshot.tasks.filter((task) => task.kind === "command");
			watched.value.dispose();
			assert.ok(commands.length > 0 && commands.every((task) => task.execution.kind === "settled"));
		},
		{ timeout: 10_000, interval: 20 },
	);
}

describe("a released stage's task host (#4309)", () => {
	test("refuses a launch while the stage is released (#4309)", async () => {
		const context = stageContext();
		const first = await stageSession(context, new MemorySessionStore());
		first.setResponses([bashTurn("echo stage", "bash-1"), fauxAssistantMessage("done")]);
		await first.session.prompt("run it");
		parkWorkflowStageForRelease(context);

		first.setResponses([bashTurn("echo late", "bash-2"), fauxAssistantMessage("gave up")]);
		await first.session.prompt("run another");

		const [ran, refused] = toolResultsOf(first);
		assert.equal(ran?.isError, false);
		assert.match(ran?.text ?? "", /stage/);
		assert.equal(refused?.isError, true);
		assert.match(refused?.text ?? "", /\(stage-parked\)/);
		assert.doesNotMatch(refused?.text ?? "", /Task owner is closed/);
		await boundaryOf(context).close();
	});

	test("refuses an agent task launch with a retryable stage-parked ToolDetachmentError naming the stage's session (#4309)", async () => {
		const context = stageContext();
		const first = await stageSession(context, new MemorySessionStore());
		const host = first.session.getAgentTaskHost();
		parkWorkflowStageForRelease(context);
		let dispatched = 0;

		const refusal = await host
			.startAgentTask({ kind: "agent", agent: "worker", task: "Work" }, randomUUID() as OperationId, () => {
				dispatched++;
				throw new Error("a parked stage dispatched work");
			})
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		assert.ok(isToolDetachmentError(refusal), `launch raised ${String(refusal)}`);
		assert.ok(refusal instanceof ToolDetachmentError);
		assert.equal(refusal.code, "stage-parked");
		assert.equal(refusal.retryable, true);
		assert.deepEqual(refusal.fields, { sessionId: first.sessionManager.getSessionId() });
		assert.equal(dispatched, 0);
		await boundaryOf(context).close();
	});

	test("lets the stage's next session launch tasks again (#4309)", async () => {
		const context = stageContext();
		const store = new MemorySessionStore();
		const first = await stageSession(context, store);
		first.setResponses([bashTurn("echo before", "bash-1"), fauxAssistantMessage("done")]);
		await first.session.prompt("run it");
		const sessionId = first.sessionManager.getSessionId();
		parkWorkflowStageForRelease(context);
		await first.session.dispose();

		const reopened = await stageSession(context, store, sessionId);
		reopened.setResponses([bashTurn("echo after-release", "bash-2"), fauxAssistantMessage("done")]);
		await reopened.session.prompt("run it again");

		const results = toolResultsOf(reopened);
		const last = results.at(-1);
		assert.equal(last?.isError, false);
		assert.match(last?.text ?? "", /after-release/);
		await boundaryOf(context).close();
	});

	test("hands the completion of a task that settled meanwhile to the next session as a notice that starts no turn (#4309)", async () => {
		const context = stageContext();
		const store = new MemorySessionStore();
		const first = await stageSession(context, store);
		first.setResponses([
			bashTurn("sleep 0.3; echo settled-while-released", "bash-1", { wait: { kind: "background" } }),
			fauxAssistantMessage("started it"),
		]);
		await first.session.prompt("start the build");
		const sessionId = first.sessionManager.getSessionId();
		const host = first.session.getAgentTaskHost();
		parkWorkflowStageForRelease(context);
		await first.session.dispose();
		await untilCommandsSettled(host);

		const reopened = await stageSession(context, store, sessionId);
		reopened.setResponses([fauxAssistantMessage("must not run")]);

		await vi.waitFor(
			() => {
				const entries = reopened.sessionManager.getEntries();
				assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === "task-completion-ack"));
			},
			{ timeout: 5_000, interval: 20 },
		);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const notice = reopened.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === TASK_COMPLETION_MESSAGE_TYPE);
		assert.ok(notice?.type === "custom_message", "the completion reached the reopened session");
		assert.match(String(notice.content), /settled-while-released/);
		assert.equal((notice.details as { readonly taskKind?: string } | undefined)?.taskKind, "command");
		assert.equal(reopened.getPendingResponseCount(), 1, "no turn consumed a response");
		assert.equal(
			reopened.sessionManager.buildSessionProjection().messages.filter((message) => message.role === "assistant")
				.length,
			2,
			"no turn answered the notice: the transcript holds only the two replies of the first session",
		);
		await boundaryOf(context).close();
	});

	test("still parks the settlement of a task that the stage's close cancels, though the owner can no longer be read (#4309)", async () => {
		const context = stageContext();
		const first = await stageSession(context, new MemorySessionStore());
		first.setResponses([
			bashTurn("sleep 30", "bash-1", { wait: { kind: "background" } }),
			fauxAssistantMessage("started it"),
		]);
		await first.session.prompt("start the build");
		parkWorkflowStageForRelease(context);
		await first.session.dispose();
		const boundary = boundaryOf(context);

		await boundary.close();

		const parked: ParkedTaskSettlement[] = [];
		await vi.waitFor(
			() => {
				parked.push(...boundary.takeParkedTaskSettlements());
				assert.equal(parked.length, 1);
			},
			{ timeout: 5_000, interval: 20 },
		);
		assert.equal(parked[0]?.kind, undefined);
	});

	test("leaves no watch of its tasks open once it has named the kind of a settled task (#4309)", async () => {
		const context = stageContext();
		const store = new MemorySessionStore();
		const first = await stageSession(context, store);
		first.setResponses([
			bashTurn("sleep 0.3; echo settled-while-released", "bash-1", { wait: { kind: "background" } }),
			fauxAssistantMessage("started it"),
		]);
		await first.session.prompt("start the build");
		const host = first.session.getAgentTaskHost();
		let opened = 0;
		let disposed = 0;
		const watchOwnerTasks = host.watchOwnerTasks.bind(host);
		vi.spyOn(host, "watchOwnerTasks").mockImplementation((...args) => {
			const watched = watchOwnerTasks(...args);
			if (watched.ok) {
				opened++;
				const dispose = watched.value.dispose.bind(watched.value);
				watched.value.dispose = () => {
					disposed++;
					dispose();
				};
			}
			return watched;
		});
		parkWorkflowStageForRelease(context);
		await first.session.dispose();

		await vi.waitFor(
			() => {
				const parked = boundaryOf(context).takeParkedTaskSettlements();
				assert.equal(parked.length, 1);
				assert.equal(parked[0]?.kind, "command");
			},
			{ timeout: 10_000, interval: 20 },
		);

		assert.ok(opened >= 1, "the kind was read from the owner's tasks");
		assert.equal(disposed, opened);
		await boundaryOf(context).close();
	});

	test("names the kind of the task that settled, not of another task the stage runs (#4309)", async () => {
		const context = stageContext();
		const store = new MemorySessionStore();
		const first = await stageSession(context, store);
		const host = first.session.getAgentTaskHost();
		const agentResult = Promise.withResolvers<TaskResult>();
		const agentCleanup = Promise.withResolvers<Cleanup>();
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: "Work" },
			randomUUID() as OperationId,
			() => ({ result: agentResult.promise, cleanup: agentCleanup.promise }),
		);
		assert.ok(started.ok, "an agent task is running beside the command");
		first.setResponses([
			bashTurn("sleep 0.3; echo settled-beside-agent", "bash-1", { wait: { kind: "background" } }),
			fauxAssistantMessage("started it"),
		]);
		await first.session.prompt("start the build");
		const sessionId = first.sessionManager.getSessionId();
		parkWorkflowStageForRelease(context);
		await first.session.dispose();
		await untilCommandsSettled(host);

		const reopened = await stageSession(context, store, sessionId);

		await vi.waitFor(
			() => {
				const entries = reopened.sessionManager.getEntries();
				assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === "task-completion-ack"));
			},
			{ timeout: 5_000, interval: 20 },
		);
		const notice = reopened.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom_message" && entry.customType === TASK_COMPLETION_MESSAGE_TYPE);
		assert.ok(notice?.type === "custom_message", "the completion reached the reopened session");
		assert.match(String(notice.content), /settled-beside-agent/);
		assert.equal((notice.details as { readonly taskKind?: string } | undefined)?.taskKind, "command");
		agentResult.resolve({ kind: "cancelled", cause: "user" });
		agentCleanup.resolve({ kind: "reaped" });
		await boundaryOf(context).close();
	});
});
