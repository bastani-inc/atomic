import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "vitest";
import { StoragePrefixError, StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import {
	bunExecutable,
	fileExists,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";
import { withNodeSqliteDatabase } from "../helpers/storage-database.js";

registerSqliteDatabaseConformance({ describe, it: test }, "node SQLite", withNodeSqliteDatabase);

test("SQLite facade binds values without treating them as SQL", async () => {
	const directory = makeTempDirectory("atomic-storage-");
	try {
		const database = await openNodeSqliteDatabase(join(directory, "nested", "storage.sqlite"));
		try {
			await database.exec("CREATE TABLE entries (value TEXT)");
			assert.deepEqual(await database.run("INSERT INTO entries VALUES (?)", "'); DROP TABLE entries; --"), {
				changes: 1,
			});
			assert.equal((await database.get("SELECT value FROM entries"))?.value, "'); DROP TABLE entries; --");
		} finally {
			await database.close();
		}
	} finally {
		removeTempDirectory(directory);
	}
});

test("SQLite facade conformance also runs in a Bun child", () => {
	const result = spawnSyncCollect([
		bunExecutable(),
		"test",
		join(moduleDir(import.meta.url), "../fixtures/storage-database.bun.ts"),
	]);
	assert.equal(result.exitCode, 0, result.stdout.toString() + result.stderr.toString());
});

test("node SQLite applies durability pragmas and a configurable busy timeout", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		assert.deepEqual(await database.get("PRAGMA journal_mode"), { journal_mode: "wal" });
		assert.deepEqual(await database.get("PRAGMA synchronous"), { synchronous: 2 });
		assert.deepEqual(await database.get("PRAGMA foreign_keys"), { foreign_keys: 1 });
		assert.deepEqual(await database.get("PRAGMA busy_timeout"), { timeout: 5000 });
	});
	const memory = await openNodeSqliteDatabase(":memory:", { busyTimeoutMs: 17 });
	try {
		assert.deepEqual(memory.descriptor, { adapter: "node-sqlite", location: ":memory:" });
		assert.deepEqual(await memory.get("PRAGMA busy_timeout"), { timeout: 17 });
	} finally {
		await memory.close();
	}
});

test("node SQLite takes the write lock before calling the transaction callback", async () => {
	await withNodeSqliteDatabase(async ({ database }) => {
		const second = await openNodeSqliteDatabase(database.descriptor.location, { busyTimeoutMs: 0 });
		try {
			await database.exec("CREATE TABLE items (value)");
			await database.transaction(async () => {
				await assert.rejects(second.run("INSERT INTO items VALUES (1)"), StorageUnavailableError);
			});
			await second.run("INSERT INTO items VALUES (2)");
			assert.deepEqual(await database.all("SELECT value FROM items"), [{ value: 2 }]);
		} finally {
			await second.close();
		}
	});
});

test("node SQLite wraps an opening failure without changing the display path", async () => {
	const directory = makeTempDirectory("atomic-storage-");
	try {
		await assert.rejects(openNodeSqliteDatabase(directory), (error: Error) => {
			assert.ok(error instanceof StorageUnavailableError);
			assert.equal(error.adapter, "node-sqlite");
			assert.equal(error.location, directory);
			assert.ok(error.cause instanceof Error);
			return true;
		});
	} finally {
		removeTempDirectory(directory);
	}
});

test("prefix rendering rejects invalid prefixes before opening a database", async () => {
	const directory = makeTempDirectory("atomic-storage-");
	const path = join(directory, "not-created", "db.sqlite");
	try {
		await assert.rejects(async () => {
			renderStorageIdentifiers("sessions", { meta: "meta" }, "bad-prefix");
			const database = await openNodeSqliteDatabase(path);
			await database.close();
		}, StoragePrefixError);
		assert.equal(await fileExists(path), false);
	} finally {
		removeTempDirectory(directory);
	}
});
