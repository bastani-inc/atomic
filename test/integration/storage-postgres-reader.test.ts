import assert from "node:assert/strict";
import { StoreClosedError } from "@bastani/atomic/storage";
import { describe, test } from "vitest";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL reader (#6560)", () => {
	test("a reader answers while every connection of the database is held by a transaction, and closes with it (#6560)", async () => {
		await withPostgresDatabase(async ({ open, admin, name }) => {
			const database = await open({ maxConnections: 1 });
			await database.exec("CREATE TABLE items (id integer PRIMARY KEY)");
			await database.run("INSERT INTO items (id) VALUES (1)");
			const reader = await database.openReader!();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const holder = database.transaction(async (tx) => {
				await tx.run("INSERT INTO items (id) VALUES (2)");
				entered.resolve();
				await release.promise;
			});
			await entered.promise;
			try {
				assert.deepEqual(await reader.get("SELECT count(*)::int AS n FROM items"), { n: 1 });
				assert.deepEqual(
					await reader.transaction((tx) => tx.get("SELECT count(*)::int AS n FROM items"), { readOnly: true }),
					{ n: 1 },
				);
			} finally {
				release.resolve();
				await holder;
			}
			assert.deepEqual(await reader.get("SELECT count(*)::int AS n FROM items"), { n: 2 });
			await database.close();
			await assert.rejects(reader.get("SELECT 1 AS one"), StoreClosedError);
			const connections = await admin.get(
				"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ? AND application_name LIKE 'atomic%'",
				name,
			);
			assert.deepEqual(connections, { n: 0 }, "closing the database closed the reader's connections");
		});
	});

	test("readerMaxConnections sizes the reader's pool, and 0 opens no reader (#6560)", async () => {
		await withPostgresDatabase(async ({ open, admin, name }) => {
			const without = await open({ readerMaxConnections: 0 });
			try {
				assert.equal(without.openReader, undefined, "no separate reader, so reads share the main pool");
			} finally {
				await without.close();
			}
			const database = await open({ maxConnections: 8, readerMaxConnections: 3 });
			try {
				const reader = await database.openReader!();
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let inside = 0;
				const held = Array.from({ length: 4 }, () =>
					reader.transaction(
						async (tx) => {
							await tx.get("SELECT 1 AS one");
							if (++inside === 3) entered.resolve();
							await release.promise;
						},
						{ readOnly: true },
					),
				);
				await entered.promise;
				const readers = await admin.get(
					"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ? AND application_name = 'atomic-reader' AND state <> 'idle'",
					name,
				);
				release.resolve();
				await Promise.all(held);
				assert.deepEqual(
					readers,
					{ n: 3 },
					"three reads ran on the reader's three connections while the fourth waited",
				);
			} finally {
				await database.close();
			}
		});
	});
});
