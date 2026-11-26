import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import { observeLeadingReads, observeRowsAndFailures } from "../helpers/node-sqlite-observations.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { withNodeSqliteDatabase } from "../helpers/storage-database.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { ensureStorageSchema, storageSchemaCurrent } from "../../packages/coding-agent/src/core/storage/migrations.js";
import { withStorageSchemaCatalog } from "../../packages/coding-agent/src/core/storage/schema-catalog.js";

registerSqliteDatabaseConformance({ describe, it: test }, "node SQLite on Bun", withNodeSqliteDatabase);

/** Files under `directory` that this process still holds open (Linux /proc only). */
function openFilesUnder(directory: string): string[] {
	return readdirSync("/proc/self/fd").flatMap((fd) => {
		try {
			const target = readlinkSync(join("/proc/self/fd", fd));
			return target.startsWith(directory) ? [target] : [];
		} catch {
			return [];
		}
	});
}

// Windows refuses to delete or rename a file that is still open, so close() must release every handle.
test.skipIf(!existsSync("/proc/self/fd"))("close releases the database files after statements ran", async () => {
	const directory = realpathSync(makeTempDirectory("atomic-storage-"));
	try {
		const database = await openNodeSqliteDatabase(join(directory, "database.sqlite"));
		await database.exec("CREATE TABLE items (value)");
		await database.run("INSERT INTO items VALUES (?)", 1);
		assert.deepEqual(await database.all("SELECT value FROM items WHERE value = ?", 1), [{ value: 1 }]);
		assert.notDeepEqual(openFilesUnder(directory), []);
		await database.close();
		assert.deepEqual(openFilesUnder(directory), []);
	} finally {
		removeTempDirectory(directory);
	}
});

test("rows and driver errors cross from a connection's thread as they come from one on the calling thread (#5376)", async () => {
	const directory = makeTempDirectory("atomic-storage-");
	const threaded = await openNodeSqliteDatabase(join(directory, "database.sqlite"));
	const inMemory = await openNodeSqliteDatabase(":memory:");
	try {
		assert.deepStrictEqual(await observeRowsAndFailures(threaded), await observeRowsAndFailures(inMemory));
	} finally {
		await threaded.close();
		await inMemory.close();
		removeTempDirectory(directory);
	}
});

test("a read transaction's leading reads answer and fail on a connection's thread as each call does on the calling thread (#6560)", async () => {
	const directory = makeTempDirectory("atomic-storage-");
	const threaded = await openNodeSqliteDatabase(join(directory, "database.sqlite"));
	const inMemory = await openNodeSqliteDatabase(":memory:");
	const kinds: string[] = [];
	const interception = interceptConnectionRequests((request, send) => {
		kinds.push(request.kind);
		return send(request);
	});
	try {
		const observed = await observeLeadingReads(threaded);
		interception.restore();
		assert.deepStrictEqual(observed, await observeLeadingReads(inMemory));
		assert.deepEqual(kinds.slice(kinds.indexOf("read")), ["read", "all", "get", "get", "all", "endRead"]);
	} finally {
		interception.restore();
		await threaded.close();
		await inMemory.close();
		removeTempDirectory(directory);
	}
});

test("a SQLite store's stamped schema setup is believed until the schema changes (#6560)", async () => {
	const directory = makeTempDirectory("atomic-storage-");
	const database = await openNodeSqliteDatabase(join(directory, "database.sqlite"));
	const schema = { ledger: "atomic_migrations", domain: "stamped", revision: 2 };
	const current = () => withStorageSchemaCatalog(database, schema.ledger, () => storageSchemaCurrent(database, schema));
	try {
		assert.equal(await current(), false);
		await database.transaction((tx) =>
			ensureStorageSchema(tx, dialectOf(database), schema, () => tx.exec("CREATE TABLE stamped (value)")),
		);
		assert.equal(await current(), true);
		assert.equal(await withStorageSchemaCatalog(database, schema.ledger, () => storageSchemaCurrent(database, { ...schema, revision: 3 })), false);
		await database.exec("CREATE INDEX stamped_value ON stamped (value)");
		assert.equal(await current(), false, "a later change to the schema leaves the stamp behind");
	} finally {
		await database.close();
		removeTempDirectory(directory);
	}
});
