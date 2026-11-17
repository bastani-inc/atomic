import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Worker } from "node:worker_threads";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import {
	type SqliteDatabase,
	StorageInvalidTextError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageUnavailableError,
	StoreClosedError,
} from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { openThreadedSqliteDatabase } from "../../packages/workflows/src/workers/ship-shard-thread.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const threads = vi.hoisted(() => ({ started: [] as Worker[] }));

vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>();
	class TrackedWorker extends actual.Worker {
		constructor(...args: ConstructorParameters<typeof actual.Worker>) {
			super(...args);
			threads.started.push(this);
		}
	}
	return { ...actual, Worker: TrackedWorker };
});

const WINDOWS_MAX_PATH = 260;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CANTOPEN = 14;

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
	for (const database of databases.splice(0)) await database.close().catch(() => {});
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
	threads.started.splice(0);
});

function itemsPath(...segments: string[]): string {
	const directory = makeTempDirectory("ship-shard-thread-");
	directories.push(directory);
	return join(directory, ...segments, "items.sqlite");
}

async function openItems(
	schema = "CREATE TABLE items (value TEXT NOT NULL UNIQUE)",
	path = itemsPath("nested"),
): Promise<SqliteDatabase> {
	const database = await openThreadedSqliteDatabase(path);
	databases.push(database);
	await database.exec(schema);
	return database;
}

async function rows(database: SqliteDatabase): Promise<string[]> {
	const found = await database.all<{ value: string }>("SELECT value FROM items ORDER BY rowid");
	return found.map((row) => row.value);
}

test("a threaded connection opens its file in write-ahead mode with full syncs and foreign keys (#5321)", async () => {
	const database = await openItems();
	assert.deepEqual(await database.get("PRAGMA journal_mode"), { journal_mode: "wal" });
	assert.deepEqual(await database.get("PRAGMA synchronous"), { synchronous: 2 });
	assert.deepEqual(await database.get("PRAGMA foreign_keys"), { foreign_keys: 1 });
});

test("transactions requested together commit in the order requested and each sees the writes ahead of it (#5321)", async () => {
	const database = await openItems();
	const seen = await Promise.all(
		Array.from({ length: 5 }, (_, index) =>
			database.transaction(async (tx) => {
				const before = await tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM items");
				await tx.run("INSERT INTO items VALUES (?)", `v${index}`);
				return before?.count;
			}),
		),
	);
	assert.deepEqual(seen, [0, 1, 2, 3, 4]);
	assert.deepEqual(await rows(database), ["v0", "v1", "v2", "v3", "v4"]);
});

test("a grouped transaction that throws undoes only its own writes and rejects only its caller (#5321)", async () => {
	const database = await openItems();
	const outcomes = await Promise.allSettled([
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('a')")),
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('b')");
			throw new Error("conflict");
		}),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('c')")),
	]);
	assert.deepEqual(
		outcomes.map((outcome) => outcome.status),
		["fulfilled", "rejected", "fulfilled"],
	);
	assert.equal((outcomes[1] as PromiseRejectedResult).reason.message, "conflict");
	assert.deepEqual(await rows(database), ["a", "c"]);
});

test("a transaction alone that throws rolls back and rejects with its own error (#5321)", async () => {
	const database = await openItems();
	await assert.rejects(
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('undone')");
			throw new Error("alone");
		}),
		/alone/,
	);
	assert.deepEqual(await rows(database), []);
});

test("a statement requested between transactions keeps its place in the order (#5321)", async () => {
	const database = await openItems();
	await Promise.all([
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('first')")),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('second')")),
		database.run("INSERT INTO items VALUES ('statement')"),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('third')")),
	]);
	assert.deepEqual(await rows(database), ["first", "second", "statement", "third"]);
});

test("a commit that fails rejects every grouped caller and writes nothing (#5321)", async () => {
	const database = await openItems(`
		CREATE TABLE parents (id INTEGER PRIMARY KEY);
		CREATE TABLE items (value TEXT NOT NULL UNIQUE, parent INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);
	`);
	const outcomes = await Promise.allSettled([
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('x', NULL)")),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('orphan', 7)")),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('z', NULL)")),
	]);
	assert.ok(outcomes.every((outcome) => outcome.status === "rejected"));
	assert.ok((outcomes[0] as PromiseRejectedResult).reason instanceof StorageUnavailableError);
	assert.deepEqual(await rows(database), []);
	await database.transaction((tx) => tx.run("INSERT INTO items VALUES ('after', NULL)"));
	assert.deepEqual(await rows(database), ["after"]);
});

test("a member that ends the shared transaction fails the members before it, and the rest still commit in order (#5321)", async () => {
	const database = await openItems();
	await database.run("INSERT INTO items VALUES ('taken')");
	let late: Promise<unknown> | undefined;
	const outcomes = await Promise.allSettled([
		database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('before')");
			late = database.transaction((inner) => inner.run("INSERT INTO items VALUES ('late')"));
		}),
		database.transaction((tx) => tx.run("INSERT OR ROLLBACK INTO items VALUES ('taken')")),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('behind')")),
		database.run("INSERT INTO items VALUES ('statement')"),
	]);
	await late;
	assert.deepEqual(
		outcomes.map((outcome) => outcome.status),
		["rejected", "rejected", "fulfilled", "fulfilled"],
	);
	assert.ok((outcomes[0] as PromiseRejectedResult).reason instanceof StorageUnavailableError);
	assert.ok((outcomes[1] as PromiseRejectedResult).reason instanceof StorageRollbackError);
	assert.deepEqual(await rows(database), ["taken", "behind", "statement", "late"]);
});

test("a transaction's handle refuses statements once its callback returned (#5321)", async () => {
	const database = await openItems();
	let kept: Parameters<Parameters<SqliteDatabase["transaction"]>[0]>[0] | undefined;
	await database.transaction(async (tx) => {
		kept = tx;
	});
	await assert.rejects(kept!.run("INSERT INTO items VALUES ('late')"), StorageTransactionClosedError);
	assert.deepEqual(await rows(database), []);
});

test("a text parameter with a NUL character is refused before it reaches SQLite (#5321)", async () => {
	const database = await openItems();
	await assert.rejects(database.run("INSERT INTO items VALUES (?)", "a\0b"), StorageInvalidTextError);
	assert.deepEqual(await rows(database), []);
});

test("closing runs what was queued first, then refuses new work (#5321)", async () => {
	const database = await openItems();
	const queued = database.run("INSERT INTO items VALUES ('queued')");
	const closing = database.close();
	await assert.rejects(database.run("INSERT INTO items VALUES ('refused')"), StoreClosedError);
	await assert.rejects(
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('refused')")),
		StoreClosedError,
	);
	assert.deepEqual(await queued, { changes: 1 });
	await closing;
	await database.close();
	const reopened = await openThreadedSqliteDatabase(join(directories.at(-1)!, "nested", "items.sqlite"));
	databases.push(reopened);
	assert.deepEqual(await rows(reopened), ["queued"]);
});

test("a failed statement reports the SQLite failure and the database it happened in (#5321)", async () => {
	const path = itemsPath("nested");
	const database = await openItems(undefined, path);
	await database.run("INSERT INTO items VALUES ('taken')");
	const failure = await database.run("INSERT INTO items VALUES ('taken')").then(
		() => assert.fail("a duplicate was inserted"),
		(error: unknown) => error,
	);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal(failure.adapter, "node-sqlite");
	assert.equal(failure.location, path);
	assert.match(
		failure.message,
		new RegExp(`UNIQUE constraint failed: items\\.value \\(SQLite code ${SQLITE_CONSTRAINT_UNIQUE}\\)$`),
	);
	assert.deepEqual(
		{
			name: (failure.cause as Error).name,
			code: (failure.cause as { code?: string }).code,
			errcode: (failure.cause as { errcode?: number }).errcode,
			errstr: (failure.cause as { errstr?: string }).errstr,
		},
		{ name: "Error", code: "ERR_SQLITE_ERROR", errcode: SQLITE_CONSTRAINT_UNIQUE, errstr: "constraint failed" },
	);
});

test("a file that cannot open fails the open with SQLite's reason and stops its thread (#5321)", async () => {
	const path = itemsPath();
	mkdirSync(path);
	const failure = await openThreadedSqliteDatabase(path).then(
		() => assert.fail("a directory opened as a database"),
		(error: unknown) => error,
	);
	assert.ok(failure instanceof StorageUnavailableError);
	assert.equal(((failure.cause as { errcode?: number }).errcode ?? 0) & 0xff, SQLITE_CANTOPEN);
	assert.equal(threads.started.length, 1);
	assert.equal(threads.started[0]!.threadId, -1);
});

test("a database whose path is longer than Windows' MAX_PATH opens and keeps its rows (#5321)", async () => {
	const segments = Array.from({ length: 12 }, (_, index) => `segment-${index}-${"x".repeat(16)}`);
	const path = itemsPath(...segments);
	assert.ok(path.length > WINDOWS_MAX_PATH);
	const database = await openItems(undefined, path);
	await database.run("INSERT INTO items VALUES ('deep')");
	await database.close();
	const reopened = await openThreadedSqliteDatabase(path);
	databases.push(reopened);
	assert.deepEqual(await rows(reopened), ["deep"]);
});

test("a grouped transaction's handle refuses statements once its callback returned (#5321)", async () => {
	const database = await openItems();
	let kept: Parameters<Parameters<SqliteDatabase["transaction"]>[0]>[0] | undefined;
	await Promise.all([
		database.transaction(async (tx) => {
			kept = tx;
			await tx.run("INSERT INTO items VALUES ('first')");
		}),
		database.transaction((tx) => tx.run("INSERT INTO items VALUES ('second')")),
	]);
	await assert.rejects(kept!.run("INSERT INTO items VALUES ('late')"), StorageTransactionClosedError);
	assert.deepEqual(await rows(database), ["first", "second"]);
});

for (const grouped of [false, true])
	test(`a connection thread that fails inside ${grouped ? "a group of transactions" : "a transaction"} fails it with the thread's failure, not a rollback failure (#5321)`, async () => {
		const database = await openItems();
		const [thread] = threads.started;
		assert.ok(thread !== undefined);
		const inside = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const failing = database.transaction(async (tx) => {
			await tx.run("INSERT INTO items VALUES ('first')");
			inside.resolve();
			await resume.promise;
			await tx.run("INSERT INTO items VALUES ('second')");
		});
		const behind = grouped ? database.transaction((tx) => tx.run("INSERT INTO items VALUES ('behind')")) : undefined;
		await inside.promise;
		const reported = new Error("connection thread failed");
		thread.emit("error", reported);
		resume.resolve();
		const lost = await failing.then(
			() => assert.fail("the transaction committed after its thread failed"),
			(error: unknown) => error,
		);
		assert.ok(lost instanceof StorageUnavailableError);
		assert.equal(lost.cause, reported);
		if (behind !== undefined) await assert.rejects(behind, (error: unknown) => error === lost);
		await assert.rejects(database.get("SELECT 1"), (error: unknown) => error === lost);
	});

test("a threaded connection returns a column named __proto__ as its own field, as the in-process adapter does (#5321)", async () => {
	const path = itemsPath("nested");
	const threaded = await openItems(undefined, path);
	const inProcess = await openNodeSqliteDatabase(join(dirname(path), "in-process.sqlite"));
	databases.push(inProcess);
	const sql = `SELECT NULL AS "__proto__", 3 AS "constructor", 4 AS "toString"`;
	const read = async (database: SqliteDatabase) => [await database.get(sql), ...(await database.all(sql))];
	const [threadedRows, inProcessRows] = [await read(threaded), await read(inProcess)];
	for (const row of [...threadedRows, ...inProcessRows]) {
		assert.ok(row !== undefined);
		assert.deepEqual(Object.keys(row), ["__proto__", "constructor", "toString"]);
		assert.ok(Object.hasOwn(row, "__proto__"));
		assert.equal(Object.getPrototypeOf(row), Object.prototype);
	}
	assert.deepStrictEqual(threadedRows, inProcessRows);
});
