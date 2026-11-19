import assert from "node:assert/strict";
import { join } from "node:path";
import { openNodeSqliteDatabase, type SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { openSqlKnownSessionStore } from "../../packages/intercom/broker/sql-known-session-store.js";
import { openSqlBrokerLeaseStore } from "../../packages/intercom/broker/sql-lease-store.js";

import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";

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
			const read = (): number => {
				const at = clock.now;
				clock.now += clock.step;
				return at;
			};
			// SQLite's millisecond clock reads julianday(), its second clock unixepoch().
			this.function("unixepoch", { varargs: true }, () => read() / 1_000);
			this.function("julianday", { varargs: true }, () => read() / 86_400_000 + 2_440_587.5);
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
