/**
 * Task completion notices that no live session could take (#5079): a released stage's tasks, whose notices waited only
 * in memory and died with a restart, and a session's tasks its close cancelled, whose notices were never saved.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import type { WorkflowStageOrchestrationContext } from "../src/core/extensions/index.js";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { TASK_COMPLETION_MESSAGE_TYPE } from "../src/core/tasks/completion.js";
import type { Cleanup, OperationId, OwnerId, TaskId, TaskResult } from "../src/core/tasks/contracts.js";
import { PARKED_STAGE_TASKS_TYPE, recordTasksInterruptedByRestart } from "../src/core/workflow-stage-parked-tasks.js";
import { parkWorkflowStageForRelease } from "../src/index.js";
import { createHarness, type Harness } from "./suite/harness.js";

const WAIT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 20;

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
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

async function openHarness(
	store: MemorySessionStore,
	sessionId?: string,
	orchestrationContext?: WorkflowStageOrchestrationContext,
): Promise<Harness> {
	const manager =
		sessionId === undefined
			? await SessionManager.create(store, process.cwd())
			: await SessionManager.open(store, sessionId);
	const harness = await createHarness({
		sessionManager: manager,
		...(orchestrationContext ? { orchestrationContext } : {}),
	});
	harnesses.push(harness);
	return harness;
}

const backgroundBash = (command: string, id: string) =>
	fauxAssistantMessage([fauxToolCall("bash", { command, wait: { kind: "background" } }, { id })], {
		stopReason: "toolUse",
	});

function gatedCommand(text: string): { readonly command: string; open(): void } {
	const directory = mkdtempSync(join(tmpdir(), "atomic-notice-gate-"));
	directories.push(directory);
	const gate = join(directory, "open").replaceAll("\\", "/");
	return {
		command: `while [ ! -e '${gate}' ]; do sleep 0.02; done; echo ${text}`,
		open: () => writeFileSync(gate, ""),
	};
}

function notices(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === TASK_COMPLETION_MESSAGE_TYPE
				? [String(entry.content)]
				: [],
		);
}

describe("task notices no live session could take (#5079)", () => {
	test("a stage released while its shell runs learns after a restart that the shell was interrupted (#5079)", async () => {
		const store = new MemorySessionStore();
		const before = stageContext();
		const first = await openHarness(store, undefined, before);
		const command = gatedCommand("settled-while-released");
		first.setResponses([backgroundBash(command.command, "bash-1"), fauxAssistantMessage("started it")]);
		await first.session.prompt("start the build");
		const sessionId = first.sessionManager.getSessionId();
		parkWorkflowStageForRelease(before);
		await first.session.dispose();
		command.open();
		const boundary = before.messageAdmission!.boundary;
		await vi.waitFor(
			() => assert.ok((boundary as unknown as { parkedSettlements: unknown[] }).parkedSettlements.length === 1),
			{
				timeout: WAIT_TIMEOUT_MS,
				interval: POLL_INTERVAL_MS,
			},
		);

		// Atomic restarts: the stage resumes in a new process, with a new admission boundary and task owner.
		const after = { ...stageContext(), workflowRunId: before.workflowRunId };
		const resumed = await openHarness(store, sessionId, after);
		resumed.setResponses([fauxAssistantMessage("must not run")]);
		// A host such as the task UI may open the stage's task owner before recovery runs.
		resumed.session.getAgentTaskHost();
		await resumed.session.startPendingRecovery("workflow_stage_resume");
		await vi.waitFor(() => assert.equal(notices(resumed).length, 1), {
			timeout: WAIT_TIMEOUT_MS,
			interval: POLL_INTERVAL_MS,
		});
		assert.match(notices(resumed)[0]!, /Background shell interrupted by a restart/);
		assert.match(notices(resumed)[0]!, /its result and output were not kept/);

		// Exactly once: a later resume finds the notice delivered.
		await resumed.session.dispose();
		const again = await openHarness(store, sessionId, { ...stageContext(), workflowRunId: before.workflowRunId });
		await again.session.startPendingRecovery("workflow_stage_resume");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(notices(again).length, 1);
		await boundary.close();
	});

	test("a stage reopened in the same process gets its shell's real outcome, not an interruption (#5079)", async () => {
		const store = new MemorySessionStore();
		const context = stageContext();
		const first = await openHarness(store, undefined, context);
		const command = gatedCommand("settled-in-process");
		first.setResponses([backgroundBash(command.command, "bash-1"), fauxAssistantMessage("started it")]);
		await first.session.prompt("start the build");
		const sessionId = first.sessionManager.getSessionId();
		parkWorkflowStageForRelease(context);
		await first.session.dispose();
		command.open();
		const boundary = context.messageAdmission!.boundary;
		await vi.waitFor(
			() => assert.ok((boundary as unknown as { parkedSettlements: unknown[] }).parkedSettlements.length === 1),
			{
				timeout: WAIT_TIMEOUT_MS,
				interval: POLL_INTERVAL_MS,
			},
		);

		const reopened = await openHarness(store, sessionId, context);
		reopened.setResponses([fauxAssistantMessage("must not run")]);
		await reopened.session.startPendingRecovery("workflow_stage_resume");
		await vi.waitFor(() => assert.equal(notices(reopened).length, 1), {
			timeout: WAIT_TIMEOUT_MS,
			interval: POLL_INTERVAL_MS,
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(notices(reopened).length, 1);
		assert.match(notices(reopened)[0]!, /settled-in-process/);
		assert.doesNotMatch(notices(reopened)[0]!, /interrupted by a restart/);

		// A restart after the notice was delivered tells the stage nothing more.
		await reopened.session.dispose();
		const resumed = await openHarness(store, sessionId, { ...stageContext(), workflowRunId: context.workflowRunId });
		await resumed.session.startPendingRecovery("workflow_stage_resume");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(notices(resumed).length, 1);
		await boundary.close();
	});

	test("a shell that a session's close cancels shows one notice naming the close when the session next opens (#5079)", async () => {
		const store = new MemorySessionStore();
		const first = await openHarness(store);
		first.setResponses([backgroundBash("sleep 30", "bash-1"), fauxAssistantMessage("started it")]);
		await first.session.prompt("start the build");
		const sessionId = first.sessionManager.getSessionId();
		const host = first.session.getAgentTaskHost();
		const watchOwnerTasks = host.watchOwnerTasks.bind(host);
		const watches = { opened: 0, disposed: 0 };
		vi.spyOn(host, "watchOwnerTasks").mockImplementation((...args) => {
			const watched = watchOwnerTasks(...args);
			if (watched.ok) {
				watches.opened++;
				const dispose = watched.value.dispose.bind(watched.value);
				watched.value.dispose = () => {
					watches.disposed++;
					dispose();
				};
			}
			return watched;
		});
		await first.session.dispose();
		assert.ok(watches.opened > 0, "the close read the kinds of the tasks it stops");
		assert.equal(watches.disposed, watches.opened, "the close leaves no watch of its tasks open");

		const reopened = await openHarness(store, sessionId);
		reopened.setResponses([fauxAssistantMessage("must not run")]);
		await reopened.session.startPendingRecovery("resume");
		await vi.waitFor(() => assert.equal(notices(reopened).length, 1), {
			timeout: WAIT_TIMEOUT_MS,
			interval: POLL_INTERVAL_MS,
		});
		assert.match(notices(reopened)[0]!, /Background shell stopped \(session closed\)/);

		await reopened.session.dispose();
		const again = await openHarness(store, sessionId);
		await again.session.startPendingRecovery("resume");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(notices(again).length, 1);
	});
	test("a restart reports only the shells a released stage was running, not its finished shells or its subagents (#5079)", async () => {
		const store = new MemorySessionStore();
		const before = stageContext();
		const first = await openHarness(store, undefined, before);
		const host = first.session.getAgentTaskHost();
		const agentResult = Promise.withResolvers<TaskResult>();
		const agentCleanup = Promise.withResolvers<Cleanup>();
		const agent = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: "Work" },
			randomUUID() as OperationId,
			() => ({ result: agentResult.promise, cleanup: agentCleanup.promise }),
		);
		assert.ok(agent.ok, "a subagent runs beside the shells");
		const running = gatedCommand("still-running");
		first.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo finished" }, { id: "bash-done" })], {
				stopReason: "toolUse",
			}),
			backgroundBash(running.command, "bash-running"),
			fauxAssistantMessage("started it"),
		]);
		await first.session.prompt("start the build");
		const sessionId = first.sessionManager.getSessionId();
		parkWorkflowStageForRelease(before);
		await first.session.dispose();

		const resumed = await openHarness(store, sessionId, { ...stageContext(), workflowRunId: before.workflowRunId });
		await resumed.session.startPendingRecovery("workflow_stage_resume");
		await vi.waitFor(() => assert.equal(notices(resumed).length, 1), {
			timeout: WAIT_TIMEOUT_MS,
			interval: POLL_INTERVAL_MS,
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(notices(resumed).length, 1);
		assert.match(notices(resumed)[0]!, /Background shell interrupted by a restart/);
		running.open();
		agentResult.resolve({ kind: "cancelled", cause: "user" });
		agentCleanup.resolve({ kind: "reaped" });
		await before.messageAdmission!.boundary.close();
	});
});

describe("recordTasksInterruptedByRestart (#5079)", () => {
	const owner = "owner-1-0" as OwnerId;
	const task = "task-1-0-0" as TaskId;
	function sessionOf(entries: SessionEntry[]) {
		return {
			getEntries: () => entries,
			appendCustomEntry: async (customType: string, data?: unknown) => {
				entries.push({ type: "custom", customType, data } as SessionEntry);
				return "";
			},
		};
	}
	const marker = (attemptId: string) =>
		({
			type: "custom",
			customType: PARKED_STAGE_TASKS_TYPE,
			data: { attemptId, tasks: [{ ownerId: owner, taskId: task }] },
		}) as SessionEntry;
	const intent = (completionId: string) =>
		({
			type: "custom",
			customType: "task-completion-intent",
			data: { completionId, ownerId: owner, taskId: task },
		}) as SessionEntry;

	test("saves one interrupted intent for a shell an earlier process released, once (#5079)", async () => {
		const session = sessionOf([marker("earlier")]);

		assert.equal(await recordTasksInterruptedByRestart(session, "now"), 1);
		assert.deepEqual(session.getEntries().at(-1), {
			type: "custom",
			customType: "task-completion-intent",
			data: {
				completionId: "restart-interrupted:earlier:owner-1-0:task-1-0-0",
				ownerId: owner,
				taskId: task,
				terminalSequence: "0",
				result: { kind: "cancelled", cause: "shutdown" },
				display: false,
				taskKind: "command",
				interruptedByRestart: true,
			},
		});
		assert.equal(await recordTasksInterruptedByRestart(session, "now"), 0);
	});

	test("counts only an intent saved after the release, since task ids restart with each process (#5079)", async () => {
		assert.equal(await recordTasksInterruptedByRestart(sessionOf([intent("older"), marker("earlier")]), "now"), 1);
		assert.equal(await recordTasksInterruptedByRestart(sessionOf([marker("earlier"), intent("real")]), "now"), 0);
		const otherTask = {
			type: "custom",
			customType: "task-completion-intent",
			data: { completionId: "other", ownerId: owner, taskId: "task-1-0-1" },
		} as SessionEntry;
		assert.equal(await recordTasksInterruptedByRestart(sessionOf([marker("earlier"), otherTask]), "now"), 1);
	});

	test("leaves the shells of a release in this process to the completions it holds (#5079)", async () => {
		assert.equal(await recordTasksInterruptedByRestart(sessionOf([marker("now")]), "now"), 0);
	});
});
