import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";
import { holdSqliteWriteLock } from "../helpers/sqlite-lock-holder.js";

/** How long the waiting connection's busy handler waits for the lock: long enough to show it never ran out. */
const BUSY_TIMEOUT_MS = 4_000;
/** How long the transaction holds the lock across an await that needs this thread: a timer. */
const HOLD_MS = 200;
/**
 * The longest this thread may go without running. A statement waiting for the lock on this thread would hold it for
 * the whole busy timeout; a few hundred milliseconds leaves room for a loaded machine.
 */
const MAX_EVENT_LOOP_STALL_MS = 1_000;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(path: string): Promise<SqliteDatabase> {
	const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: BUSY_TIMEOUT_MS });
	cleanups.push(() => database.close());
	return database;
}

function databasePath(): string {
	const directory = makeTempDirectory("atomic-connection-threads-");
	cleanups.push(() => removeTempDirectory(directory));
	return join(directory, "threads.sqlite");
}

/** The longest stretch this thread did not run while `operation` ran, in milliseconds. */
async function longestStall<T>(operation: () => Promise<T>): Promise<{ value: T; stallMs: number }> {
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	histogram.enable();
	try {
		const value = await operation();
		return { value, stallMs: histogram.max / 1e6 };
	} finally {
		histogram.disable();
	}
}

async function rows(database: SqliteDatabase): Promise<string[]> {
	return (await database.all<{ value: string }>("SELECT value FROM items ORDER BY rowid")).map((row) => row.value);
}

test("a write waiting for a lock that another connection of the process holds across an await no longer stops that connection (#5376)", async () => {
	const path = databasePath();
	const holder = await open(path);
	const waiter = await open(path);
	await holder.exec("CREATE TABLE items (value TEXT NOT NULL)");
	let locked!: () => void;
	const holding = new Promise<void>((resolve) => {
		locked = resolve;
	});
	const { value, stallMs } = await longestStall(async () => {
		const transaction = holder.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('first')");
			locked();
			// Work the transaction awaits on this thread while it holds the lock, as the writers' queue's file work does.
			await sleep(HOLD_MS);
			await tx.run("INSERT INTO items VALUES ('second')");
		});
		await holding;
		// A write outside a transaction: SQLite's busy handler makes it wait for the lock the transaction holds.
		const write = waiter.run("INSERT INTO items VALUES ('third')");
		const outcomes = await Promise.allSettled([transaction, write]);
		return outcomes.map((outcome) => (outcome.status === "fulfilled" ? "ok" : String(outcome.reason)));
	});
	assert.deepEqual(value, ["ok", "ok"], "the transaction committed and the waiting write followed it");
	assert.deepEqual(await rows(waiter), ["first", "second", "third"]);
	assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `this thread stalled for ${Math.round(stallMs)} ms`);
});

test("a writer queued behind another process, holding the lock, and a same-process write waiting for it all finish (#5376)", async () => {
	const path = databasePath();
	const writer = await open(path);
	const waiter = await open(path);
	await writer.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const other = await holdSqliteWriteLock(path);
	let released = false;
	try {
		let locked!: () => void;
		const holding = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const { value, stallMs } = await longestStall(async () => {
			// Refused while the other process holds the lock, so it queues for it.
			const transaction = writer.transaction(async (tx) => {
				await tx.run("INSERT INTO items VALUES ('queued')");
				locked();
				await sleep(HOLD_MS);
			});
			await sleep(HOLD_MS);
			released = true;
			await other.release();
			await holding;
			const write = waiter.run("INSERT INTO items VALUES ('waiting')");
			const outcomes = await Promise.allSettled([transaction, write]);
			return outcomes.map((outcome) => (outcome.status === "fulfilled" ? "ok" : String(outcome.reason)));
		});
		assert.deepEqual(value, ["ok", "ok"]);
		assert.deepEqual(await rows(waiter), ["queued", "waiting"]);
		assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `this thread stalled for ${Math.round(stallMs)} ms`);
	} finally {
		if (!released) await other.release();
	}
});

test("a closed connection that stays referenced keeps nothing its closer held (#5376)", async () => {
	const database = await open(databasePath());
	await database.run("CREATE TABLE t(v)");
	const closers = trackCollection();
	// A session that closes its store and ends, while something else keeps the store, as a module's state can.
	await (async () => {
		const session = { transcript: Array.from({ length: 1_000 }, (_, index) => `entry ${index}`) };
		closers.track(session);
		const dispose = async () => {
			await database.close();
			return session.transcript.length;
		};
		await dispose();
	})();
	await collectEverythingTracked(closers);
	assert.deepEqual(closers.uncollected(), [], "the closed connection keeps the session that closed it");
	await assert.rejects(database.run("INSERT INTO t VALUES (1)"), /closed/);
});

test("a connection's thread raises only its own scheduling priority, never the caller's (#5376)", async () => {
	const { currentThreadPriority } = createRequire(import.meta.url)("@bastani/atomic-natives") as {
		currentThreadPriority(): number;
	};
	const before = currentThreadPriority();
	const database = await open(databasePath());
	await database.transaction((transaction) => transaction.run("CREATE TABLE t(v)"));
	assert.equal(currentThreadPriority(), before, "the calling thread keeps its priority");
	assert.equal(before, 0, "at normal priority");
});

/** The kinds of the requests every adapter connection sends its thread while `work` runs. */
async function requestKinds<T>(work: () => Promise<T>): Promise<{ value: T; kinds: string[] }> {
	const kinds: string[] = [];
	const interception = interceptConnectionRequests((request, send) => {
		kinds.push(request.kind);
		return send(request);
	});
	try {
		return { value: await work(), kinds };
	} finally {
		interception.restore();
	}
}

test("committed statements with nobody waiting for the lock are one request to their connection's thread, lock and commit included (#5376)", async () => {
	const database = await open(databasePath());
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const { value, kinds } = await requestKinds(() =>
		database.commitStatements!([
			{ sql: "INSERT INTO items VALUES (?)", params: ["first"] },
			{ sql: "INSERT INTO items VALUES (?) RETURNING value", params: ["second"] },
		]),
	);
	assert.deepEqual(value, [[], [{ value: "second" }]], "each statement's rows");
	assert.deepEqual(kinds, ["transaction"]);
	assert.deepEqual(await rows(database), ["first", "second"]);
});

test("committed statements of which one fails write nothing and reject with the driver's error (#5376)", async () => {
	const database = await open(databasePath());
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	await assert.rejects(
		database.commitStatements!([
			{ sql: "INSERT INTO items VALUES (?)", params: ["kept back"] },
			{ sql: "INSERT INTO items VALUES (NULL)", params: [] },
		]),
		(error: Error) => /NOT NULL constraint failed/.test(String((error as { cause?: Error }).cause?.message)),
	);
	assert.deepEqual(await rows(database), [], "the first statement was rolled back with the rest");
	await database.commitStatements!([{ sql: "INSERT INTO items VALUES (?)", params: ["after"] }]);
	assert.deepEqual(await rows(database), ["after"], "and the connection is out of the transaction");
});

test("committed statements refused by a lock another process holds wait for it, then commit in order with the connection's other calls (#5376)", async () => {
	const path = databasePath();
	const database = await open(path);
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const other = await holdSqliteWriteLock(path);
	const committed = database.commitStatements!([{ sql: "INSERT INTO items VALUES (?)", params: ["committed"] }]);
	const after = database.run("INSERT INTO items VALUES ('after')");
	await sleep(HOLD_MS);
	await other.release();
	await Promise.all([committed, after]);
	assert.deepEqual(await rows(database), ["committed", "after"]);
});

test("committing statements leaves the connection without batch, so stores that write in batches keep their transactions (#5376)", async () => {
	const database = await open(databasePath());
	assert.equal(database.batch, undefined);
	assert.equal(typeof database.commitStatements, "function");
});

test("committed statements that waited for the lock run and commit in one request once they hold it (#5376)", async () => {
	const path = databasePath();
	const database = await open(path);
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const other = await holdSqliteWriteLock(path);
	const { kinds } = await requestKinds(async () => {
		const committed = database.commitStatements!([{ sql: "INSERT INTO items VALUES (?)", params: ["waited"] }]);
		await sleep(HOLD_MS);
		await other.release();
		await committed;
	});
	const tookLock = kinds.lastIndexOf("begin");
	assert.ok(tookLock >= 0, `the call waited for the lock: ${kinds.join(", ")}`);
	assert.deepEqual(kinds.slice(tookLock + 1), ["statements"], "then ran and committed in one request");
	assert.deepEqual(await rows(database), ["waited"]);
});

test("committed statements are one request again once contention has left the writers' queue empty (#5376)", async () => {
	const path = databasePath();
	const database = await open(path);
	await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
	// The queue directory a contended moment leaves behind, with no writer waiting in it.
	mkdirSync(`${path}-writers`, { recursive: true });
	const { kinds } = await requestKinds(() =>
		database.commitStatements!([{ sql: "INSERT INTO items VALUES (?)", params: ["after contention"] }]),
	);
	assert.deepEqual(kinds, ["transaction"]);
	assert.deepEqual(await rows(database), ["after contention"]);
});
