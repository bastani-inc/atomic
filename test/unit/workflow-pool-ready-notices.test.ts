import assert from "node:assert/strict";
import { join } from "node:path";
import type { SqliteDatabase, StorageNotificationEvent, StorageNotifications } from "@bastani/atomic/storage";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	listenPoolReady,
	poolReadyChannel,
	sqlPoolStorage,
} from "../../packages/workflows/src/durable/journal/internal.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Which pool writes wake listening hosts (#5103), on a SQLite journal whose database is given notifications that record
 * each notice in a table: a notice is written by the transaction of the write it announces, so it is there exactly
 * when that write committed.
 */

const { work, boundary } = poolWorkFixture();
const header = { runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" };

/** Notifications that record each notice in the `notices` table, and hand out the listeners given to `listen`. */
function recordingNotifications() {
	const listeners: { channel: string; listener: (event: StorageNotificationEvent) => void; open: boolean }[] = [];
	const notifications: StorageNotifications = {
		notify: (channel, payload) => ({
			sql: "INSERT INTO notices(channel, payload) VALUES (?, ?)",
			params: [channel, payload],
		}),
		listen(channel, listener) {
			const entry = { channel, listener, open: true };
			listeners.push(entry);
			return {
				close() {
					entry.open = false;
				},
			};
		},
		state: async () => ({ status: "listening" }),
	};
	return { notifications, listeners };
}

function withNotifications(database: SqliteDatabase, notifications: StorageNotifications): SqliteDatabase {
	return new Proxy(database, {
		get: (target, key) => (key === "notifications" ? notifications : Reflect.get(target, key)),
	});
}

async function fixture(prefix?: string) {
	const directory = makeTempDirectory("pool-ready-notices-");
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	await database.exec("CREATE TABLE notices(id INTEGER PRIMARY KEY, channel TEXT NOT NULL, payload TEXT NOT NULL)");
	const recording = recordingNotifications();
	const journal = await SqlRunJournal.open(
		withNotifications(database, recording.notifications),
		prefix === undefined ? {} : { prefix },
	);
	await journal.createRun(header);
	const acquired = await journal.acquire("root", "coordinator");
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(lease, 60_000);
	let seen = 0;
	return {
		database,
		journal,
		pool,
		lease,
		listeners: recording.listeners,
		/** The notices written since the last call. */
		async notices(): Promise<string[]> {
			const rows = await database.all<{ id: number; channel: string; payload: string }>(
				"SELECT id, channel, payload FROM notices WHERE id > ? ORDER BY id",
				seen,
			);
			seen = rows.at(-1)?.id ?? seen;
			return rows.map((row) => `${row.channel} ${row.payload}`);
		},
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

const ready = ["pool_ready root"];

test("each write that makes work ready or ends an attempt notifies pool_ready with its root, in its transaction (#5103)", async () => {
	const f = await fixture();
	try {
		await f.pool.enqueue(f.lease, work, boundary);
		assert.deepEqual(await f.notices(), ready, "enqueue");
		assert.deepEqual(
			await f.pool.enqueue(f.lease, work, boundary).then(() => f.notices()),
			[],
			"an enqueue that changes nothing",
		);
		const first = (await f.pool.claim(f.lease, "worker", [work], 60_000))!;
		assert.deepEqual(await f.notices(), [], "a claim makes nothing ready");
		assert.equal(await f.pool.releaseExited(f.lease, first, { delayMs: 0 }), true);
		assert.deepEqual(await f.notices(), ready, "release");
		assert.equal(await f.pool.releaseExited(f.lease, first), false);
		assert.deepEqual(await f.notices(), [], "a release that finds nothing to settle");
		const second = (await f.pool.claim(f.lease, "worker", [work], 60_000))!;
		assert.equal(await f.pool.releaseUnplaced(f.lease, second), true);
		assert.deepEqual(await f.notices(), ready, "unplaced release");
		const third = (await f.pool.claim(f.lease, "worker", [work], 60_000))!;
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0");
		assert.equal(await f.pool.expire(f.lease, third), true);
		assert.deepEqual(await f.notices(), ready, "expiry");
		const fourth = (await f.pool.claim(f.lease, "worker", [work], 60_000))!;
		await f.pool.complete(f.lease, fourth, { runId: work.childRunId, status: "completed", result: {} });
		assert.deepEqual(await f.notices(), ready, "completion");
	} finally {
		await f.close();
	}
});

test("failing an attempt and closing the pool notify, and closing a pool with nothing to settle does not (#5103)", async () => {
	const f = await fixture();
	try {
		await f.pool.enqueue(f.lease, work, boundary);
		await f.notices();
		const attempt = (await f.pool.claim(f.lease, "worker", [work], 60_000))!;
		assert.equal(await f.pool.failExited(f.lease, attempt), true);
		assert.deepEqual(await f.notices(), ready, "failure");
		assert.equal(await f.pool.releaseClosed(f.lease), 0);
		assert.deepEqual(await f.notices(), [], "nothing to close");
		const other = poolWorkFixture("other");
		await f.pool.enqueue(f.lease, other.work, other.boundary);
		await f.notices();
		assert.equal(await f.pool.releaseClosed(f.lease), 1);
		assert.deepEqual(await f.notices(), ready, "closed");
	} finally {
		await f.close();
	}
});

test("resuming the pool notifies, so idle workers of other hosts claim at once; pausing and quitting do not (#5230)", async () => {
	const f = await fixture();
	try {
		await f.notices();
		await f.pool.setControl(f.lease, "paused");
		assert.deepEqual(await f.notices(), [], "pause");
		await f.pool.setControl(f.lease, "running");
		assert.deepEqual(await f.notices(), ready, "resume");
		await f.pool.setControl(f.lease, "quit");
		assert.deepEqual(await f.notices(), [], "quit");
	} finally {
		await f.close();
	}
});

test("a new incarnation's releases and reopenings notify, and none notifies with nothing to release (#5103)", async () => {
	const f = await fixture();
	try {
		await f.pool.enqueue(f.lease, work, boundary);
		const held = (await f.pool.claim(f.lease, "dead-worker", [work], 60_000))!;
		const done = poolWorkFixture("done");
		await f.pool.enqueue(f.lease, done.work, done.boundary);
		const finished = (await f.pool.claim(f.lease, "worker", [done.work], 60_000))!;
		await f.pool.complete(f.lease, finished, { runId: done.work.childRunId, status: "completed", result: {} });
		await f.notices();
		await f.database.run("UPDATE wf_leases SET renewed_at = 0");
		const takeover = await f.journal.takeoverExpired("root", "resumed", 60_000);
		if (takeover.status !== "acquired") assert.fail("takeover failed");
		assert.equal(await f.pool.releasePreviousIncarnations(takeover.lease, [held.id]), 0);
		assert.deepEqual(await f.notices(), [], "nothing released");
		assert.equal(await f.pool.releaseRetained(takeover.lease, held, true), true);
		assert.deepEqual(await f.notices(), ready, "a retained attempt released");
		assert.ok(await f.pool.reopenCompleted(takeover.lease, finished.id, () => true));
		assert.deepEqual(await f.notices(), ready, "a completed child reopened");
		const again = (await f.pool.claim(takeover.lease, "worker", [work], 60_000))!;
		await f.notices();
		await f.database.run("UPDATE wf_leases SET renewed_at = 0");
		const third = await f.journal.takeoverExpired("root", "third", 60_000);
		if (third.status !== "acquired") assert.fail("takeover failed");
		assert.equal(again.epoch, takeover.lease.epoch);
		assert.equal(await f.pool.releasePreviousIncarnations(third.lease), 1);
		assert.deepEqual(await f.notices(), ready, "a previous incarnation's attempt released");
	} finally {
		await f.close();
	}
});

test("the channel is named after the journal's prefix, and listeners hear each root and missed wake-ups (#5103)", async () => {
	const f = await fixture("team_");
	try {
		assert.equal(poolReadyChannel(sqlPoolStorage(f.journal)!), "team_pool_ready");
		await f.pool.enqueue(f.lease, work, boundary);
		assert.deepEqual(await f.notices(), ["team_pool_ready root"]);
		const heard: (string | undefined)[] = [];
		const subscription = listenPoolReady(f.journal, (root) => heard.push(root));
		assert.ok(subscription);
		const [listening] = f.listeners;
		assert.equal(listening?.channel, "team_pool_ready");
		listening!.listener({ kind: "notification", payload: "root" });
		listening!.listener({ kind: "listening" });
		assert.deepEqual(heard, ["root", undefined]);
		subscription.close();
		assert.equal(listening!.open, false);
	} finally {
		await f.close();
	}
	assert.equal(
		poolReadyChannel({ tables: { runs: "custom_runs", events: "e", leases: "l" } }),
		"custom_runs_pool_ready",
	);
});

test("a journal whose database has no notifications sends none and has nothing to listen to (#5103)", async () => {
	const directory = makeTempDirectory("pool-ready-plain-");
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const journal = await SqlRunJournal.open(database);
	try {
		await journal.createRun(header);
		const acquired = await journal.acquire("root", "coordinator");
		const lease = (acquired as { lease: Lease }).lease;
		const pool = await openSqlPoolQueue(journal);
		await pool.initialize(lease, 60_000);
		await pool.enqueue(lease, work, boundary);
		const attempt = (await pool.claim(lease, "worker", [work], 60_000))!;
		await pool.complete(lease, attempt, { runId: work.childRunId, status: "completed", result: {} });
		assert.equal(await pool.releaseClosed(lease), 0);
		assert.equal(
			listenPoolReady(journal, () => {}),
			undefined,
		);
		assert.equal(sqlPoolStorage(journal)!.notifications, undefined);
	} finally {
		await journal.close();
		await database.close();
		removeTempDirectory(directory);
	}
});
