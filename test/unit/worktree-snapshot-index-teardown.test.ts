import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type { SqliteDatabase, SqliteRow } from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.ts";
import {
	BackgroundCollectionPace,
	SNAPSHOT_INDEX_BACKFILL_BATCH,
	SNAPSHOT_INDEX_BACKFILL_BYTES,
	SNAPSHOT_INDEX_TEARDOWN_BATCH,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	collectSnapshotGarbage,
	resetSnapshotCollectionScheduleForTesting,
} from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import type { SnapshotBlob } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	ageBlobs,
	createSession,
	dropSnapshotIndex,
	fullScanRetainedHashes,
	messageEntry,
	snapshotEntry,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";

let directory: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-index-teardown-"));
	resetSnapshotCollectionScheduleForTesting();
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

async function openDatabase(name = "shared.sqlite"): Promise<SqliteDatabase> {
	const database = await openNodeSqliteDatabase(join(directory, name));
	closers.push(() => database.close());
	return database;
}

/** The session store and run journal of `database`; both close with the test. */
async function openStores(database: SqliteDatabase) {
	const sessions = await SqlSessionStore.open(database);
	const journal = await SqlRunJournal.open(database);
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await journal.close();
		await sessions.close();
	};
	closers.push(close);
	return { sessions, journal, blobs: journal.snapshotBlobs, close };
}

type Stores = Awaited<ReturnType<typeof openStores>>;

/** Entries of the long session: more index rows than two teardown batches whatever their size. */
const LONG_ENTRIES = 2_600;
/** Every this many entries of the long session is a snapshot entry with a blob of its own. */
const SNAPSHOT_EVERY = 100;

const snapshotBlobOf = (session: string, index: number) => textBlob(`${session} snapshot ${index}`);

/** `count` entries, chained, every {@link SNAPSHOT_EVERY}th a snapshot entry of the blob {@link snapshotBlobOf} names. */
function sessionEntries(session: string, count: number): { entries: SessionEntry[]; blobs: SnapshotBlob[] } {
	const entries: SessionEntry[] = [];
	const blobs: SnapshotBlob[] = [];
	for (let index = 1; index <= count; index++) {
		if (index % SNAPSHOT_EVERY !== 0) {
			entries.push(messageEntry(`${session} message ${index}`));
			continue;
		}
		const blob = snapshotBlobOf(session, index);
		blobs.push(blob);
		const id = `${session}-${index}`;
		entries.push(snapshotEntry("/repo", id, syntheticSnapshot(id, [blob.hash])));
	}
	return { entries, blobs };
}

/**
 * A database whose reference index is complete and holds a long session's rows and a short session's, as this build
 * leaves it.
 */
async function indexedStore() {
	const database = await openDatabase();
	const stores = await openStores(database);
	const long = sessionEntries("long", LONG_ENTRIES);
	const short = sessionEntries("short", 2 * SNAPSHOT_EVERY);
	// A session id past every ASCII one, whose rows the key order puts last.
	const unicode = sessionEntries("セッション-é", SNAPSHOT_EVERY + 5);
	await stores.blobs.putBlobs([...long.blobs, ...short.blobs, ...unicode.blobs]);
	await createSession(stores.sessions, "long", long.entries);
	await createSession(stores.sessions, "short", short.entries);
	await createSession(stores.sessions, "セッション-é", unicode.entries);
	return { database, stores, long, short, unicode };
}

/** What an older build leaves: the session entries' index without this build's version row (#5065). */
async function installedByAnOlderBuild(database: SqliteDatabase): Promise<void> {
	await database.run("DELETE FROM snapshot_index_sources WHERE source = 'session-entries@degraded-pins'");
}

const SESSION_INDEX = ["snapshot_session_links", "snapshot_session_refs", "snapshot_session_records"] as const;

async function indexRows(database: SqliteDatabase): Promise<number> {
	const row = await database.get<SqliteRow & { rows: number }>(
		`SELECT ${SESSION_INDEX.map((table) => `(SELECT count(*) FROM ${table})`).join(" + ")} AS rows`,
	);
	return Number(row?.rows);
}

async function entriesProgress(database: SqliteDatabase) {
	const row = await database.get<SqliteRow & { watermark: number; backfilled_through: number }>(
		"SELECT watermark, backfilled_through FROM snapshot_index_sources WHERE source = 'session-entries'",
	);
	return row === undefined
		? undefined
		: { watermark: Number(row.watermark), backfilled: Number(row.backfilled_through) };
}

/**
 * Whether the session index awaits its rebuild: its progress row, the only one older builds read, is gone, so none reads
 * the index as complete, and this build's mark is there (#5553).
 */
async function awaitsRebuild(database: SqliteDatabase): Promise<boolean> {
	const marked = await database.get(
		"SELECT 1 AS marked FROM snapshot_index_sources WHERE source = 'session-entries@rebuild'",
	);
	return marked !== undefined && (await entriesProgress(database)) === undefined;
}

/** One write transaction: how many session index rows it removed, and whether the event loop turned before it began. */
interface WatchedTransaction {
	readonly removed: number;
	readonly afterTurn: boolean;
}

/**
 * `database`, recording for each write transaction how many session index rows it removed (negative: added) and
 * whether the event loop turned between the end of the previous one and its start.
 */
function watchingTransactions(database: SqliteDatabase) {
	const transactions: WatchedTransaction[] = [];
	let turned = true;
	const wrapped: SqliteDatabase = {
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: (sql, ...params) => database.get(sql, ...params),
		all: (sql, ...params) => database.all(sql, ...params),
		descriptor: database.descriptor,
		close: () => database.close(),
		transaction: async (callback, options) => {
			const afterTurn = turned;
			const before = await indexRows(database);
			const result = await database.transaction(callback, options);
			transactions.push({ removed: before - (await indexRows(database)), afterTurn });
			turned = false;
			setImmediate(() => {
				turned = true;
			});
			return result;
		},
	};
	return { wrapped, transactions };
}

/** The rows of the session index, every column but the clock reading of a degraded pin. */
async function indexContents(database: SqliteDatabase) {
	return {
		links: await database.all(
			"SELECT session_id, seq, entry_id, parent_id, anchor_seq, children, broken FROM snapshot_session_links ORDER BY session_id, seq",
		),
		refs: await database.all(
			"SELECT session_id, seq, root, snapshot_id, prev_seq, restore_from, restore_to, degraded_from FROM snapshot_session_refs ORDER BY session_id, seq",
		),
		records: await database.all(
			"SELECT session_id, seq, snapshot_id, hash FROM snapshot_session_records ORDER BY session_id, seq, hash",
		),
	};
}

let copies = 0;
/** The session index a copy of `database` builds from nothing: what every rebuild must end with. */
async function rebuiltFromNothing(database: SqliteDatabase) {
	const path = join(directory, `rebuilt-${++copies}.sqlite`);
	await database.exec(`VACUUM INTO '${path}'`);
	const copy = await openNodeSqliteDatabase(path);
	closers.push(() => copy.close());
	await dropSnapshotIndex(copy);
	const stores = await openStores(copy);
	await stores.blobs.completeIndex();
	return indexContents(copy);
}

const sorted = (hashes: Iterable<string>) => [...hashes].sort();

/** Asserts that a collection now keeps every blob a full scan retains, and deletes every blob it does not. */
async function assertCollectsExactlyTheUnretained(database: SqliteDatabase, stores: Stores, blobs = stores.blobs) {
	const retained = await fullScanRetainedHashes(stores.journal, stores.sessions);
	await ageBlobs(database, "snapshot_blobs", 10_000);
	await collectSnapshotGarbage(blobs);
	assert.deepEqual(sorted(await blobs.listBlobHashes()), sorted(retained));
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe("an old session index is removed in bounded batches before it is rebuilt (#5553)", () => {
	test("an index an older build installed is removed in transactions of at most SNAPSHOT_INDEX_TEARDOWN_BATCH rows, with a turn of the event loop between them (#5553)", async () => {
		const { database, stores } = await indexedStore();
		await installedByAnOlderBuild(database);
		const before = await indexRows(database);
		const watched = watchingTransactions(database);
		const upgraded = await SqlSnapshotBlobStore.open(watched.wrapped);

		await upgraded.completeIndex();

		const teardown = watched.transactions.filter((transaction) => transaction.removed > 0);
		const largest = Math.max(...teardown.map((transaction) => transaction.removed));
		assert.ok(
			largest <= SNAPSHOT_INDEX_TEARDOWN_BATCH,
			`one transaction removed ${largest} of the ${before} index rows`,
		);
		assert.ok(before > 2 * SNAPSHOT_INDEX_TEARDOWN_BATCH, "the index spans several batches");
		assert.equal(sum(teardown.map((transaction) => transaction.removed)), before, "every old row is removed");
		assert.equal(teardown.length, Math.ceil(before / SNAPSHOT_INDEX_TEARDOWN_BATCH));
		assert.deepEqual(
			teardown.map((transaction) => transaction.afterTurn),
			Array<boolean>(teardown.length).fill(true),
			"the event loop turned before each batch",
		);
		assert.deepEqual(await indexContents(database), await rebuiltFromNothing(database));
		await assertCollectsExactlyTheUnretained(database, stores, upgraded);
	});

	test("opening a store whose session index lost a trigger removes no index row; the next collection removes them in batches (#5553)", async () => {
		const { database, stores } = await indexedStore();
		await database.exec("DROP TRIGGER session_entries_snapshot_refs");
		const before = await indexRows(database);
		const watched = watchingTransactions(database);

		const reopened = await SqlSnapshotBlobStore.open(watched.wrapped);

		assert.equal(await indexRows(database), before, "the open removed no index row");
		assert.ok(
			watched.transactions.every((transaction) => transaction.removed === 0),
			"no transaction of the open removed rows",
		);
		assert.ok(await awaitsRebuild(database), "the open left the rebuild to collection");
		await reopened.completeIndex();
		const teardown = watched.transactions.filter((transaction) => transaction.removed > 0);
		assert.ok(Math.max(...teardown.map((transaction) => transaction.removed)) <= SNAPSHOT_INDEX_TEARDOWN_BATCH);
		assert.deepEqual(await indexContents(database), await rebuiltFromNothing(database));
		await assertCollectsExactlyTheUnretained(database, stores, reopened);
	});

	test("a teardown stopped at shutdown resumes where it stopped after a restart, and nothing is collected meanwhile (#5553)", async () => {
		const { database, stores, long } = await indexedStore();
		await installedByAnOlderBuild(database);
		const before = await indexRows(database);
		const upgraded = await SqlSnapshotBlobStore.open(database);
		const controller = new AbortController();
		const reason = new Error("shutting down");
		class StoppingPace extends BackgroundCollectionPace {
			override wait(milliseconds: number): Promise<void> {
				controller.abort(reason);
				return super.wait(milliseconds);
			}
		}

		await assert.rejects(
			upgraded.completeIndex({ signal: controller.signal, pace: new StoppingPace(controller.signal) }),
			(error: unknown) => error === reason,
		);

		const left = await indexRows(database);
		assert.equal(left, before - SNAPSHOT_INDEX_TEARDOWN_BATCH, "the teardown stopped after its first batch");
		assert.ok(await awaitsRebuild(database), "the index still awaits its rebuild");
		// A sweep stopped during the teardown it resumes deletes nothing, however old every blob is.
		await ageBlobs(database, "snapshot_blobs", 10_000);
		const sweeping = new AbortController();
		class StoppingSweep extends BackgroundCollectionPace {
			override wait(milliseconds: number): Promise<void> {
				sweeping.abort(reason);
				return super.wait(milliseconds);
			}
		}
		await assert.rejects(
			upgraded.sweep({ graceSeconds: 0, signal: sweeping.signal, pace: new StoppingSweep(sweeping.signal) }),
		);
		assert.equal((await upgraded.listBlobHashes()).length, long.blobs.length + 3, "no blob was deleted");
		const stopped = await indexRows(database);

		// The process exits; the next one opens the database again and collects.
		await stores.close();
		const again = await openDatabase();
		const restarted = await openStores(again);
		assert.equal(await indexRows(again), stopped, "opening again removes nothing");
		const watched = watchingTransactions(again);
		const resumed = await SqlSnapshotBlobStore.open(watched.wrapped);
		await resumed.completeIndex();

		const teardown = watched.transactions.filter((transaction) => transaction.removed > 0);
		assert.equal(sum(teardown.map((transaction) => transaction.removed)), stopped, "only what was left is removed");
		assert.equal(teardown.length, Math.ceil(stopped / SNAPSHOT_INDEX_TEARDOWN_BATCH));
		assert.deepEqual(await indexContents(again), await rebuiltFromNothing(again));
		await assertCollectsExactlyTheUnretained(again, restarted, resumed);
	});

	test("sessions another connection writes during the teardown and the backfill end up indexed as a rebuild from nothing indexes them (#5553)", async () => {
		const { database, long } = await indexedStore();
		await installedByAnOlderBuild(database);
		const other = await openDatabase("shared.sqlite");
		const writer = await openStores(other);
		const upgraded = await SqlSnapshotBlobStore.open(database);
		const seqs: Record<string, number> = { long: LONG_ENTRIES, short: 2 * SNAPSHOT_EVERY };
		const latest = (await writer.sessions.load("long")).entries.at(-1)!;
		const early = (await writer.sessions.load("long")).entries[10]!;
		const late = (name: string) => {
			const blob = textBlob(`written during the rebuild: ${name}`);
			return { blob, entry: snapshotEntry("/repo", name, syntheticSnapshot(name, [blob.hash])) };
		};
		const writes: Array<() => Promise<void>> = [
			async () => {
				// A new branch from an early entry of the long session, with a snapshot of its own.
				const { blob, entry } = late("branch");
				await writer.blobs.putBlobs([blob]);
				const branched = { ...entry, parentId: early.id } as SessionEntry;
				seqs.long = (await writer.sessions.append("long", [branched], { expectSeq: seqs.long! })).lastSeq;
			},
			async () => {
				const { blob, entry } = late("new session");
				await writer.blobs.putBlobs([blob]);
				await createSession(writer.sessions, "written", [messageEntry("start"), entry]);
				seqs.written = 2;
			},
			() => writer.sessions.delete("short"),
			async () => {
				const { blob, entry } = late("main branch");
				await writer.blobs.putBlobs([blob]);
				const next = { ...entry, parentId: latest.id } as SessionEntry;
				seqs.long = (await writer.sessions.append("long", [next], { expectSeq: seqs.long! })).lastSeq;
			},
			async () => {
				const { header, lastSeq } = await writer.sessions.load("written");
				const { blob, entry } = late("replaced");
				await writer.blobs.putBlobs([blob]);
				await writer.sessions.replace("written", header, [messageEntry("again"), entry], { expectSeq: lastSeq });
			},
		];
		let duringTeardown = 0;
		let duringBackfill = 0;
		class WritingPace extends BackgroundCollectionPace {
			override async wait(milliseconds: number): Promise<void> {
				const write = writes.shift();
				if (write !== undefined) {
					const progress = await entriesProgress(database);
					if (await awaitsRebuild(database)) duringTeardown++;
					else if (progress !== undefined && progress.backfilled < progress.watermark) duringBackfill++;
					await write();
				}
				return super.wait(milliseconds);
			}
		}

		await upgraded.completeIndex({ pace: new WritingPace() });

		assert.equal(writes.length, 0, "every write ran");
		assert.ok(duringTeardown >= 2, `${duringTeardown} writes ran while the old index was being removed`);
		assert.ok(long.entries.length > SNAPSHOT_INDEX_BACKFILL_BATCH);
		assert.deepEqual(await indexContents(database), await rebuiltFromNothing(database));
		assert.ok(
			(await writer.sessions.findEntrySeq("long", early.id)) === 11,
			"entries keep resolving by id after the rebuild",
		);
		assert.ok(duringTeardown + duringBackfill === 5);
		await assertCollectsExactlyTheUnretained(database, writer, upgraded);
	});

	test("two collectors removing the same old index at once both finish with the index a rebuild from nothing builds (#5553)", async () => {
		const { database } = await indexedStore();
		await installedByAnOlderBuild(database);
		const first = await SqlSnapshotBlobStore.open(database);
		const second = await SqlSnapshotBlobStore.open(await openDatabase("shared.sqlite"));
		let turns = 0;
		class CountingPace extends BackgroundCollectionPace {
			override wait(milliseconds: number): Promise<void> {
				turns++;
				return super.wait(milliseconds);
			}
		}

		await Promise.all([
			first.completeIndex({ pace: new CountingPace() }),
			second.completeIndex({ pace: new CountingPace() }),
		]);

		assert.ok(turns > 2, "both collectors worked in batches");
		const progress = await entriesProgress(database);
		assert.equal(progress?.backfilled, progress?.watermark);
		assert.deepEqual(await indexContents(database), await rebuiltFromNothing(database));
	});

	test("a backfill that finds the session index marked for a rebuild meanwhile leaves the mark for every build to read (#5553)", async () => {
		const { database, stores } = await indexedStore();
		await installedByAnOlderBuild(database);
		const other = await openDatabase("shared.sqlite");
		const upgraded = await SqlSnapshotBlobStore.open(database);
		let marked = false;
		class MarkingPace extends BackgroundCollectionPace {
			override async wait(milliseconds: number): Promise<void> {
				const progress = await entriesProgress(database);
				if (!marked && progress !== undefined && progress.watermark > 0 && progress.backfilled > 0) {
					marked = true;
					// Between two backfill batches the index loses a trigger, and another process opens the store.
					await other.exec("DROP TRIGGER session_entries_snapshot_refs");
					await SqlSnapshotBlobStore.open(other);
				}
				return super.wait(milliseconds);
			}
		}

		await upgraded.completeIndex({ pace: new MarkingPace() });

		assert.ok(marked, "the index was marked during the backfill");
		assert.ok(
			await awaitsRebuild(database),
			`the index awaits its rebuild, which no build reads as complete: ${JSON.stringify(await entriesProgress(database))}`,
		);
		await upgraded.completeIndex();
		assert.deepEqual(await indexContents(database), await rebuiltFromNothing(database));
		await assertCollectsExactlyTheUnretained(database, stores, upgraded);
	});

	test("a session appended to while its old index is half removed still resolves the entries it names (#5553)", async () => {
		const { database, stores } = await indexedStore();
		await installedByAnOlderBuild(database);
		const upgraded = await SqlSnapshotBlobStore.open(database);
		const controller = new AbortController();
		class StoppingPace extends BackgroundCollectionPace {
			override wait(milliseconds: number): Promise<void> {
				controller.abort(new Error("shutting down"));
				return super.wait(milliseconds);
			}
		}
		await assert.rejects(
			upgraded.completeIndex({ signal: controller.signal, pace: new StoppingPace(controller.signal) }),
		);
		// The first batch removed the links of the long session's first entries.
		const { entries } = await stores.sessions.load("long");

		assert.equal(await stores.sessions.findEntrySeq("long", entries[0]!.id), 1);
		assert.equal(await stores.sessions.findEntrySeq("long", entries.at(-1)!.id), entries.length);
		const branched = { ...messageEntry("a branch from the first entry"), parentId: entries[0]!.id } as SessionEntry;
		await stores.sessions.append("long", [branched], { expectSeq: entries.length });
		const resume = await stores.sessions.readResume("long");
		assert.deepEqual(
			resume.branch.map((held) => held.entry.id),
			[entries[0]!.id, branched.id],
			"the resumed branch is the first entry and the new one",
		);
	});
});

describe("a backfill holds the database for a bounded amount of session JSON (#5553)", () => {
	test("each backfill transaction indexes session entries up to SNAPSHOT_INDEX_BACKFILL_BYTES of their JSON (#5553)", async () => {
		const database = await openDatabase();
		const stores = await openStores(database);
		const text = "x".repeat(100_000);
		const entries = Array.from({ length: 60 }, (_, index) => messageEntry(`${index} ${text}`));
		await createSession(stores.sessions, "large", entries);
		await stores.close();
		await dropSnapshotIndex(database);
		// An open creates the index and installs its triggers; collection backfills the entries written before.
		await SqlSnapshotBlobStore.open(database);
		const watched = watchingTransactions(database);
		const upgraded = await SqlSnapshotBlobStore.open(watched.wrapped);
		const entryBytes = Number(
			(
				await database.get<SqliteRow & { bytes: number }>(
					"SELECT max(length(CAST(entry_json AS BLOB))) AS bytes FROM session_entries",
				)
			)?.bytes,
		);

		await upgraded.completeIndex();

		const indexed = watched.transactions.filter((transaction) => transaction.removed < 0).map((t) => -t.removed);
		const perTransaction = Math.ceil(SNAPSHOT_INDEX_BACKFILL_BYTES / entryBytes);
		assert.ok(
			Math.max(...indexed) <= perTransaction,
			`one transaction indexed ${Math.max(...indexed)} entries of ${entryBytes} bytes`,
		);
		assert.ok(entries.length > 2 * perTransaction, "the entries hold more JSON than two transactions index");
		assert.equal(sum(indexed), entries.length);
		const links = await database.get<SqliteRow & { broken: number; leaves: number }>(
			"SELECT sum(broken) AS broken, count(*) FILTER (WHERE children = 0) AS leaves FROM snapshot_session_links",
		);
		assert.deepEqual({ ...links }, { broken: 0, leaves: 1 }, "each entry met its parent's link");
	});

	test("a backfill indexes the snapshot records of snapshot entries only, not of every entry (#5553)", async () => {
		const database = await openDatabase();
		const stores = await openStores(database);
		const { entries, blobs } = sessionEntries("long", 1_000);
		await stores.blobs.putBlobs(blobs);
		await createSession(stores.sessions, "long", entries);
		await stores.close();
		await dropSnapshotIndex(database);
		const statements: string[] = [];
		const counting: SqliteDatabase = {
			exec: (sql) => database.exec(sql),
			run: (sql, ...params) => database.run(sql, ...params),
			get: (sql, ...params) => database.get(sql, ...params),
			all: (sql, ...params) => database.all(sql, ...params),
			descriptor: database.descriptor,
			close: () => database.close(),
			transaction: (callback, options) =>
				database.transaction(
					(transaction) =>
						callback({
							exec: (sql) => transaction.exec(sql),
							get: (sql, ...params) => transaction.get(sql, ...params),
							all: (sql, ...params) => transaction.all(sql, ...params),
							run: (sql, ...params) => {
								statements.push(sql);
								return transaction.run(sql, ...params);
							},
						}),
					options,
				),
		};
		const upgraded = await SqlSnapshotBlobStore.open(counting);

		await upgraded.completeIndex();

		const recordStatements = statements.filter(
			(sql) => sql.includes("INTO snapshot_session_refs") || sql.includes("INTO snapshot_session_records"),
		).length;
		assert.equal(recordStatements, 3 * blobs.length, "three statements for each snapshot entry, none for messages");
		const reopened = await openStores(database);
		await assertCollectsExactlyTheUnretained(database, reopened);
	});
});
