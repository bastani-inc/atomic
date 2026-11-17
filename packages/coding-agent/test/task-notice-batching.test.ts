import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { TASK_COMPLETION_MESSAGE_TYPE } from "../src/core/tasks/completion.js";
import type { OperationId, TaskId, TaskResult } from "../src/core/tasks/contracts.js";
import type { BashToolDetails } from "../src/core/tools/bash.js";
import { createHarness, type Harness } from "./suite/harness.js";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) {
		const harness = harnesses.pop()!;
		await harness.session.closeSessionTasks().catch(() => {});
		await harness.cleanup();
	}
});

const shellName = process.platform === "win32" ? "powershell" : "bash";
const waitingCommand =
	process.platform === "win32"
		? "$value = [Console]::ReadLine(); Write-Output 'shell done'"
		: "read value; printf 'shell done'";

async function chat(): Promise<Harness> {
	const harness = await createHarness();
	harnesses.push(harness);
	return harness;
}

async function startBackground(session: AgentSession): Promise<TaskId> {
	const shell = session.agent.state.tools.find((tool) => tool.name === shellName);
	assert.ok(shell, `${shellName} is registered`);
	const result = await shell.execute("launch", {
		command: waitingCommand,
		wait: { kind: "background" },
		timeout: 30,
	});
	const observation = (result.details as BashToolDetails).observation;
	assert.equal(observation?.kind, "yielded");
	return observation.taskId;
}

async function finish(session: AgentSession, id: TaskId): Promise<void> {
	const host = session.getAgentTaskHost();
	const task = host.resolveTask(id);
	assert.ok(task.ok);
	const { supervisor } = host.ownerBinding;
	const input = supervisor.taskStdin(task.value);
	assert.ok(input.ok);
	const written = await supervisor.writeTaskInput(input.value, crypto.randomUUID() as OperationId, {
		kind: "bytes",
		bytes: Buffer.from("go\n"),
	});
	assert.ok(written.ok);
}

function noticeEntries(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === TASK_COMPLETION_MESSAGE_TYPE);
}

function acknowledged(harness: Harness): number {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "task-completion-ack").length;
}

/** The task ids a model request carried in its task notices. */
function noticedTasks(text: string): string[] {
	return [...text.matchAll(/Task: (task-[\w-]+)/g)].map((match) => match[1]!);
}

/** The task ids the notices at the end of a model request named: those it was started with. */
function requestNotices(messages: readonly { role: string; content?: unknown }[]): string[] {
	const trailing: string[] = [];
	for (const message of [...messages].reverse()) {
		const tasks = noticedTasks(JSON.stringify(message.content ?? ""));
		if (message.role !== "user" || tasks.length === 0) break;
		trailing.unshift(...tasks);
	}
	return trailing;
}

test("tasks that finish together reach an idle chat in one request and start one turn", async () => {
	const harness = await chat();
	const seen: string[][] = [];
	harness.setResponses([
		(context) => {
			seen.push(requestNotices(context.messages));
			return fauxAssistantMessage("All three tasks finished.");
		},
	]);
	const host = harness.session.getAgentTaskHost();
	const gates: PromiseWithResolvers<TaskResult>[] = [];
	const ids: TaskId[] = [];
	for (let index = 0; index < 3; index++) {
		const gate = Promise.withResolvers<TaskResult>();
		gates.push(gate);
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: `task ${index}` },
			`together-${index}` as OperationId,
			() => ({ result: gate.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) }),
		);
		assert.ok(started.ok);
		ids.push(started.value.taskId);
		await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
	}

	for (const gate of gates) gate.resolve({ kind: "failed", code: "fixture", message: "done" });
	await vi.waitFor(() => assert.equal(acknowledged(harness), 3), { timeout: 15000 });
	await harness.session.agent.waitForIdle();

	assert.equal(noticeEntries(harness).length, 3, "one notice line per task");
	assert.equal(harness.faux.state.callCount, 1, "one model request");
	assert.equal(harness.eventsOfType("agent_start").length, 1, "one turn");
	assert.deepEqual(seen, [ids], "the request carried every notice");
});

test("a partial batch write still delivers every saved notice to the model (#5342)", async () => {
	const harness = await chat();
	const seen = new Set<string>();
	harness.setResponses(
		Array.from({ length: 4 }, () => (context: { messages: readonly { role: string; content?: unknown }[] }) => {
			for (const id of requestNotices(context.messages)) seen.add(id);
			return fauxAssistantMessage("Noted.");
		}),
	);
	const host = harness.session.getAgentTaskHost();
	const gates: PromiseWithResolvers<TaskResult>[] = [];
	const ids: TaskId[] = [];
	const start = async (name: string) => {
		const gate = Promise.withResolvers<TaskResult>();
		gates.push(gate);
		const started = await host.startAgentTask(
			{ kind: "agent", agent: "worker", task: name },
			`batch-${name}` as OperationId,
			() => ({ result: gate.promise, cleanup: Promise.resolve({ kind: "reaped" as const }) }),
		);
		assert.ok(started.ok);
		ids.push(started.value.taskId);
		await host.observeAgentLaunch(started.value.taskId, { kind: "background" });
	};
	for (const name of ["a", "b", "c"]) await start(name);
	const manager = harness.sessionManager;
	const append = manager.appendCustomMessageEntry.bind(manager);
	let noticeWrites = 0;
	vi.spyOn(manager, "appendCustomMessageEntry").mockImplementation(async (...args) => {
		if (args[0] === TASK_COMPLETION_MESSAGE_TYPE && ++noticeWrites === 2)
			throw new Error("SQLITE_BUSY: database is locked");
		return append(...args);
	});

	for (const gate of gates) gate.resolve({ kind: "failed", code: "fixture", message: "done" });
	await vi.waitFor(() => assert.ok(noticeWrites >= 2), { timeout: 15000 });
	await harness.session.agent.waitForIdle();
	await start("d");
	gates.at(-1)!.resolve({ kind: "failed", code: "fixture", message: "done" });
	await vi.waitFor(() => assert.equal(acknowledged(harness), 4), { timeout: 15000 });
	await harness.session.agent.waitForIdle();

	assert.equal(noticeEntries(harness).length, 4);
	assert.deepEqual([...seen].sort(), [...ids].sort(), "the model reads every acknowledged notice");
});

test("notices that arrive while the chat works are read within its turn, with no turn of their own", async () => {
	const harness = await chat();
	const ids = [await startBackground(harness.session), await startBackground(harness.session)];
	const answering = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<void>();
	const seen = new Set<string>();
	harness.setResponses([
		async () => {
			answering.resolve();
			await answer.promise;
			return fauxAssistantMessage("Working on your request.");
		},
		...Array.from({ length: 2 }, () => (context: { messages: readonly { role: string; content?: unknown }[] }) => {
			for (const id of requestNotices(context.messages)) seen.add(id);
			return fauxAssistantMessage("Read the notice.");
		}),
	]);

	const turn = harness.session.prompt("do something long");
	await answering.promise;
	await finish(harness.session, ids[0]!);
	await vi.waitFor(() => assert.equal(acknowledged(harness), 1), { timeout: 15000 });
	await finish(harness.session, ids[1]!);
	await vi.waitFor(() => assert.equal(acknowledged(harness), 2), { timeout: 15000 });
	answer.resolve();
	await turn;
	await harness.session.agent.waitForIdle();

	assert.equal(noticeEntries(harness).length, 2, "one notice line per shell");
	assert.equal(harness.eventsOfType("agent_start").length, 1, "they started no turn of their own");
	assert.deepEqual([...seen].sort(), [...ids].sort(), "the turn read both");
});
