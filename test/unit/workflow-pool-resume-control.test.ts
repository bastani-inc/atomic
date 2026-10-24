import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

for (const state of ["paused", "quit"] as const) {
	test(`a newer ${state} survives explicit pool resume preparation (#3869)`, async () => {
		const directory = makeTempDirectory("pool-resume-control-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		// Preparation runs in the coordinator; keep it in this process to hold its control write.
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [],
			coordinator: "in-process",
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let preparing: Promise<void> | undefined;
		try {
			await backend.commitWorkflowRegistration({
				workflowId: "root",
				name: "root",
				inputs: {},
				createdAt: 0,
				status: "running",
			});
			const owned = (await journal.leaseState("root"))!;
			const lease = { runId: "root", holderId: owned.holderId!, epoch: owned.epoch };
			const queue = await openSqlPoolQueue(journal);
			await queue.initialize(lease, 90_000);
			await queue.setControl(lease, "quit");
			const setControl = SqlPoolQueue.prototype.setControl;
			vi.spyOn(SqlPoolQueue.prototype, "setControl").mockImplementationOnce(async function (
				this: SqlPoolQueue,
				...args
			) {
				entered.resolve();
				await release.promise;
				return setControl.apply(this, args);
			});
			preparing = pool.prepare("root");
			await entered.promise;
			await pool.control(state);
			release.resolve();
			await preparing;
			assert.equal((await queue.control(lease)).state, state);
			assert.equal(pool.workerPids.length, 0);
		} finally {
			release.resolve();
			await preparing?.catch(() => {});
			vi.restoreAllMocks();
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	});
}

test("concurrent root preparation cannot replace another root's pool control (#3869)", async () => {
	const directory = makeTempDirectory("pool-root-ownership-");
	const path = join(directory, "journal.sqlite");
	const journal = await resolveRunJournal({ journal: { path } });
	const backend = await JournalDurableBackend.open(journal);
	const pool = new LocalWorkerPool(backend, { journalPath: path, workers: 1, definitions: [] });
	try {
		for (const workflowId of ["root", "other"])
			await backend.commitWorkflowRegistration({
				workflowId,
				name: workflowId,
				inputs: {},
				createdAt: 0,
				status: "running",
			});
		const [first, second] = await Promise.allSettled([pool.prepare("root"), pool.prepare("other")]);
		assert.equal(first.status, "fulfilled");
		assert.equal(second.status, "rejected");
		if (second.status === "rejected") assert.match(String(second.reason), /belongs to another root/);
		await pool.control("paused");
		const owned = (await journal.leaseState("root"))!;
		const queue = await openSqlPoolQueue(journal);
		assert.equal(
			(await queue.control({ runId: "root", holderId: owned.holderId!, epoch: owned.epoch })).state,
			"paused",
		);
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});
