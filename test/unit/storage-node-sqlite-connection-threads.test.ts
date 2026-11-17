import assert from "node:assert/strict";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
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
