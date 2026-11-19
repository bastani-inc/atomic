import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import {
	createSession,
	messageEntry,
	snapshotEntry,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";

/**
 * The snapshot blob stores of Atomic 0.9.87 and 0.9.89, vendored unmodified (test/fixtures/snapshot-store-0.9.87 and
 * test/fixtures/snapshot-store-0.9.89): releases that share a store with this build. 0.9.89's backfill and its session
 * store's lookups are 0.9.88's.
 */
interface ReleasedPace {
	wait(milliseconds: number): Promise<void>;
}
interface ReleasedBlobStore {
	completeIndex(options?: { readonly pace?: ReleasedPace; readonly signal?: AbortSignal }): Promise<void>;
	collectGarbage(options: { readonly graceSeconds: number }): Promise<readonly string[]>;
}
const release0987 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.87/worktree-snapshot/blob-store.ts")).href
)) as { SqlSnapshotBlobStore: { open(database: SqliteDatabase): Promise<ReleasedBlobStore> } };
const release0989 = (await import(
	pathToFileURL(join(import.meta.dirname, "../fixtures/snapshot-store-0.9.89/worktree-snapshot/blob-store.ts")).href
)) as {
	SqlSnapshotBlobStore: { open(database: SqliteDatabase): Promise<ReleasedBlobStore> };
	BackgroundCollectionPace: new (signal?: AbortSignal) => ReleasedPace;
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
	directory = mkdtempSync(join(tmpdir(), "snapshot-index-released-"));
});
afterEach(async () => {
	while (databases.length > 0) await databases.pop()!.close();
	rmSync(directory, { recursive: true, force: true });
});

/** Two connections to one store, as two processes have: one for a released build, one for this build. */
const drivers: Record<string, () => Promise<SqliteDatabase>> = {
	"node:sqlite": () => openNodeSqliteDatabase(join(directory, "store.sqlite")),
	libSQL: () => openLibsqlDatabase({ url: pathToFileURL(join(directory, "store.sqlite")).href }),
};
async function connect(driver: () => Promise<SqliteDatabase>): Promise<SqliteDatabase> {
	const database = await driver();
	databases.push(database);
	return database;
}

/** Leaves the session entries without any reference index, as before a build installs one over them. */
async function dropSessionIndex(database: SqliteDatabase): Promise<void> {
	for (const name of SESSION_TRIGGERS) await database.exec(`DROP TRIGGER IF EXISTS ${name}`);
	await database.exec(
		"DELETE FROM snapshot_session_links; DELETE FROM snapshot_session_refs; DELETE FROM snapshot_session_records; DELETE FROM snapshot_index_sources WHERE source LIKE 'session-entries%'",
	);
}

/** `count` message entries, each the child of the one before. */
function chain(prefix: string, count: number, size = 0): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let index = 0; index < count; index++)
		entries.push(messageEntry(`${prefix} ${index} ${"p".repeat(size)}`, entries.at(-1)?.id ?? null));
	return entries;
}

/**
 * Whether a session store of 0.9.88 or 0.9.89 reads the session index as complete, and finds entries by their id in
 * it instead of in the session: its lookup's query, unchanged.
 */
async function releasedReadsComplete(database: SqliteDatabase): Promise<boolean> {
	const source = await database.get<SqliteRow & { complete: number }>(
		"SELECT CASE WHEN backfilled_through >= watermark THEN 1 ELSE 0 END AS complete FROM snapshot_index_sources WHERE source = 'session-entries'",
	);
	return Number(source?.complete) === 1;
}

/**
 * A partly restored worktree (#4922) appended to `session` after its entry `parentId`: `S-lacked`, whose bundle the
 * worktree lacks, then `S-derived`, which names it in `degradedFrom`. Only the pin keeps the bundle.
 */
async function appendDegradedRestore(sessions: SqlSessionStore, session: string, parentId: string, expectSeq: number) {
	const bundle = textBlob("the bundle a partly restored worktree still needs");
	await sessions.snapshotBlobs.putBlobs([bundle]);
	const lacked = snapshotEntry(
		"/repo",
		"S-lacked",
		syntheticSnapshot("S-lacked", [], { bundle: bundle.hash }),
		parentId,
	);
	const derived = { ...snapshotEntry("/repo", "S-derived", undefined, lacked.id), degradedFrom: "S-lacked" };
	await sessions.append(session, [lacked, derived as SessionEntry], { expectSeq });
	return bundle;
}

async function indexedPin(database: SqliteDatabase): Promise<string | null | undefined> {
	const row = await database.get<SqliteRow & { degraded_from: string | null }>(
		"SELECT degraded_from FROM snapshot_session_refs WHERE snapshot_id = 'S-derived'",
	);
	return row === undefined ? undefined : row.degraded_from;
}

/**
 * One batch of the backfill of a released store whose collection is under way: its own batch step, which its
 * collection runs in a loop, so that a test can interleave another build's transactions between two of them.
 */
async function releasedBatch(store: ReleasedBlobStore): Promise<boolean> {
	const internal = store as unknown as {
		sources: readonly { readonly name: string }[];
		backfillBatch(source: unknown, options: object): Promise<boolean>;
	};
	return internal.backfillBatch(internal.sources.find((source) => source.name === "session-entries")!, {});
}

async function linked(database: SqliteDatabase, session: string, entry: string): Promise<boolean> {
	return (
		(await database.get(
			"SELECT 1 AS found FROM snapshot_session_links WHERE session_id = ? AND entry_id = ?",
			session,
			entry,
		)) !== undefined
	);
}

describe("released builds sharing the store while this build installs or indexes the session index (#5558)", () => {
	for (const [driver, open] of Object.entries(drivers)) {
		test(`on ${driver}, a 0.9.89 backfill running on after this build installed the session index again never leaves an index 0.9.89 reads as complete without an entry written since (#5558)`, async () => {
			const released = await connect(open);
			const mine = await connect(open);
			const sessions = await SqlSessionStore.open(mine);
			const entries = chain("message", 1_200);
			await createSession(sessions, "long", entries);
			// 0.9.89 installs its index over the entries and runs its backfill.
			await dropSessionIndex(mine);
			const releasedStore = await release0989.SqlSnapshotBlobStore.open(released);
			let appended: SessionEntry | undefined;
			class BetweenBatches extends release0989.BackgroundCollectionPace {
				override async wait(milliseconds: number): Promise<void> {
					if (appended === undefined && (await mine.get("SELECT 1 FROM snapshot_session_links LIMIT 1"))) {
						// Between two of 0.9.89's batches the session entries table loses a trigger, and this build opens the
						// store; then an entry is written.
						await mine.exec("DROP TRIGGER session_entries_snapshot_refs");
						await SqlSnapshotBlobStore.open(mine);
						appended = messageEntry("written after this build opened", entries.at(-1)!.id);
						await sessions.append("long", [appended], { expectSeq: entries.length });
					}
					return super.wait(milliseconds);
				}
			}

			await releasedStore.completeIndex({ pace: new BetweenBatches() });

			assert.ok(appended !== undefined, "this build opened the store during 0.9.89's backfill");
			assert.ok(
				!(await releasedReadsComplete(mine)) || (await linked(mine, "long", appended.id)),
				"0.9.89 reads the session index as complete, and finds no entry by the id of one written since",
			);
		});

		for (const setup of [
			{
				name: "an index this build installs over large entries",
				entries: () => chain("large", 12, 100_000),
				before: async (_mine: SqliteDatabase) => {},
			},
			{
				name: "an index 0.9.87 installed, which this build installs again",
				entries: () => chain("small", 1_200),
				before: async (older: SqliteDatabase) => {
					await (await release0987.SqlSnapshotBlobStore.open(older)).completeIndex();
				},
			},
		]) {
			test(`on ${driver}, entries 0.9.87 indexes between two of this build's backfill transactions of ${setup.name} are indexed again before this build deletes the bundle a pin keeps (#5558)`, async () => {
				const mine = await connect(open);
				const older = await connect(open);
				const sessions = await SqlSessionStore.open(mine);
				const bundle = textBlob("the bundle a partly restored worktree still needs");
				await sessions.snapshotBlobs.putBlobs([bundle]);
				const padding = setup.entries();
				const lacked = snapshotEntry(
					"/repo",
					"S-lacked",
					syntheticSnapshot("S-lacked", [], { bundle: bundle.hash }),
					padding.at(-1)!.id,
				);
				const derived = { ...snapshotEntry("/repo", "S-derived", undefined, lacked.id), degradedFrom: "S-lacked" };
				await createSession(sessions, "pinned", [...padding, lacked, derived as SessionEntry]);
				await dropSessionIndex(mine);
				await setup.before(older);
				let interleaved = false;
				const watched: SqliteDatabase = {
					exec: (sql) => mine.exec(sql),
					run: (sql, ...params) => mine.run(sql, ...params),
					get: (sql, ...params) => mine.get(sql, ...params),
					all: (sql, ...params) => mine.all(sql, ...params),
					descriptor: mine.descriptor,
					close: () => mine.close(),
					transaction: async (callback, options) => {
						const result = await mine.transaction(callback, options);
						const progress = await mine.get<SqliteRow & { backfilled_through: number }>(
							"SELECT backfilled_through FROM snapshot_index_sources WHERE source = 'session-entries'",
						);
						if (!interleaved && Number(progress?.backfilled_through) > 0) {
							interleaved = true;
							// After this build's first backfill transaction, 0.9.87 indexes the rest of the entries its way.
							await (await release0987.SqlSnapshotBlobStore.open(older)).completeIndex();
						}
						return result;
					},
				};
				const store = await SqlSnapshotBlobStore.open(watched);

				await store.completeIndex();
				const deleted = await store.collectGarbage({ graceSeconds: 0 });

				assert.ok(interleaved, "0.9.87 indexed entries during this build's backfill");
				assert.equal(deleted.includes(bundle.hash), false, "the bundle the pin keeps was collected");
				assert.deepEqual(await store.getBlob(bundle.hash), bundle.data);
				const pin = await mine.get<SqliteRow & { degraded_from: string | null }>(
					"SELECT degraded_from FROM snapshot_session_refs WHERE snapshot_id = 'S-derived'",
				);
				assert.equal(pin?.degraded_from, "S-lacked", "the pin is indexed");
			});
		}

		test(`on ${driver}, entries written at rowids this build's backfill had passed, which 0.9.87 then indexes its way, are indexed again before this build deletes the bundle a pin keeps (#5558)`, async () => {
			const mine = await connect(open);
			const older = await connect(open);
			const sessions = await SqlSessionStore.open(mine);
			await createSession(sessions, "older", chain("older", SNAPSHOT_INDEX_BACKFILL_BATCH - 11));
			await createSession(sessions, "newest", chain("newest", 120));
			// This build installs its index over the entries; its backfill stops after its first batch (Atomic exits).
			await dropSessionIndex(mine);
			const store = await SqlSnapshotBlobStore.open(mine);
			const controller = new AbortController();
			class StoppingPace extends BackgroundCollectionPace {
				override wait(milliseconds: number): Promise<void> {
					controller.abort(new Error("Atomic exits"));
					return super.wait(milliseconds);
				}
			}
			await assert.rejects(
				store.completeIndex({ signal: controller.signal, pace: new StoppingPace(controller.signal) }),
			);
			// The newest session is deleted and a new one takes its rowids, some below where the backfill got.
			await sessions.delete("newest");
			const start = messageEntry("pinned start");
			await createSession(sessions, "pinned", [start]);
			const bundle = await appendDegradedRestore(sessions, "pinned", start.id, 1);
			const reused = await mine.get<SqliteRow & { id: number }>(
				"SELECT max(rowid) AS id FROM session_entries WHERE session_id = 'pinned'",
			);
			assert.ok(
				Number(reused?.id) <= SNAPSHOT_INDEX_BACKFILL_BATCH,
				"the new entries reuse rowids the backfill passed",
			);
			// 0.9.87 collects next and indexes them its way.
			await (await release0987.SqlSnapshotBlobStore.open(older)).collectGarbage({ graceSeconds: 1_000_000 });
			assert.equal(await indexedPin(mine), null, "0.9.87 indexed the entry without its pin");

			const deleted = await store.collectGarbage({ graceSeconds: 0 });

			assert.equal(deleted.includes(bundle.hash), false, "the bundle the pin keeps was collected");
			assert.deepEqual(await store.getBlob(bundle.hash), bundle.data);
			assert.equal(await indexedPin(mine), "S-lacked", "the pin is indexed");
		});

		for (const at of [2, 3]) {
			test(`on ${driver}, 0.9.89 opening the store after this build's transaction ${at} over an index 0.9.87 installed, and 0.9.87 indexing it its way, leave the bundle a pin keeps (#5558)`, async () => {
				const mine = await connect(open);
				const released = await connect(open);
				const older = await connect(open);
				const sessions = await SqlSessionStore.open(mine);
				const bundle = textBlob("the bundle a partly restored worktree still needs");
				await sessions.snapshotBlobs.putBlobs([bundle]);
				const start = messageEntry("start");
				const lacked = snapshotEntry(
					"/repo",
					"S-lacked",
					syntheticSnapshot("S-lacked", [], { bundle: bundle.hash }),
					start.id,
				);
				const derived = { ...snapshotEntry("/repo", "S-derived", undefined, lacked.id), degradedFrom: "S-lacked" };
				await createSession(sessions, "pinned", [start, lacked, derived as SessionEntry]);
				// Snapshot entries that name many blobs: an index of a few thousand rows.
				const wide: SessionEntry[] = [];
				for (let index = 0; index < 150; index++) {
					const patches = Array.from({ length: 20 }, (_, patch) => textBlob(`wide ${index} ${patch}`).hash);
					wide.push(
						snapshotEntry("/repo", `W${index}`, syntheticSnapshot(`W${index}`, patches), wide.at(-1)?.id ?? null),
					);
				}
				await createSession(sessions, "wide", wide);
				// More entries than one backfill transaction indexes.
				await createSession(sessions, "longer", chain("longer", 2 * SNAPSHOT_INDEX_BACKFILL_BATCH));
				// The store as 0.9.87 left it: its triggers and its complete index, as after an upgrade from 0.9.87.
				await dropSessionIndex(mine);
				await (await release0987.SqlSnapshotBlobStore.open(older)).completeIndex();
				let commits = 0;
				const watched: SqliteDatabase = {
					exec: (sql) => mine.exec(sql),
					run: (sql, ...params) => mine.run(sql, ...params),
					get: (sql, ...params) => mine.get(sql, ...params),
					all: (sql, ...params) => mine.all(sql, ...params),
					descriptor: mine.descriptor,
					close: () => mine.close(),
					transaction: async (callback, options) => {
						const result = await mine.transaction(callback, options);
						if (++commits === at) {
							// A 0.9.89 process starts; then 0.9.87 collects and indexes the entries its way.
							await release0989.SqlSnapshotBlobStore.open(released);
							await (await release0987.SqlSnapshotBlobStore.open(older)).completeIndex();
						}
						return result;
					},
				};
				const store = await SqlSnapshotBlobStore.open(watched);

				await store.completeIndex();
				const deleted = await store.collectGarbage({ graceSeconds: 0 });

				assert.ok(commits > at, "the released builds ran during this build's collection");
				assert.equal(deleted.includes(bundle.hash), false, "the bundle the pin keeps was collected");
				assert.deepEqual(await store.getBlob(bundle.hash), bundle.data);
				assert.equal(await indexedPin(mine), "S-lacked", "the pin is indexed");
			});

			test(`on ${driver}, this build stopping after its transaction ${at} over an index 0.9.87 installed, then 0.9.89 opening, 0.9.87 indexing and 0.9.89 collecting, leave the bundle a pin keeps (#5558)`, async () => {
				const mine = await connect(open);
				const released = await connect(open);
				const older = await connect(open);
				const sessions = await SqlSessionStore.open(mine);
				const bundle = textBlob("the bundle a partly restored worktree still needs");
				await sessions.snapshotBlobs.putBlobs([bundle]);
				const start = messageEntry("start");
				const lacked = snapshotEntry(
					"/repo",
					"S-lacked",
					syntheticSnapshot("S-lacked", [], { bundle: bundle.hash }),
					start.id,
				);
				const derived = { ...snapshotEntry("/repo", "S-derived", undefined, lacked.id), degradedFrom: "S-lacked" };
				await createSession(sessions, "pinned", [start, lacked, derived as SessionEntry]);
				await createSession(sessions, "longer", chain("longer", 2 * SNAPSHOT_INDEX_BACKFILL_BATCH));
				// The store as 0.9.87 left it: its triggers and its complete index, as after an upgrade from 0.9.87.
				await dropSessionIndex(mine);
				await (await release0987.SqlSnapshotBlobStore.open(older)).completeIndex();
				const controller = new AbortController();
				let commits = 0;
				const watched: SqliteDatabase = {
					exec: (sql) => mine.exec(sql),
					run: (sql, ...params) => mine.run(sql, ...params),
					get: (sql, ...params) => mine.get(sql, ...params),
					all: (sql, ...params) => mine.all(sql, ...params),
					descriptor: mine.descriptor,
					close: () => mine.close(),
					transaction: async (callback, options) => {
						const result = await mine.transaction(callback, options);
						if (++commits === at) controller.abort(new Error("Atomic exits"));
						return result;
					},
				};
				const store = await SqlSnapshotBlobStore.open(watched);
				// This build's collection stops after its transaction `at`, as when Atomic exits.
				await assert.rejects(store.collectGarbage({ graceSeconds: 0, signal: controller.signal }));

				// While it is not running, a 0.9.89 process starts, 0.9.87 collects, and the 0.9.89 process collects.
				await release0989.SqlSnapshotBlobStore.open(released);
				await (await release0987.SqlSnapshotBlobStore.open(older)).completeIndex();
				const deleted = await (await release0989.SqlSnapshotBlobStore.open(released)).collectGarbage({
					graceSeconds: 0,
				});

				assert.equal(deleted.includes(bundle.hash), false, "0.9.89 collected the bundle the pin keeps");
				assert.deepEqual(await store.getBlob(bundle.hash), bundle.data);
			});
		}

		test(`on ${driver}, 0.9.89 collecting a reset after shutdown keeps pins when 0.9.87 finishes its backfill (#5553)`, async () => {
			const mine = await connect(open);
			const other = await connect(open);
			const older = await connect(open);
			const sessions = await SqlSessionStore.open(mine);
			const start = messageEntry("start");
			await createSession(sessions, "pinned", [start]);
			const bundle = await appendDegradedRestore(sessions, "pinned", start.id, 1);
			await mine.exec("DROP TRIGGER session_entries_snapshot_refs_delete");
			// A session removed while its delete trigger was missing left many more index rows than live entries.
			await mine.exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i < 4000)
				INSERT INTO snapshot_session_links(session_id, seq, entry_id, children, broken) SELECT 'stale',i,'e'||i,0,0 FROM n`);
			const afterCommit = (db: SqliteDatabase, after: () => void | Promise<void>): SqliteDatabase => ({
				exec: (sql) => db.exec(sql),
				run: (sql, ...args) => db.run(sql, ...args),
				get: (sql, ...args) => db.get(sql, ...args),
				all: (sql, ...args) => db.all(sql, ...args),
				close: () => db.close(),
				descriptor: db.descriptor,
				...(db.freeBytes ? { freeBytes: () => db.freeBytes!() } : {}),
				transaction: async (cb, options) => {
					const result = await db.transaction(cb, options);
					await after();
					return result;
				},
			});
			const stop = new AbortController();
			let commits = 0;
			const current = await SqlSnapshotBlobStore.open(
				afterCommit(mine, () => {
					if (++commits === 2) stop.abort();
				}),
			);
			await current.completeIndex({ signal: stop.signal }).catch((error: unknown) => {
				if (error !== stop.signal.reason) throw error;
			});
			let ran = false;
			const released = await release0989.SqlSnapshotBlobStore.open(
				afterCommit(other, async () => {
					if (ran) return;
					if (
						!(await other.get(
							"SELECT 1 FROM snapshot_index_sources WHERE source='session-entries@degraded-pins' AND watermark=0",
						))
					)
						return;
					ran = true;
					await (await release0987.SqlSnapshotBlobStore.open(older)).completeIndex();
				}),
			);
			const deleted = await released.collectGarbage({ graceSeconds: 0 });
			assert.ok(!deleted.includes(bundle.hash), "0.9.89 deleted the bundle after 0.9.87 indexed the pin");
			assert.deepEqual(await current.getBlob(bundle.hash), bundle.data);
		});

		for (const entries of [100, 1_200]) {
			test(`on ${driver} with ${entries} entries, a reference trigger 0.9.87 installs again before this build's first backfill transaction over 0.9.89's index, this build stopping after it, then 0.9.87 and 0.9.89 collecting, leave the bundle a pin keeps (#5558)`, async () => {
				const mine = await connect(open);
				const released = await connect(open);
				const older = await connect(open);
				const sessions = await SqlSessionStore.open(mine);
				const bundle = textBlob("the bundle a partly restored worktree still needs");
				await sessions.snapshotBlobs.putBlobs([bundle]);
				const padding = chain("message", entries);
				const lacked = snapshotEntry(
					"/repo",
					"S-lacked",
					syntheticSnapshot("S-lacked", [], { bundle: bundle.hash }),
					padding.at(-1)!.id,
				);
				const derived = { ...snapshotEntry("/repo", "S-derived", undefined, lacked.id), degradedFrom: "S-lacked" };
				await createSession(sessions, "pinned", [...padding, lacked, derived as SessionEntry]);
				// 0.9.89 installs its index over the entries; its backfill has not run.
				await dropSessionIndex(mine);
				await release0989.SqlSnapshotBlobStore.open(released);
				let transactions = 0;
				const controller = new AbortController();
				const watched: SqliteDatabase = {
					exec: (sql) => mine.exec(sql),
					run: (sql, ...params) => mine.run(sql, ...params),
					get: (sql, ...params) => mine.get(sql, ...params),
					all: (sql, ...params) => mine.all(sql, ...params),
					descriptor: mine.descriptor,
					close: () => mine.close(),
					transaction: async (callback, options) => {
						if (++transactions === 1) {
							// After this build read the states, before its first backfill transaction: the reference trigger goes
							// missing and 0.9.87 opens the store, which installs its own again.
							await mine.exec("DROP TRIGGER session_entries_snapshot_refs");
							await release0987.SqlSnapshotBlobStore.open(older);
						}
						const result = await mine.transaction(callback, options);
						// Atomic exits after this build's first backfill transaction.
						controller.abort(new Error("Atomic exits"));
						return result;
					},
				};
				const store = await SqlSnapshotBlobStore.open(watched);
				// Its collection stops there, whether its index was left for later or not.
				await store.completeIndex({ signal: controller.signal }).catch(() => undefined);
				assert.ok(transactions >= 1, "this build ran a backfill transaction");

				await (await release0987.SqlSnapshotBlobStore.open(older)).completeIndex();
				const deleted = await (await release0989.SqlSnapshotBlobStore.open(released)).collectGarbage({
					graceSeconds: 0,
				});

				assert.equal(deleted.includes(bundle.hash), false, "0.9.89 collected the bundle the pin keeps");
				assert.deepEqual(await store.getBlob(bundle.hash), bundle.data);
			});
		}

		test(`on ${driver}, a reference trigger lost before this build's first backfill transaction over 0.9.89's index that 0.9.87 is indexing, then 0.9.89 opening, leave the bundle a pin keeps (#5558)`, async () => {
			const mine = await connect(open);
			const released = await connect(open);
			const older = await connect(open);
			const sessions = await SqlSessionStore.open(mine);
			const bundle = textBlob("the bundle a partly restored worktree still needs");
			await sessions.snapshotBlobs.putBlobs([bundle]);
			const padding = chain("message", 1_200);
			const lacked = snapshotEntry(
				"/repo",
				"S-lacked",
				syntheticSnapshot("S-lacked", [], { bundle: bundle.hash }),
				padding.at(-1)!.id,
			);
			const derived = { ...snapshotEntry("/repo", "S-derived", undefined, lacked.id), degradedFrom: "S-lacked" };
			await createSession(sessions, "pinned", [...padding, lacked, derived as SessionEntry]);
			// 0.9.89 installs its index; 0.9.87's collection takes it for its own and indexes one batch.
			await dropSessionIndex(mine);
			await release0989.SqlSnapshotBlobStore.open(released);
			const olderStore = await release0987.SqlSnapshotBlobStore.open(older);
			assert.equal(await releasedBatch(olderStore), false, "0.9.87's backfill has batches left");
			let transactions = 0;
			let olderDone = false;
			const watched: SqliteDatabase = {
				exec: (sql) => mine.exec(sql),
				run: (sql, ...params) => mine.run(sql, ...params),
				get: (sql, ...params) => mine.get(sql, ...params),
				all: (sql, ...params) => mine.all(sql, ...params),
				descriptor: mine.descriptor,
				close: () => mine.close(),
				transaction: async (callback, options) => {
					// Before this build's first backfill transaction the reference trigger goes missing; after it, 0.9.89 opens
					// the store and installs its index again.
					if (++transactions === 1) await mine.exec("DROP TRIGGER session_entries_snapshot_refs");
					const result = await mine.transaction(callback, options);
					if (transactions === 1) await release0989.SqlSnapshotBlobStore.open(released);
					// 0.9.87's backfill runs a batch between two of this build's.
					else if (!olderDone) olderDone = await releasedBatch(olderStore);
					return result;
				},
			};
			const store = await SqlSnapshotBlobStore.open(watched);

			await store.completeIndex();
			while (!olderDone) olderDone = await releasedBatch(olderStore);
			const deleted = await store.collectGarbage({ graceSeconds: 0 });

			assert.equal(deleted.includes(bundle.hash), false, "this build collected the bundle the pin keeps");
			const releasedDeleted = await (await release0989.SqlSnapshotBlobStore.open(released)).collectGarbage({
				graceSeconds: 0,
			});
			assert.equal(releasedDeleted.includes(bundle.hash), false, "0.9.89 collected the bundle the pin keeps");
		});

		test(`on ${driver}, a reference trigger lost before this build's first backfill transaction, 0.9.89 opening then and this build stopping after it, then 0.9.87 and 0.9.89 collecting, leave the bundle a pin keeps (#5558)`, async () => {
			const mine = await connect(open);
			const released = await connect(open);
			const older = await connect(open);
			const sessions = await SqlSessionStore.open(mine);
			const bundle = textBlob("the bundle a partly restored worktree still needs");
			await sessions.snapshotBlobs.putBlobs([bundle]);
			const padding = chain("message", 100);
			const lacked = snapshotEntry(
				"/repo",
				"S-lacked",
				syntheticSnapshot("S-lacked", [], { bundle: bundle.hash }),
				padding.at(-1)!.id,
			);
			const derived = { ...snapshotEntry("/repo", "S-derived", undefined, lacked.id), degradedFrom: "S-lacked" };
			await createSession(sessions, "pinned", [...padding, lacked, derived as SessionEntry]);
			// No index over the entries yet: this build's open installs it.
			await dropSessionIndex(mine);
			let backfills = 0;
			const controller = new AbortController();
			const watched: SqliteDatabase = {
				exec: (sql) => mine.exec(sql),
				run: (sql, ...params) => mine.run(sql, ...params),
				get: (sql, ...params) => mine.get(sql, ...params),
				all: (sql, ...params) => mine.all(sql, ...params),
				descriptor: mine.descriptor,
				close: () => mine.close(),
				transaction: async (callback, options) => {
					const installed =
						(await mine.get("SELECT 1 AS found FROM snapshot_index_sources WHERE source = 'session-entries'")) !==
						undefined;
					if (installed && ++backfills === 1) {
						// Before this build's first backfill transaction the reference trigger goes missing, and 0.9.89 opens.
						await mine.exec("DROP TRIGGER session_entries_snapshot_refs");
						await release0989.SqlSnapshotBlobStore.open(released);
					}
					const result = await mine.transaction(callback, options);
					// Atomic exits after this build's first backfill transaction.
					if (backfills >= 1) controller.abort(new Error("Atomic exits"));
					return result;
				},
			};
			const store = await SqlSnapshotBlobStore.open(watched);
			await store.completeIndex({ signal: controller.signal }).catch(() => undefined);
			assert.ok(backfills >= 1, "this build ran a backfill transaction");

			await (await release0987.SqlSnapshotBlobStore.open(older)).completeIndex();
			const deleted = await (await release0989.SqlSnapshotBlobStore.open(released)).collectGarbage({
				graceSeconds: 0,
			});

			assert.equal(deleted.includes(bundle.hash), false, "0.9.89 collected the bundle the pin keeps");
			assert.deepEqual(await store.getBlob(bundle.hash), bundle.data);
		});
	}
});
