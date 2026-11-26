import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type SqliteDatabase, StorageProvider } from "@bastani/atomic/storage";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { openIntercomBrokerState, resolveBrokerStateSource } from "../../packages/intercom/broker/open-broker-state.js";
import { type PostgresScope, postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory, moduleDir, removeTempDirectory, sleep } from "../helpers/runtime.js";

/**
 * The connections a process holds on PostgreSQL (#6560): every database it opens with one identity (the session store's,
 * the Intercom broker's, a reader's) shares one pool, one readers' pool and one listening connection, which close with
 * the last database.
 */

const adapterPath = join(moduleDir(import.meta.url), "../../packages/storage-postgres/postgres.js");
/** The idle timeout of the tiered pool test: long enough apart from the 10-second surge timeout to tell them apart. */
const TIERED_IDLE_TIMEOUT_MS = 13_000;
/** That test waits out both timeouts. */
const TIERED_TEST_TIMEOUT_MS = 60_000;

/** This process's connections to the scope's database, by application name. */
async function connections({ admin, name }: PostgresScope): Promise<Record<string, number>> {
	const rows = (await admin.all(
		"SELECT application_name AS app, count(*)::int AS n FROM pg_stat_activity WHERE datname = ? GROUP BY 1",
		name,
	)) as { app: string; n: number }[];
	return Object.fromEntries(rows.map((row) => [row.app, row.n]));
}

/** Polls until `check` holds of the scope's connections, which close a moment after their pool ends. */
async function connectionsUntil(scope: PostgresScope, check: (counts: Record<string, number>) => boolean) {
	let counts = await connections(scope);
	for (let attempt = 0; attempt < 100 && !check(counts); attempt++) {
		await sleep(50);
		counts = await connections(scope);
	}
	return counts;
}

const header = (id: string) => ({ id, version: 4 as const, cwd: "/work", createdAt: "2026-11-25T00:00:00.000Z" });
const entry = (id: string): SessionEntry =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-25T00:00:01.000Z",
		message: { role: "user", content: id, timestamp: 1 },
	}) as SessionEntry;
const from = { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

/** `count` read-only transactions that each hold a connection of `database` for a moment, all at once. */
const sleepers = (database: SqliteDatabase, count: number) =>
	Promise.all(
		Array.from({ length: count }, () =>
			database.transaction((tx) => tx.get("SELECT pg_sleep(0.2) AS slept"), { readOnly: true }),
		),
	);

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL connections shared in a process (#6560)", () => {
	test("a session store and an Intercom broker opened through the adapter in one process share one pool (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			const agentDir = await makeTempDirectory("atomic-shared-pool-");
			const variable = `ATOMIC_TEST_SHARED_POOL_PASSWORD_${randomBytes(4).toString("hex")}`;
			process.env[variable] = process.env.ATOMIC_TEST_POSTGRES_PASSWORD ?? "";
			const options = { url: scope.url, maxConnections: 1 };
			const secrets = { password: { env: variable } };
			try {
				// Each opens the adapter as Atomic does: loaded on its own, and its password read through the selection.
				const store = await new StorageProvider().openSessionStore(
					{ kind: "adapter", module: adapterPath, options, secrets },
					{ agentDir, domain: "sessions" },
				);
				const source = await resolveBrokerStateSource({ adapter: adapterPath, options, secrets }, agentDir);
				assert.equal(source.status, "shared");
				if (source.status !== "shared") return;
				const { state, bus } = await openIntercomBrokerState(source.source);
				try {
					await Promise.all([
						(async () => {
							const created = await store.create(header("s1"), []);
							await store.append("s1", [entry("m1")], { expectSeq: created.lastSeq, epoch: created.epoch });
						})(),
						state.reserveAndEnqueue!(
							{ messageId: "m1", digest: "m1", targetIdentity: "target-a" },
							{
								targetIdentity: "target-a",
								originBrokerId: "broker-a",
								digest: "m1",
								frame: { type: "message", from, message: { id: "m1", timestamp: 1, content: { text: "m1" } } },
							},
						),
					]);
					// One pool of at most one connection: two pools would hold one each.
					assert.equal((await connections(scope)).atomic, 1);
				} finally {
					await state.close();
					await bus.close();
					await store.close();
				}
				assert.deepEqual(await connectionsUntil(scope, (counts) => Object.keys(counts).length === 0), {});
			} finally {
				delete process.env[variable];
				await removeTempDirectory(agentDir);
			}
		});
	});

	test("closing one database keeps the shared pool open for the other, and closing the last closes it (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			const first = await scope.open();
			const second = await scope.open();
			// One after the other, the two take the pool's one idle connection in turn.
			assert.deepEqual(await first.get("SELECT 1 AS one"), { one: 1 });
			assert.deepEqual(await second.get("SELECT 1 AS one"), { one: 1 });
			assert.deepEqual(await connections(scope), { atomic: 1 });
			await first.close();
			// The pool's connection is still open, and the other database still uses it.
			assert.deepEqual(await connections(scope), { atomic: 1 });
			assert.deepEqual(await second.get("SELECT 2 AS two"), { two: 2 });
			assert.deepEqual(await connections(scope), { atomic: 1 });
			await second.close();
			assert.deepEqual(await connectionsUntil(scope, (counts) => Object.keys(counts).length === 0), {});
			// A database opened after the last closed gets a pool of its own.
			const third = await scope.open();
			assert.deepEqual(await third.get("SELECT 3 AS three"), { three: 3 });
			await third.close();
		});
	});

	test("databases with another role, password source result, schema or pool size do not share a pool (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			const role = `atomic_pool_${randomBytes(4).toString("hex")}`;
			const password = randomBytes(12).toString("hex");
			await scope.admin.exec(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
			try {
				await scope.admin.exec(`GRANT ALL ON DATABASE ${scope.name} TO ${role}`);
				const roleUrl = new URL(scope.url);
				roleUrl.username = role;
				const base = await scope.open({ maxConnections: 1 });
				// The same password from a function shares the pool.
				const sameCredential = await scope.open({
					maxConnections: 1,
					password: async () => process.env.ATOMIC_TEST_POSTGRES_PASSWORD ?? "",
				});
				const otherRole = await scope.open({ url: roleUrl.href, password, maxConnections: 1 });
				const otherSchema = await scope.open({ schema: "other_schema", maxConnections: 1 });
				const otherSize = await scope.open({ maxConnections: 2 });
				// A transaction holds the base pool's only connection: a database that shared it would wait for it.
				const entered = Promise.withResolvers<void>();
				const done = Promise.withResolvers<void>();
				const holder = base.transaction(async (tx) => {
					await tx.get("SELECT 1 AS one");
					entered.resolve();
					await done.promise;
				});
				await entered.promise;
				try {
					for (const database of [otherRole, otherSchema, otherSize])
						assert.deepEqual(await database.get("SELECT 1 AS one"), { one: 1 });
					assert.equal((await connections(scope)).atomic, 4);
				} finally {
					done.resolve();
					await holder;
				}
				assert.deepEqual(await sameCredential.get("SELECT 1 AS one"), { one: 1 });
				assert.equal((await connections(scope)).atomic, 4);
				await Promise.all(
					[base, sameCredential, otherRole, otherSchema, otherSize].map((database) => database.close()),
				);
			} finally {
				await scope.admin.exec(`DROP DATABASE IF EXISTS ${scope.name} WITH (FORCE)`);
				await scope.admin.exec(`DROP ROLE IF EXISTS ${role}`);
			}
		});
	});

	test("the readers of databases that share a pool share one readers' pool, closed by the last reader (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			const first = await scope.open();
			const second = await scope.open();
			const readers = await Promise.all([first.openReader!(), second.openReader!(), first.openReader!()]);
			// Six statements at once on three readers: one readers' pool, of 2 connections, serves them all.
			await Promise.all(readers.map((reader) => sleepers(reader, 2)));
			assert.equal((await connections(scope))["atomic-reader"], 2);
			await readers[0]!.close();
			await readers[1]!.close();
			assert.equal((await connections(scope))["atomic-reader"], 2, "a reader is still open");
			assert.deepEqual(await readers[2]!.get("SELECT 1 AS one"), { one: 1 });
			await readers[2]!.close();
			const closed = await connectionsUntil(scope, (counts) => counts["atomic-reader"] === undefined);
			assert.equal(closed["atomic-reader"], undefined);
			await first.close();
			await second.close();
		});
	});

	test("databases that share a pool listen on one connection, and a closed one's subscriptions end with it (#6560)", async () => {
		await withPostgresDatabase(async (scope) => {
			const first = await scope.open();
			const second = await scope.open();
			const heard: string[] = [];
			first.notifications!.listen("wake", (event) => {
				if (event.kind === "notification") heard.push(`first:${event.payload}`);
			});
			second.notifications!.listen("wake", (event) => {
				if (event.kind === "notification") heard.push(`second:${event.payload}`);
			});
			assert.deepEqual(await first.notifications!.state(), { status: "listening" });
			assert.deepEqual(await second.notifications!.state(), { status: "listening" });
			assert.equal((await connections(scope))["atomic-listen"], 1);
			const notify = async (payload: string) => {
				const statement = second.notifications!.notify("wake", payload);
				await second.run(statement.sql, ...statement.params);
			};
			await notify("one");
			for (let attempt = 0; attempt < 100 && heard.length < 2; attempt++) await sleep(20);
			assert.deepEqual(heard.sort(), ["first:one", "second:one"]);
			await first.close();
			heard.length = 0;
			await notify("two");
			for (let attempt = 0; attempt < 100 && heard.length < 1; attempt++) await sleep(20);
			await sleep(100);
			assert.deepEqual(heard, ["second:two"]);
			assert.equal((await connections(scope))["atomic-listen"], 1);
			await second.close();
			assert.deepEqual(await connectionsUntil(scope, (counts) => Object.keys(counts).length === 0), {});
		});
	});

	test(
		"a pool gives back a burst's extra connections after 10 seconds idle and its last one after the idle timeout (#6560)",
		async () => {
			await withPostgresDatabase(async (scope) => {
				const database = await scope.open({ idleTimeoutMs: TIERED_IDLE_TIMEOUT_MS });
				await sleepers(database, 3);
				const released = performance.now();
				assert.deepEqual(await connections(scope), { atomic: 3 });
				const seen: number[] = [];
				let counts = await connections(scope);
				while ((counts.atomic ?? 0) > 0 && performance.now() - released < TIERED_TEST_TIMEOUT_MS - 10_000) {
					if (seen.at(-1) !== (counts.atomic ?? 0)) seen.push(counts.atomic ?? 0);
					await sleep(100);
					counts = await connections(scope);
				}
				const emptied = performance.now() - released;
				if (seen.at(-1) !== (counts.atomic ?? 0)) seen.push(counts.atomic ?? 0);
				// 3, then one connection kept past the surge timeout, then none once the pool idled for the idle timeout.
				assert.equal(seen[0], 3);
				assert.deepEqual(seen.slice(-2), [1, 0]);
				assert.ok(emptied >= TIERED_IDLE_TIMEOUT_MS - 500, `the last connection closed after ${emptied} ms`);
				await database.close();
			});
		},
		TIERED_TEST_TIMEOUT_MS,
	);
});
