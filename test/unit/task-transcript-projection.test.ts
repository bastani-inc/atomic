import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import {
	VERBATIM_COMPACTION_PROMPT_VERSION,
	type VerbatimCompactionDetails,
} from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	readSessionHistory,
	readSessionHistoryChunks,
} from "../../packages/coding-agent/src/core/storage/session/history-pages.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { OperationId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	type TaskLease,
	TaskSupervisor,
	type TaskTranscriptSource,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	readTaskTranscript,
	readTaskTranscriptSnapshot,
} from "../../packages/coding-agent/src/core/tasks/transcript.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { taskFixture } from "../helpers/task-projection.js";

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

test("a saved task chat requests a bounded page instead of loading its whole transcript (#5593)", async () => {
	const session = SessionManager.inMemory();
	for (let i = 0; i < 145; i++) await session.appendMessage({ role: "user", content: `saved-${i}`, timestamp: i });
	const fixture = taskFixture();
	try {
		await fixture.start("inspect a saved chat");
		fixture.runners[0].context.bindTranscript({
			getSessionId: () => session.getSessionId(),
			getEntries: () => [],
			readHistory: session.readHistory.bind(session),
			loadHistory: async () => {
				throw new Error("whole task transcript loaded");
			},
		});
		const view = ownerTaskViewSource(fixture.store),
			task = fixture.store.tasks[0]!.ref.taskId;
		const first = await view.readTaskTranscript(task);
		assert.ok(first.ok);
		assert.ok(first.value.messages.length > 0 && first.value.messages.length < 145);
		assert.ok(first.value.nextCursor);
		await session.appendMessage({ role: "user", content: "later", timestamp: 200 });
		const older = await view.readTaskTranscript(task, first.value.nextCursor);
		assert.ok(older.ok && older.value.newerCursor, "a reader cannot revisit a page once it evicts it");
		const forward = await view.readTaskTranscript(task, older.value.newerCursor);
		assert.ok(forward.ok);
		assert.deepEqual(forward.value.messages, first.value.messages, "a later append must not enter the pinned page");
		let all = [...first.value.messages],
			cursor: string | undefined = first.value.nextCursor;
		while (cursor) {
			const page = await view.readTaskTranscript(task, cursor);
			assert.ok(page.ok);
			all = [...page.value.messages, ...all];
			cursor = page.value.nextCursor;
		}
		assert.deepEqual(
			all.map((m) => (m.role === "user" ? m.content : m.role)),
			Array.from({ length: 145 }, (_, i) => `saved-${i}`),
		);
	} finally {
		await fixture.dispose();
		await session.getSessionStore().close();
	}
});

test("reading a saved task page keeps shell commands and visible extension messages (#5593)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({
		role: "bashExecution",
		command: "echo saved",
		output: "saved",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	});
	await session.appendMessage({ role: "custom", customType: "report", content: "shown", display: true, timestamp: 2 });
	await session.appendMessage({
		role: "custom",
		customType: "state",
		content: "hidden",
		display: false,
		timestamp: 3,
	});
	const fixture = taskFixture();
	try {
		await fixture.start("inspect a saved chat");
		fixture.runners[0].context.bindTranscript({
			getSessionId: () => session.getSessionId(),
			getEntries: () => [],
			readHistory: session.readHistory.bind(session),
			loadHistory: async () => {
				throw new Error("whole transcript loaded");
			},
		});
		const page = await ownerTaskViewSource(fixture.store).readTaskTranscript(fixture.store.tasks[0]!.ref.taskId);
		assert.ok(page.ok, "the transcript is not empty");
		assert.deepEqual(
			page.value.messages.map((m) =>
				m.role === "bashExecution" ? m.command : m.role === "custom" ? m.content : m.role,
			),
			["echo saved", "shown"],
		);
	} finally {
		await fixture.dispose();
		await session.getSessionStore().close();
	}
});

test("reading saved task references never loads the entire conversation (#5593)", async () => {
	const session = SessionManager.inMemory();
	const ids: string[] = [];
	for (let i = 0; i < 130; i++)
		ids.push(await session.appendMessage({ role: "user", content: `saved-${i}`, timestamp: i }));
	try {
		await withTranscript(
			{
				getSessionId: () => session.getSessionId(),
				getEntries: () => [],
				readHistory: session.readHistory.bind(session),
				loadHistory: async () => {
					throw new Error("whole archive read");
				},
			},
			async (task) => {
				let cursor: string | undefined,
					seen: string[] = [];
				do {
					const page = await readTaskTranscript(task, cursor);
					assert.ok(page.ok);
					assert.ok(page.value.items.length <= 100);
					seen = [...page.value.items.map((x) => x.source.entryId), ...seen];
					cursor = page.value.nextCursor;
				} while (cursor);
				assert.deepEqual(seen, ids);
			},
		);
	} finally {
		await session.getSessionStore().close();
	}
});

test("a raw task reference returns a legacy identifier larger than a page without reading its whole message (#5593)", async () => {
	const id = "r".repeat(1024 * 1024 + 17),
		store = new MemorySessionStore();
	await store.create({ version: 4, id: "wide", createdAt: "2026-01-01T00:00:00Z", cwd: "/project" }, [
		{
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-01-01T00:00:01Z",
			message: { role: "user", content: "unrelated".repeat(320_000), timestamp: 1 },
		},
	]);
	store.readRange = async () => {
		throw new Error("giant body fetched");
	};
	try {
		await withTranscript(
			{
				getSessionId: () => "wide",
				getEntries: () => [],
				readHistory: (opts) => readSessionHistory(store, "wide", opts),
				readHistoryChunks: (item, opts) => readSessionHistoryChunks(store, item, opts),
				loadHistory: async () => {
					throw new Error("whole archive read");
				},
			},
			async (task) => {
				const page = await readTaskTranscript(task);
				assert.ok(page.ok);
				assert.equal(page.value.items.length, 1);
				const [row] = page.value.items;
				assert.equal(row.kind, "prompt");
				assert.equal(row.id, id);
				assert.deepEqual(row.source, { sessionId: "wide", entryId: id });
				assert.equal(page.value.nextCursor, undefined);
			},
		);
	} finally {
		await store.close();
	}
});

test("a legacy task cursor can continue inside an oversized failed assistant reply, retaining the original content indices (#5593)", async () => {
	const store = new MemorySessionStore();
	const message = fauxAssistantMessage("unused");
	message.content = Array.from({ length: 141 }, (_, i) =>
		i === 8
			? { type: "toolCall", id: "call-eight", name: "read", arguments: { irrelevant: "x".repeat(2 * 1024 * 1024) } }
			: i === 100
				? { type: "thinking", thinking: "large" }
				: { type: "text", text: `part-${i}` },
	);
	message.stopReason = "error";
	await store.create({ version: 4, id: "blocks", createdAt: "2026-01-01T00:00:00Z", cwd: "/project" }, [
		{ type: "message", id: "id:with:colon", parentId: null, timestamp: "2026-01-01T00:00:01Z", message },
	]);
	try {
		await withTranscript(
			{
				getSessionId: () => "blocks",
				getEntries: () => [],
				readHistory: (opts) => readSessionHistory(store, "blocks", opts),
				readHistoryChunks: (item, opts) => readSessionHistoryChunks(store, item, opts),
				loadHistory: async () => {
					throw new Error("whole archive read");
				},
			},
			async (task) => {
				const end = await readTaskTranscript(task);
				assert.ok(end.ok && end.value.nextCursor);
				assert.equal(end.value.items[0].id, "id:with:colon:41");
				assert.equal(end.value.items[59].kind, "thinking");
				const earlier = await readTaskTranscript(task, end.value.nextCursor);
				assert.ok(earlier.ok);
				assert.equal(earlier.value.items.length, 41);
				assert.deepEqual(earlier.value.items[8], {
					id: "id:with:colon:8",
					kind: "tool-call",
					toolCallId: "call-eight",
					source: { sessionId: "blocks", entryId: "id:with:colon", contentIndex: 8 },
				});
				assert.equal(earlier.value.items.at(-1)?.id, "id:with:colon:40");
				assert.equal(earlier.value.nextCursor, undefined);
			},
		);
	} finally {
		await store.close();
	}
});

test("a raw reference page verifies distant duplicate IDs using metadata, without fetching earlier complete messages (#5593)", async () => {
	const store = new MemorySessionStore();
	const ids = ["A", ...Array.from({ length: 300 }, (_, i) => `B-${i}`), "A"];
	await store.create(
		{ version: 4, id: "distant", cwd: "/project", createdAt: "2026-01-01T00:00:00Z" },
		ids.map((id) => ({
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-01-01T00:00:01Z",
			message: { role: "user", content: "unselected payload", timestamp: 1 },
		})),
	);
	const range = store.readRange.bind(store);
	let earliest = Infinity;
	store.readRange = async (id, a, b, epoch) => {
		earliest = Math.min(earliest, a);
		return range(id, a, b, epoch);
	};
	try {
		await withTranscript(
			{
				getSessionId: () => "distant",
				getEntries: () => [],
				readHistory: (opts) => readSessionHistory(store, "distant", opts),
				readHistoryChunks: (item, opts) => readSessionHistoryChunks(store, item, opts),
				loadHistory: async () => {
					throw new Error("whole archive read");
				},
			},
			async (task) => {
				const latest = await readTaskTranscript(task);
				assert.ok(latest.ok);
				assert.deepEqual(
					latest.value.items.map((i) => i.id),
					ids.slice(201, 301),
				);
				assert.ok(earliest > 128, `earlier complete rows were read from ${earliest}`);
				let all = latest.value.items,
					cur = latest.value.nextCursor;
				while (cur) {
					const page = await readTaskTranscript(task, cur);
					assert.ok(page.ok);
					all = [...page.value.items, ...all];
					cur = page.value.nextCursor;
				}
				assert.deepEqual(
					all.map((i) => i.id),
					ids.slice(0, -1),
				);
			},
		);
	} finally {
		await store.close();
	}
});

test("saved task references retain the first occurrence of a repeated public item id (#5593)", async () => {
	const store = new MemorySessionStore();
	const raw = (id: string) => ({
		type: "message" as const,
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:01Z",
		message: { role: "user" as const, content: id, timestamp: 1 },
	});
	await store.create({ version: 4, id: "repeated", createdAt: "2026-01-01T00:00:00Z", cwd: "/project" }, [
		raw("repeated"),
		raw("middle"),
		raw("repeated"),
	]);
	try {
		await withTranscript(
			{
				getSessionId: () => "repeated",
				getEntries: () => [],
				readHistory: (opts) => readSessionHistory(store, "repeated", opts),
				loadHistory: async () => {
					throw new Error("whole archive read");
				},
			},
			async (task) => {
				const page = await readTaskTranscript(task);
				assert.ok(page.ok);
				assert.deepEqual(
					page.value.items.map((i) => i.id),
					["repeated", "middle"],
				);
			},
		);
	} finally {
		await store.close();
	}
});

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

test("paging a successful reply consumes its provider status only once (#5651)", async () => {
	const session = SessionManager.inMemory();
	const reply = fauxAssistantMessage("done");
	reply.content = Array.from({ length: 101 }, () => ({ type: "thinking", thinking: "reasoning" }));
	await session.appendMessage(reply);
	let reads = 0;
	Object.defineProperty(reply, "stopReason", {
		enumerable: true,
		get() {
			assert.equal(++reads, 1, "provider status already consumed");
			return "stop";
		},
	});
	const fixture = taskFixture();
	try {
		await fixture.start();
		fixture.runners[0].context.bindTranscript(session);
		const page = await ownerTaskViewSource(fixture.store).readTaskTranscript(fixture.runners[0].context.ref.taskId);
		assert.ok(page.ok && page.value.nextCursor);
		const message = page.value.messages[0];
		assert.ok(message.role === "assistant");
		assert.equal(message.stopReason, "stop");
		assert.equal(message.content.length, 100);
	} finally {
		await fixture.dispose();
	}
});

test("a cursor from another task never inspects the supplied history rows (#5651)", async () => {
	const fixture = taskFixture();
	const session = SessionManager.inMemory();
	try {
		const first = await fixture.start("First task");
		const second = await fixture.start("Second task");
		for (let i = 0; i < 101; i++) await session.appendMessage({ role: "user", content: `row ${i}`, timestamp: i });
		fixture.runners[0].context.bindTranscript(session);
		let inspected = 0;
		const rows = session.getEntries().map(
			(entry) =>
				new Proxy(entry, {
					get(target, property, receiver) {
						inspected++;
						return Reflect.get(target, property, receiver);
					},
				}),
		);
		fixture.runners[1].context.bindTranscript({
			getSessionId: () => "other-session",
			getEntries: () => rows,
			loadHistory: async () => ({ entries: rows }),
		});
		const page = await readTaskTranscript(first);
		assert.ok(page.ok && page.value.nextCursor);
		const source = ownerTaskViewSource(fixture.store);
		inspected = 0;
		const cursor = page.value.nextCursor;
		for (const refused of [await readTaskTranscript(second, cursor), readTaskTranscriptSnapshot(second, cursor)]) {
			assert.ok(!refused.ok);
			assert.equal(refused.error.code, "ScopeMismatch");
		}
		const view = await source.readTaskTranscript(fixture.runners[1].context.ref.taskId, page.value.nextCursor);
		assert.ok(!view.ok);
		assert.equal(inspected, 0);
	} finally {
		await fixture.dispose();
	}
});

// RFC #2884: tool references keep original toolCallId. Thinking blocks are referenced by position, so a task
// transcript follows the reader's thinking display like the other chats do (#4521).
test("assistant thinking, tool calls and results are referenced by position (#4521)", async () => {
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
				id: `${entryId}:0`,
				kind: "thinking",
				source: { sessionId: session.getSessionId(), entryId, contentIndex: 0 },
			},
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

const verbatimDetails: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: VERBATIM_COMPACTION_PROMPT_VERSION,
	parameters: { query: "test" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
	form: "cleared",
};

test("compaction boundaries, branch summaries and displayed custom messages enter the transcript index (#4521)", async () => {
	const session = SessionManager.inMemory();
	const prompt = await session.appendMessage({ role: "user", content: "start", timestamp: 1 });
	const notice = await session.appendCustomMessageEntry("extension-notice", "shown to the reader", true);
	await session.appendCustomMessageEntry("hidden-context", "model only", false);
	const boundary = await session.appendCompaction("kept line", prompt, 100, verbatimDetails);
	const summary = await session.branchWithSummary(prompt, "what the abandoned branch did");
	await session.branchWithSummary(prompt, "");
	await withTranscript(session, async (task) => {
		const page = await readTaskTranscript(task);
		assert.ok(page.ok);
		const source = (entryId: string) => ({ sessionId: session.getSessionId(), entryId });
		assert.deepEqual(page.value.items, [
			{ id: prompt, kind: "prompt", source: source(prompt) },
			{ id: notice, kind: "custom-message", source: source(notice) },
			{ id: boundary, kind: "compaction", source: source(boundary) },
			{ id: summary, kind: "branch-summary", source: source(summary) },
		]);
	});
});

test("a summary-only or legacy compaction without a renderable boundary takes no place in the page (#4521)", async () => {
	const session = SessionManager.inMemory();
	const prompt = await session.appendMessage({ role: "user", content: "start", timestamp: 1 });
	await session.appendCompaction("summary", prompt, 100, {
		...verbatimDetails,
		strategy: "summary",
	} as unknown as VerbatimCompactionDetails);
	await withTranscript(session, async (task) => {
		const page = await readTaskTranscript(task);
		assert.ok(page.ok);
		assert.deepEqual(
			page.value.items.map((item) => item.kind),
			["prompt"],
		);
	});
});

test("a live task's saved pages include the answer and clear on a branch the child left (#5593)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "before retained span", timestamp: 0 });
	const first = await session.appendMessage({ role: "user", content: "chosen root", timestamp: 1 });
	await session.appendMessage(fauxAssistantMessage("archived provider answer"));
	await session.appendCompaction("archived clear", first, 40, verbatimDetails);
	await session.branchWithSummary(first, "new branch");
	const fixture = taskFixture();
	try {
		await fixture.start();
		fixture.runners[0].context.bindTranscript({
			getSessionId: () => session.getSessionId(),
			getEntries: () => session.getTaskTranscriptEntries(),
			getEarlierCursor: () => session.getEarlierCursor(),
			readHistory: session.readHistory.bind(session),
			subscribe: () => () => {},
		});
		const view = ownerTaskViewSource(fixture.store),
			task = fixture.store.tasks[0]!.ref.taskId;
		const current = await view.readTaskTranscript(task);
		assert.ok(current.ok && current.value.nextCursor);
		assert.deepEqual(
			current.value.messages.map((m) => m.role),
			["branchSummary"],
		);
		const earlier = await view.readTaskTranscript(task, current.value.nextCursor);
		assert.ok(earlier.ok);
		assert.deepEqual(
			earlier.value.messages.map((m) => m.role),
			["user", "user", "assistant", "custom"],
		);
		assert.match(JSON.stringify(earlier.value.messages), /archived provider answer/);
		assert.match(JSON.stringify(earlier.value.messages), /archived clear/);
	} finally {
		await fixture.dispose();
		await session.getSessionStore().close();
	}
});

test("the task view reads informational entries and thinking as chats render them, with compaction on the latest page (#4521)", async () => {
	const session = SessionManager.inMemory();
	for (let i = 0; i < 101; i++) await session.appendMessage({ role: "user", content: `early-${i}`, timestamp: i });
	const prompt = await session.appendMessage({ role: "user", content: "start", timestamp: 200 });
	await session.appendMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "visible reasoning" },
			{ type: "text", text: "done" },
		],
		api: "openai-completions",
		provider: "openai",
		model: "fixture",
		stopReason: "stop",
		timestamp: 201,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	await session.appendCustomMessageEntry("extension-notice", "notice text", true);
	await session.appendCompaction("kept line", prompt, 100, verbatimDetails);
	// This synchronous source owns its complete records, independently of the manager's current branch.
	const recorded: ReturnType<SessionManager["getEntries"]> = [];
	for await (const { items } of session.readHistory())
		for (const item of items) if ("entry" in item) recorded.push(item.entry);
	const summaryId = await session.branchWithSummary(prompt, "summary text");
	recorded.push(session.getEntry(summaryId)!);
	const fixture = taskFixture();
	try {
		await fixture.start("Read informational entries");
		fixture.runners[0].context.bindTranscript({
			getSessionId: () => session.getSessionId(),
			getEntries: () => recorded,
			getCompactionReason: () => "threshold",
		});
		const view = ownerTaskViewSource(fixture.store);
		const taskId = fixture.store.tasks[0]!.ref.taskId;
		const latest = view.readTaskTranscript(taskId);
		assert.ok(!(latest instanceof Promise) && latest.ok);
		assert.equal(latest.value.compactionReason, "threshold");
		const tail = latest.value.messages.slice(-5);
		assert.deepEqual(
			tail.map((message) => message.role),
			["user", "assistant", "custom", "custom", "branchSummary"],
		);
		const reply = tail[1];
		assert.ok(reply?.role === "assistant");
		assert.deepEqual(
			reply.content.map((block) => block.type),
			["thinking", "text"],
		);
		assert.deepEqual(
			tail.slice(2, 4).map((message) => (message.role === "custom" ? message.customType : undefined)),
			["extension-notice", "compaction"],
		);
		assert.ok(latest.value.nextCursor);
		const earlier = view.readTaskTranscript(taskId, latest.value.nextCursor);
		assert.ok(!(earlier instanceof Promise) && earlier.ok);
		assert.equal(earlier.value.compactionReason, undefined, "only the latest page describes the session now");
		assert.equal(earlier.value.messages.length, 7, "107 items leave seven before the latest hundred");
	} finally {
		await fixture.dispose();
	}
});
