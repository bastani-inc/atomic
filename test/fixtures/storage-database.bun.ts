import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { withNodeSqliteDatabase } from "../helpers/storage-database.js";

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
