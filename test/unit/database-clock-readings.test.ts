import assert from "node:assert/strict";
import { join } from "node:path";
import { openNodeSqliteDatabase, type SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";
import { readFleetDemand } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRateBuckets } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { readSharedPoolStats, SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * A statement that decides by the database's clock and reports or records a time from it reads the clock once, so its
 * answer is the one it would give at a single instant. SQLite returns one time for every reading within a statement, but
 * PostgreSQL's clock_timestamp() moves on between two readings. Every SQLite connection of this file reads `clock`
 * instead, which moves on by `step` ms at every reading as PostgreSQL's does, so a statement that reads it twice shows.
 */

const clock = vi.hoisted(() => ({ now: 0, step: 0 }));

vi.mock("node:sqlite", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:sqlite")>();
	class MovingClockDatabase extends actual.DatabaseSync {
		constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) {
			super(...args);
			this.function("unixepoch", { varargs: true }, () => {
				const at = clock.now;
				clock.now += clock.step;
				return at / 1_000;
			});
		}
	}
	return { ...actual, DatabaseSync: MovingClockDatabase };
});

const T = 1_800_000_000_000;

/** Stops the clock at `at`. */
function pin(at: number): void {
	clock.now = at;
	clock.step = 0;
}

/** Runs `read` on a clock that starts at `at` and moves on by 1 ms at every reading, then stops it. */
async function movingFrom<T>(at: number, read: () => Promise<T>): Promise<T> {
	clock.now = at;
	clock.step = 1;
	try {
		return await read();
	} finally {
		clock.step = 0;
	}
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	pin(0);
	// Windows refuses to remove a database file a connection still holds.
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function database(): Promise<SqliteDatabase> {
	const directory = makeTempDirectory("database-clock-");
	cleanups.push(() => removeTempDirectory(directory));
	const opened = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	cleanups.push(() => opened.close());
	return opened;
}

async function journal(): Promise<SqlRunJournal> {
	const opened = await SqlRunJournal.open(await database());
	cleanups.push(() => opened.close());
	return opened;
}

/** A running root of a shared pool, its lease renewed at `T`, holding one child leased at `T` for `leaseMs`. */
async function sharedRoot(leaseMs: number) {
	pin(T);
	const j = await journal();
	await j.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
	const acquired = await j.acquire("root", "owner");
	if (acquired.status !== "acquired") assert.fail("the root holds no lease");
	const queue = await openSqlPoolQueue(j);
	await queue.initialize(acquired.lease, 60_000);
	const shared = await SqlSharedPool.open(j, queue);
	await shared.publishConfig(acquired.lease, {
		definitions: [],
		leaseMs,
		heartbeatMs: 1_000,
		startupTimeoutMs: 60_000,
		claimWindowMs: 0,
	});
	const { work, boundary } = poolWorkFixture();
	await queue.enqueue(acquired.lease, work, boundary);
	assert.ok(await queue.claim(acquired.lease, "host/w0", [work], leaseMs));
	return j;
}

test("a poll reports a shared cooldown as running only while time is left of it (#4768)", async () => {
	const store = await SqlRateBuckets.open(await journal());
	pin(T);
	await store.cooldown("anthropic/opus", 5);
	for (let start = T; start <= T + 5; start++) {
		const { cooldowns } = await movingFrom(start, () => store.poll());
		if (start === T) assert.equal(cooldowns.length, 1);
		for (const { remainingMs } of cooldowns)
			assert.ok(remainingMs >= 1 && remainingMs <= T + 5 - start, `from ${start - T} ms: ${remainingMs}`);
	}
});

test("an acquire never takes more tokens than its bucket's burst in one request (#4768)", async () => {
	const store = await SqlRateBuckets.open(await journal());
	// Half a millisecond a token, a burst of one: two tokens never fit at once, at any instant.
	const shape = { intervalMs: 0.5, burst: 1 };
	for (let start = T; start < T + 5; start++) {
		const scope = `p/${start}`;
		const outcome = await movingFrom(start, () => store.acquire(scope, 2, shape));
		assert.equal(outcome.granted, 0, `from ${start - T} ms: ${JSON.stringify(outcome)}`);
		// What one request may take is the burst, and that much it takes.
		assert.deepEqual(await movingFrom(start + 10, () => store.acquire(scope, 1)), { granted: 1 });
	}
});

test("the fleet counts a root's leased child for as long as it counts the root as running (#4768)", async () => {
	// The child's own lease ended long before: only the root's lease, renewed at T with a 60 s timeout, keeps it live.
	const j = await sharedRoot(1_000);
	for (let start = T + 59_997; start <= T + 60_002; start++) {
		const [root, ...more] = await movingFrom(start, () => readFleetDemand(j));
		assert.deepEqual(more, []);
		assert.ok(
			root !== undefined && (root.blocked || root.leased === 1),
			`from ${start - T} ms: ${JSON.stringify(root)}`,
		);
	}
});

test("a shared pool's stats report each leased child renewed and expiring one whole lease apart (#4768)", async () => {
	const j = await sharedRoot(60_000);
	for (let start = T; start < T + 5; start++) {
		const stats = await movingFrom(start, () => readSharedPoolStats(j, "root"));
		const [lease] = stats?.leases ?? [];
		assert.ok(lease !== undefined);
		assert.equal(lease.renewedAgoMs + lease.expiresInMs, 60_000, `from ${start - T} ms: ${JSON.stringify(lease)}`);
	}
});

test("a broker lists a lease as live only while its age is within the stale bound (#4768)", async () => {
	const store = await openSqlBrokerLeaseStore({ database: await database(), prefix: "" });
	pin(T);
	const subject = { kind: "broker", brokerId: "broker", nodeId: "node", startedAt: 0 } as const;
	assert.equal((await store.acquire(subject, "broker", 30_000)).status, "acquired");
	for (let start = T + 7; start <= T + 12; start++) {
		const live = await movingFrom(start, () => store.listLive("broker", 10));
		if (start === T + 7) assert.equal(live.length, 1);
		for (const lease of live) assert.ok(lease.ageMs <= 10, `from ${start - T} ms: ${lease.ageMs}`);
	}
});

test("a known session is found only while its age is within the retention asked for (#4768)", async () => {
	const store = await openSqlKnownSessionStore({ database: await database(), prefix: "" });
	pin(T);
	assert.deepEqual(
		await store.record({
			targetIdentity: "agent",
			intercomSessionId: "agent",
			group: "default",
			groups: ["default"],
		}),
		{ status: "recorded" },
	);
	for (let start = T + 7; start <= T + 12; start++) {
		const found = await movingFrom(start, () => store.lookup("agent", 10));
		assert.equal(found.status, "found");
		if (found.status !== "found") return;
		if (start === T + 7) assert.equal(found.sessions.length, 1);
		for (const session of found.sessions) assert.ok(session.ageMs <= 10, `from ${start - T} ms: ${session.ageMs}`);
	}
});
