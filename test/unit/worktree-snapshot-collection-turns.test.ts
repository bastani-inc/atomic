/**
 * A collection decides whether a blob is referenced by computing the snapshots each session retains (the latest one
 * of each checkout on each open branch). Before #5530 every page and every delete computed them for the whole store in
 * one statement: seconds on a large store, run synchronously by the local SQLite driver, so the event loop got no turn
 * until it ended. These tests hold every step of a collection to a bounded number of session references, with a turn
 * between steps, and hold what it deletes to what a retention scan of the same store keeps.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteValue,
} from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	SNAPSHOT_BLOB_CHUNK_BYTES,
	SNAPSHOT_COLLECTION_BATCH,
	SNAPSHOT_COLLECTION_DELETE_BATCH,
	SNAPSHOT_COLLECTION_SESSION_REFS,
	SqlSnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	collectSnapshotGarbage,
	resetSnapshotCollectionScheduleForTesting,
	scheduleSnapshotCollection,
} from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { assertLag, MAIN_THREAD_LAG_LIMIT_MS, measureLag } from "../helpers/event-loop-lag.js";
import {
	ageBlobs,
	createSession,
	dropSnapshotIndex,
	fullScanRetainedHashes,
	messageEntry,
	openSharedSnapshotDatabase,
	type SharedSnapshotDatabase,
	snapshotEntry,
	startRun,
	statusEvent,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";

/** Sessions of the large store, and snapshot entries on each one's branch. */
const SESSIONS = 24;
const SNAPSHOT_ENTRIES_PER_SESSION = 2_000;
/** Seeding 48,000 indexed session entries is structural cost, not a slow collection. */
const LARGE_STORE_TEST_TIMEOUT_MS = 120_000;
/** Aged blobs that one workflow run retains on the store of the retained-pages test (#5530). */
const RUN_RETAINED_BLOBS = 100_000;

let directory: string;
let path: string;
let shared: SharedSnapshotDatabase;
const others: SharedSnapshotDatabase[] = [];
beforeEach(async () => {
	resetSnapshotCollectionScheduleForTesting();
	directory = mkdtempSync(join(tmpdir(), "snapshot-collection-turns-"));
	path = join(directory, "shared.sqlite");
	shared = await openSharedSnapshotDatabase(path);
});
afterEach(async () => {
	while (others.length > 0) await others.pop()?.close();
	await shared.close();
	rmSync(directory, { recursive: true, force: true });
});

/** Another host of the same store: its own connection to the file, as another process has. */
async function anotherHost(database?: SqliteDatabase): Promise<SharedSnapshotDatabase> {
	const host = await openSharedSnapshotDatabase(path, { database: database ?? (await openNodeSqliteDatabase(path)) });
	others.push(host);
	return host;
}

/** `database`, running `write` once, to its end, just before the first write transaction it starts after `arm()`. */
function writeBeforeFirstTransaction(database: SqliteDatabase, write: () => Promise<void>) {
	let armed = false;
	let wrote = false;
	const wrapped: SqliteDatabase = {
		descriptor: database.descriptor,
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: (sql, ...params) => database.get(sql, ...params),
		all: (sql, ...params) => database.all(sql, ...params),
		transaction: async (callback, options) => {
			if (armed && !wrote) {
				wrote = true;
				await write();
			}
			return database.transaction(callback, options);
		},
		close: () => database.close(),
	};
	return {
		database: wrapped,
		arm: () => {
			armed = true;
		},
		wrote: () => wrote,
	};
}

/** Counts the turns the event loop gets until the returned function is called. */
function countTurns(): () => number {
	let turns = 0;
	let counting = true;
	const tick = () => {
		if (!counting) return;
		turns++;
		setImmediate(tick);
	};
	setImmediate(tick);
	return () => {
		counting = false;
		return turns;
	};
}

/**
 * Session `index`: its first snapshot entry records a blob of its own, and every later entry names a snapshot of the
 * same checkout without a record, as an unchanged capture does. Its latest entry is then the checkout's retained
 * snapshot, so the first entry's blob is garbage, unless `keepLatest` gives the latest entry a record with a blob
 * that it retains.
 */
async function seedSession(index: number, keepLatest: boolean) {
	const dropped = textBlob(`dropped by session ${index}`);
	const kept = textBlob(`kept by session ${index}`);
	const root = `/repo/${index}`;
	const entries: SessionEntry[] = [
		snapshotEntry(root, `s${index}-0`, syntheticSnapshot(`s${index}-0`, [dropped.hash], { root })),
	];
	for (let seq = 1; seq < SNAPSHOT_ENTRIES_PER_SESSION - 1; seq++)
		entries.push(snapshotEntry(root, `s${index}-${seq}`));
	const latest = `s${index}-${SNAPSHOT_ENTRIES_PER_SESSION - 1}`;
	entries.push(snapshotEntry(root, latest, keepLatest ? syntheticSnapshot(latest, [kept.hash], { root }) : undefined));
	await shared.journal.snapshotBlobs.putBlobs(keepLatest ? [dropped, kept] : [dropped]);
	await createSession(shared.sessions, `session-${index}`, entries);
	return { dropped: dropped.hash, kept: keepLatest ? kept.hash : undefined };
}

test(
	"a collection reads a bounded number of session references per turn of the event loop, and deletes only what retention lets go (#5530)",
	async () => {
		const dropped: string[] = [];
		const kept: string[] = [];
		for (let index = 0; index < SESSIONS; index++) {
			const seeded = await seedSession(index, index % 2 === 0);
			dropped.push(seeded.dropped);
			if (seeded.kept !== undefined) kept.push(seeded.kept);
		}
		await ageBlobs(shared.database, shared.journal.snapshotBlobs.table, 10_000);
		const retained = await fullScanRetainedHashes(shared.journal, shared.sessions);
		assert.deepEqual([...retained].sort(), [...kept].sort(), "the store retains exactly the latest records");

		const turns = countTurns();
		const lag = measureLag();
		const { deleted } = await collectSnapshotGarbage(shared.journal.snapshotBlobs, { graceSeconds: 0 });
		const counted = turns();

		const references = SESSIONS * SNAPSHOT_ENTRIES_PER_SESSION;
		assert.ok(
			counted >= Math.floor(references / SNAPSHOT_COLLECTION_SESSION_REFS),
			`the collection read ${references} session references in ${counted} turns, more than ${SNAPSHOT_COLLECTION_SESSION_REFS} per turn`,
		);
		assertLag("snapshot collection over a large session index", lag());
		assert.deepEqual([...deleted].sort(), [...dropped].sort());
		assert.deepEqual([...(await shared.journal.snapshotBlobs.listBlobHashes())].sort(), [...kept].sort());
	},
	LARGE_STORE_TEST_TIMEOUT_MS,
);

/**
 * {@link RUN_RETAINED_BLOBS} aged one-byte blobs, every one referenced by the checkpoints of one running workflow run:
 * pages that a collection keeps whole, without walking a session or deleting anything.
 */
async function seedRunRetainedBlobs(): Promise<void> {
	const runId = "retaining-run";
	const lease = await startRun(shared.journal, runId);
	await shared.journal.append(lease, statusEvent(runId, { status: "running" }, "RunStarted"));
	const blobs = shared.journal.snapshotBlobs.table;
	await shared.database.run(
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO ${blobs} (hash, bytes, data, created_at, chunks) SELECT printf('%064x', i), 1, x'00', 1, 0 FROM n`,
		RUN_RETAINED_BLOBS,
	);
	// The references the run's checkpoints index, written at once rather than through 100,000 snapshot records.
	await shared.database.run(`INSERT INTO snapshot_run_refs (run_id, hash) SELECT ?, hash FROM ${blobs}`, runId);
}

test.each<[string, () => Promise<readonly string[]>]>([
	[
		"a collection",
		async () => (await collectSnapshotGarbage(shared.journal.snapshotBlobs, { graceSeconds: 0 })).deleted,
	],
	[
		"an automatic collection",
		async () => {
			const outcome = await scheduleSnapshotCollection(shared.journal.snapshotBlobs, {
				autoCollect: true,
				collectIntervalSeconds: 3_600,
				graceSeconds: 0,
			});
			if (outcome.status !== "collected") assert.fail(`the collection ended ${JSON.stringify(outcome)}`);
			return outcome.deleted;
		},
	],
])(
	"%s gives the event loop a turn after every page, also pages a run retains whole, with no session to walk and nothing to delete (#5530)",
	async (_collection, collect) => {
		await seedRunRetainedBlobs();
		const pages = Math.ceil(RUN_RETAINED_BLOBS / SNAPSHOT_COLLECTION_BATCH);

		const turns = countTurns();
		const startedAt = performance.now();
		let firstTimerAfterMs: number | undefined;
		const timer = setTimeout(() => {
			firstTimerAfterMs = performance.now() - startedAt;
		}, 1);
		const deleted = await collect();
		const counted = turns();
		const wallMs = performance.now() - startedAt;
		clearTimeout(timer);

		assert.ok(
			counted >= pages - 1,
			`the collection read ${pages} pages of retained blobs in ${counted} turns of the event loop over ${Math.round(wallMs)} ms`,
		);
		assert.ok(
			firstTimerAfterMs !== undefined && firstTimerAfterMs < MAIN_THREAD_LAG_LIMIT_MS,
			`a 1 ms timer set as the collection started ran after ${firstTimerAfterMs ?? "the whole collection"} ms; the collection took ${Math.round(wallMs)} ms`,
		);
		assert.deepEqual(deleted, []);
		const { blobs } = (await shared.database.get<{ blobs: number }>(
			`SELECT count(*) AS blobs FROM ${shared.journal.snapshotBlobs.table}`,
		))!;
		assert.equal(blobs, RUN_RETAINED_BLOBS);
	},
	LARGE_STORE_TEST_TIMEOUT_MS,
);

test(
	"a timer can stop a collection that pages through blobs a run retains: it rejects with the abort reason at the next page (#5530)",
	async () => {
		await seedRunRetainedBlobs();
		const controller = new AbortController();
		const reason = new Error("the storage is closing");

		const stop = setTimeout(() => controller.abort(reason), 1);
		const collection = collectSnapshotGarbage(shared.journal.snapshotBlobs, {
			graceSeconds: 0,
			signal: controller.signal,
		});
		await assert.rejects(collection, (error: unknown) => error === reason);
		clearTimeout(stop);

		const { blobs } = (await shared.database.get<{ blobs: number }>(
			`SELECT count(*) AS blobs FROM ${shared.journal.snapshotBlobs.table}`,
		))!;
		assert.equal(blobs, RUN_RETAINED_BLOBS);
	},
	LARGE_STORE_TEST_TIMEOUT_MS,
);

test.each(["node-sqlite", "libsql"] as const)(
	"on %s, each page of a collection reads the age index from where the page before ended, not from its start, and the pages hold every aged blob once, in age order (#5530)",
	async (adapter) => {
		const file = join(directory, `pages-${adapter}.sqlite`);
		const database =
			adapter === "node-sqlite"
				? await openNodeSqliteDatabase(file)
				: await openLibsqlDatabase({ url: pathToFileURL(file).href });
		try {
			// The statements that read a page of the age index, in order, with what each one read.
			const pages: { sql: string; params: readonly SqliteValue[]; rows: readonly SqliteRow[] }[] = [];
			const recorded: SqliteDatabase = {
				descriptor: database.descriptor,
				exec: (sql) => database.exec(sql),
				run: (sql, ...params) => database.run(sql, ...params),
				get: (sql, ...params) => database.get(sql, ...params),
				all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
					const rows = await database.all<T>(sql, ...params);
					if (/ORDER BY created_at, hash LIMIT \?$/u.test(sql)) pages.push({ sql, params, rows });
					return rows;
				},
				transaction: (callback, options) => database.transaction(callback, options),
				close: () => database.close(),
			};
			const store = await SqlSnapshotBlobStore.open(recorded);
			// Two and a half pages of aged blobs from two seconds, interleaved by hash, so page boundaries fall inside a
			// second; all of them retained by a run. Then blobs of unknown age, and blobs too young to collect.
			const aged = Math.floor(2.5 * SNAPSHOT_COLLECTION_BATCH);
			await database.run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				INSERT INTO ${store.table} (hash, bytes, data, created_at, chunks) SELECT printf('%064x', i), 1, x'00', 5 + i % 2, 0 FROM n`,
				aged,
			);
			await database.run(`INSERT INTO snapshot_run_refs (run_id, hash) SELECT 'run', hash FROM ${store.table}`);
			for (const [index, createdAt] of [0, 0, 0, Date.now() / 1000, Date.now() / 1000].entries())
				await database.run(
					`INSERT INTO ${store.table} (hash, bytes, data, created_at, chunks) VALUES (?, 1, x'00', ?, 0)`,
					`${index}`.padStart(64, "f"),
					Math.floor(createdAt),
				);

			assert.deepEqual(
				await collectSnapshotGarbage(store, { graceSeconds: 3_600 }).then((outcome) => outcome.deleted),
				[],
			);

			const expected = Array.from({ length: aged }, (_, index) => ({
				createdAt: 5 + ((index + 1) % 2),
				hash: (index + 1).toString(16).padStart(64, "0"),
			})).sort((a, b) => a.createdAt - b.createdAt || (a.hash < b.hash ? -1 : 1));
			assert.deepEqual(
				pages.flatMap((page) => page.rows.map((row) => `${row.created_at}:${row.hash}`)),
				expected.map((blob) => `${blob.createdAt}:${blob.hash}`),
				"the pages, in order",
			);
			const following = pages.slice(1);
			assert.equal(following.length, 2);
			for (const page of following) {
				// What the page costs follows from where its search of the age index starts: the cursor, or the oldest blob.
				const plan = (
					await database.all<SqliteRow & { detail: string }>(`EXPLAIN QUERY PLAN ${page.sql}`, ...page.params)
				)
					.map((row) => row.detail)
					.join("; ");
				assert.match(
					plan,
					/INDEX \w+_age \(\(created_at,hash\)>\(\?,\?\)/u,
					`the page after ${JSON.stringify(page.params.slice(1, 3))} searches the age index from ${plan}`,
				);
			}
		} finally {
			await database.close();
		}
	},
);

/**
 * `database`, recording from `arm()` on the statements of a collection that hold the event loop for as long as their
 * batch or their blob is large, and the turns of the event loop between them. Such a statement is a write transaction
 * (recorded when its callback ends, with the statements it ran), a statement that walks sessions outside a write
 * transaction, and a read of a blob's bytes. A turn counts while no transaction is open; not while a transaction waits
 * for the write lock or commits. A turn the collection gives while the callback of a write transaction runs, which
 * holds the write lock, is recorded apart (#5530); one while a statement the callback sent has not answered yet, as it
 * runs on its connection's thread (#5376), is the statement's, not one the collection gave.
 */
function heavyStatementTimeline(database: SqliteDatabase) {
	const events: string[] = [];
	let armed = false;
	let transactions = 0;
	let callbacks = 0;
	let turnsHoldingTheWriteLock = 0;
	/** Statements a write transaction's callback sent that have not answered yet. */
	let running = 0;
	const tick = () => {
		if (!armed) return;
		if (callbacks > 0) {
			if (running === 0) turnsHoldingTheWriteLock++;
		} else if (transactions === 0) events.push("turn");
		setImmediate(tick);
	};
	// The statement that walks sessions follows their open leaves, which no other statement names.
	const heavy = (sql: string) =>
		sql.includes("open_anchors(") ? "session walk" : /^\s*SELECT data FROM/u.test(sql) ? "blob read" : undefined;
	const note = <T>(sql: string, result: T): T => {
		const kind = heavy(sql);
		if (armed && kind !== undefined && callbacks === 0) events.push(kind);
		return result;
	};
	const wrap = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: async (sql) => note(sql, await executor.exec(sql)),
		run: async (sql: string, ...params: readonly SqliteValue[]) => note(sql, await executor.run(sql, ...params)),
		get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			note(sql, await executor.get<T>(sql, ...params)),
		all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			note(sql, await executor.all<T>(sql, ...params)),
	});
	const answered = async <T>(statement: Promise<T>): Promise<T> => {
		running++;
		try {
			return await statement;
		} finally {
			running--;
		}
	};
	const counted = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: (sql) => answered(executor.exec(sql)),
		run: (sql: string, ...params: readonly SqliteValue[]) => answered(executor.run(sql, ...params)),
		get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			answered(executor.get<T>(sql, ...params)),
		all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
			answered(executor.all<T>(sql, ...params)),
	});
	const wrapped: SqliteDatabase = {
		...wrap(database),
		descriptor: database.descriptor,
		close: () => database.close(),
		transaction: async (callback, options) => {
			transactions++;
			try {
				return await database.transaction(async (transaction) => {
					callbacks++;
					try {
						return await callback(wrap(counted(transaction)));
					} finally {
						callbacks--;
						if (armed) events.push("write transaction");
					}
				}, options);
			} finally {
				transactions--;
			}
		},
	};
	return {
		database: wrapped,
		arm: () => {
			armed = true;
			setImmediate(tick);
		},
		/**
		 * The pairs of heavy statements that ran with no turn between them, each as `first -> second`, in order, and the
		 * turns the event loop got while a write transaction's callback ran.
		 */
		stop: () => {
			armed = false;
			const stacked: string[] = [];
			let previous: string | undefined;
			for (const event of events) {
				if (event === "turn") previous = undefined;
				else {
					if (previous !== undefined) stacked.push(`${previous} -> ${event}`);
					previous = event;
				}
			}
			return { stacked, kinds: new Set(events), turnsHoldingTheWriteLock };
		},
	};
}

test(
	"a collection gives the event loop a turn between any two statements that hold it, and none while it holds the write lock, from indexing through deleting to moving legacy blobs (#5530)",
	async () => {
		const store = await openSharedSnapshotDatabase(join(directory, "phases.sqlite"));
		const lease = await startRun(store.journal, "run");
		await store.journal.append(lease, statusEvent("run", { status: "running" }, "RunStarted"));
		await store.database.run(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
			INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at) SELECT 'run', 1 + i, ?, NULL, 'CheckpointRecorded', json_object('kind', 'tool', 'checkpointId', 'c' || i), 0 FROM n`,
			lease.epoch,
		);
		// Two sessions whose first snapshot records a blob that their latest one no longer retains: deleting it walks them.
		const dropped = [textBlob("dropped by session 1"), textBlob("dropped by session 2")];
		const orphans = Array.from({ length: SNAPSHOT_COLLECTION_DELETE_BATCH + 1 }, (_, index) =>
			textBlob(`orphan ${index}`),
		);
		const legacy = [textBlob("legacy 1"), textBlob("legacy 2")];
		await store.journal.snapshotBlobs.putBlobs([...dropped, ...orphans, ...legacy]);
		for (const [index, blob] of dropped.entries()) {
			const root = `/repo/${index}`;
			await createSession(store.sessions, `session-${index}`, [
				snapshotEntry(root, `first-${index}`, syntheticSnapshot(`first-${index}`, [blob.hash], { root })),
				snapshotEntry(root, `latest-${index}`),
			]);
		}
		await ageBlobs(store.database, "snapshot_blobs", 10_000);
		// Blobs an older build stored: two of unknown age, and one held in its row, which collection moves to chunks.
		await store.database.run(
			`UPDATE snapshot_blobs SET created_at = 0 WHERE hash IN (?, ?)`,
			legacy[0]!.hash,
			legacy[1]!.hash,
		);
		const inRow = Buffer.alloc(SNAPSHOT_BLOB_CHUNK_BYTES + 1, 7);
		await store.database.run(
			"INSERT INTO snapshot_blobs (hash, bytes, data, created_at, chunks) VALUES (?, ?, ?, 0, 0)",
			createHash("sha256").update(inRow).digest("hex"),
			inRow.length,
			inRow,
		);

		await store.sessions.close();
		// Without its index, the store is indexed again from its journal and sessions first, table by table.
		await dropSnapshotIndex(store.database);
		const timeline = heavyStatementTimeline(store.database);
		try {
			const blobs = await SqlSnapshotBlobStore.open(timeline.database);
			timeline.arm();
			const deleted = await blobs.collectGarbage({ graceSeconds: 0 });
			const { stacked, kinds, turnsHoldingTheWriteLock } = timeline.stop();

			assert.deepEqual([...deleted].sort(), [...dropped, ...orphans].map((blob) => blob.hash).sort());
			assert.deepEqual(
				[...kinds].sort(),
				["blob read", "session walk", "turn", "write transaction"],
				"the collection indexed, walked sessions, deleted, stamped and moved",
			);
			assert.deepEqual(stacked, [], "statements that ran in one turn of the event loop");
			assert.equal(turnsHoldingTheWriteLock, 0, "turns of the event loop while a write transaction held the lock");
		} finally {
			await store.database.close();
		}
	},
	LARGE_STORE_TEST_TIMEOUT_MS,
);

test("a collection keeps a blob that another host's session retains again before its delete batch commits (#5530)", async () => {
	const early = textBlob("recorded by the early snapshot");
	const late = textBlob("recorded by the late snapshot");
	const orphan = textBlob("recorded by nothing");
	await shared.journal.snapshotBlobs.putBlobs([early, late, orphan]);
	const root = messageEntry("start");
	const earlySnapshot = snapshotEntry("/repo", "early", syntheticSnapshot("early", [early.hash]), root.id);
	const reply = messageEntry("reply", earlySnapshot.id);
	const lateSnapshot = snapshotEntry("/repo", "late", syntheticSnapshot("late", [late.hash]), reply.id);
	const entries = [root, earlySnapshot, reply, lateSnapshot];
	await createSession(shared.sessions, "session-1", entries);
	await ageBlobs(shared.database, shared.journal.snapshotBlobs.table, 10_000);
	const writer = await anotherHost();
	// The other host branches from the reply, whose latest snapshot is the early one: a new leaf that retains it, with
	// no blob stored again.
	const collector = writeBeforeFirstTransaction(await openNodeSqliteDatabase(path), async () => {
		await writer.sessions.append("session-1", [messageEntry("branch from the reply", reply.id)], {
			expectSeq: entries.length,
		});
	});
	const host = await anotherHost(collector.database);
	collector.arm();

	const { deleted } = await collectSnapshotGarbage(host.journal.snapshotBlobs, { graceSeconds: 0 });

	assert.equal(collector.wrote(), true, "the other host wrote while the collection ran");
	assert.deepEqual(deleted, [orphan.hash]);
	assert.deepEqual([...(await shared.journal.snapshotBlobs.listBlobHashes())].sort(), [early.hash, late.hash].sort());
	assert.deepEqual(
		[...(await fullScanRetainedHashes(shared.journal, shared.sessions))].sort(),
		[early.hash, late.hash].sort(),
	);
});

test("a collection keeps a blob a session another host creates records, when it is created before the delete batch commits (#5530)", async () => {
	const dropped = textBlob("dropped by the first session");
	await shared.journal.snapshotBlobs.putBlobs([dropped]);
	await createSession(shared.sessions, "session-1", [
		snapshotEntry("/repo", "dropped", syntheticSnapshot("dropped", [dropped.hash])),
		snapshotEntry("/repo", "unchanged"),
	]);
	await ageBlobs(shared.database, shared.journal.snapshotBlobs.table, 10_000);
	const writer = await anotherHost();
	// A copy of the session's first snapshot entry, as a fork writes it: its blob is stored, so the write goes ahead.
	const collector = writeBeforeFirstTransaction(await openNodeSqliteDatabase(path), async () => {
		await createSession(writer.sessions, "fork", [
			snapshotEntry("/repo", "dropped", syntheticSnapshot("dropped", [dropped.hash])),
		]);
	});
	const host = await anotherHost(collector.database);
	collector.arm();

	const { deleted } = await collectSnapshotGarbage(host.journal.snapshotBlobs, { graceSeconds: 0 });

	assert.equal(collector.wrote(), true);
	assert.deepEqual(deleted, []);
	assert.deepEqual(await shared.journal.snapshotBlobs.listBlobHashes(), [dropped.hash]);
});

test(
	"two hosts collecting one store at once delete each unretained blob once and keep every retained one (#5530)",
	async () => {
		const dropped: string[] = [];
		const kept: string[] = [];
		for (let index = 0; index < 6; index++) {
			const seeded = await seedSession(index, index % 2 === 0);
			dropped.push(seeded.dropped);
			if (seeded.kept !== undefined) kept.push(seeded.kept);
		}
		await ageBlobs(shared.database, shared.journal.snapshotBlobs.table, 10_000);
		const other = await anotherHost();

		const [first, second] = await Promise.all([
			collectSnapshotGarbage(shared.journal.snapshotBlobs, { graceSeconds: 0 }),
			collectSnapshotGarbage(other.journal.snapshotBlobs, { graceSeconds: 0 }),
		]);

		const both = [...first.deleted, ...second.deleted];
		assert.equal(new Set(both).size, both.length, "no blob is reported deleted by both hosts");
		assert.deepEqual([...both].sort(), [...dropped].sort());
		assert.deepEqual([...(await shared.journal.snapshotBlobs.listBlobHashes())].sort(), [...kept].sort());
	},
	LARGE_STORE_TEST_TIMEOUT_MS,
);
