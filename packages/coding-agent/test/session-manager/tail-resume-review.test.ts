import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as crypto from "crypto";
import { afterEach, test, vi } from "vitest";

vi.mock("crypto", async () => {
	const actual = await vi.importActual<typeof import("crypto")>("crypto");
	return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

import { SessionManager } from "../../src/core/session-manager.ts";
import type { CompactionEntry, SessionEntry } from "../../src/core/session-manager-types.ts";
import { generateId } from "../../src/core/session-manager-validation.ts";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.ts";
import { sessionTailOf } from "../../src/core/storage/session/session-resume.ts";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.ts";

const stamp = "2026-11-16T00:00:00.000Z";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function user(id: string, parentId: string | null): SessionEntry {
	return { type: "message", id, parentId, timestamp: stamp, message: { role: "user", content: id, timestamp: 1 } };
}
function boundary(id: string, parentId: string, firstKeptEntryId: string | null): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: stamp,
		summary: "summary",
		tokensBefore: 100,
		firstKeptEntryId,
		details: { strategy: "verbatim-lines", backend: "summary" },
	};
}
async function fixture(entries: SessionEntry[]) {
	const dir = await mkdtemp(join(tmpdir(), "tail-review-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
	const db = await openNodeSqliteDatabase(join(dir, "s.sqlite"));
	cleanups.push(() => db.close());
	const store = await SqlSessionStore.open(db);
	cleanups.push(() => store.close());
	const header = { id: "session", version: 4 as const, createdAt: stamp, cwd: dir };
	await store.create(header, entries);
	return { store, header, open: () => SessionManager.open(store, "session", undefined, { history: "tail" }) };
}

test("keeps the model inferred from an assistant before the compaction (#5249)", async () => {
	const zero = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const entries: SessionEntry[] = [
		user("u", null),
		{
			type: "message",
			id: "a",
			parentId: "u",
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [],
				provider: "test",
				model: "inferred",
				api: "anthropic-messages",
				usage: zero,
				stopReason: "stop",
				timestamp: 1,
			},
		},
		user("kept", "a"),
		boundary("c", "kept", "kept"),
	];
	const { open, store } = await fixture(entries);
	assert.deepEqual(
		(await open()).buildSessionContext(),
		(await SessionManager.open(store, "session")).buildSessionContext(),
	);
});

test("branching to held state and pre-boundary kept messages restores their complete context (#5249)", async () => {
	const entries: SessionEntry[] = [
		user("u", null),
		{ type: "thinking_level_change", id: "thinking", parentId: "u", timestamp: stamp, thinkingLevel: "high" },
		user("kept", "thinking"),
		boundary("c", "kept", "kept"),
		user("after", "c"),
	];
	const { open, store } = await fixture(entries);
	for (const target of ["thinking", "kept"]) {
		const partial = await open();
		const full = await SessionManager.open(store, "session");
		await partial.recordBranch(target);
		await full.branch(target);
		assert.deepEqual(partial.buildSessionContext(), full.buildSessionContext());
	}
});

test("rewinding within the current window needs no archive and preserves a live entry's identity (#5554)", async () => {
	const { store, open } = await fixture([
		user("old", null),
		boundary("clear", "old", null),
		user("current", "clear"),
		user("later", "current"),
	]);
	const local = await open();
	const held = local.getEntry("current");
	assert.ok(held?.type === "message" && held.message.role === "user");
	held.message.content = "SDK mutation";
	await store.delete("session");
	await local.branch("current");
	assert.equal(local.getLeafEntry(), held);
	const last = local.buildSessionContext().messages.at(-1);
	assert.equal(last?.role === "user" && last.content, "SDK mutation");
});

test("a later compaction may keep an older span, and live and reopened windows agree (#5554)", async () => {
	const { open } = await fixture([user("old", null), boundary("clear", "old", null), user("current", "clear")]);
	const live = await open();
	await live.appendCompaction("second", "old", 3, { strategy: "verbatim-lines", backend: "summary" } as Parameters<
		SessionManager["appendCompaction"]
	>[3]);
	const restored = await open();
	assert.deepEqual(live.buildSessionContext(), restored.buildSessionContext());
	assert.ok(live.getEntry("old"));
});

test("the source window stays visible while a historical branch write is pending and after it fails (#5554)", async () => {
	const { open, store } = await fixture([user("old", null), boundary("clear", "old", null), user("current", "clear")]);
	const session = await open();
	const before = session.getEntries(),
		leaf = session.getLeafId();
	const started = Promise.withResolvers<void>(),
		finish = Promise.withResolvers<void>();
	const refusal = new Error("branch append refused");
	const append = vi.spyOn(store, "append").mockImplementation(async () => {
		started.resolve();
		await finish.promise;
		throw refusal;
	});
	try {
		const switched = session.branchWithSummary("old", "summary");
		const rejected = assert.rejects(switched, (error) => error === refusal);
		await started.promise;
		const during = session.getEntries(),
			duringLeaf = session.getLeafId();
		finish.resolve();
		await rejected;
		assert.equal(duringLeaf, leaf);
		assert.deepEqual(during, before);
		assert.equal(session.getLeafId(), leaf);
		assert.deepEqual(session.getEntries(), before);
	} finally {
		finish.resolve();
		append.mockRestore();
	}
});

test("a peer append conflicts once when moving to an archived branch, and retry reopens the selected conversation (#5554)", async () => {
	const { open } = await fixture([
		user("root", null),
		user("old", "root"),
		boundary("clear", "old", null),
		user("current", "clear"),
	]);
	const local = await open();
	const peer = await open();
	await peer.appendMessage({ role: "user", content: "other writer", timestamp: 2 });
	await assert.rejects(local.recordBranch("old"), { name: "SessionConflictError" });
	assert.equal(local.getLeafId(), "current");
	await local.recordBranch("old");
	for (const view of [local, await open()]) {
		assert.equal(view.getLeafId(), "old");
		assert.deepEqual(
			view.buildSessionContext().messages.map((m) => m.role === "user" && m.content),
			["root", "old"],
		);
	}
});

for (const tier of ["native", "paged", "legacy"] as const) {
	test(`a stale local branch uses its original watermark with a ${tier} source (#5554)`, async () => {
		const { store } = await fixture([user("old", null), boundary("clear", "old", null), user("current", "clear")]);
		const viewStore = Object.create(store) as import("../../src/core/storage/session/types.ts").SessionStore;
		if (tier !== "native") viewStore.readResumeAt = undefined;
		if (tier === "legacy") {
			viewStore.readEntrySizes = undefined;
			viewStore.readEntryChunk = undefined;
		}
		const read = vi.spyOn(viewStore, "load");
		const view = await SessionManager.open(viewStore, "session");
		const newer = await SessionManager.open(store, "session");
		await newer.appendSessionInfo("new owner's title");
		await view.branch("old");
		assert.equal(view.getLastSeq(), 3);
		assert.equal(view.getSessionName(), undefined, "newer metadata did not enter the old view");
		assert.deepEqual(
			view.getBranch().map((e) => e.id),
			["old"],
		);
		assert.equal(read.mock.calls.length, tier === "legacy" ? 1 : 0);
		await assert.rejects(view.appendMessage({ role: "user", content: "stale write", timestamp: 2 }), {
			name: "SessionConflictError",
		});
	});
}

test("a snapshot-only SDK store opens a window and pages the archive without keeping earlier turns (#5554)", async () => {
	const { store } = await fixture([user("old", null), boundary("clear", "old", null), user("current", "clear")]);
	const adapter = Object.assign(
		Object.create(store) as import("../../src/core/storage/session/types.ts").SessionStore,
		{
			readResume: undefined,
			readResumeAt: undefined,
			readRange: undefined,
			readEntrySizes: undefined,
			readEntryChunk: undefined,
			findEntrySeq: undefined,
		},
	);
	const load = vi.spyOn(adapter, "load");
	const view = await SessionManager.open(adapter, "session");
	assert.equal(load.mock.calls.length, 1);
	assert.equal(view.getEntry("old"), undefined);
	assert.equal((await view.readEntry("old"))?.id, "old");
	assert.equal(view.getEntry("old"), undefined);
	assert.equal(view.getLeafId(), "current");
});

test("hydration rejects a same-length replacement instead of merging session generations (#5249)", async () => {
	const entries = [user("u", null), user("kept", "u"), boundary("c", "kept", "kept")];
	const { open, store, header } = await fixture(entries);
	const partial = await open();
	await store.replace("session", header, [user("new", null), user("new2", "new"), user("new3", "new2")], {
		expectSeq: 3,
	});
	await assert.rejects(partial.loadFullHistory(), { name: "SessionConflictError" });
});

test("resume excludes abandoned branches after the active boundary (#5249)", async () => {
	const entries: SessionEntry[] = [
		user("u", null),
		boundary("c", "u", null),
		user("a", "c"),
		user("b", "u"),
		user("b2", "b"),
		{ type: "custom", customType: "atomic.leaf", id: "move", parentId: "a", timestamp: stamp },
	];
	const { open, store } = await fixture(entries);
	const partial = await open();
	assert.equal(
		partial.getEntries().some((e) => e.id === "b" || e.id === "b2"),
		false,
	);
	const id = await partial.appendMessage({ role: "user", content: "new", timestamp: 1 });
	assert.equal(id.length, 36);
	await partial.loadFullHistory();
	assert.deepEqual(partial.getEntries(), (await store.load("session")).entries);
});

test("settled heartbeats and delivery cards do not grow the resumed state (#5249)", async () => {
	const counts = [];
	for (const n of [10, 100]) {
		const entries: SessionEntry[] = [user("u", null)];
		for (let i = 0; i < n; i++) {
			const id = `card${i}`;
			const parentId = entries.at(-1)!.id;
			entries.push({
				type: "custom_message",
				id,
				parentId,
				timestamp: stamp,
				customType: "task-heartbeat",
				content: "heartbeat".repeat(100),
				display: true,
				protectedReconciliation: { delivery: "followUp" },
			});
			entries.push({
				type: "custom_message",
				id: `done${i}`,
				parentId: id,
				timestamp: stamp,
				customType: "atomic:protected-streaming-reconciliation",
				content: "heartbeat".repeat(100),
				display: false,
				details: { protectedReconciliationOf: id },
			});
		}
		entries.push(boundary("c", entries.at(-1)!.id, null));
		const header = { id: "s", version: 4 as const, createdAt: stamp, cwd: "/p" };
		counts.push(sessionTailOf(header, entries, entries.length).state.length);
	}
	assert.deepEqual(counts, [0, 0]);
});

test("partial session ids cannot reuse a short id hidden in omitted history (#5249)", () => {
	const uuid = "deadbeef-0000-4000-8000-000000000001";
	vi.mocked(crypto.randomUUID).mockReturnValueOnce(uuid);
	assert.equal(generateId({ has: () => false, preferFullIds: true }), uuid);
});

test("refreshing a resumed mirror reads only the new seq range and rejects branch or generation changes (#5249)", async () => {
	const entries = [user("u", null), user("kept", "u"), boundary("c", "kept", "kept")];
	const { open, store, header } = await fixture(entries);
	const partial = await open();
	const spy = vi.spyOn(store, "readRange");
	await store.append("session", [user("later", "c")], { expectSeq: 3 });
	assert.equal(await partial.refreshFromStore(), true);
	assert.equal(partial.getLeafId(), "later");
	assert.deepEqual(spy.mock.calls, [["session", 3, Number.MAX_SAFE_INTEGER]]);
	assert.equal(partial.hasFullHistory(), false);
	await store.replace("session", header, [user("new", null)], { expectSeq: 4 });
	assert.equal(await partial.refreshFromStore(), false);
	assert.equal(partial.getLeafId(), "later");
});

test("resume preserves the latest session-wide usage even when it came from an abandoned branch (#5249)", async () => {
	const assistant = (id: string, parentId: string, tokens: number): SessionEntry => ({
		type: "message",
		id,
		parentId,
		timestamp: stamp,
		message: {
			role: "assistant",
			content: [],
			provider: "test",
			model: "model",
			api: "anthropic-messages",
			usage: {
				input: tokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: tokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	});
	const entries: SessionEntry[] = [
		user("u", null),
		boundary("c", "u", null),
		assistant("a", "c", 1),
		user("b", "u"),
		assistant("b-reply", "b", 17),
		{ type: "custom", customType: "atomic.leaf", id: "move", parentId: "a", timestamp: stamp },
	];
	const { open, store } = await fixture(entries);
	const partial = await open();
	const full = await SessionManager.open(store, "session");
	const { getSessionStats } = await import("../../src/core/agent-session-export.ts");
	const stats = (manager: SessionManager) =>
		getSessionStats.call({
			sessionManager: manager,
			sessionId: "session",
			sessionFile: undefined,
			getContextUsage: () => undefined,
		} as never);
	assert.deepEqual(stats(partial), stats(full));
});
