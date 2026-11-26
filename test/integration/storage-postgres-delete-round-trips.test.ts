import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openPostgresDatabase } from "../../packages/storage-postgres/postgres.js";
import {
	type PostgresScope,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
import { countRoundTrips as countingRoundTrips } from "../helpers/postgres-round-trips.js";

/**
 * What deleting and replacing a session costs on PostgreSQL (#6560): the session's rows go in statements sent together
 * with the commit, and its search index is forgotten in a request of its own, so the round trips do not grow with the
 * tables a session has rows in. A statement among them that fails commits nothing.
 */

const restores: (() => void)[] = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

/** Counts the round trips to the server until the test ends. */
function countRoundTrips() {
	const trips = countingRoundTrips();
	restores.push(trips.restore);
	return trips;
}

const FORMAT = 1;
const header = (id: string) => ({ id, version: 4 as const, cwd: "/work", createdAt: "2026-11-25T00:00:00.000Z" });
function thread(prefix: string, count: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let i = 1; i <= count; i++)
		entries.push({
			type: "message",
			id: `${prefix}${i}`,
			parentId: i === 1 ? null : `${prefix}${i - 1}`,
			timestamp: "2026-11-25T00:00:01.000Z",
			message: { role: "user", content: `entry ${i} needle`, timestamp: 1 },
		} as SessionEntry);
	return entries;
}

/** A session `id` of `count` entries, each indexed for search. */
async function indexedSession(store: SqlSessionStore, id: string, count: number) {
	const created = await store.create(header(id), thread(`${id}-`, count));
	const texts = Array.from({ length: count }, (_, index) => ({ seq: index + 1, text: `entry ${index + 1} needle` }));
	assert.equal(await store.searchIndex!.extend(id, FORMAT, 0, count, texts), true);
	assert.equal((await store.searchIndex!.candidates(id, [["needle"]], 1, count, 50))?.length, count);
	return created;
}

async function count(database: SqliteDatabase, sql: string, ...params: string[]): Promise<number> {
	const row = await database.get<{ count: number }>(sql, ...params);
	return Number(row?.count);
}

interface PostgresRoute {
	readonly name: string;
	readonly skipReason: string | undefined;
	open(scope: PostgresScope): Promise<SqliteDatabase>;
}

const pgbouncerUrl = process.env.ATOMIC_TEST_PGBOUNCER_URL || undefined;
if (
	pgbouncerUrl === undefined &&
	postgresSkipReason === undefined &&
	process.env.ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED === "1"
)
	throw new Error("ATOMIC_TEST_STORAGE_BACKENDS_REQUIRED=1 but ATOMIC_TEST_PGBOUNCER_URL is not set");

const postgresRoutes: readonly PostgresRoute[] = [
	{
		name: "direct",
		skipReason: postgresSkipReason,
		open: (scope) => scope.open(),
	},
	{
		name: "through PgBouncer in transaction mode",
		skipReason:
			postgresSkipReason ?? (pgbouncerUrl === undefined ? "ATOMIC_TEST_PGBOUNCER_URL is not set" : undefined),
		open: (scope) => {
			const url = new URL(pgbouncerUrl!);
			url.pathname = `/${scope.name}`;
			return openPostgresDatabase({
				url: url.href,
				...(postgresTestPassword === undefined ? {} : { password: postgresTestPassword }),
			});
		},
	},
];

for (const route of postgresRoutes) {
	describe.skipIf(route.skipReason !== undefined)(
		`PostgreSQL session delete and replace round trips (${route.name}) (#6560, #6710)`,
		() => {
			test("deleting an indexed session costs three round trips, not one per table: the start, the index, then the rows with the commit", async () => {
				await withPostgresDatabase(async (scope) => {
					const database = await route.open(scope);
					const store = await SqlSessionStore.open(database);
					try {
						await indexedSession(store, "s1", 6);
						await indexedSession(store, "s2", 3);
						const trips = countRoundTrips();
						await store.delete("s1");
						assert.equal(trips.take(), 3);
						assert.equal(await store.readHeader("s1"), undefined);
						assert.equal(
							await count(
								database,
								"SELECT count(*)::int AS count FROM session_entries WHERE session_id = ?",
								"s1",
							),
							0,
						);
						assert.equal(
							await count(
								database,
								"SELECT count(*)::int AS count FROM session_search_state WHERE session_id = ?",
								"s1",
							),
							0,
						);
						// The other session and its index stay.
						assert.equal((await store.searchIndex!.candidates("s2", [["needle"]], 1, 3, 50))?.length, 3);
						assert.equal((await store.load("s2")).entries.length, 3);
					} finally {
						await store.close();
						await database.close();
					}
				});
			});

			test("replacing an indexed session costs three round trips: the start, the index, then the rewrite with the commit", async () => {
				await withPostgresDatabase(async (scope) => {
					const database = await route.open(scope);
					const store = await SqlSessionStore.open(database);
					try {
						const created = await indexedSession(store, "s1", 6);
						const trips = countRoundTrips();
						const replaced = await store.replace("s1", header("s1"), thread("r", 4), {
							expectSeq: created.lastSeq,
							epoch: created.epoch,
						});
						assert.equal(trips.take(), 3);
						assert.equal(replaced.lastSeq, 4);
						assert.deepEqual(
							(await store.load("s1")).entries.map((entry) => entry.id),
							["r1", "r2", "r3", "r4"],
						);
						assert.deepEqual(
							await store.searchIndex!.coverage("s1", FORMAT).then((found) => found?.indexedSeq),
							0,
						);
					} finally {
						await store.close();
						await database.close();
					}
				});
			});
		},
	);
}

describe.skipIf(postgresSkipReason !== undefined)(
	"PostgreSQL session delete and replace atomicity and recovery (#6560, #6710)",
	() => {
		test("a delete whose last statement the server refuses deletes nothing: the statements sent with the commit commit together or not at all", async () => {
			await withPostgresDatabase(async ({ open }) => {
				const database = await open();
				const store = await SqlSessionStore.open(database);
				try {
					await indexedSession(store, "s1", 4);
					// A row that refers to the session, which its last statement, the delete of its row, then cannot remove.
					await database.exec(
						"CREATE TABLE delete_guard (session_id text REFERENCES session_sessions (id)); INSERT INTO delete_guard VALUES ('s1')",
					);
					await assert.rejects(store.delete("s1"), (error: Error) =>
						/delete_guard|foreign key/.test(causes(error)),
					);
					assert.equal((await store.load("s1")).entries.length, 4);
					assert.equal(
						await count(
							database,
							"SELECT count(*)::int AS count FROM session_search_texts WHERE session_id = ?",
							"s1",
						),
						4,
					);
					assert.equal(
						await count(
							database,
							"SELECT count(*)::int AS count FROM session_search_state WHERE session_id = ?",
							"s1",
						),
						1,
					);
					await database.exec("DROP TABLE delete_guard");
					await store.delete("s1");
					assert.equal(await store.readHeader("s1"), undefined);
				} finally {
					await store.close();
				}
			});
		});

		for (const table of ["session_search_entries", "session_search_state"] as const) {
			test(`a search index that refuses to delete from ${table} does not stop the delete: its savepoint is rolled back and the rows go`, async () => {
				await withPostgresDatabase(async ({ open }) => {
					const database = await open();
					const store = await SqlSessionStore.open(database);
					try {
						await indexedSession(store, "s1", 3);
						// The index's rows refuse to go when the store forgets them itself, though not when the entries' own trigger does.
						await database.exec(
							`CREATE FUNCTION refuse_forget() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'index rows stay'; END$$;
						CREATE TRIGGER refuse_forget BEFORE DELETE ON ${table} FOR EACH ROW WHEN (pg_trigger_depth() < 1)
							EXECUTE FUNCTION refuse_forget()`,
						);
						await store.delete("s1");
						assert.equal(await store.readHeader("s1"), undefined);
						assert.equal(
							await count(
								database,
								"SELECT count(*)::int AS count FROM session_entries WHERE session_id = ?",
								"s1",
							),
							0,
						);
					} finally {
						await store.close();
					}
				});
			});
		}
	},
);

/** The messages of `error` and its causes, one per line. */
function causes(error: Error): string {
	const messages: string[] = [];
	for (let current: unknown = error; current instanceof Error; current = current.cause) messages.push(current.message);
	return messages.join("\n");
}
