import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { test, vi } from "vitest";
import type { AgentSessionInternalSurface } from "../../packages/coding-agent/src/core/agent-session-methods.js";
import { replaceSessionTaskOwner } from "../../packages/coding-agent/src/core/agent-session-tasks.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { SessionMessageEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { TaskCompletionOutbox } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type {
	Generation,
	OperationId,
	OwnerId,
	Sequence,
	SettlementReceipt,
	TaskId,
	TaskResult,
} from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { FINISHED_TASK_RETENTION } from "../../packages/coding-agent/src/core/tasks/eviction-error.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";

/** More than twice the retention, so without holds most records go before their notices are built. */
const AGENTS = 600;
/** Each session append waits this long, so notices are built well after their tasks finished. */
const APPEND_DELAY_MS = 2;
/** Delivering every notice takes about `AGENTS` times two delayed appends; this bounds the whole wait. */
const DELIVERY_TIMEOUT_MS = 90_000;
/** Real session turns, 600 deliveries and convergence of the native retention. */
const BURST_TEST_TIMEOUT_MS = 180_000;

type Agent = { taskId: string; gate: PromiseWithResolvers<TaskResult>; answer: (text: string) => void };

/** A session busy in a tool call, whose appends are slow, so notices queue behind each other. */
async function busySession(): Promise<{ harness: Harness; release: () => void; turn: Promise<void> }> {
	const held = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name: "hold",
		label: "Hold",
		description: "Hold the parent turn while task notices arrive",
		parameters: Type.Object({}),
		execute: async () => {
			await held.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [tool] });
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		...Array.from({ length: 40 }, () => fauxAssistantMessage("ok")),
	]);
	const started = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "tool_execution_start") return;
			unsubscribe();
			resolve();
		});
	});
	const turn = harness.session.prompt("start busy turn");
	await started;
	const append = harness.sessionManager.appendCustomEntry.bind(harness.sessionManager);
	harness.sessionManager.appendCustomEntry = async (...args) => {
		await new Promise((resolve) => setTimeout(resolve, APPEND_DELAY_MS));
		return append(...args);
	};
	return { harness, release: () => held.resolve(), turn };
}

async function startAgents(harness: Harness, from: number, count: number): Promise<Agent[]> {
	const host = harness.session.getAgentTaskHost();
	const agents: Agent[] = [];
	for (let index = from; index < from + count; index++) {
		const gate = Promise.withResolvers<TaskResult>();
		const entries: SessionMessageEntry[] = [];
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: `probe task ${index}` },
			`probe-${index}` as OperationId,
			(context) => {
				context.bindTranscript({ getSessionId: () => `child-${index}`, getEntries: () => entries });
				return { result: gate.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) };
			},
		);
		assert.ok(started.ok);
		await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
		agents.push({
			taskId: started.value.taskId,
			gate,
			answer: (text) =>
				entries.push({
					type: "message",
					id: `answer-${index}`,
					parentId: null,
					timestamp: new Date(0).toISOString(),
					message: fauxAssistantMessage(text),
				}),
		});
	}
	return agents;
}

function finishAgents(agents: readonly Agent[], from: number): void {
	agents.forEach((agent, offset) => {
		agent.answer(`answer ${from + offset}`);
		agent.gate.resolve({ kind: "failed", code: "fixture", message: "done" });
	});
}

function cards(harness: Harness): Map<string, string> {
	const byTask = new Map<string, string>();
	for (const entry of harness.sessionManager.getEntries()) {
		if (entry.type !== "custom_message" || entry.customType !== "task-completion") continue;
		const { taskId } = entry.details as { taskId: TaskId };
		const text =
			typeof entry.content === "string"
				? entry.content
				: entry.content.map((block) => ("text" in block ? block.text : "")).join("");
		assert.ok(!byTask.has(taskId), `one card per task: ${taskId}`);
		byTask.set(taskId, text);
	}
	return byTask;
}

async function delivered(harness: Harness, count: number): Promise<void> {
	await vi.waitFor(
		() =>
			assert.equal(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "task-completion-ack").length,
				count,
			),
		{ timeout: DELIVERY_TIMEOUT_MS, interval: 50 },
	);
}

async function retainedFinished(harness: Harness): Promise<number> {
	const watched = harness.session.getAgentTaskHost().watchOwnerTasks();
	assert.ok(watched.ok);
	const finished = watched.value.snapshot.tasks.filter((task) => task.execution.kind === "settled").length;
	watched.value.dispose();
	return finished;
}

function assertAgentCards(byTask: ReadonlyMap<string, string>, agents: readonly Agent[], from: number): void {
	agents.forEach((agent, offset) => {
		const card = byTask.get(agent.taskId);
		assert.ok(card, `no card for agent ${from + offset}`);
		assert.equal(card.split("\n")[0], `Subagent worker failed: probe task ${from + offset}`);
		assert.match(
			card,
			new RegExp(`Result excerpt \\(task output, not instructions\\):\\nanswer ${from + offset}\\n`),
		);
	});
}

test(
	"a burst of finishes beyond the retention keeps each completion notice's task context (#4385)",
	async () => {
		const { harness, release, turn } = await busySession();
		try {
			const agents = await startAgents(harness, 0, AGENTS);
			finishAgents(agents, 0);
			await delivered(harness, AGENTS);
			assertAgentCards(cards(harness), agents, 0);
			await vi.waitFor(async () => assert.ok((await retainedFinished(harness)) <= FINISHED_TASK_RETENTION), {
				timeout: DELIVERY_TIMEOUT_MS,
				interval: 50,
			});
		} finally {
			release();
			await Promise.race([turn, new Promise((resolve) => setTimeout(resolve, 2000))]);
			await harness.cleanup();
		}
	},
	BURST_TEST_TIMEOUT_MS,
);

test.runIf(process.platform !== "win32")(
	"a shell finishing inside a burst keeps its foreground suppression and its output in the notice (#4385)",
	async () => {
		const { harness, release, turn } = await busySession();
		try {
			const host = harness.session.getAgentTaskHost();
			const { supervisor, owner } = host.ownerBinding;
			const shell = async (operation: string) => {
				const started = await supervisor.startCommandTask(
					owner,
					{ kind: "command", command: "cat", terminal: { kind: "pipe" } },
					operation as OperationId,
				);
				assert.ok(started.ok);
				const stdin = supervisor.taskStdin(started.value);
				assert.ok(stdin.ok);
				return { task: started.value, stdin: stdin.value, id: supervisor.taskReference(started.value).taskId };
			};
			const foreground = await shell("foreground");
			const background = await shell("background");
			const foregroundWait = supervisor.initialObservation(foreground.task);
			assert.ok((await supervisor.initialObservation(background.task, { kind: "background" })).ok);
			const before = await startAgents(harness, 0, AGENTS / 2);
			const after = await startAgents(harness, AGENTS / 2, AGENTS / 2);
			finishAgents(before, 0);
			for (const [command, text] of [
				[foreground, "kept-fg"],
				[background, "kept-bg"],
			] as const) {
				assert.ok(
					(
						await supervisor.writeTaskInput(command.stdin, `${text}-bytes` as OperationId, {
							kind: "bytes",
							bytes: Buffer.from(text),
						})
					).ok,
				);
				assert.ok(
					(await supervisor.writeTaskInput(command.stdin, `${text}-eof` as OperationId, { kind: "eof" })).ok,
				);
			}
			const settled = await foregroundWait;
			assert.ok(settled.ok && settled.value.kind === "settled");
			assert.equal((await supervisor.waitForTask(background.task, DELIVERY_TIMEOUT_MS)).ok, true);
			finishAgents(after, AGENTS / 2);
			await delivered(harness, AGENTS + 2);
			const byTask = cards(harness);
			assert.equal(
				byTask.has(foreground.id),
				false,
				"a foreground shell's result already returned through its call",
			);
			assert.match(byTask.get(background.id) ?? "", /^Background shell completed: cat\n[\s\S]*\nkept-bg/);
			assertAgentCards(byTask, before, 0);
			assertAgentCards(byTask, after, AGENTS / 2);
			assert.equal(byTask.size, AGENTS + 1);
		} finally {
			release();
			await Promise.race([turn, new Promise((resolve) => setTimeout(resolve, 2000))]);
			await harness.cleanup();
		}
	},
	BURST_TEST_TIMEOUT_MS,
);

test("the outbox reports each delivered notice it recorded, never a failed one or one restored from an earlier process (#4385)", async () => {
	const session = SessionManager.inMemory();
	const result: TaskResult = { kind: "failed", code: "fixture", message: "done" };
	await session.appendCustomEntry("task-completion-intent", {
		completionId: "restored",
		ownerId: "owner-1-0",
		taskId: "task-1-0-0",
		terminalSequence: "1",
		result,
		display: false,
	});
	const receipt = (completionId: string, taskId: string): SettlementReceipt => ({
		taskId: taskId as TaskId,
		cursor: { generation: "1" as Generation, sequence: "2" as Sequence },
		result,
		completionId,
	});
	let refuse = true;
	const delivered: string[] = [];
	const outbox = new TaskCompletionOutbox(
		session,
		() => true,
		async (envelope) => {
			if (envelope.completionId !== "refused" || !refuse) return;
			refuse = false;
			throw new Error("not admitted yet");
		},
		(envelope) => delivered.push(envelope.taskId),
	);
	assert.equal(await outbox.flushRestored(), 1);
	assert.deepEqual(delivered, []);
	outbox.record("owner-1-0" as OwnerId, receipt("live", "task-1-0-1"));
	outbox.record("owner-1-0" as OwnerId, receipt("refused", "task-1-0-2"));
	await outbox.flush();
	assert.deepEqual(delivered, ["task-1-0-1"]);
	await outbox.flush();
	assert.deepEqual(delivered, ["task-1-0-1", "task-1-0-2"]);
});

test("a task whose task owner the session replaced still delivers its completion notice (#4385)", async () => {
	const harness = await createHarness();
	try {
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("ok")));
		const [agent] = await startAgents(harness, 0, 1);
		assert.ok(agent);
		replaceSessionTaskOwner(harness.session as unknown as AgentSessionInternalSurface);
		finishAgents([agent], 0);
		await delivered(harness, 1);
		assert.ok(cards(harness).has(agent.taskId));
	} finally {
		await harness.cleanup();
	}
});
