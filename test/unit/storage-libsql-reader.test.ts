import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { StoreClosedError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";

test("a libSQL file's reader reads the last commit while a write transaction is open, and closes with the database (#6560)", async () => {
	const directory = makeLibsqlDirectory();
	try {
		const database = await openLibsqlDatabase({ url: pathToFileURL(join(directory, "store.sqlite")).href });
		try {
			await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
			await database.run("INSERT INTO items (id) VALUES (1)");
			const reader = await database.openReader!();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const writing = database.transaction(async (tx) => {
				await tx.run("INSERT INTO items (id) VALUES (2)");
				entered.resolve();
				await release.promise;
			});
			await entered.promise;
			try {
				assert.deepEqual(await reader.get("SELECT count(*) AS n FROM items"), { n: 1 });
			} finally {
				release.resolve();
				await writing;
			}
			assert.deepEqual(await reader.get("SELECT count(*) AS n FROM items"), { n: 2 });
			await database.close();
			await assert.rejects(reader.get("SELECT 1 AS one"), StoreClosedError);
		} finally {
			await database.close();
		}
	} finally {
		await removeLibsqlDirectory(directory);
	}
});
