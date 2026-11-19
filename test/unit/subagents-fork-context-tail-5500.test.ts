import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";

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
	assert.ok(await (await SessionManager.open(store, parent.getSessionId())).readEntry(retired));
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

test("a mentioned pre-clear tool output keeps its original opaque receipt bytes without copying unrelated messages (#5500, #5594)", async () => {
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
	const copied = (await store.load(child.getSessionId())).entries;
	const receipt = original.find((e) => e.type === "custom" && e.customType === "atomic.tool-output")!;
	assert.deepEqual(
		copied.find((e) => e.id === receipt.id),
		receipt,
	);
	assert.ok(!copied.some((e) => e.type === "message" && e.message.role === "user" && e.message.content === "retired"));
	assert.deepEqual(child.buildSessionContext(), parent.buildSessionContext());
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
