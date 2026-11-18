import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as realSleep, setImmediate as realTurn } from "node:timers/promises";
import { afterEach, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteRow,
	SqliteTransactionOptions,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { StorageWriteLockTimeoutError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

/**
 * A connection sends each call that is one request to its thread without waiting for the answers of the calls before
 * it (#5376), and still commits its calls in the order they were made: a transaction that finds the write lock busy is
 * answered so and runs nothing, the thread refuses every request sent behind it, and those calls are sent again, in
 * order, once it committed.
 */

/** How long another connection holds the write lock: long enough that every call behind the refused one was sent. */
const HOLD_MS = 300;
/** Real event-loop turns a held request waits for the requests behind it; far more than sending them takes. */
const SEND_TURNS = 10_000;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function database() {
	const directory = makeTempDirectory("node-sqlite-pipeline-");
	cleanups.push(() => removeTempDirectory(directory));
	const path = join(directory, "pipeline.sqlite");
	const opened = await openNodeSqliteDatabase(path);
	cleanups.push(() => opened.close());
	await opened.exec("CREATE TABLE items (n INTEGER NOT NULL)");
	return { database: opened, path };
}

/** Another connection holding the write lock, as a writer of another process that does not queue would. */
function holdLock(path: string): { release(): void } {
	const other = new DatabaseSync(path);
	other.exec("BEGIN IMMEDIATE");
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		other.exec("COMMIT");
		other.close();
	};
	cleanups.push(release);
	return { release };
}

/** Inserts `n` in a transaction of its own, as one request. */
function insert(db: SqliteDatabase, n: number, options?: SqliteTransactionOptions): Promise<SqliteRow[][]> {
	const { commitStatements } = db;
	if (commitStatements === undefined) return assert.fail("node-sqlite connections commit statements in one request");
	return commitStatements.call(db, [{ sql: "INSERT INTO items VALUES (?)", params: [n] }], options);
}

async function items(path: string): Promise<number[]> {
	const reader = new DatabaseSync(path, { readOnly: true });
	try {
		return (reader.prepare("SELECT n FROM items ORDER BY rowid").all() as { n: number }[]).map((row) => row.n);
	} finally {
		reader.close();
	}
}

/** Counts the requests refused because a request before them found the lock busy. */
function countRefusals(): { readonly refused: number } {
	let refused = 0;
	const interception = interceptConnectionRequests((request, send) =>
		send(request).catch((error: unknown) => {
			if ((error as Error).name === "ConnectionRefusedError") refused++;
			throw error;
		}),
	);
	cleanups.push(interception.restore);
	return {
		get refused() {
			return refused;
		},
	};
}

test("a connection sends calls that are one request each without waiting for the answers before them (#5376)", async () => {
	const { database: db } = await database();
	let sent = 0;
	let mostInFlight = 0;
	let inFlight = 0;
	const interception = interceptConnectionRequests(async (request, send) => {
		sent++;
		inFlight++;
		mostInFlight = Math.max(mostInFlight, inFlight);
		try {
			// The first answer waits until the calls behind it were sent, or until they plainly were not.
			if (sent === 1) for (let turn = 0; turn < SEND_TURNS && sent < 4; turn++) await realTurn();
			return await send(request);
		} finally {
			inFlight--;
		}
	});
	cleanups.push(interception.restore);
	const calls = [
		db.get("SELECT COUNT(*) AS count FROM items"),
		db.run("INSERT INTO items VALUES (1)"),
		insert(db, 2),
		db.all("SELECT n FROM items"),
	];
	await Promise.all(calls);
	interception.restore();
	assert.equal(mostInFlight, 4, "every call was sent before the first one was answered");
	assert.deepEqual(await db.all("SELECT n FROM items ORDER BY rowid"), [{ n: 1 }, { n: 2 }]);
});

test("calls sent behind a transaction that found the write lock busy commit after it, in order and once (#5376)", async () => {
	const { database: db, path } = await database();
	const refusals = countRefusals();
	const holder = holdLock(path);
	const calls = [
		insert(db, 1),
		db.run("INSERT INTO items VALUES (2)"),
		insert(db, 3),
		db.get<{ count: number }>("SELECT COUNT(*) AS count FROM items"),
	];
	await realSleep(HOLD_MS);
	holder.release();
	const settled = await Promise.all(calls);
	assert.ok(refusals.refused > 0, "the calls behind the busy transaction were refused, then sent again");
	assert.deepEqual(await items(path), [1, 2, 3]);
	assert.deepEqual(settled[3], { count: 3 }, "a read sent behind them sees what they wrote");
});

test("calls sent behind a busy transaction that gives up waiting still commit, in order (#5376)", async () => {
	const { database: db, path } = await database();
	const refusals = countRefusals();
	const holder = holdLock(path);
	const gaveUp = insert(db, 1, { lockWaitMs: 50 });
	const behind = [db.run("INSERT INTO items VALUES (2)"), insert(db, 3)];
	await assert.rejects(gaveUp, StorageWriteLockTimeoutError);
	holder.release();
	await Promise.all(behind);
	assert.ok(refusals.refused > 0, "the calls behind the busy transaction were refused, then sent again");
	assert.deepEqual(await items(path), [2, 3]);
});

test("a statement queued behind a transaction that holds the lock across awaits is not sent until it ended (#5376)", async () => {
	const { database: db, path } = await database();
	const rolledBack = db.transaction(async (tx) => {
		await tx.run("INSERT INTO items VALUES (1)");
		await realSleep(20);
		throw new Error("rolled back");
	});
	// Run inside that transaction, it would be rolled back with it.
	const behind = db.run("INSERT INTO items VALUES (2)");
	await assert.rejects(rolledBack, /rolled back/);
	await behind;
	assert.deepEqual(await items(path), [2]);
});

test("while a busy transaction waits for the lock, its connection's lock record says it is trying, the calls refused behind it notwithstanding (#5376)", async () => {
	const { database: db, path } = await database();
	const refusals = countRefusals();
	const holder = holdLock(path);
	const calls = [insert(db, 1), db.run("INSERT INTO items VALUES (2)")];
	for (let turn = 0; turn < SEND_TURNS && refusals.refused === 0; turn++) await realTurn();
	// Long enough for the refused answer to be handled and any record it wrote to land.
	await realSleep(50);
	const records = `${path}-holders`;
	const own = readdirSync(records).filter((name) => name.startsWith(`${process.pid}-`));
	const states = own.map((name) => readFileSync(join(records, name), "utf8").slice(0, 4));
	holder.release();
	await Promise.all(calls);
	assert.ok(refusals.refused > 0, "a call behind the busy transaction was refused");
	assert.deepEqual(states, ["want"], "a writer that gives up waiting meanwhile names this process");
	assert.deepEqual(await items(path), [1, 2]);
});
