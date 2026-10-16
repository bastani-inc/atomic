import assert, { AssertionError } from "node:assert/strict";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.js";
import { StoragePrefixError, StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	registerSqliteConnectionConformance,
	registerSqliteDatabaseConformance,
	type WithSqliteDatabaseSubject,
} from "../../packages/coding-agent/src/core/storage/testing.js";
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

registerSqliteConnectionConformance({ describe, it: test }, "node SQLite shared file", async (body) => {
	const directory = makeTempDirectory("atomic-storage-concurrent-");
	const first = await openNodeSqliteDatabase(join(directory, "shared.sqlite"));
	try {
		await symlink(directory, join(directory, "alias"), "junction");
		const second = await openNodeSqliteDatabase(join(directory, "alias", "shared.sqlite"));
		try {
			await body(first, second);
		} finally {
			await second.close();
		}
	} finally {
		await first.close();
		removeTempDirectory(directory);
	}
});

type CommitFault = "swallows the commit error" | "rejects without rolling back";

/** Wraps the real adapter with a hand-rolled transaction that mishandles a failed COMMIT. */
function withFaultyCommit(fault: CommitFault): WithSqliteDatabaseSubject {
	const wrap = (inner: SqliteDatabase): SqliteDatabase => ({
		descriptor: inner.descriptor,
		exec: (sql) => inner.exec(sql),
		run: (sql, ...params) => inner.run(sql, ...params),
		get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => inner.get<T>(sql, ...params),
		all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => inner.all<T>(sql, ...params),
		close: () => inner.close(),
		async transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
			await inner.exec("BEGIN IMMEDIATE");
			let result: T;
			try {
				result = await callback(inner);
			} catch (error) {
				await inner.exec("ROLLBACK");
				throw error;
			}
			try {
				await inner.exec("COMMIT");
			} catch (error) {
				if (fault === "rejects without rolling back") throw error;
				await inner.exec("ROLLBACK");
			}
			return result;
		},
	});
	return (body) =>
		withNodeSqliteDatabase((subject) =>
			body({
				get database() {
					return wrap(subject.database);
				},
				reopen: async () => wrap(await subject.reopen()),
				withRollbackFailure: (cause, operation) => subject.withRollbackFailure(cause, operation),
			}),
		);
}

for (const fault of ["swallows the commit error", "rejects without rolling back"] as const) {
	test(`SQLite facade conformance fails an adapter that ${fault}`, async () => {
		const failedCommitCases: Array<() => Promise<void>> = [];
		registerSqliteDatabaseConformance(
			{
				describe: (_name, body) => body(),
				it: (name, body) => {
					if (name === "rejects a failed commit with a typed error and leaves nothing visible")
						failedCommitCases.push(body);
				},
			},
			"faulty commit",
			withFaultyCommit(fault),
		);
		assert.equal(failedCommitCases.length, 2);
		for (const run of failedCommitCases) await assert.rejects(run(), AssertionError);
	});
}

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
