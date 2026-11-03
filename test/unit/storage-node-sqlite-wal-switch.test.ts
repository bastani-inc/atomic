import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	openNodeSqliteDatabase,
	wrapNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { holdSqliteWriteLock } from "../helpers/sqlite-lock-holder.js";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

/** A path for a new database file; another process creates it in the rollback journal and holds its write lock. */
function databasePath(): string {
	const directory = makeTempDirectory("atomic-wal-switch-");
	directories.push(directory);
	return join(directory, "store.sqlite");
}

test("opening a store another process is writing waits for its lock to switch the file to the write-ahead log (#4270)", async () => {
	const path = databasePath();
	const holder = await holdSqliteWriteLock(path);
	const opening = openNodeSqliteDatabase(path);
	let early: unknown;
	try {
		early = await Promise.race([
			opening.then(
				() => "opened",
				(error: unknown) => error,
			),
			sleep(500).then(() => "waiting"),
		]);
	} finally {
		await holder.release();
	}
	// The open must still be waiting for the other process's lock, not have failed with SQLITE_BUSY.
	assert.equal(early, "waiting");
	const database = await opening;
	try {
		assert.equal(String((await database.get("PRAGMA journal_mode"))?.journal_mode), "wal");
		// It switched the file after the other process committed, not instead of it.
		assert.equal(Number((await database.get("SELECT COUNT(*) AS count FROM held"))?.count), 1);
	} finally {
		await database.close();
	}
});

test("an open refused for longer than its busy timeout fails with SQLITE_BUSY once the timeout has passed (#4270)", async () => {
	const path = databasePath();
	const holder = await holdSqliteWriteLock(path);
	try {
		const started = Date.now();
		await assert.rejects(openNodeSqliteDatabase(path, { busyTimeoutMs: 300 }), (error: unknown) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal((error.cause as { errcode?: unknown }).errcode, 5);
			return true;
		});
		const waited = Date.now() - started;
		assert.ok(waited >= 300, `the open gave up after ${waited} ms, before its 300 ms busy timeout`);
	} finally {
		await holder.release();
	}
});

test("wrapping a connection to a file another process is writing waits for its lock to switch the file to the write-ahead log (#4270)", async () => {
	const path = databasePath();
	// The holder commits on its own: wrapping is synchronous and waits on this thread, as node:sqlite's busy timeout does.
	const holder = await holdSqliteWriteLock(path, 750);
	const connection = new DatabaseSync(path);
	try {
		const database = wrapNodeSqliteDatabase(connection);
		try {
			assert.equal(String((await database.get("PRAGMA journal_mode"))?.journal_mode), "wal");
			// It switched the file after the other process committed, not instead of it.
			assert.equal(Number((await database.get("SELECT COUNT(*) AS count FROM held"))?.count), 1);
		} finally {
			await database.close();
		}
	} finally {
		connection.close();
		await holder.release();
	}
});
