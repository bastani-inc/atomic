import assert from "node:assert/strict";
import { connect, createServer, type Socket } from "node:net";
import { type SqliteExecutor, StoreClosedError } from "@bastani/atomic/storage";
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

	test("closing the database returns once the server has let go of every connection of its pools", async () => {
		await withPostgresDatabase(async ({ open, admin, name }) => {
			const atomicConnections = async () =>
				await admin.get(
					"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ? AND application_name LIKE 'atomic%'",
					name,
				);
			for (let round = 0; round < 5; round++) {
				const database = await open({ maxConnections: 6, readerMaxConnections: 3 });
				const reader = await database.openReader!();
				// Every connection of both pools open at once, then idle in their pools.
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let inside = 0;
				const hold = async (tx: SqliteExecutor) => {
					await tx.get("SELECT 1 AS one");
					if (++inside === 9) entered.resolve();
					await release.promise;
				};
				const held = [
					// Writes of different domains run at once, each on a connection of its own.
					...Array.from({ length: 6 }, (_, index) =>
						database.transaction(hold, { concurrency: { kind: "serial", domain: `hold-${index}` } }),
					),
					...Array.from({ length: 3 }, () => reader.transaction(hold, { readOnly: true })),
				];
				await entered.promise;
				release.resolve();
				await Promise.all(held);
				await database.close();
				assert.deepEqual(await atomicConnections(), { n: 0 }, `round ${round}: a connection outlived close()`);
			}
		});
	});

	test("closing gives up on connections whose server stopped answering, after a bound", async () => {
		await withPostgresDatabase(async ({ open, url }) => {
			const server = new URL(url);
			// A proxy that, once stalled, carries nothing either way and closes nothing, as a network that stopped.
			const sockets = new Set<Socket>();
			let stalled = false;
			const proxy = createServer({ allowHalfOpen: true }, (client) => {
				const upstream = connect(Number(server.port), server.hostname);
				for (const socket of [client, upstream]) {
					sockets.add(socket);
					socket.on("error", () => {});
				}
				client.on("data", (chunk) => stalled || upstream.write(chunk));
				upstream.on("data", (chunk) => stalled || client.write(chunk));
			});
			await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
			try {
				const proxied = new URL(url);
				proxied.host = `127.0.0.1:${(proxy.address() as { port: number }).port}`;
				const database = await open({ url: proxied.href });
				const reader = await database.openReader!();
				assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
				assert.deepEqual(await reader.get("SELECT 1 AS one"), { one: 1 });
				stalled = true;
				const started = performance.now();
				await database.close();
				const took = performance.now() - started;
				assert.ok(took < 15_000, `closing took ${Math.round(took)} ms`);
			} finally {
				for (const socket of sockets) socket.destroy();
				await new Promise((resolve) => proxy.close(resolve));
			}
		});
	}, 30_000);
});
