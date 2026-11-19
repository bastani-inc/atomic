import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { pendingTaskCompletionIntents } from "../../packages/coding-agent/src/core/tasks/completion.js";
import { TaskCompletionMessage } from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { countingDatabase } from "../helpers/counting-database.js";

const cleared = {
	strategy: "verbatim-lines",
	form: "cleared",
	promptVersion: 7,
	parameters: { query: "clear" },
	stats: {
		linesBefore: 1,
		linesDeleted: 1,
		linesKept: 0,
		rangeCount: 0,
		tokensBefore: 300,
		tokensAfter: 20,
		percentReduction: 93,
	},
} as const;

async function compactedParent() {
	const store = new MemorySessionStore();
	const parent = await SessionManager.create(store, process.cwd());
	await parent.appendModelChange("provider", "parent-model");
	await parent.appendThinkingLevelChange("high");
	const retired = await parent.appendMessage({ role: "user", content: "retired", timestamp: 1 });
	await parent.appendCompaction(
		`Earlier conversation: history://sessions/${parent.getSessionId()}`,
		null,
		300,
		cleared,
	);
	const cut = await parent.appendMessage({ role: "user", content: "the current request", timestamp: 2 });
	return { store, parent, retired, cut };
}

test("a forked subagent writes the captured context and settings, not the pre-clear conversation (#5500)", async () => {
	const { store, parent, retired } = await compactedParent();
	const expected = parent.buildSessionContext();
	const launch = createForkContextResolver(parent, "fork");
	await parent.appendMessage({ role: "user", content: "after the launch", timestamp: 3 });
	const child = await launch.sessionManagerForIndex(0);
	assert.ok(child);
	assert.deepEqual(child.buildSessionContext(), expected);
	const saved = await SessionManager.open(store, child.getSessionId());
	assert.deepEqual(saved.buildSessionContext(), expected);
	assert.equal(saved.getHeader()?.parentSessionId, parent.getSessionId());
	assert.equal(saved.getEntry(retired), undefined, "the retired conversation was copied into the child's session");
	assert.ok((await SessionManager.open(store, parent.getSessionId())).getEntry(retired));
});

test("a store without a fork-window reader keeps its original child entries byte for byte (#5500)", async () => {
	const { store, parent } = await compactedParent();
	Object.defineProperty(store, "readForkWindow", { value: undefined });
	const original = (await store.load(parent.getSessionId())).entries;
	const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
	assert.ok(child);
	assert.equal(JSON.stringify((await store.load(child.getSessionId())).entries), JSON.stringify(original));
});

test("an uncovered turn survives without copying the payload of the entry the clear covers (#5500)", async () => {
	const store = new MemorySessionStore();
	const parent = await SessionManager.create(store, process.cwd());
	const retired = "retired payload ".repeat(4096);
	const covered = await parent.appendMessage({ role: "user", content: retired, timestamp: 1 });
	await parent.appendMessage({ role: "user", content: "uncovered turn", timestamp: 2 });
	await parent.appendCompaction("cleared", null, 300, cleared, undefined, covered);
	const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
	assert.ok(child);
	const reopened = await SessionManager.open(store, child.getSessionId());
	assert.deepEqual(reopened.buildSessionContext(), parent.buildSessionContext());
	assert.ok(
		!JSON.stringify(reopened.getEntries()).includes(retired),
		"a covered-through ID must not keep its retired conversation payload",
	);
});

const tool = (name: string) => ({ name, description: name, parameters: { type: "object" as const, properties: {} } });

for (const backend of ["memory", "sqlite", "jsonl"] as const)
	test(`a ${backend} fork keeps the settings, tool history and extension state its branch recorded before a clear (#5500)`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "fork-state-"));
		const db = backend === "sqlite" ? await openNodeSqliteDatabase(join(dir, "test.db")) : undefined;
		const store =
			backend === "memory"
				? new MemorySessionStore()
				: db
					? await SqlSessionStore.open(db)
					: await JsonlSessionStore.open(dir, { exactDirectory: true });
		try {
			const parent = await SessionManager.create(store, process.cwd());
			await parent.appendThinkingLevelChange("high");
			await parent.appendMessage({
				role: "system",
				content: "",
				toolsAdded: [tool("read"), tool("bash")],
				timestamp: 1,
			});
			await parent.appendCustomEntry("todo-extension", { todos: ["first"] });
			const retired = await parent.appendMessage({ role: "user", content: "retired", timestamp: 2 });
			await parent.appendCustomEntry("todo-extension", { todos: ["other branch"] });
			await parent.branch(retired);
			await parent.appendMessage({ role: "system", content: "", toolsRemoved: [tool("bash")], timestamp: 3 });
			await parent.appendCustomEntry("todo-extension", { todos: ["first", "second"] });
			await parent.appendCompaction("cleared", null, 300, cleared);
			await parent.appendMessage({ role: "user", content: "the current request", timestamp: 4 });
			// What the complete-branch copy before #5506 gave the child.
			const full = await SessionManager.open(store, parent.getSessionId());
			await full.createBranchedSession(parent.getLeafId()!);
			const state = (manager: SessionManager) => ({
				context: manager.buildSessionContext(),
				recorded: manager
					.getBranch()
					.flatMap((e) =>
						e.type === "message" && e.message.role === "system"
							? [e.message]
							: e.type === "custom" && e.customType === "todo-extension"
								? [e.data]
								: [],
					),
			});
			assert.equal(state(full).recorded.length, 4);
			const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
			assert.ok(child);
			for (const manager of [child, await SessionManager.open(store, child.getSessionId())]) {
				assert.deepEqual(state(manager), state(full));
				assert.equal(manager.buildSessionContext().thinkingLevel, "high");
				assert.equal(manager.getEntry(retired), undefined, "the retired conversation was copied into the child");
			}
		} finally {
			await store.close();
			await db?.close();
			await rm(dir, { recursive: true, force: true, maxRetries: 10 });
		}
	});

test("a fork copies the extension state a current index lists without reparsing retired messages (#5500)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fork-extension-index-"));
	const store = await JsonlSessionStore.open(dir, { exactDirectory: true });
	try {
		const parent = await SessionManager.create(store, process.cwd());
		for (let i = 0; i < 64; i++)
			await parent.appendMessage({ role: "user", content: `retired-extension-test-payload ${i}`, timestamp: 1 });
		await parent.appendCustomEntry("todo-extension", { todos: ["first"] });
		await parent.appendCompaction("cleared", null, 300, cleared);
		await parent.appendMessage({ role: "user", content: "current", timestamp: 2 });
		await store.readResume(parent.getSessionId());
		const parse = vi.spyOn(JSON, "parse");
		try {
			const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
			assert.ok(child);
			assert.deepEqual(
				child
					.getBranch()
					.flatMap((e) => (e.type === "custom" && e.customType === "todo-extension" ? [e.data] : [])),
				[{ todos: ["first"] }],
			);
			assert.ok(
				!parse.mock.calls.some(([json]) => json.includes('"content":"retired-extension-test-payload')),
				"the fork scanned retired messages for extension state instead of using the index",
			);
		} finally {
			parse.mockRestore();
		}
	} finally {
		await store.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 10 });
	}
});

test("a fork of a session an earlier build indexed still copies its extension state (#5500)", async () => {
	const db = await openNodeSqliteDatabase(":memory:");
	const store = await SqlSessionStore.open(db);
	try {
		const parent = await SessionManager.create(store, process.cwd());
		await parent.appendMessage({ role: "user", content: "retired", timestamp: 1 });
		await parent.appendCustomEntry("todo-extension", { todos: ["first"] });
		await parent.appendCompaction("cleared", null, 300, cleared);
		await parent.appendMessage({ role: "user", content: "current", timestamp: 2 });
		// The saved index of an earlier build does not list extension state.
		await db.run(
			"UPDATE session_sessions SET summary_state = json_remove(summary_state, '$.resume.extensionState') WHERE id = ?",
			parent.getSessionId(),
		);
		const earlier = await SqlSessionStore.open(db);
		const child = await SessionManager.forkContext(
			earlier,
			parent.getSessionId(),
			parent.getLeafId()!,
			process.cwd(),
		);
		assert.deepEqual(
			child.getBranch().flatMap((e) => (e.type === "custom" && e.customType === "todo-extension" ? [e.data] : [])),
			[{ todos: ["first"] }],
		);
		await earlier.close();
	} finally {
		await store.close();
		await db.close();
	}
});

for (const backend of ["sqlite", "jsonl"] as const)
	test(`a ${backend} fork preserves the exact model from a covered signed reply without copying that reply (#5500)`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "fork-model-"));
		const db = backend === "sqlite" ? await openNodeSqliteDatabase(join(dir, "test.db")) : undefined;
		const store = db ? await SqlSessionStore.open(db) : await JsonlSessionStore.open(dir, { exactDirectory: true });
		try {
			const parent = await SessionManager.create(store, process.cwd());
			await parent.appendModelChange("owner/group", "model");
			const sig = "old-signature".repeat(55_000);
			await parent.appendMessage({
				role: "assistant",
				provider: "owner",
				model: "group/model",
				api: "faux",
				stopReason: "stop",
				timestamp: 1,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				content: [{ type: "thinking", thinking: "outside window", thinkingSignature: sig }],
			});
			await parent.appendCompaction("cleared", null, 300, cleared);
			await parent.appendMessage({ role: "user", content: "current", timestamp: 3 });
			const expected = parent.buildSessionContext();
			const launch = createForkContextResolver(parent, "fork");
			await parent.appendCompaction("later clear", null, 300, cleared);
			const child = await launch.sessionManagerForIndex(0);
			assert.ok(child);
			assert.deepEqual(child.buildSessionContext(), expected);
			assert.ok(!JSON.stringify((await store.load(child.getSessionId())).entries).includes(sig));
		} finally {
			await store.close();
			await db?.close();
			await rm(dir, { recursive: true, force: true, maxRetries: 10 });
		}
	});

test("a fork of a branched, released memory session reads the original cut without reloading the spill file (#5500)", async () => {
	let fullReads = 0;
	let saved: Uint8Array = new Uint8Array();
	const store = new MemorySessionStore(undefined, {
		report: () => {},
		createDirectory: async () => ({
			path: "fork-test",
			write: async (_file, data) => {
				saved = data;
			},
			read: async () => {
				fullReads++;
				return saved;
			},
			readRange: async (_file, start, length) => ({
				bytes: saved.subarray(start, start + length),
				size: saved.byteLength,
			}),
			removeFile: async () => {},
			remove: async () => {},
		}),
	});
	try {
		const parent = await SessionManager.create(store, process.cwd());
		await parent.appendMessage({ role: "user", content: "retired".repeat(32_768), timestamp: 1 });
		const boundary = await parent.appendCompaction("cleared", null, 300, cleared);
		await parent.appendMessage({ role: "user", content: "original fork", timestamp: 2 });
		const expected = parent.buildSessionContext();
		const launch = createForkContextResolver(parent, "fork");
		await parent.branch(boundary);
		await parent.appendMessage({ role: "user", content: "other branch", timestamp: 3 });
		await store.releaseSession(parent.getSessionId());
		const child = await launch.sessionManagerForIndex(0);
		assert.ok(child);
		assert.deepEqual(child.buildSessionContext(), expected);
		assert.equal(fullReads, 0, "forking must not rebuild a branch index from a decoded whole file");
	} finally {
		await store.close();
	}
});

for (const laterTurns of [1, 2])
	test(`a concurrent SQLite writer can start another branch and add ${laterTurns} turn(s) before a delayed fork takes its snapshot (#5500)`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "fork-writer-"));
		const path = join(dir, "test.db"),
			reader = await openNodeSqliteDatabase(path),
			peer = await openNodeSqliteDatabase(path);
		const source = await SqlSessionStore.open(reader),
			other = await SqlSessionStore.open(peer);
		try {
			const parent = await SessionManager.create(source, process.cwd());
			const root = await parent.appendMessage({ role: "user", content: "retired", timestamp: 1 });
			await parent.appendThinkingLevelChange("high");
			await parent.appendCompaction("cleared", null, 300, cleared);
			await parent.appendMessage({ role: "user", content: "launch point", timestamp: 2 });
			const expected = parent.buildSessionContext();
			const launch = createForkContextResolver(parent, "fork");
			const writer = await SessionManager.open(other, parent.getSessionId());
			await writer.branch(root);
			const begin = reader.transaction.bind(reader);
			reader.transaction = async (op, options) => {
				reader.transaction = begin;
				for (let i = 0; i < laterTurns; i++)
					await writer.appendMessage({ role: "user", content: `other branch ${i}`, timestamp: 3 + i });
				return begin(op, options);
			};
			const child = await launch.sessionManagerForIndex(0);
			assert.ok(child);
			assert.deepEqual(child.buildSessionContext(), expected);
			assert.equal(child.getEntry(root), undefined);
		} finally {
			await source.close();
			await other.close();
			await reader.close();
			await peer.close();
			await rm(dir, { recursive: true, force: true, maxRetries: 10 });
		}
	});

for (const labelCount of [0, 64])
	test(`forking a short side branch with ${labelCount} label changes takes no more database calls than copying from the full parent (#5500)`, async () => {
		const counted = countingDatabase(await openNodeSqliteDatabase(":memory:"));
		const store = await SqlSessionStore.open(counted.wrapped);
		try {
			const time = new Date().toISOString();
			const entries = Array.from({ length: 8_192 }, (_, i) => ({
				type: "message" as const,
				id: `entry-${i}`,
				parentId: i ? `entry-${i - 1}` : null,
				timestamp: time,
				message: { role: "user" as const, content: `${i} ${"x".repeat(400)}`, timestamp: 1 },
			}));
			const labels = Array.from({ length: labelCount }, (_, i) => ({
				type: "label" as const,
				id: `label-${i}`,
				parentId: i ? `label-${i - 1}` : entries.at(-1)!.id,
				targetId: "entry-0",
				label: `bookmark ${i}`,
				timestamp: time,
			}));
			await store.create({ id: "fork-cost", version: 4, createdAt: time, cwd: process.cwd() }, [
				...entries,
				...labels,
			]);
			const parent = await SessionManager.open(store, "fork-cost");
			await parent.branch("entry-2");
			for (let i = 0; i < 5; i++)
				await parent.appendMessage({ role: "user", content: `new branch ${i}`, timestamp: 2 + i });
			const leaf = parent.getLeafId()!;
			counted.statements.length = 0;
			const full = await SessionManager.open(store, "fork-cost");
			await full.createBranchedSession(leaf);
			const fullCalls = counted.statements.length;
			counted.statements.length = 0;
			const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
			assert.ok(child);
			assert.deepEqual(child.buildSessionContext(), full.buildSessionContext());
			assert.equal(child.getLabel("entry-0"), labelCount ? `bookmark ${labelCount - 1}` : undefined);
			assert.ok(
				counted.statements.length <= fullCalls,
				`fork used ${counted.statements.length} statements; full branch used ${fullCalls}`,
			);
		} finally {
			await store.close();
			await counted.wrapped.close();
		}
	});

test("a child inherits the name and summary from its own branch before a clear (#5500)", async () => {
	const store = new MemorySessionStore();
	const parent = await SessionManager.create(store, process.cwd());
	const first = await parent.appendMessage({ role: "user", content: "retired", timestamp: 1 });
	await parent.appendSessionInfo("original name");
	await parent.appendSessionSummary("original summary", first);
	await parent.appendCompaction("cleared", null, 300, cleared);
	await parent.appendMessage({ role: "user", content: "current", timestamp: 2 });
	const launch = createForkContextResolver(parent, "fork");
	await parent.branch(first);
	await parent.appendSessionInfo("sibling name");
	await parent.appendSessionSummary("sibling summary", first);
	const child = await launch.sessionManagerForIndex(0);
	assert.ok(child);
	const reopened = await SessionManager.open(store, child.getSessionId());
	assert.equal(reopened.getSessionName(), "original name");
	const summaries = [];
	for await (const s of store.list({ includeInternal: true }))
		if (s.id === child.getSessionId()) summaries.push([s.name, s.summary, s.summarizedThroughId]);
	assert.deepEqual(summaries, [["original name", "original summary", first]]);
	assert.equal(reopened.getEntry(first), undefined);
});

test("a fork reads saved JSONL labels without reparsing retired messages (#5500)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fork-label-index-"));
	const store = await JsonlSessionStore.open(dir, { exactDirectory: true });
	try {
		const parent = await SessionManager.create(store, process.cwd());
		await parent.appendMessage({ role: "user", content: "retired-label-test-payload", timestamp: 1 });
		await parent.appendCompaction("cleared", null, 300, cleared);
		const target = await parent.appendMessage({ role: "user", content: "keep", timestamp: 2 });
		await parent.appendLabelChange(target, "bookmark");
		await store.readResume(parent.getSessionId());
		const parse = vi.spyOn(JSON, "parse");
		try {
			const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
			assert.ok(child);
			assert.equal(child.getLabel(target), "bookmark");
			assert.ok(
				!parse.mock.calls.some(([json]) => json.includes('"content":"retired-label-test-payload"')),
				"fork reparsed a retired message for label discovery",
			);
		} finally {
			parse.mockRestore();
		}
	} finally {
		await store.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 10 });
	}
});

for (const setup of ["current", "rebranched", "no-acknowledgement", "nonmatching", "sibling", "ordinary"] as const)
	test(`a ${setup} fork retains only the acknowledged stop evidence its legacy card needs (#5500, #5690)`, async () => {
		initTheme("dark");
		const db = await openNodeSqliteDatabase(":memory:"),
			store = await SqlSessionStore.open(db);
		try {
			const parent = await SessionManager.create(store, process.cwd());
			const first = await parent.appendMessage({ role: "user", content: "retired", timestamp: 1 });
			const data = {
				taskKind: "agent",
				taskId: "task-1",
				ownerId: "owner-1-0",
				terminalSequence: "7",
				result: { kind: "cancelled", cause: "execution-timeout" },
			};
			await parent.appendCustomEntry("task-completion-intent", { ...data, completionId: "other" });
			await parent.appendCustomEntry("task-completion-ack", { completionId: "other" });
			const receipt = await parent.appendCustomEntry("task-completion-intent", {
				...data,
				completionId: "matching",
				...(setup === "nonmatching" ? { taskId: "another-task" } : {}),
			});
			if (setup === "sibling") await parent.branch(first);
			await parent.appendCompaction("cleared", null, 300, cleared);
			const title = "Subagent docs worker timed out: quit · paused, awaiting resume: check the queue";
			await parent.appendCustomMessageEntry(
				"task-completion",
				title,
				true,
				{
					notification: {
						status: "cancelled",
						preview: "",
						taskId: "task-1",
						title,
						...(setup === "ordinary" ? { agentName: "docs worker" } : {}),
					},
				},
				undefined,
				undefined,
				"matching",
			);
			if (setup !== "no-acknowledgement")
				await parent.appendCustomEntry("task-completion-ack", { completionId: "matching" });
			await parent.appendMessage({ role: "user", content: "current", timestamp: 2 });
			const expected = JSON.stringify(convertToLlm(parent.buildSessionContext().messages));
			const launch = createForkContextResolver(parent, "fork");
			if (setup === "rebranched") {
				await parent.branch(first);
				for (let i = 0; i < 2; i++)
					await parent.appendMessage({ role: "user", content: `side ${i}`, timestamp: 3 + i });
			}
			const child = await launch.sessionManagerForIndex(0);
			assert.ok(child);
			const evidence = setup === "current" || setup === "rebranched";
			for (const manager of [
				child,
				await SessionManager.open(store, child.getSessionId()),
				await SessionManager.open(store, child.getSessionId(), undefined, { history: "tail" }),
			]) {
				assert.deepEqual(
					pendingTaskCompletionIntents(manager),
					[],
					"reopened evidence must never enter delivery recovery",
				);
				const messages = manager.buildSessionContext().messages;
				assert.equal(JSON.stringify(convertToLlm(messages)), expected);
				const notice = messages.find((m) => m.role === "custom" && m.customType === "task-completion");
				assert.ok(notice?.role === "custom");
				const card = TaskCompletionMessage.fromMessage(notice, false);
				assert.ok(card);
				assert.equal(
					stripVTControlCharacters(card.render(120)[0]!).trim(),
					evidence || setup === "ordinary"
						? "◼ docs worker stopped"
						: "⏸ docs worker timed out: quit · awaiting resume",
				);
			}
			const raw = (await store.load(child.getSessionId())).entries;
			assert.deepEqual(
				raw.filter((e) => e.type === "custom" && e.customType === "task-completion-intent").map((e) => e.id),
				evidence ? [receipt] : [],
			);
		} finally {
			await store.close();
			await db.close();
		}
	});

test("a mentioned pre-clear tool output keeps the original branch and opaque receipt bytes (#5500)", async () => {
	const store = new MemorySessionStore();
	const parent = await SessionManager.create(store, process.cwd());
	const bytes = Buffer.from("saved tool output");
	const { hash } = await store.putBlob(parent.getSessionId(), bytes);
	await parent.appendMessage({ role: "user", content: "retired", timestamp: 1 });
	await parent.appendCustomEntry("atomic.tool-output", {
		toolCallId: "work",
		hash,
		bytes: bytes.length,
		extra: "opaque field".repeat(5000),
	});
	await parent.appendCompaction("cleared", null, 300, cleared);
	await parent.appendMessage({ role: "user", content: `Inspect tool-output://${hash}:1-3`, timestamp: 2 });
	const original = (await store.load(parent.getSessionId())).entries;
	const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
	assert.ok(child);
	assert.equal(JSON.stringify((await store.load(child.getSessionId())).entries), JSON.stringify(original));
	await store.delete(parent.getSessionId());
	assert.deepEqual(Buffer.from((await store.getBlob(child.getSessionId(), hash))!), bytes);
});

test("a child retains the original order of labels updated from another branch (#5500)", async () => {
	const { parent, store, cut } = await compactedParent();
	const second = await parent.appendMessage({ role: "user", content: "second", timestamp: 3 });
	const launch = createForkContextResolver(parent, "fork");
	await parent.branch(cut);
	await parent.appendLabelChange(cut, "first");
	await parent.appendLabelChange(second, "second");
	await parent.appendLabelChange(cut, "updated first");
	const child = await launch.sessionManagerForIndex(0);
	assert.ok(child);
	const entries = (await store.load(child.getSessionId())).entries;
	assert.deepEqual(
		entries.filter((e) => e.type === "label").map((e) => [e.targetId, e.label]),
		[
			[cut, "updated first"],
			[second, "second"],
		],
	);
});
