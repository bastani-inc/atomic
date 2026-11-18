import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import {
	BackgroundCollectionPace,
	SNAPSHOT_INDEX_BACKFILL_BATCH,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { createSession, messageEntry, syntheticSnapshot } from "../helpers/snapshot-reference-index.js";

/** The snapshot blob store of Atomic 0.9.87, vendored unmodified (test/fixtures/snapshot-store-0.9.87/README.md). */
interface Release0987BlobStore {
	collectGarbage(options: { readonly graceSeconds: number }): Promise<readonly string[]>;
}
const release0987 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.87/worktree-snapshot/blob-store.ts")).href
)) as { SqlSnapshotBlobStore: { open(database: SqliteDatabase): Promise<Release0987BlobStore> } };

/**
 * The session-entries triggers and progress rows 0.9.87 leaves when it installs its reference index over a session
 * table that has none, recorded from the vendored store above (the first test checks it still writes exactly these).
 */
const GOLDEN = JSON.parse(
	readFileSync(join(import.meta.dirname, "../fixtures/snapshot-index-0.9.87-session-triggers.json"), "utf8"),
) as {
	readonly triggers: readonly { readonly name: string; readonly sql: string }[];
	readonly progress: readonly {
		readonly source: string;
		readonly watermark: number;
		readonly backfilled_through: number;
	}[];
};

const SESSION_TRIGGERS = [
	"session_entries_snapshot_links",
	"session_entries_snapshot_refs",
	"session_entries_snapshot_pending",
	"session_entries_snapshot_refs_delete",
] as const;

let directory: string;
const databases: SqliteDatabase[] = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-index-older-build-"));
});
afterEach(async () => {
	while (databases.length > 0) await databases.pop()!.close();
	rmSync(directory, { recursive: true, force: true });
});

async function open(): Promise<SqliteDatabase> {
	const database = await openNodeSqliteDatabase(join(directory, "store.sqlite"));
	databases.push(database);
	return database;
}

/** The session-entries triggers a database holds, with their SQL, by name. */
async function sessionTriggers(database: SqliteDatabase) {
	return database.all<SqliteRow & { name: string; sql: string }>(
		"SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'session_entries' AND name LIKE 'session\\_entries\\_snapshot\\_%' ESCAPE '\\' ORDER BY name",
	);
}

/**
 * A partly restored worktree (#4922) appended to `session` after its entry `parentId`: `S-lacked`, whose bundle the
 * worktree lacks, then `S-derived`, which names it in `degradedFrom`. Only the pin keeps the bundle, so a collection
 * that deletes it lost the pin. Resolves with the bundle's hash and bytes.
 */
async function appendDegradedRestore(sessions: SqlSessionStore, session: string, parentId: string, expectSeq: number) {
	const bundle = new TextEncoder().encode("bundle bytes of S-lacked");
	const hash = createHash("sha256").update(bundle).digest("hex");
	await sessions.snapshotBlobs.putBlobs([{ hash, data: bundle }]);
	const lacked = {
		type: "worktree_snapshot",
		id: "e-lacked",
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		root: "/w",
		snapshotId: "S-lacked",
		snapshot: syntheticSnapshot("S-lacked", [], { bundle: hash, root: "/w" }),
	} as SessionEntry;
	const derived = {
		type: "worktree_snapshot",
		id: "e-derived",
		parentId: lacked.id,
		timestamp: "2026-01-01T00:00:00.000Z",
		root: "/w",
		snapshotId: "S-derived",
		degradedFrom: "S-lacked",
	} as SessionEntry;
	await sessions.append(session, [lacked, derived], { expectSeq });
	return { hash, bundle };
}

/** How the index records the entry that names the snapshot it lacks: its pin, or null when the pin was not indexed. */
async function indexedPin(database: SqliteDatabase): Promise<string | null | undefined> {
	const row = await database.get<SqliteRow & { degraded_from: string | null }>(
		"SELECT degraded_from FROM snapshot_session_refs WHERE snapshot_id = 'S-derived'",
	);
	return row === undefined ? undefined : row.degraded_from;
}

describe("an older build working on this build's session index (#5558)", () => {
	test("the recorded 0.9.87 triggers and progress rows are what the vendored 0.9.87 store installs (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		await createSession(created, "s1", [messageEntry("hi") as SessionEntry]);
		for (const name of SESSION_TRIGGERS) await database.exec(`DROP TRIGGER ${name}`);
		await database.run("DELETE FROM snapshot_index_sources WHERE source LIKE 'session-entries%'");

		await release0987.SqlSnapshotBlobStore.open(database);

		assert.deepEqual(
			(await sessionTriggers(database)).map(({ name, sql }) => ({ name, sql })),
			GOLDEN.triggers,
		);
		assert.deepEqual(
			(
				await database.all<SqliteRow & { source: string; watermark: number; backfilled_through: number }>(
					"SELECT source, watermark, backfilled_through FROM snapshot_index_sources WHERE source LIKE 'session-entries%' ORDER BY source",
				)
			).map((row) => ({ ...row })),
			GOLDEN.progress,
		);
	});

	test("triggers an older build installed after this build's went missing are not trusted, and a degraded pin is kept (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const first = messageEntry("hi") as SessionEntry;
		await createSession(created, "s1", [first]);
		// The session entries table loses this build's triggers; this build's progress rows stay.
		for (const name of SESSION_TRIGGERS) await database.exec(`DROP TRIGGER ${name}`);
		// 0.9.87 opens the store first: it installs its own triggers under the same names and indexes the entries.
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		assert.deepEqual(
			(await sessionTriggers(database)).map(({ name, sql }) => ({ name, sql })),
			GOLDEN.triggers,
			"0.9.87's triggers are installed",
		);

		// This build opens the store and records a partly restored worktree.
		const sessions = await SqlSessionStore.open(database);
		const { hash, bundle } = await appendDegradedRestore(sessions, "s1", first.id, 1);
		const deleted = await sessions.snapshotBlobs.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked", "the pin is indexed");
		const refs = (await sessionTriggers(database)).find(({ name }) => name === "session_entries_snapshot_refs");
		assert.notEqual(
			refs?.sql,
			GOLDEN.triggers.find(({ name }) => name === "session_entries_snapshot_refs")?.sql,
			"this build's reference trigger replaced 0.9.87's",
		);
	});

	test("an older build that finishes this build's interrupted backfill does not leave its entries indexed its way, and a degraded pin is kept (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const first = messageEntry("hi") as SessionEntry;
		await createSession(created, "s1", [first]);
		const { hash, bundle } = await appendDegradedRestore(created, "s1", first.id, 1);
		// The index is rebuilt: this build installs its triggers over the entries, and its collection stops before
		// it indexes them (Atomic exits).
		for (const name of SESSION_TRIGGERS) await database.exec(`DROP TRIGGER ${name}`);
		await database.exec(
			"DELETE FROM snapshot_session_links; DELETE FROM snapshot_session_refs; DELETE FROM snapshot_session_records",
		);
		await SqlSnapshotBlobStore.open(database);
		const pending = await database.get<SqliteRow & { watermark: number; backfilled_through: number }>(
			"SELECT watermark, backfilled_through FROM snapshot_index_sources WHERE source = 'session-entries'",
		);
		assert.ok(Number(pending?.backfilled_through) < Number(pending?.watermark), "the backfill is pending");
		// 0.9.87 collects next: it takes the triggers for its own and indexes the entries with its statements.
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

		const sessions = await SqlSessionStore.open(database);
		const deleted = await sessions.snapshotBlobs.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await sessions.snapshotBlobs.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked", "this build indexed the entry again");
	});

	test("an older build that indexes entries written at reused rowids during this build's backfill does not leave them indexed its way (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const chain = (prefix: string, count: number) => {
			const entries: SessionEntry[] = [messageEntry(`${prefix} 0`) as SessionEntry];
			for (let index = 1; index < count; index++)
				entries.push({ ...messageEntry(`${prefix} ${index}`), parentId: entries.at(-1)!.id } as SessionEntry);
			return entries;
		};
		await createSession(created, "older", chain("older", SNAPSHOT_INDEX_BACKFILL_BATCH - 11));
		await createSession(created, "newest", chain("newest", 120));
		// The index is rebuilt, and this build's backfill stops after its first batch.
		for (const name of SESSION_TRIGGERS) await database.exec(`DROP TRIGGER ${name}`);
		await database.exec(
			"DELETE FROM snapshot_session_links; DELETE FROM snapshot_session_refs; DELETE FROM snapshot_session_records",
		);
		const upgraded = await SqlSnapshotBlobStore.open(database);
		const controller = new AbortController();
		class StoppingPace extends BackgroundCollectionPace {
			override wait(milliseconds: number): Promise<void> {
				controller.abort(new Error("Atomic exits"));
				return super.wait(milliseconds);
			}
		}
		await assert.rejects(
			upgraded.completeIndex({ signal: controller.signal, pace: new StoppingPace(controller.signal) }),
		);
		// The newest session is deleted and a new one takes its rowids, some of them below where the backfill got.
		await created.delete("newest");
		const start = messageEntry("pinned start") as SessionEntry;
		await createSession(created, "pinned", [start]);
		const { hash, bundle } = await appendDegradedRestore(created, "pinned", start.id, 1);
		const reused = await database.get<SqliteRow & { id: number }>(
			"SELECT max(rowid) AS id FROM session_entries WHERE session_id = 'pinned'",
		);
		assert.ok(
			Number(reused?.id) <= SNAPSHOT_INDEX_BACKFILL_BATCH,
			"the new entries reuse rowids the backfill passed",
		);
		// 0.9.87 collects next and indexes them its way.
		await (await release0987.SqlSnapshotBlobStore.open(database)).collectGarbage({ graceSeconds: 1_000_000 });
		assert.equal(await indexedPin(database), null, "0.9.87 indexed the entry without its pin");

		const deleted = await upgraded.collectGarbage({ graceSeconds: 0 });

		assert.equal(deleted.includes(hash), false, "the bundle the pin keeps was collected");
		assert.deepEqual(await upgraded.getBlob(hash), bundle);
		assert.equal(await indexedPin(database), "S-lacked");
	});

	test("a store indexed by a released build that writes degraded pins is trusted without indexing it again (#5558)", async () => {
		const database = await open();
		const created = await SqlSessionStore.open(database);
		const first = messageEntry("hi") as SessionEntry;
		await createSession(created, "s1", [first]);
		// What 0.9.88 to 0.9.90 leave: the same reference triggers and version row, and no row of this build's own
		// backfill progress.
		await database.run("DELETE FROM snapshot_index_sources WHERE source = 'session-entries@own-progress'");
		const before = await database.all("SELECT * FROM snapshot_session_links ORDER BY session_id, seq");
		let transactions = 0;
		const counting: SqliteDatabase = {
			exec: (sql) => database.exec(sql),
			run: (sql, ...params) => database.run(sql, ...params),
			get: (sql, ...params) => database.get(sql, ...params),
			all: (sql, ...params) => database.all(sql, ...params),
			descriptor: database.descriptor,
			close: () => database.close(),
			transaction: (callback, options) => {
				transactions++;
				return database.transaction(callback, options);
			},
		};
		const store = await SqlSnapshotBlobStore.open(counting);

		await store.completeIndex();

		assert.equal(transactions, 0, "the index needed no work");
		assert.deepEqual(await database.all("SELECT * FROM snapshot_session_links ORDER BY session_id, seq"), before);
	});
});
