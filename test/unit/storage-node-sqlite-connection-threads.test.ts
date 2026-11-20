import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { isSqliteBusy } from "../../packages/coding-agent/src/core/storage/write-ahead-log.js";
import { collectEverythingTracked, trackCollection } from "../helpers/collect-garbage.js";
import { observeRowsAndFailures } from "../helpers/node-sqlite-observations.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { holdSqliteWriteLock } from "../helpers/sqlite-lock-holder.js";

/** How long the waiting connection's busy handler waits for the lock: long enough to show it never ran out. */
const BUSY_TIMEOUT_MS = 4_000;
/** How long a lock is held across a wait that needs this thread, a timer, or by another process. */
const HOLD_MS = 2_000;
/**
 * The longest this thread may go without running while a statement waits for the lock. A statement waiting on this
 * thread holds it for the whole wait, `HOLD_MS`; half of it leaves room for a loaded machine.
 */
const MAX_EVENT_LOOP_STALL_MS = HOLD_MS / 2;

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

/** How often the stall measurement runs a timer, in milliseconds. */
const TICK_MS = 10;

/**
 * The longest stretch this thread did not run while `operation` ran, in milliseconds: the longest gap between two
 * runs of a repeating timer, the last one after the operation ended.
 */
async function longestStall<T>(operation: () => Promise<T>): Promise<{ value: T; stallMs: number }> {
	let last = performance.now();
	let stallMs = 0;
	const tick = () => {
		const now = performance.now();
		stallMs = Math.max(stallMs, now - last);
		last = now;
	};
	const timer = setInterval(tick, TICK_MS);
	try {
		const value = await operation();
		// A stall that ended with the operation is seen when the timer next runs.
		await sleep(2 * TICK_MS);
		tick();
		return { value, stallMs };
	} finally {
		clearInterval(timer);
	}
}

async function rows(database: SqliteDatabase): Promise<string[]> {
	return (await database.all<{ value: string }>("SELECT value FROM items ORDER BY rowid")).map((row) => row.value);
}

test("a write waiting for another process's lock leaves the event loop running (#5376)", async () => {
	const path = databasePath();
	const database = await open(path);
	// Another process holds the write lock and lets go after HOLD_MS on its own.
	const other = await holdSqliteWriteLock(path, HOLD_MS);
	try {
		const { stallMs } = await longestStall(async () => {
			// Outside a transaction: SQLite's busy handler waits for the lock.
			await database.exec("CREATE TABLE items (value TEXT NOT NULL)");
			await database.run("INSERT INTO items VALUES ('after the other process')");
		});
		assert.deepEqual(await rows(database), ["after the other process"]);
		assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `the event loop stalled for ${Math.round(stallMs)} ms`);
	} finally {
		await other.release();
	}
});

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
			// Work the transaction awaits on this thread while it holds the lock.
			await sleep(HOLD_MS / 4);
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
	assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `the event loop stalled for ${Math.round(stallMs)} ms`);
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

test("rows and driver errors cross from a connection's thread as they come from one on the calling thread (#5376)", async () => {
	const threaded = await open(databasePath());
	const inMemory = await openNodeSqliteDatabase(":memory:");
	cleanups.push(() => inMemory.close());
	assert.deepStrictEqual(await observeRowsAndFailures(threaded), await observeRowsAndFailures(inMemory));
});

/** A connection this thread opens itself and wraps, on the file of `threaded`; closed with the test. */
function wrappedBeside(threaded: SqliteDatabase, busyTimeoutMs: number): SqliteDatabase {
	const raw = new DatabaseSync(threaded.descriptor.location);
	const wrapped = wrapNodeSqliteDatabase(raw);
	raw.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
	cleanups.push(async () => {
		await wrapped.close();
		raw.close();
	});
	return wrapped;
}

/** A read that keeps a connection busy for a while: long enough for the event loop to turn while it runs. */
const SLOW_READ =
	"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300000) SELECT sum(i) AS s FROM n";

test("a write through a wrapped connection, made while a transaction on a thread holds the file's lock, runs after it commits without stopping the event loop (#5376)", async () => {
	const threaded = await open(databasePath());
	await threaded.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const wrapped = wrappedBeside(threaded, HOLD_MS);
	let write: Promise<unknown> | undefined;
	const { value, stallMs } = await longestStall(async () => {
		await threaded.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('threaded')");
			// Made from the event loop while the transaction holds the lock, not awaited by it.
			setImmediate(() => {
				write = wrapped.run("INSERT INTO items VALUES ('wrapped')");
			});
			await tx.get(SLOW_READ);
		});
		return write;
	});
	assert.ok(value !== undefined, "the wrapped write was made while the transaction ran");
	await value;
	assert.deepEqual(await rows(threaded), ["threaded", "wrapped"]);
	assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `the event loop stalled for ${Math.round(stallMs)} ms`);
});

test("a read through a wrapped connection that a transaction on a thread awaits runs at once (#5376)", async () => {
	const threaded = await open(databasePath());
	await threaded.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const wrapped = wrappedBeside(threaded, BUSY_TIMEOUT_MS);
	const started = performance.now();
	const read = await threaded.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('uncommitted')");
		return wrapped.get<{ n: number }>("SELECT count(*) AS n FROM items");
	});
	assert.deepEqual(read, { n: 0 }, "the read saw the file before the transaction committed");
	assert.ok(performance.now() - started < BUSY_TIMEOUT_MS / 2, "the read did not wait for the busy timeout");
});

test("a write through a wrapped connection that a transaction on a thread awaits fails busy after its busy timeout without stopping the event loop (#5376)", async () => {
	const threaded = await open(databasePath());
	await threaded.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const wrapped = wrappedBeside(threaded, HOLD_MS);
	const { value, stallMs } = await longestStall(() =>
		threaded.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('threaded')");
			return wrapped.run("INSERT INTO items VALUES ('wrapped')").then(
				() => "wrote",
				(error: unknown) => error,
			);
		}),
	);
	assert.ok(value instanceof StorageUnavailableError, String(value));
	assert.ok(isSqliteBusy(value), "it failed as SQLite's busy handler fails once its busy timeout passed");
	assert.deepEqual(await rows(threaded), ["threaded"]);
	assert.ok(stallMs < MAX_EVENT_LOOP_STALL_MS, `the event loop stalled for ${Math.round(stallMs)} ms`);
});

test("a wrapped connection's busy timeout reads and changes as always while a transaction on a thread holds the file's lock (#5376)", async () => {
	const threaded = await open(databasePath());
	await threaded.exec("CREATE TABLE items (value TEXT NOT NULL)");
	const wrapped = wrappedBeside(threaded, BUSY_TIMEOUT_MS);
	const seen = await threaded.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES ('threaded')");
		const before = await wrapped.get<{ timeout: number }>("PRAGMA busy_timeout");
		await wrapped.run("PRAGMA busy_timeout=37");
		return [before, await wrapped.get<{ timeout: number }>("PRAGMA busy_timeout")];
	});
	assert.deepEqual(seen, [{ timeout: BUSY_TIMEOUT_MS }, { timeout: 37 }]);
	assert.deepEqual(await wrapped.get("PRAGMA busy_timeout"), { timeout: 37 });
});
