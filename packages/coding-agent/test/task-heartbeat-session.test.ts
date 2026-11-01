import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { OperationId, TaskId } from "../src/core/tasks/contracts.js";
import type { TaskHeartbeatDetails } from "../src/core/tasks/heartbeat.js";
import type { BashToolDetails } from "../src/core/tools/bash.js";
import { createHarness, type Harness } from "./suite/harness.js";

const MINUTE = 60_000;
const harnesses: Harness[] = [];

afterEach(async () => {
	vi.useRealTimers();
	for (const harness of harnesses.splice(0)) {
		await harness.session.closeSessionTasks();
		harness.cleanup();
	}
});

async function sessionHarness(settings: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	const harness = await createHarness({
		initialActiveToolNames: ["bash"],
		...settings,
		settings: { bashInterceptor: { enabled: false }, ...settings.settings },
	});
	harnesses.push(harness);
	return harness;
}

function bash(session: AgentSession) {
	const registered = session.agent.state.tools.find((item) => item.name === "bash");
	assert.ok(registered, "bash must be registered on the session");
	return registered;
}

async function launch(session: AgentSession, args: Record<string, unknown>): Promise<TaskId> {
	const result = await bash(session).execute("launch", { wait: { kind: "background" }, timeout: 600, ...args });
	const observation = (result.details as BashToolDetails).observation;
	assert.equal(observation?.kind, "yielded");
	return observation.taskId;
}

function taskRecord(session: AgentSession, taskId: TaskId) {
	const watched = session.getAgentTaskHost().watchOwnerTasks();
	assert.ok(watched.ok);
	try {
		return watched.value.snapshot.tasks.find((task) => task.ref.taskId === taskId);
	} finally {
		watched.value.dispose();
	}
}

async function release(session: AgentSession, taskId: TaskId): Promise<void> {
	const host = session.getAgentTaskHost();
	const task = host.resolveTask(taskId);
	assert.ok(task.ok);
	const { supervisor } = host.ownerBinding;
	const input = supervisor.taskStdin(task.value);
	assert.ok(input.ok);
	await supervisor.writeTaskInput(input.value, crypto.randomUUID() as OperationId, {
		kind: "bytes",
		bytes: Buffer.from("done\n"),
	});
}

function heartbeatCards(session: AgentSession): TaskHeartbeatDetails[] {
	return session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === "task-heartbeat"
				? [entry.details as TaskHeartbeatDetails]
				: [],
		);
}

test.runIf(process.platform !== "win32")(
	"bash heartbeatMs is recorded on its task, and an out-of-range value is refused before launch",
	async () => {
		const { session } = await sessionHarness();
		session.pauseQueuedMessages();
		const taskId = await launch(session, { command: "read value", heartbeatMs: 2 * MINUTE });
		assert.equal(taskRecord(session, taskId)?.heartbeatMs, 2 * MINUTE);
		const disabled = await launch(session, { command: "read value", heartbeatMs: 0 });
		assert.equal(taskRecord(session, disabled)?.heartbeatMs, 0);
		for (const heartbeatMs of [1000, -1, Number.POSITIVE_INFINITY])
			await assert.rejects(
				bash(session).execute("invalid", {
					command: "echo never",
					wait: { kind: "background" },
					heartbeatMs,
				}),
				/Invalid heartbeatMs .*use 0 to disable task heartbeats, or a finite number of milliseconds of at least 60000/,
			);
		const watched = session.getAgentTaskHost().watchOwnerTasks();
		assert.ok(watched.ok);
		assert.equal(watched.value.snapshot.tasks.length, 2, "a refused call admits no task");
		watched.value.dispose();
		await release(session, taskId);
		await release(session, disabled);
	},
);

test.runIf(process.platform !== "win32")(
	"a long background shell heartbeats into the owning chat once per unread notice, then resumes after it is read",
	async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
		const harness = await sessionHarness({ settings: { tasks: { heartbeatMs: MINUTE } } });
		const { session } = harness;
		// Hold model turns so the first card stays unread.
		session.pauseQueuedMessages();
		const taskId = await launch(session, { command: "echo building; read value" });
		await vi.advanceTimersByTimeAsync(MINUTE + 1000);
		await vi.waitFor(() => assert.equal(heartbeatCards(session).length, 1), { timeout: 5000 });
		const [card] = heartbeatCards(session);
		assert.equal(card?.tasks[0]?.taskId, taskId);
		assert.equal(card?.tasks[0]?.kind, "command");
		assert.deepEqual(card?.tasks[0]?.output?.tail, ["building"]);

		// The owner has not read it: later boundaries do not stack more cards.
		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		assert.equal(heartbeatCards(session).length, 1);

		// Reading the card frees the slot; the owed heartbeat follows on the next check.
		harness.setResponses([fauxAssistantMessage("It is still building; continuing.")]);
		await session.resumeQueuedMessages();
		await session.prompt("Carry on.");
		const read = session.messages.filter(
			(message) =>
				message.role === "custom" &&
				message.customType === "atomic:protected-streaming-reconciliation" &&
				JSON.stringify(message.content).includes(`♥ Task heartbeat (shell ${taskId}: echo building; read value)`),
		);
		assert.equal(read.length, 1, "the model context received the heartbeat once");
		harness.setResponses([fauxAssistantMessage("Still fine.")]);
		await vi.advanceTimersByTimeAsync(30_000);
		await vi.waitFor(() => assert.equal(heartbeatCards(session).length, 2), { timeout: 5000 });
		assert.match(
			String(session.messages.findLast((message) => message.role === "custom")?.content),
			/still running after 4m, on a 1-minute cadence/,
		);

		await release(session, taskId);
		await session.getAgentTaskHost().waitForTask(taskId);
		const settled = heartbeatCards(session).length;
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		assert.equal(heartbeatCards(session).length, settled, "no heartbeat after the command finished");
	},
);

test.runIf(process.platform !== "win32")(
	"a heartbeat releases a tool call stuck waiting on its shell, so the model can act while the command keeps running",
	async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
		const harness = await sessionHarness();
		const { session } = harness;
		const taskId = await launch(session, { command: "read value", heartbeatMs: MINUTE });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { action: "wait", id: taskId, budgetMs: 3_600_000 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The command is waiting for input; leaving it running."),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const turn = session.prompt("Wait for the command.");
		await toolStarted;
		await vi.advanceTimersByTimeAsync(MINUTE + 1000);
		await turn;

		const result = session.messages.find((message) => message.role === "toolResult");
		assert.ok(result?.role === "toolResult");
		const observation = (result.details as BashToolDetails).observation;
		assert.equal(observation?.kind, "yielded", "the wait was released, not the command");
		assert.equal(observation.kind === "yielded" && observation.reason, "intercom-coordination");
		assert.equal(taskRecord(session, taskId)?.execution.kind, "running");
		assert.equal(heartbeatCards(session).length, 1);
		await release(session, taskId);
	},
);
