import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { SqlSnapshotBlobStore } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { type PostgresScope, postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";

/** Entries appended one at a time after the session's first, each the child of the one before. */
const APPENDS = 20;
/** How long PostgreSQL may take to publish the statistics of the store's closed connections. */
const STATS_WAIT_MS = 10_000;
/** Links in a table larger than an open builds the index for in its own transaction. */
const LARGE_LINKS = 250_000;

function entry(n: number): SessionEntry {
	const id = `e${n}`;
	const parentId = n === 0 ? null : `e${n - 1}`;
	const timestamp = new Date(Date.parse("2026-11-26T00:00:00.000Z") + n * 1_000).toISOString();
	// The first entry is a worktree snapshot, so every link after it has an anchor, as in a session that takes them.
	if (n === 0)
		return { type: "worktree_snapshot", id, parentId, timestamp, root: "/work", snapshotId: "snap-0" } as never;
	return { type: "message", id, parentId, timestamp, message: { role: "user", content: `turn ${n}`, timestamp: n } };
}

/**
 * The snapshot blob store of Atomic 0.9.89, vendored unmodified (test/fixtures/snapshot-store-0.9.89): an earlier
 * release that knows the same migration steps, so it opens a database this build set up.
 */
const release0989 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.89/worktree-snapshot/blob-store.ts")).href
)) as { SqlSnapshotBlobStore: { open(database: SqliteDatabase): Promise<unknown> } };

/** The session links' indexes as `name: definition`. */
async function linkIndexes(database: SqliteDatabase): Promise<string[]> {
	return (
		await database.all<{ name: string; definition: string; valid: number }>(
			`SELECT i.relname AS name, pg_get_indexdef(x.indexrelid) AS definition, x.indisvalid::int AS valid FROM pg_index x
			JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = 'snapshot_session_links'::regclass ORDER BY i.relname`,
		)
	).map(
		(index) =>
			`${index.name}: ${index.definition.replace(/^.* USING btree /, "")}${Number(index.valid) === 1 ? "" : " (invalid)"}`,
	);
}

const EARLIER_INDEXES = [
	"snapshot_session_links_broken: (session_id) WHERE (broken = 1)",
	"snapshot_session_links_entry: (session_id, entry_id)",
	"snapshot_session_links_leaves: (session_id, anchor_seq) WHERE ((children = 0) AND (anchor_seq IS NOT NULL))",
	"snapshot_session_links_pkey: (session_id, seq)",
];

const HOT_INDEXES = [
	"snapshot_session_links_anchored: (session_id, anchor_seq) WHERE (anchor_seq IS NOT NULL)",
	"snapshot_session_links_broken: (session_id) WHERE (broken = 1)",
	"snapshot_session_links_entry: (session_id, entry_id)",
	"snapshot_session_links_pkey: (session_id, seq)",
];

/** Puts the links back as an earlier build left them: the index of leaves, and no ledger record of the step. */
async function asEarlierBuildLeftIt(database: SqliteDatabase): Promise<void> {
	await database.exec("DROP INDEX IF EXISTS snapshot_session_links_anchored");
	await database.exec(
		"CREATE INDEX snapshot_session_links_leaves ON snapshot_session_links (session_id, anchor_seq) WHERE children = 0 AND anchor_seq IS NOT NULL",
	);
	await database.run("DELETE FROM atomic_migrations WHERE domain = 'schema:snapshot-links-hot'");
}

/** Whether the ledger records the step. */
async function recorded(database: SqliteDatabase): Promise<boolean> {
	return (
		(await database.get("SELECT 1 AS found FROM atomic_migrations WHERE domain = 'schema:snapshot-links-hot'")) !==
		undefined
	);
}

/** Opens the session store on `database`, as a session does, and closes it. */
async function openStore(database: SqliteDatabase): Promise<void> {
	await (await SqlSessionStore.open(database, {})).close();
}

/** Creates session `s` with its first entry, then appends {@link APPENDS} more one at a time, and closes the store. */
async function writeSession(scope: PostgresScope): Promise<void> {
	const database = await scope.open();
	const store = await SqlSessionStore.open(database, {});
	const created = await store.create(
		{ id: "s", version: SESSION_FORMAT_VERSION, createdAt: "2026-11-26T00:00:00.000Z", cwd: "/work" },
		[entry(0)],
	);
	let lastSeq = created.lastSeq;
	for (let n = 1; n <= APPENDS; n++)
		lastSeq = (await store.append("s", [entry(n)], { expectSeq: lastSeq, epoch: created.epoch })).lastSeq;
	await store.close();
	await database.close();
}

/**
 * The session links' updates and HOT updates. A connection publishes its statistics when it ends, so this reads them
 * until they include every append of the closed store's connections.
 */
async function linkUpdates(scope: PostgresScope): Promise<{ updates: number; hot: number }> {
	const reader = await scope.open();
	const deadline = performance.now() + STATS_WAIT_MS;
	for (;;) {
		const row = await reader.get<{ updates: number | string; hot: number | string }>(
			"SELECT n_tup_upd AS updates, n_tup_hot_upd AS hot FROM pg_stat_user_tables WHERE relname = 'snapshot_session_links'",
		);
		const stats = { updates: Number(row?.updates ?? 0), hot: Number(row?.hot ?? 0) };
		if (stats.updates >= APPENDS || performance.now() >= deadline) return stats;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe.skipIf(postgresSkipReason !== undefined)("session links on PostgreSQL (#6560)", () => {
	test("an append updates its parent's session link in place, writing no index entry", () =>
		withPostgresDatabase(async (scope) => {
			await writeSession(scope);
			assert.deepEqual(await linkIndexes(await scope.open()), HOT_INDEXES);
			assert.deepEqual(await linkUpdates(scope), { updates: APPENDS, hot: APPENDS });
		}));

	test("an earlier release that opens the database keeps the indexes, and appends stay in place", () =>
		withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			await (await SqlSessionStore.open(database, {})).close();
			const released = await scope.open();
			await release0989.SqlSnapshotBlobStore.open(released);
			await released.close();
			assert.deepEqual(await linkIndexes(database), HOT_INDEXES);
			await database.close();

			await writeSession(scope);
			assert.deepEqual(await linkUpdates(scope), { updates: APPENDS, hot: APPENDS });
		}));

	test("migrate replaces an index a stopped build left invalid, which an open leaves alone, and records the step once", () =>
		withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			await openStore(database);
			await asEarlierBuildLeftIt(database);
			// A build of `_anchored` that stopped part way leaves it invalid: here one that fails on duplicate keys.
			await database.run(
				"INSERT INTO snapshot_session_links VALUES ('x', 1, 'a', NULL, 5, 1, 0), ('x', 2, 'b', 'a', 5, 0, 0)",
			);
			await assert.rejects(
				database.exec(
					"CREATE UNIQUE INDEX CONCURRENTLY snapshot_session_links_anchored ON snapshot_session_links (anchor_seq)",
				),
			);
			const stopped = ["snapshot_session_links_anchored: (anchor_seq) (invalid)", ...EARLIER_INDEXES];
			assert.deepEqual(await linkIndexes(database), stopped);

			await openStore(await scope.open());
			assert.deepEqual(await linkIndexes(database), stopped, "an open leaves the invalid index to migrate");
			assert.equal(await recorded(database), false);

			assert.equal(await SqlSnapshotBlobStore.buildHotSessionLinksIndex(database), "built");
			assert.deepEqual(await linkIndexes(database), HOT_INDEXES);
			assert.equal(await recorded(database), true);
			assert.equal(await SqlSnapshotBlobStore.buildHotSessionLinksIndex(database), "current");
		}));

	test("an open leaves a large links table's index to migrate, which builds it", () =>
		withPostgresDatabase(async (scope) => {
			const database = await scope.open();
			await openStore(database);
			await asEarlierBuildLeftIt(database);
			// More links than an open builds the index for in its own transaction: over 16 MiB.
			await database.run(
				`INSERT INTO snapshot_session_links (session_id, seq, entry_id, parent_id, anchor_seq, children, broken)
				SELECT 's' || (g / 1000), g % 1000, 'e' || g, 'e' || (g - 1), g - g % 10, 1, 0 FROM generate_series(0, ${LARGE_LINKS - 1}) g`,
			);
			await database.exec("ANALYZE snapshot_session_links");

			await openStore(await scope.open());
			assert.deepEqual(await linkIndexes(database), EARLIER_INDEXES, "the open built nothing");
			assert.equal(await recorded(database), false);

			assert.equal(await SqlSnapshotBlobStore.buildHotSessionLinksIndex(database), "built");
			assert.deepEqual(await linkIndexes(database), HOT_INDEXES);
			assert.equal(await recorded(database), true);
		}));
});
