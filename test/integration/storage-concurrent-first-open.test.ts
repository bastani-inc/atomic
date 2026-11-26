import assert from "node:assert/strict";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import pg from "pg";
import { afterEach, test } from "vitest";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openIntercomBrokerState } from "../../packages/intercom/broker/open-broker-state.js";
import { storageBackends } from "../helpers/storage-backends.js";

/**
 * Hosts started together on a new database each open a session store and an Intercom broker on it (#6560). Each opener
 * uses connections of its own, as a host on another machine does. Of the hosts that find a schema missing, one sets it
 * up and the others wait for it without its lock: none queues behind the others' setups, as each did when every setup
 * held the database's write lock.
 */

/** Hosts opening at once. */
const OPENERS = 8;
const FIRST_OPEN_TIMEOUT_MS = 120_000;

/**
 * The write transactions one host's first open of a new SQLite file may take, at most: its setups that found nothing to
 * do once another host had run them took none. Each setup took one of its own, about 30 a host, before (#6560).
 */
const SQLITE_WRITES_PER_OPENER = 12;

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

/** Every statement sent to a PostgreSQL server until the test ends, as the adapter's pg sends it. */
function recordStatements(): string[] {
	const query = pg.Client.prototype.query;
	const sent: string[] = [];
	pg.Client.prototype.query = function (this: pg.Client, ...args: Parameters<pg.Client["query"]>) {
		const first = args[0] as unknown;
		sent.push(typeof first === "string" ? first : String((first as { text?: unknown } | undefined)?.text ?? ""));
		return Reflect.apply(query, this, args);
	} as pg.Client["query"];
	restores.push(() => {
		pg.Client.prototype.query = query;
	});
	return sent;
}

/** `database`, counting into `writes` the write transactions it runs: its own and the ones it tried and won. */
function countingWrites(database: SqliteDatabase, writes: { count: number }): SqliteDatabase {
	return new Proxy(database, {
		get(target, key) {
			const value = Reflect.get(target, key);
			if (key === "transaction")
				return (callback: Parameters<SqliteDatabase["transaction"]>[0], options?: { readOnly?: boolean }) => {
					if (options?.readOnly !== true) writes.count += 1;
					return target.transaction(callback, options);
				};
			if (key === "tryMaintenance" && typeof value === "function")
				return async (callback: Parameters<NonNullable<SqliteDatabase["tryMaintenance"]>>[0]) => {
					const won = await target.tryMaintenance!(callback);
					if (won) writes.count += 1;
					return won;
				};
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** A statement that waits for an advisory lock, rather than trying it: one that can queue behind another host. */
const WAITS_FOR_LOCK = /pg_advisory_xact_lock(_shared)?\(/;

for (const backend of storageBackends) {
	const run = backend.skipReason === undefined ? test : test.skip;
	run(
		`${OPENERS} hosts opening sessions and an Intercom broker on a new ${backend.name} database at once: each store is set up once, and none waits for another's setup lock (#6560)`,
		async () => {
			const scope = await backend.openScope();
			const sent = recordStatements();
			const writes = { count: 0 };
			const openDatabase = async () => countingWrites(await scope.connect(), writes);
			const openHost = async () => {
				const [store, broker] = await Promise.all([
					openDatabase().then((database) => SqlSessionStore.open(database, { prefix: scope.prefix })),
					openIntercomBrokerState({ openDatabase, prefix: scope.prefix }),
				]);
				await store.close();
				await broker.bus.close();
				await broker.state.close();
			};
			try {
				const opened = await Promise.allSettled(Array.from({ length: OPENERS }, openHost));
				assert.deepEqual(
					opened.flatMap((result) => (result.status === "rejected" ? [String(result.reason)] : [])),
					[],
				);
				if (backend.name === "Postgres") {
					// The adapter creates the schema itself, once per connection pool, in one request that holds its lock only on
					// the server; no other statement of a first open waits for a lock.
					assert.deepEqual(
						sent.filter((sql) => WAITS_FOR_LOCK.test(sql) && !/CREATE SCHEMA/.test(sql)),
						[],
					);
					// One host created each store's tables; the others found them recorded.
					for (const table of ["session_meta", "intercom_outbox", "intercom_known_sessions"])
						assert.equal(
							sent.filter((sql) => sql.includes(`CREATE TABLE IF NOT EXISTS ${scope.prefix}${table}`)).length,
							1,
							table,
						);
				} else
					assert.ok(
						writes.count <= OPENERS * SQLITE_WRITES_PER_OPENER,
						`${writes.count} write transactions for ${OPENERS} first opens`,
					);
				// The schema is complete: a host that opens it now takes no write lock and creates nothing.
				sent.length = 0;
				writes.count = 0;
				await openHost();
				assert.equal(writes.count, 0);
				assert.deepEqual(
					sent.filter((sql) => /CREATE |ALTER /.test(sql)),
					[],
				);
			} finally {
				await scope.close();
			}
		},
		FIRST_OPEN_TIMEOUT_MS,
	);
}
