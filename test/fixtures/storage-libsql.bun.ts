import { describe, it, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import { openLibsqlDatabase as openPackageDatabase } from "../../packages/storage-libsql/libsql.js";
import { withLibsqlDatabase } from "../helpers/libsql-database.js";

const root = process.env.ATOMIC_TEST_LIBSQL_ROOT;
assert.ok(root, "Bun conformance requires a parent-owned temporary root");

registerSqliteDatabaseConformance({ describe, it }, "libSQL file on Bun", withLibsqlDatabase);
registerSessionStoreConformance({ describe, it }, "SqlSessionStore on libSQL on Bun", async (body) => {
	await withLibsqlDatabase(async (subject) => {
		let store = await SqlSessionStore.open(subject.database);
		await body({
			store,
			async reopen() {
				store = await SqlSessionStore.open(await subject.reopen());
				return store;
			},
		});
	});
});

/** The files under `directory` this process holds open, as Linux lists its descriptors. */
function heldFiles(directory: string): string[] {
	return readdirSync("/proc/self/fd").flatMap((descriptor) => {
		try {
			const target = readlinkSync(join("/proc/self/fd", descriptor));
			return target.startsWith(directory) ? [target] : [];
		} catch (error) {
			// The descriptor that listed the directory is closed by the time it is read.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	});
}

test("the package's file database releases its files before close resolves on Bun (#4433)", async () => {
	const directory = mkdtempSync(join(root, "package-release-"));
	const database = await openPackageDatabase({ url: pathToFileURL(join(directory, "journal.sqlite")).href });
	await database.exec("CREATE TABLE entries(value INTEGER NOT NULL)");
	await database.transaction(async (transaction) => {
		await transaction.run("INSERT INTO entries VALUES (?)", 1);
	});
	assert.deepEqual(await database.all("SELECT value FROM entries"), [{ value: 1 }]);
	await database.close();
	if (process.platform === "linux") assert.deepEqual(heldFiles(directory), []);
	// Windows refuses to delete a file a handle holds open.
	rmSync(directory, { recursive: true });
});
