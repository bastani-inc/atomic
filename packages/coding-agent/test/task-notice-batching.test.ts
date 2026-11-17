import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { TASK_COMPLETION_MESSAGE_TYPE } from "../src/core/tasks/completion.js";
import type { OperationId, TaskId } from "../src/core/tasks/contracts.js";
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

test("background shells that finish together reach an idle chat as one notice message and start one turn", async () => {
	const harness = await chat();
	const seen: string[][] = [];
	harness.setResponses([
		(context) => {
			const last = context.messages.at(-1);
			seen.push(noticedTasks(JSON.stringify(last?.content ?? "")));
			return fauxAssistantMessage("All three shells finished.");
		},
	]);
	const ids = [
		await startBackground(harness.session),
		await startBackground(harness.session),
		await startBackground(harness.session),
	];

	await Promise.all(ids.map((id) => finish(harness.session, id)));
	await vi.waitFor(() => assert.equal(acknowledged(harness), 3), { timeout: 15000 });
	await harness.session.agent.waitForIdle();

	const entries = noticeEntries(harness);
	assert.equal(entries.length, 1, "one notice message in the transcript");
	assert.equal(harness.faux.state.callCount, 1, "one turn");
	assert.equal(harness.eventsOfType("agent_start").length, 1);
	assert.deepEqual(seen, [ids], "the model read every notice in that one message");
});

test("notices that arrive while the chat works wait for its turn, then reach it as one message and one turn", async () => {
	const harness = await chat();
	const ids = [await startBackground(harness.session), await startBackground(harness.session)];
	const answering = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<void>();
	const seen: string[][] = [];
	harness.setResponses([
		async () => {
			answering.resolve();
			await answer.promise;
			return fauxAssistantMessage("Working on your request.");
		},
		(context) => {
			seen.push(noticedTasks(JSON.stringify(context.messages.at(-1)?.content ?? "")));
			return fauxAssistantMessage("Both shells finished.");
		},
	]);

	const turn = harness.session.prompt("do something long");
	await answering.promise;
	await finish(harness.session, ids[0]!);
	await vi.waitFor(() => assert.ok(harness.sessionManager.getEntries().some((entry) => entry.type === "custom")));
	await new Promise((resolve) => setTimeout(resolve, 200));
	await finish(harness.session, ids[1]!);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(noticeEntries(harness).length, 0, "nothing reaches the chat while its turn runs");
	answer.resolve();
	await turn;
	await vi.waitFor(() => assert.equal(acknowledged(harness), 2), { timeout: 15000 });
	await harness.session.agent.waitForIdle();

	assert.equal(noticeEntries(harness).length, 1, "one notice message");
	assert.equal(harness.faux.state.callCount, 2, "the user's turn, then one turn for both notices");
	assert.deepEqual(seen, [ids]);
});
