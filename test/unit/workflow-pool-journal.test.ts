import assert from "node:assert/strict";
import { join } from "node:path";
import { StorageUnavailableError } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { type Lease, RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const header = { runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" };
const { work, boundary } = poolWorkFixture();

async function fixture() {
	const directory = makeTempDirectory("pool-journal-");
	const path = join(directory, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	await journal.createRun(header);
	const acquired = await journal.acquire(header.runId, "coordinator");
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
	return {
		database,
		journal,
		lease,
		path,
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

test("child boundary enqueue is atomic, durable and idempotent (#3869)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		const first = await pool.enqueue(f.lease, work, boundary);
		assert.equal(first.boundaryId, work.boundaryId);
		assert.equal(
			(
				await f.journal.readKey(
					"root",
					JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, "stage", boundary.checkpointId]),
				)
			)?.event.type,
			RUN_EVENT_TYPES.checkpointRecorded,
		);
		assert.deepEqual(await pool.enqueue(f.lease, work, boundary), first);
		await assert.rejects(pool.enqueue(f.lease, { ...work, digest: "changed" }, boundary), /identity conflict/);
		await f.database.exec(
			`CREATE TRIGGER reject_boundary BEFORE INSERT ON wf_events WHEN NEW.key = '["CheckpointRecorded","stage","boundary-start:workflow:rollback:0"]' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
		);
		const rollback = poolWorkFixture("rollback");
		await assert.rejects(
			pool.enqueue(f.lease, rollback.work, rollback.boundary),
			(error: Error) =>
				error instanceof StorageUnavailableError &&
				error.cause instanceof Error &&
				error.cause.message === "injected failure",
		);
		assert.equal((await pool.inspect("root")).length, 1);
		const secondDatabase = await openNodeSqliteDatabase(f.path);
		const second = await SqlRunJournal.open(secondDatabase);
		try {
			assert.deepEqual(await (await openSqlPoolQueue(second)).inspect("root"), [first]);
		} finally {
			await second.close();
			await secondDatabase.close();
		}
	} finally {
		await f.close();
	}
});

test("independent connections claim once and fence lease renewals and expiry (#3869)", async () => {
	const f = await fixture();
	const otherDatabase = await openNodeSqliteDatabase(f.path);
	const other = await SqlRunJournal.open(otherDatabase);
	try {
		const pool = await openSqlPoolQueue(f.journal);
		const peer = await openSqlPoolQueue(other);
		await pool.initialize(f.lease, 60_000);
		await pool.enqueue(f.lease, work, boundary);
		assert.equal(
			await peer.claim(f.lease, "incompatible", [{ definition: work.definition, digest: "wrong" }], 60_000),
			undefined,
		);
		const claims = await Promise.all([
			pool.claim(f.lease, "one", [work], 60_000),
			peer.claim(f.lease, "two", [work], 60_000),
		]);
		assert.equal(claims.filter(Boolean).length, 1);
		const held = claims.find((claim) => claim !== undefined)!;
		assert.equal(held.generation, 1);
		assert.ok(held.expiresAt > 0);
		assert.ok(held.renewedAt > 0);
		assert.equal(held.expiresAt - held.renewedAt, 60_000);
		const renewed = await pool.renew(f.lease, held, "heartbeat-1", 60_000);
		const later = await peer.renew(f.lease, held, "heartbeat-2", 70_000);
		assert.ok(later.expiresAt > renewed.expiresAt);
		assert.deepEqual(await peer.renew(f.lease, held, "heartbeat-1", 60_000), renewed);
		assert.equal((await pool.inspect("root"))[0]?.expiresAt, later.expiresAt);
		await assert.rejects(pool.renew(f.lease, held, "heartbeat-1", 70_000), /operation identity conflict/);
		assert.equal(await pool.expire(f.lease, held), false);
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0");
		await assert.rejects(pool.renew(f.lease, held, "late", 60_000), /stale work lease/i);
		assert.equal(await pool.expire(f.lease, held), true);
		const replacement = await peer.claim(f.lease, "two", [work], 60_000);
		assert.equal(replacement?.generation, 2);
		assert.ok(replacement);
		assert.equal((await pool.renew(f.lease, replacement, "heartbeat-1", 60_000)).generation, 2);
		await assert.rejects(pool.renew(f.lease, held, "heartbeat-1", 60_000), /stale work lease/i);
		await assert.rejects(pool.expire(f.lease, held), /stale work lease/i);
	} finally {
		await other.close();
		await otherDatabase.close();
		await f.close();
	}
});

test("coordinator expiry and takeover fence every queue mutation; paused roots grant no claims (#3869)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await pool.initialize(f.lease, 60_000);
		await assert.rejects(pool.initialize(f.lease, 1), /immutable/);
		await pool.enqueue(f.lease, work, boundary);
		await f.journal.append(f.lease, { type: RUN_EVENT_TYPES.statusChanged, payload: { status: "paused" } });
		assert.equal(await pool.claim(f.lease, "worker", [work], 60_000), undefined);
		await f.journal.append(f.lease, { type: RUN_EVENT_TYPES.statusChanged, payload: { status: "running" } });
		const held = (await pool.claim(f.lease, "worker", [work], 60_000))!;
		await f.database.run("UPDATE wf_leases SET renewed_at = 0");
		await assert.rejects(pool.claim(f.lease, "worker", [work], 60_000), /Stale lease/);
		await assert.rejects(pool.renew(f.lease, held, "old", 60_000), /Stale lease/);
		const takeover = await f.journal.takeoverExpired("root", "new-coordinator", 60_000);
		assert.equal(takeover.status, "acquired");
		if (takeover.status !== "acquired") assert.fail("takeover failed");
		await pool.initialize(takeover.lease, 60_000);
		await assert.rejects(pool.enqueue(f.lease, work, boundary), /Stale lease/);
		await assert.rejects(pool.expire(f.lease, held), /Stale lease/);
		await assert.rejects(pool.renew(takeover.lease, held, "old", 60_000), /Stale work lease/);
		assert.equal(await pool.expire(takeover.lease, held), true);
		const next = await pool.claim(takeover.lease, "worker", [work], 60_000);
		assert.equal(next?.epoch, takeover.lease.epoch);
		assert.equal(next?.generation, held.generation + 1);
		await f.journal.deleteOwnedRun(takeover.lease);
		assert.deepEqual(await pool.inspect("root"), []);
	} finally {
		await f.close();
	}
});

test("pool schema is lazy, versioned and prefix-isolated (#3869)", async () => {
	const f = await fixture();
	try {
		assert.deepEqual(await f.database.all("SELECT name FROM sqlite_master WHERE name LIKE '%pool%'"), []);
		const prefixed = await SqlRunJournal.open(f.database, { prefix: "isolated_" });
		await openSqlPoolQueue(prefixed);
		await openSqlPoolQueue(f.journal);
		await f.database.run("UPDATE wf_runs_pool_meta SET version = 999");
		await assert.rejects(openSqlPoolQueue(f.journal), /schema version/i);
		await openSqlPoolQueue(prefixed);
		await f.journal.createRun({ ...header, runId: "ordinary" });
		assert.ok(await f.journal.getRun("ordinary"));
		await prefixed.close();
	} finally {
		await f.close();
	}
});

test("queue rejects missing initialization and mismatched child boundaries (#3869)", async () => {
	const f = await fixture();
	try {
		const pool = await openSqlPoolQueue(f.journal);
		await assert.rejects(pool.enqueue(f.lease, work, boundary), /not initialized/);
		await pool.initialize(f.lease, 60_000);
		await assert.rejects(pool.enqueue(f.lease, { ...work, childRunId: "unrelated" }, boundary), /boundary/);
		await assert.rejects(pool.enqueue(f.lease, work, { ...boundary, checkpointId: "wrong" }), /boundary/);
		await assert.rejects(pool.enqueue(f.lease, work, { ...boundary, workflowId: "wrong" }), /boundary/);
		await pool.enqueue(f.lease, work, boundary);
		for (const duplicate of [
			poolWorkFixture("duplicate", work.childRunId),
			poolWorkFixture("duplicate-scope", "other-child", work.scope),
		]) {
			await assert.rejects(pool.enqueue(f.lease, duplicate.work, duplicate.boundary), /identity conflict/);
		}
		assert.equal((await pool.inspect("root")).length, 1);
	} finally {
		await f.close();
	}
});
