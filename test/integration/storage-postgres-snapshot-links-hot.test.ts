import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { type PostgresScope, postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";

/** Entries appended one at a time after the session's first, each the child of the one before. */
const APPENDS = 20;
/** How long PostgreSQL may take to publish the statistics of the store's closed connections. */
const STATS_WAIT_MS = 10_000;

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
		await database.all<{ name: string; definition: string }>(
			"SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE tablename = 'snapshot_session_links' ORDER BY indexname",
		)
	).map((index) => `${index.name}: ${index.definition.replace(/^.* USING btree /, "")}`);
}

const HOT_INDEXES = [
	"snapshot_session_links_anchored: (session_id, anchor_seq) WHERE (anchor_seq IS NOT NULL)",
	"snapshot_session_links_broken: (session_id) WHERE (broken = 1)",
	"snapshot_session_links_entry: (session_id, entry_id)",
	"snapshot_session_links_pkey: (session_id, seq)",
];

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
});
