import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const { work, boundary } = poolWorkFixture();
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const usage = (input: number, output = 0, cost = 0) => ({ ...zero, input, output, cost });

async function fixture() {
	const directory = makeTempDirectory("pool-usage-");
	const path = join(directory, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "coordinator");
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(lease, 60_000);
	await pool.enqueue(lease, work, boundary);
	const attempt = await pool.claim(lease, "worker", [work], 60_000);
	assert.ok(attempt);
	const ledger = await openSqlPoolUsage(journal);
	return {
		database,
		journal,
		lease,
		pool,
		attempt,
		ledger,
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

test("duplicate and regressing worker usage reports are charged once (#3869)", async () => {
	const f = await fixture();
	try {
		const report = [{ key: "child:stage-a", usage: usage(100, 20, 0.5) }];
		assert.deepEqual(await f.ledger.report(f.lease, f.attempt, report), usage(100, 20, 0.5));
		assert.deepEqual(await f.ledger.report(f.lease, f.attempt, report), usage(100, 20, 0.5));
		assert.deepEqual(
			await f.ledger.report(f.lease, f.attempt, [{ key: "child:stage-a", usage: usage(40, 5, 0.1) }]),
			usage(100, 20, 0.5),
		);
		assert.deepEqual(
			await f.ledger.report(f.lease, f.attempt, [{ key: "child:stage-a", usage: usage(130, 20, 0.6) }]),
			usage(130, 20, 0.6),
		);
		assert.deepEqual(
			await f.ledger.report(f.lease, f.attempt, [{ key: "child:stage-b", usage: usage(7) }]),
			usage(137, 20, 0.6),
		);
	} finally {
		await f.close();
	}
});

test("replacement attempts add spend and a reopened ledger keeps the root total (#3869)", async () => {
	const f = await fixture();
	try {
		await f.ledger.report(f.lease, f.attempt, [{ key: "child:stage-a", usage: usage(100, 10, 1) }]);
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", f.attempt.id);
		assert.equal(await f.pool.expire(f.lease, f.attempt), true);
		const replacement = await f.pool.claim(f.lease, "replacement", [work], 60_000);
		assert.ok(replacement);
		assert.deepEqual(
			await f.ledger.report(f.lease, replacement, [{ key: "child:stage-a", usage: usage(30, 3, 0.25) }]),
			usage(130, 13, 1.25),
		);
		const reopened = await openSqlPoolUsage(f.journal);
		assert.deepEqual(await reopened.total("root"), usage(130, 13, 1.25));
		assert.deepEqual(await reopened.total("other-root"), zero);
	} finally {
		await f.close();
	}
});

test("fenced, foreign and malformed worker usage reports are rejected (#3869)", async () => {
	const f = await fixture();
	try {
		const report = [{ key: "child:stage-a", usage: usage(100) }];
		await f.ledger.report(f.lease, f.attempt, report);
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", f.attempt.id);
		await f.pool.expire(f.lease, f.attempt);
		const replacement = await f.pool.claim(f.lease, "replacement", [work], 60_000);
		assert.ok(replacement);
		await assert.rejects(
			f.ledger.report(f.lease, f.attempt, [{ key: "late", usage: usage(500) }]),
			/stale work lease/i,
		);
		await assert.rejects(
			f.ledger.report({ ...f.lease, epoch: f.lease.epoch + 1 }, replacement, report),
			/stale|lease/i,
		);
		for (const bad of [usage(-1), usage(Number.NaN), usage(Number.POSITIVE_INFINITY), { ...zero, cost: -0.01 }])
			await assert.rejects(f.ledger.report(f.lease, replacement, [{ key: "bad", usage: bad }]), /usage/i);
		await assert.rejects(f.ledger.report(f.lease, replacement, [{ key: "", usage: usage(1) }]), /key/i);
		assert.deepEqual(await f.ledger.total("root"), usage(100));
	} finally {
		await f.close();
	}
});
