import assert from "node:assert/strict";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { SqliteDatabase, SqliteExecutor } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { resetSnapshotCollectionScheduleForTesting } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { textBlob } from "../helpers/snapshot-reference-index.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
	resetSnapshotCollectionScheduleForTesting();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	resetSnapshotCollectionScheduleForTesting();
	sandbox.dispose();
});

/** A journal whose collection reads wait for `release` and whose blob deletes fail while `failDeletes` is set. */
async function journalFixture() {
	const database = await openNodeSqliteDatabase(sandbox.path("journal.sqlite"));
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const state = { entered: false, gated: false, failDeletes: false };
	const faulty = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: (sql) => executor.exec(sql),
		run: (sql, ...params) => executor.run(sql, ...params),
		get: (sql, ...params) => executor.get(sql, ...params),
		all: async (sql, ...params) => {
			if (state.failDeletes && sql.startsWith("DELETE FROM snapshot_blobs")) throw new Error("disk I/O error");
			return executor.all(sql, ...params);
		},
	});
	const wrapped: SqliteDatabase = {
		...faulty(database),
		get: async (sql, ...params) => {
			if (sql.startsWith("SELECT id FROM snapshot_collection")) {
				state.entered = true;
				if (state.gated) await released;
			}
			return database.get(sql, ...params);
		},
		descriptor: database.descriptor,
		transaction: (callback, options) => database.transaction((tx) => callback(faulty(tx)), options),
		close: () => database.close(),
	};
	const journal = await SqlRunJournal.open(wrapped);
	const backend = await JournalDurableBackend.open(journal, { runs: [] });
	cleanups.push(async () => {
		release();
		await backend.close();
		await database.close();
	});
	const orphan = textBlob("left by an abandoned capture");
	await journal.snapshotBlobs.putBlobs([orphan]);
	await database.run(`UPDATE ${journal.snapshotBlobs.table} SET created_at = created_at - 7200`);
	return { journal, backend, state, release, orphan };
}

const definition = (write: (cwd: string) => void) =>
	workflow({
		name: "collects-on-completion",
		description: "",
		inputs: {},
		outputs: { ok: Type.Boolean() },
		run: async (ctx) => {
			await ctx.tool("write", {}, async () => {
				write(ctx.cwd!);
				return "done";
			});
			return { ok: true };
		},
	});

test("a finished root run starts a collection of its journal's blobs and returns without waiting for it (#4355)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const { journal, backend, state, release, orphan } = await journalFixture();
	state.gated = true;

	const result = await run(
		definition((cwd) => sandbox.write(join(cwd, "a.txt"), "changed\n")),
		{},
		{ cwd: clone, durableBackend: backend, store: createStore() },
	);

	assert.equal(result.status, "completed");
	await vi.waitFor(() => assert.equal(state.entered, true));
	assert.ok(await journal.snapshotBlobs.getBlob(orphan.hash), "the run returned while the collection was held");
	release();
	await vi.waitFor(async () => assert.equal(await journal.snapshotBlobs.getBlob(orphan.hash), undefined));
	assert.equal((await journal.snapshotBlobs.listBlobHashes()).length, 1, "the run's own fresh patch is kept");
});

test("a collection that fails after a run finishes becomes a warning notice on that run (#4355)", async () => {
	const { clone } = await sandbox.remoteWithClone();
	const { backend, state } = await journalFixture();
	state.failDeletes = true;
	const store = createStore();

	const result = await run(
		definition((cwd) => sandbox.write(join(cwd, "a.txt"), "changed\n")),
		{},
		{ cwd: clone, durableBackend: backend, store },
	);

	await vi.waitFor(() =>
		assert.deepEqual(
			store.notices().map(({ id, runId, level }) => ({ id, runId, level })),
			[
				{
					id: `workflow-snapshot-collection:${result.runId}:collection-failed`,
					runId: result.runId,
					level: "warning",
				},
			],
		),
	);
	assert.match(store.notices()[0]!.message, /^Snapshot blob collection failed while deleting unreferenced blobs/u);
});
