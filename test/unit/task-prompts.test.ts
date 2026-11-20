import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { OperationId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { readTaskPrompts } from "../../packages/coding-agent/src/core/tasks/task-prompts.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { taskFixture } from "../helpers/task-projection.js";

type Fixture = ReturnType<typeof taskFixture>;

/** A subagent's attempt, launched (or resumed, `resumeOf` its first attempt's operation) and bound to `session`. */
async function attempt(fixture: Fixture, session: TaskTranscriptSource, resumeOf?: string): Promise<string> {
	const operation = resumeOf === undefined ? randomUUID() : `${resumeOf}:resume:${randomUUID()}`;
	const lease = await fixture.supervisor.startAgentTask(
		fixture.owner,
		{ kind: "agent", agent: "worker", task: "trace the loader" },
		operation as OperationId,
	);
	assert.ok(lease.ok);
	fixture.store.drain();
	fixture.runners.at(-1)!.context.bindTranscript(session);
	return operation;
}

function live(session: SessionManager): TaskTranscriptSource {
	return Object.assign(session, { subscribe: () => () => {} });
}

async function say(session: SessionManager, role: "user" | "assistant", text: string, rawText?: string) {
	await session.appendMessage(
		role === "user"
			? { role, content: [{ type: "text", text }], timestamp: 0, ...(rawText === undefined ? {} : { rawText }) }
			: {
					role,
					content: [{ type: "text", text }],
					api: "faux",
					provider: "faux",
					model: "faux",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
	);
}

test("a subagent's prompts are its own user messages, oldest first: its task, then what was sent to it, as typed", async () => {
	const fixture = taskFixture();
	try {
		const session = SessionManager.inMemory();
		await attempt(fixture, live(session));
		await say(session, "user", "trace the loader");
		await say(session, "assistant", "Tracing.");
		await session.appendCustomMessageEntry("intercom_message", "a message from another agent", true);
		await say(session, "user", "<skill>expanded</skill> look closer", "/skill:review look closer");
		await say(session, "user", "now the cache");
		const source = ownerTaskViewSource(fixture.store);
		const taskId = fixture.store.tasks[0]!.ref.taskId;
		assert.deepEqual(await readTaskPrompts(source, taskId), [
			"trace the loader",
			"/skill:review look closer",
			"now the cache",
		]);
	} finally {
		await fixture.dispose();
	}
});

test("a forked subagent's prompts leave out the conversation it inherited from the main chat", async () => {
	const fixture = taskFixture();
	try {
		const session = SessionManager.inMemory();
		await say(session, "user", "a main chat prompt");
		await say(session, "assistant", "A main chat answer.");
		await attempt(fixture, live(session));
		await say(session, "user", "trace the loader");
		const source = ownerTaskViewSource(fixture.store);
		assert.deepEqual(await readTaskPrompts(source, fixture.store.tasks[0]!.ref.taskId), ["trace the loader"]);
	} finally {
		await fixture.dispose();
	}
});

test("a resumed subagent's prompts are the whole conversation's, the inherited part still left out while its launch is listed", async () => {
	const fixture = taskFixture();
	try {
		const session = SessionManager.inMemory();
		await say(session, "user", "a main chat prompt");
		const launch = await attempt(fixture, live(session));
		await say(session, "user", "trace the loader");
		await say(session, "assistant", "Done.");
		await fixture.settle(0);
		await attempt(fixture, live(session), launch);
		await say(session, "user", "resume note");
		const source = ownerTaskViewSource(fixture.store);
		const resumed = fixture.store.tasks.find((task) => task.launchOperationId.includes(":resume:"))!;
		assert.deepEqual(await readTaskPrompts(source, resumed.ref.taskId), ["trace the loader", "resume note"]);
		assert.deepEqual(await readTaskPrompts(source, fixture.store.tasks[0]!.ref.taskId), [
			"trace the loader",
			"resume note",
		]);
	} finally {
		await fixture.dispose();
	}
});

test("a finished subagent whose history is only saved has its prompts read from there", async () => {
	const fixture = taskFixture();
	try {
		const saved = SessionManager.inMemory();
		await say(saved, "user", "trace the loader");
		await say(saved, "assistant", "Done.");
		await say(saved, "user", "and the cache");
		const transcript: TaskTranscriptSource = {
			getSessionId: () => saved.getSessionId(),
			getEntries: () => [],
			loadHistory: async () => ({ entries: saved.getEntries() }),
		};
		await attempt(fixture, transcript);
		const source = ownerTaskViewSource(fixture.store);
		const read = readTaskPrompts(source, fixture.store.tasks[0]!.ref.taskId);
		assert.ok(read instanceof Promise);
		assert.deepEqual(await read, ["trace the loader", "and the cache"]);
	} finally {
		await fixture.dispose();
	}
});

test("a subagent with no readable session has no prompts, and a failed read gives none", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("no transcript yet");
		const source = ownerTaskViewSource(fixture.store);
		assert.deepEqual(await readTaskPrompts(source, fixture.store.tasks[0]!.ref.taskId), []);
		const failing: TaskTranscriptSource = {
			getSessionId: () => "gone",
			getEntries: () => [],
			loadHistory: async () => {
				throw new Error("store closed");
			},
		};
		await attempt(fixture, failing);
		assert.deepEqual(await readTaskPrompts(source, fixture.store.tasks[1]!.ref.taskId), []);
	} finally {
		await fixture.dispose();
	}
});
