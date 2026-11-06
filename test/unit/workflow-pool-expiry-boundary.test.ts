import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { PoolRemoteJournal } from "../../packages/workflows/src/durable/journal/pool-remote-journal.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { staleWorkLease } from "../helpers/pool-errors.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * A work lease is current through the millisecond it expires at and stale from the next one (#4327). Every database
 * connection's clock (`unixepoch`) is pinned to the test's, so an attempt's operations run exactly at its expiry.
 */

const NOW = 1_800_000_000_000;
const { work, boundary } = poolWorkFixture();
const run = { ...boundary.topology!.boundary!.child };
const tool = (index: number): DurableToolCheckpoint => ({
	kind: "tool",
	workflowId: "root",
	checkpointId: `${work.scope}:tool:${index}`,
	name: "tool",
	argsHash: `${work.scope}:args:${index}`,
	output: { saved: index },
	completedAt: 1,
	topology: { version: 1, nodeId: `tool-${index}`, parentIds: [], ordinal: index, order: index, run },
});
const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

/**
 * Every SQLite connection in this file reads its clock from `Date`, the pool's read-only connections included, so
 * pinning `Date` pins the database's time for every read and write.
 */
vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class DateClockedDatabase extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			super(...args);
			this.function("unixepoch", { varargs: true }, () => Date.now() / 1_000);
		}
	}
	return { ...actual, DatabaseSync: DateClockedDatabase };
});

afterEach(() => {
	vi.useRealTimers();
});

function pinnedDatabase(path: string): DatabaseSync {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	return new DatabaseSync(path);
}

async function claimed(connection: DatabaseSync, remote?: (lease: Lease) => Promise<PoolRemoteJournal>) {
	const journal = await openSqlRunJournal(connection);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire("root", backend.holderId);
	if (acquired.status !== "acquired") assert.fail("No root lease");
	const lease = acquired.lease;
	const pool = await openSqlPoolQueue(journal, await remote?.(lease));
	await pool.initialize(lease, 60_000);
	await pool.enqueue(lease, work, boundary);
	const attempt = (await pool.claim(lease, "worker", [work], 60_000)) as PoolWork;
	assert.ok(attempt);
	const expireAt = (at: number) =>
		connection.prepare("UPDATE wf_runs_work SET expires_at = ? WHERE id = ?").run(at, attempt.id);
	return { journal, backend, lease, pool, attempt, expireAt };
}

const expired = staleWorkLease({ root: "root", reason: "expired" });

test("an attempt is current, renewable, and may commit, report usage and complete at its expiry, and not after it (#4327)", async () => {
	const directory = makeTempDirectory("pool-expiry-boundary-");
	const connection = pinnedDatabase(join(directory, "journal.sqlite"));
	const f = await claimed(connection);
	try {
		const ledger = await openSqlPoolUsage(f.journal);
		const steps: readonly (readonly [string, (index: number) => Promise<unknown>])[] = [
			["assertCurrent", () => f.pool.assertCurrent(f.lease, f.attempt)],
			["renew", () => f.pool.renew(f.lease, f.attempt, 1)],
			[
				"commit",
				(index) =>
					f.pool.commit(f.lease, f.attempt, `op-${index}`, { kind: "checkpoint", checkpoint: tool(index) }),
			],
			["usage", (index) => ledger.report(f.lease, f.attempt, [{ key: `stage-${index}`, usage }])],
		];
		let index = 0;
		for (const [name, step] of steps) {
			f.expireAt(NOW);
			await step(++index).catch((error: unknown) => assert.fail(`${name} at its expiry: ${String(error)}`));
			f.expireAt(NOW - 1);
			await assert.rejects(step(++index), expired, `${name} after its expiry`);
		}
		f.expireAt(NOW - 1);
		await assert.rejects(
			f.pool.complete(f.lease, f.attempt, { runId: work.childRunId, status: "completed" }),
			expired,
		);
		f.expireAt(NOW);
		await f.pool.complete(f.lease, f.attempt, { runId: work.childRunId, status: "completed" });
	} finally {
		await f.backend.close();
		await f.journal.close();
		if (connection.isOpen) connection.close();
		removeTempDirectory(directory);
	}
});

test("a remote checkpoint commit is accepted at its attempt's expiry and refused after it (#4327)", async () => {
	const directory = makeTempDirectory("pool-expiry-boundary-remote-");
	const durable = new MemoryRunJournal({ adapter: "remote", location: "memory" });
	const connection = pinnedDatabase(join(directory, "pool.sqlite"));
	await durable.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
	const acquired = await durable.acquire("root", "holder");
	if (acquired.status !== "acquired") assert.fail("No root lease");
	const coordination = await openSqlRunJournal(connection);
	const remote = new PoolRemoteJournal(durable, sqlPoolStorage(coordination)!);
	await remote.mirror(acquired.lease);
	const pool = await openSqlPoolQueue(coordination, remote);
	try {
		await pool.initialize(acquired.lease, 60_000);
		await pool.enqueue(acquired.lease, work, boundary);
		const attempt = (await pool.claim(acquired.lease, "worker", [work], 60_000)) as PoolWork;
		const expireAt = (at: number) =>
			connection.prepare("UPDATE wf_runs_work SET expires_at = ? WHERE id = ?").run(at, attempt.id);
		expireAt(NOW - 1);
		await assert.rejects(
			pool.commit(acquired.lease, attempt, "late", { kind: "checkpoint", checkpoint: tool(1) }),
			expired,
		);
		expireAt(NOW);
		await pool.commit(acquired.lease, attempt, "on-time", { kind: "checkpoint", checkpoint: tool(2) });
	} finally {
		await coordination.close();
		if (connection.isOpen) connection.close();
		removeTempDirectory(directory);
	}
});
