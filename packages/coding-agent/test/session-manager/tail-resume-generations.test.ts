import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { CompactionEntry, SessionEntry } from "../../src/core/session-manager-types.ts";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.ts";
import { SessionConflictError } from "../../src/core/storage/session/errors.ts";
import { JsonlSessionStore } from "../../src/core/storage/session/jsonl-session-store.ts";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.ts";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../../src/core/storage/session/types.ts";

const stamp = "2026-11-16T00:00:00.000Z";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function user(id: string, parentId: string | null): SessionEntry {
	return { type: "message", id, parentId, timestamp: stamp, message: { role: "user", content: id, timestamp: 1 } };
}
function boundary(id: string, parentId: string, firstKeptEntryId: string): CompactionEntry {
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
const history: SessionEntry[] = [
	user("a", null),
	user("b", "a"),
	user("kept", "b"),
	{ type: "label", id: "mark", parentId: "kept", timestamp: stamp, targetId: "b", label: "early" },
	boundary("c", "mark", "kept"),
	user("d", "c"),
];

const backends: Record<string, (dir: string) => Promise<SessionStore>> = {
	sqlite: async (dir) => {
		const db = await openNodeSqliteDatabase(join(dir, `${crypto.randomUUID()}.sqlite`));
		cleanups.push(() => db.close());
		return SqlSessionStore.open(db);
	},
	memory: async () => new MemorySessionStore(),
	jsonl: async (dir) => JsonlSessionStore.open(join(dir, crypto.randomUUID()), { exactDirectory: true }),
};

async function tailResumed(backend: (dir: string) => Promise<SessionStore>) {
	const dir = await mkdtemp(join(tmpdir(), "tail-generations-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
	const store = await backend(dir);
	cleanups.push(() => store.close());
	const header = { id: "session", version: 4 as const, createdAt: stamp, cwd: dir };
	await store.create(header, history);
	const manager = await SessionManager.open(store, "session", undefined, { history: "tail" });
	assert.equal(manager.hasFullHistory(), false);
	return { dir, store, backend, manager };
}

async function storedIds(store: SessionStore, sessionId: string): Promise<string[]> {
	return (await store.load(sessionId)).entries.map((entry) => entry.id);
}

for (const [name, backend] of Object.entries(backends)) {
	describe(`${name} store`, () => {
		test("appends after forking a tail-resumed session (#5249)", async () => {
			const { store, manager } = await tailResumed(backend);
			await manager.createBranchedSession("d");
			const id = await manager.appendMessage({ role: "user", content: "after", timestamp: 2 });
			assert.equal((await storedIds(store, manager.getSessionId())).at(-1), id);
		});

		test("a fork of a labeled branch records each copied entry's own seq (#5249)", async () => {
			const { store, manager } = await tailResumed(backend);
			await manager.createBranchedSession("d");
			const forked = manager.getSessionId();
			const ids = await storedIds(store, forked);
			assert.ok(manager.getEntries().some((entry) => entry.type === "label"));
			for (const entry of manager.getEntries()) {
				assert.equal(manager.getEntrySeq(entry.id), ids.indexOf(entry.id) + 1, entry.id);
			}
		});

		test("still rejects a foreign same-length replacement after a tail resume (#5249)", async () => {
			const { store, manager } = await tailResumed(backend);
			const header = (await store.readHeader("session"))!;
			const foreign = Array.from(history, (_, i) => user(`foreign-${i}`, i === 0 ? null : `foreign-${i - 1}`));
			await store.replace("session", header, foreign, { expectSeq: manager.getLastSeq() });
			await assert.rejects(
				manager.appendMessage({ role: "user", content: "late", timestamp: 2 }),
				(error: Error) => error instanceof SessionConflictError,
			);
			assert.deepEqual(
				await storedIds(store, "session"),
				foreign.map((entry) => entry.id),
			);
		});

		test("appends after newSession and rebindStore from a tail-resumed manager (#5249)", async () => {
			const { dir, store, manager } = await tailResumed(backend);
			await manager.newSession();
			const first = await manager.appendMessage({ role: "user", content: "fresh", timestamp: 2 });
			assert.deepEqual(await storedIds(store, manager.getSessionId()), [first]);

			const rebound = await tailResumed(backend);
			const target = await backend(dir);
			cleanups.push(() => target.close());
			await rebound.manager.rebindStore(target, false);
			const second = await rebound.manager.appendMessage({ role: "user", content: "rebound", timestamp: 2 });
			assert.deepEqual(await storedIds(target, "session"), [...history.map((entry) => entry.id), second]);
		});
	});
}

test("copying a session between stores does not expand its live window, on success or failure (#5554)", async () => {
	const { manager } = await tailResumed(backends.memory!);
	const closed = new MemorySessionStore();
	await closed.close();
	await assert.rejects(manager.rebindStore(closed, false));
	assert.equal(manager.hasFullHistory(), false, "a failed copy left old messages resident in its source");
	const destination = new MemorySessionStore();
	cleanups.push(() => destination.close());
	await manager.rebindStore(destination, false);
	assert.equal(manager.hasFullHistory(), false, "a successful copy hydrated retired messages into the live manager");
	assert.deepEqual(
		await storedIds(destination, manager.getSessionId()),
		history.map((entry) => entry.id),
	);
	assert.equal(manager.getEntry("a"), undefined);
});

test("a JSONL backup streams earlier entries without bringing them back into the open window (#5554)", async () => {
	const { store, manager } = await tailResumed(backends.jsonl!);
	assert.ok(store instanceof JsonlSessionStore);
	const path = await store.findFile(manager.getSessionId());
	assert.ok(path);
	const giant = "日🙂".repeat(180_000);
	await manager.appendMessage({ role: "user", timestamp: 1, content: giant });
	await manager.appendCompaction("cleared", null, 100, { strategy: "verbatim-lines" });
	const before = manager.getEntries();
	const backup = await manager.writeBackupSnapshot();
	assert.ok(backup);
	assert.deepEqual(await readFile(backup), await readFile(path));
	assert.deepEqual(
		manager.getEntries().map((entry) => entry.id),
		before.map((entry) => entry.id),
	);
});

test("switching to a compacted session file keeps its saved history positions and interrupted runs (#5554)", async () => {
	const { dir, store, manager } = await tailResumed(backends.jsonl!);
	assert.ok(store instanceof JsonlSessionStore);
	await store.create({ id: "other", version: 4, createdAt: stamp, cwd: dir }, [
		{
			type: "custom",
			customType: "workflow.run.start",
			id: "start",
			parentId: null,
			timestamp: stamp,
			data: { runId: "open", name: "work", ts: 1 },
		},
		user("old", "start"),
		user("tail", "old"),
		boundary("clear", "tail", "tail"),
	]);
	const file = await store.findFile("other");
	assert.ok(file);
	await manager.setSessionFile(file);
	assert.equal(manager.getEntrySeq("tail"), 3);
	assert.deepEqual(await manager.readOpenWorkflowIds(), ["open"]);
	assert.equal(manager.getEntry("old"), undefined);
});

test("appends after setSessionFile from a tail-resumed manager (#5249)", async () => {
	const { dir, store, manager } = await tailResumed(backends.jsonl!);
	assert.ok(store instanceof JsonlSessionStore);
	const other = { id: "other", version: 4 as const, createdAt: stamp, cwd: dir };
	await store.create(other, [user("x", null)]);
	const file = await store.findFile("other");
	assert.ok(file);
	await manager.setSessionFile(file);
	const id = await manager.appendMessage({ role: "user", content: "switched", timestamp: 2 });
	assert.deepEqual(await storedIds(store, "other"), ["x", id]);
});
