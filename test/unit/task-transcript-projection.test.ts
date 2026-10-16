import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { OperationId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	type TaskLease,
	TaskSupervisor,
	type TaskTranscriptSource,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { readTaskTranscript } from "../../packages/coding-agent/src/core/tasks/transcript.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

async function withTranscript(source: TaskTranscriptSource | undefined, check: (task: TaskLease) => Promise<void>) {
	const supervisor = new TaskSupervisor();
	const scope = { kind: "session" as const, sessionId: randomUUID() };
	const host = supervisor.bindHostSession({
		scope,
		authorizeLaunch() {},
		createRunner(context) {
			if (source) context.bindTranscript(source);
			return {
				result: Promise.resolve({ kind: "failed" as const, code: "Fixture", message: "done" }),
				cleanup: Promise.resolve({ kind: "reaped" as const }),
			};
		},
	});
	const owner = supervisor.openTaskOwner(host, scope);
	assert.ok(owner.ok);
	try {
		const task = await supervisor.startAgentTask(
			owner.value,
			{ kind: "agent", agent: "worker", task: " raw " },
			randomUUID() as OperationId,
		);
		assert.ok(task.ok);
		await check(task.value);
	} finally {
		assert.ok((await supervisor.closeTaskOwner(owner.value, "session-close")).ok);
	}
}

// RFC #2884: references retain source identity rather than constructing transcript text.
test("transcript references use authorized session entries and preserve repeated prompts", async () => {
	const session = SessionManager.inMemory();
	await withTranscript(session, async (task) => {
		assert.deepEqual(await readTaskTranscript(task), {
			ok: false,
			error: { code: "TranscriptUnavailable", message: "Transcript unavailable" },
		});
		const first = await session.appendMessage({ role: "user", content: " raw ", timestamp: 1 });
		const second = await session.appendMessage({ role: "user", content: " raw ", timestamp: 2 });
		const page = await readTaskTranscript(task);
		assert.ok(page.ok);
		assert.deepEqual(page.value, {
			items: [first, second].map((entryId) => ({
				id: entryId,
				kind: "prompt",
				source: { sessionId: session.getSessionId(), entryId },
			})),
			omittedEarlier: false,
		});
		assert.equal(session.getEntries().filter((entry) => entry.type === "message").length, 2);
	});
});

// RFC #2884: no made-up messages when the admitted runner captured nothing.
test("unbound and unknown task transcripts are unavailable without looking up arbitrary sessions", async () => {
	await withTranscript(undefined, async (task) => {
		const result = await readTaskTranscript(task);
		assert.ok(!result.ok);
		assert.equal(result.error.code, "TranscriptUnavailable");
	});
	const result = await readTaskTranscript({} as TaskLease);
	assert.ok(!result.ok);
	assert.equal(result.error.code, "UnknownTask");
});

// RFC #2884: paging references older records without truncating the authoritative session.
test("transcript pages have opaque task scoped cursors and omit duplicate source identities only", async () => {
	const session = SessionManager.inMemory();
	const ids = await Promise.all(
		Array.from(
			{ length: 105 },
			async (_, timestamp) => await session.appendMessage({ role: "user", content: "same", timestamp }),
		),
	);
	const source: TaskTranscriptSource = {
		getSessionId: () => session.getSessionId(),
		getEntries: () => [...session.getEntries(), ...session.getEntries()],
	};
	await withTranscript(source, async (task) => {
		const recent = await readTaskTranscript(task);
		assert.ok(recent.ok);
		assert.equal(recent.value.omittedEarlier, true);
		assert.deepEqual(
			recent.value.items.map((item) => item.id),
			ids.slice(5),
		);
		assert.ok(recent.value.nextCursor);
		const earlier = await readTaskTranscript(task, recent.value.nextCursor);
		assert.ok(earlier.ok);
		assert.deepEqual(
			earlier.value.items.map((item) => item.id),
			ids.slice(0, 5),
		);
		assert.equal(earlier.value.omittedEarlier, false);
		assert.ok(!("nextCursor" in earlier.value));
		await withTranscript(session, async (other) => {
			const wrong = await readTaskTranscript(other, recent.value.nextCursor);
			assert.ok(!wrong.ok);
			assert.equal(wrong.error.code, "ScopeMismatch");
		});
	});
});

// RFC #2884: tool references keep original toolCallId and never disclose reasoning.
test("assistant tool calls and results correlate while hidden reasoning is absent", async () => {
	const session = SessionManager.inMemory();
	const entryId = await session.appendMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hidden" },
			{ type: "toolCall", id: "call", name: "bash", arguments: { command: " raw " } },
			{ type: "text", text: "working" },
		],
		api: "openai-completions",
		provider: "openai",
		model: "fixture",
		stopReason: "toolUse",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const resultId = await session.appendMessage({
		role: "toolResult",
		toolCallId: "call",
		toolName: "bash",
		content: [{ type: "text", text: "" }],
		isError: false,
		timestamp: 2,
	});
	await withTranscript(session, async (task) => {
		const page = await readTaskTranscript(task);
		assert.ok(page.ok);
		assert.deepEqual(page.value.items, [
			{
				id: `${entryId}:1`,
				kind: "tool-call",
				source: { sessionId: session.getSessionId(), entryId, contentIndex: 1 },
				toolCallId: "call",
			},
			{
				id: `${entryId}:2`,
				kind: "assistant",
				source: { sessionId: session.getSessionId(), entryId, contentIndex: 2 },
			},
			{
				id: resultId,
				kind: "tool-result",
				source: { sessionId: session.getSessionId(), entryId: resultId },
				toolCallId: "call",
			},
		]);
	});
});

// RFC #2884: persisted and live history refer to identical original entries.
test("persisted transcript references agree with live source and expose recorded response only", async () => {
	const directory = makeTempDirectory("task-transcript-");
	try {
		const session = await SessionManager.create(directory, directory);
		await session.appendMessage({ role: "user", content: " original ", timestamp: 1 });
		const response = await session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: " final " }],
			api: "openai-completions",
			provider: "openai",
			model: "fixture",
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const file = session.getSessionFile();
		assert.ok(file);
		const persisted = await SessionManager.open(file);
		await withTranscript(session, async (liveTask) => {
			const live = await readTaskTranscript(liveTask);
			assert.ok(live.ok);
			assert.equal(live.value.items.at(-1)?.id, `${response}:0`);
			assert.equal(live.value.items.at(-1)?.kind, "response");
			await withTranscript(persisted, async (persistedTask) =>
				assert.deepEqual(await readTaskTranscript(persistedTask), live),
			);
		});
	} finally {
		removeTempDirectory(directory);
	}
});
