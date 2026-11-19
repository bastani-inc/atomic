import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { VerbatimCompactionDetails } from "../../src/core/compaction/compaction-types.js";
import { buildSessionProjection, getSessionLeafId, SessionManager } from "../../src/core/session-manager.ts";
import type { SqliteDatabase } from "../../src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../src/core/storage/node-sqlite.ts";
import { JsonlSessionStore } from "../../src/core/storage/session/jsonl-session-store.ts";
import { MemorySessionStore } from "../../src/core/storage/session/memory-session-store.ts";
import { SqlSessionStore } from "../../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../../src/core/storage/session/types.ts";
import {
	pendingTaskCompletionIntents,
	type TaskCompletionEnvelope,
	TaskCompletionOutbox,
} from "../../src/core/tasks/completion.ts";
import type { OwnerId, Sequence, TaskId } from "../../src/core/tasks/contracts.ts";

const details: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: 6,
	parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
	rung: "planned",
};

function intent(completionId: string, taskId: string): TaskCompletionEnvelope {
	return {
		completionId,
		ownerId: "owner" as OwnerId,
		taskId: taskId as TaskId,
		terminalSequence: "1" as Sequence,
		result: { kind: "failed", code: "fixture", message: "done" },
		display: false,
	};
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "tail-offbranch-ack-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10 }));
	return dir;
}

async function sqlite(path: string): Promise<{ store: SqlSessionStore; database: SqliteDatabase }> {
	const database = await openNodeSqliteDatabase(path);
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return { store, database };
}

const backends: Record<string, (dir: string) => Promise<SessionStore>> = {
	memory: async () => new MemorySessionStore(),
	jsonl: async (dir) => JsonlSessionStore.open(join(dir, "jsonl"), { exactDirectory: true }),
	sqlite: async (dir) => (await sqlite(join(dir, "sessions.sqlite"))).store,
};

const message = (manager: SessionManager, content: string) =>
	manager.appendMessage({ role: "user", content, timestamp: 1 });

/** Save c1's intent on the branch that stays open, and acknowledge it on a sibling branch. */
async function ackOnSibling(manager: SessionManager): Promise<void> {
	const root = await message(manager, "root");
	await manager.appendCustomEntry("task-completion-intent", intent("c1", "first"));
	const a1 = await message(manager, "a1");
	await manager.recordBranch(root);
	await manager.appendCustomEntry("task-completion-ack", { completionId: "c1" });
	await manager.recordBranch(a1);
	await message(manager, "a2");
}

const layouts: Record<string, (manager: SessionManager) => Promise<void>> = {
	"without a compaction": ackOnSibling,
	"after a compaction boundary": async (manager) => {
		await message(manager, "earlier");
		const kept = await message(manager, "kept");
		await manager.appendCompaction("compacted", kept, 100, details);
		await ackOnSibling(manager);
	},
	"before a compaction boundary": async (manager) => {
		// The parked stage keeps the intent of its notified task as state before the boundary.
		await manager.appendCustomEntry("workflow-stage-parked-tasks", {
			tasks: [
				{ ownerId: "owner", taskId: "first" },
				{ ownerId: "owner", taskId: "second" },
			],
		});
		await ackOnSibling(manager);
		const kept = await message(manager, "kept");
		await manager.appendCompaction("compacted", kept, 100, details);
		await message(manager, "after");
	},
};

async function restoredAdmissions(manager: SessionManager): Promise<string[]> {
	const admitted: string[] = [];
	const outbox = new TaskCompletionOutbox(
		manager,
		() => true,
		async (envelope) => {
			admitted.push(envelope.completionId);
			return undefined;
		},
	);
	await outbox.flushRestored();
	return admitted;
}

async function assertTailMatchesWhole(store: SessionStore, id: string): Promise<void> {
	const entries = [...(await store.load(id)).entries];
	const leaf = getSessionLeafId(entries);
	const pending = pendingTaskCompletionIntents({ getEntries: () => entries });
	const tail = await SessionManager.open(store, id, undefined, { history: "tail" });
	assert.equal(tail.hasFullHistory(), false);
	assert.deepEqual(pending, []);
	assert.deepEqual(pendingTaskCompletionIntents(tail), pending);
	assert.deepEqual(tail.buildSessionProjection(), buildSessionProjection(entries, leaf, undefined, id));
	assert.equal(tail.getLeafId(), leaf);
	assert.deepEqual(await restoredAdmissions(tail), []);
}

for (const [backendName, backend] of Object.entries(backends)) {
	describe(`${backendName} store: a completion acknowledged on a sibling branch`, () => {
		for (const [layoutName, layout] of Object.entries(layouts)) {
			test(`stays acknowledged after a tail open, ${layoutName}`, async () => {
				const store = await backend(await directory());
				const manager = await SessionManager.create(store, "/project");
				await layout(manager);
				await assertTailMatchesWhole(store, manager.getSessionId());
			});
		}
	});
}

/** Make a stored resume index look like one an earlier build saved, before it kept acknowledgements. */
function earlierIndex(index: Record<string, unknown>): Record<string, unknown> {
	const { acks: _acks, ...rest } = index;
	return { ...rest, version: 4 };
}

describe("an index saved by an earlier build", () => {
	test("is rebuilt on a SQLite tail open, so the acknowledgement holds", async () => {
		const path = join(await directory(), "sessions.sqlite");
		let id: string;
		{
			const database = await openNodeSqliteDatabase(path);
			const store = await SqlSessionStore.open(database);
			const manager = await SessionManager.create(store, "/project");
			await layouts["after a compaction boundary"]!(manager);
			id = manager.getSessionId();
			await SessionManager.open(store, id, undefined, { history: "tail" });
			const row = await database.get<{ summary_state: string }>(
				"SELECT summary_state FROM session_sessions WHERE id = ?",
				id,
			);
			const state = JSON.parse(row!.summary_state) as { resume: Record<string, unknown> };
			assert.equal(typeof state.resume, "object");
			await database.run(
				"UPDATE session_sessions SET summary_state = ? WHERE id = ?",
				JSON.stringify({ ...state, resume: earlierIndex(state.resume) }),
				id,
			);
			await store.close();
			await database.close();
		}
		const { store } = await sqlite(path);
		await assertTailMatchesWhole(store, id);
	});

	test("is rebuilt on a JSONL tail open, so the acknowledgement holds", async () => {
		const dir = join(await directory(), "jsonl");
		const first = await JsonlSessionStore.open(dir, { exactDirectory: true });
		const manager = await SessionManager.create(first, "/project");
		await layouts["after a compaction boundary"]!(manager);
		const id = manager.getSessionId();
		await SessionManager.open(first, id, undefined, { history: "tail" });
		const sidecars = (await readdir(dir)).filter((name) => name.endsWith(".idx"));
		assert.equal(sidecars.length, 1);
		const sidecar = join(dir, sidecars[0]!);
		const saved = await readFile(sidecar, "utf8");
		const stored = JSON.parse(saved.slice(saved.indexOf("\n") + 1)) as { index: Record<string, unknown> };
		const body = JSON.stringify({ ...stored, index: earlierIndex(stored.index) });
		await writeFile(sidecar, `${createHash("sha256").update(body).digest("hex")}\n${body}`);
		await first.close();
		const store = await JsonlSessionStore.open(dir, { exactDirectory: true });
		cleanups.push(() => store.close());
		await assertTailMatchesWhole(store, id);
	});
});
