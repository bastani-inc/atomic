import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import {
	SNAPSHOT_COLLECTION_BATCH,
	SNAPSHOT_COLLECTION_DELETE_BATCH,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import type { CountedStatement } from "../helpers/counting-database.js";
import { countingDatabase } from "../helpers/counting-database.js";
import {
	ageBlobs,
	checkpointEvent,
	createSession,
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

let directory: string;
const opened: SharedSnapshotDatabase[] = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-collection-counting-"));
});
afterEach(async () => {
	while (opened.length > 0) await opened.pop()?.close();
	rmSync(directory, { recursive: true, force: true });
});

/**
 * The only scans a collection may make: the schema and source rows its index check reads, the one table's entry its
 * chunk-layout check reads (#5541), and the structures it builds once per statement from the open leaves of session
 * trees (the covering index of leaves with a snapshot behind them, the distinct anchors they give, the snapshot entries
 * on their branches and the restores among them), none of which grows with messages.
 */
const SCANS_OF_INDEX_STRUCTURES =
	/^SCAN (?!json_each|sqlite_schema|pragma_table_list VIRTUAL TABLE|snapshot_index_sources|snapshot_session_links USING COVERING INDEX snapshot_session_links_leaves$|anchor$|branch$|walk$|checkout$|session_heads$)/u;

/** Tables a collection must never read: the journal's and the sessions'. */
const HISTORY_TABLES = /\b(wf_events|wf_runs|wf_leases|session_entries|session_sessions|session_search_texts)\b/u;

/**
 * A shared database with `snapshots` snapshots, half kept by a failed run and the rest split between a completed
 * run and older entries of one session, padded with `events` checkpoint events and `events` session entries that
 * reference nothing, as long-running roots accumulate.
 */
async function history(name: string, snapshots: number, events: number) {
	const counted = countingDatabase(await openNodeSqliteDatabase(join(directory, `${name}.sqlite`)));
	const shared = await openSharedSnapshotDatabase("", { database: counted.wrapped });
	opened.push(shared);
	const blobs = Array.from({ length: snapshots }, (_, index) => textBlob(`${name}-blob-${index}`));
	await shared.journal.snapshotBlobs.putBlobs(blobs);
	const kept = blobs.slice(0, snapshots / 2);
	const done = blobs.slice(snapshots / 2, (snapshots * 3) / 4);
	const sessionBlobs = blobs.slice((snapshots * 3) / 4);
	for (const [runId, status, owned] of [
		["run-kept", "failed", kept],
		["run-done", "completed", done],
	] as const) {
		const lease = await startRun(shared.journal, runId);
		await shared.journal.append(lease, statusEvent(runId, { status: "running" }, "RunStarted"));
		for (const blob of owned)
			await shared.journal.append(lease, checkpointEvent([syntheticSnapshot(blob.hash, [blob.hash])]));
		await shared.database.run(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
			INSERT INTO wf_events(run_id, seq, epoch, key, type, payload, at) SELECT ?, (SELECT MAX(seq) FROM wf_events WHERE run_id = ?) + i, ?, NULL,
				'CheckpointRecorded', json_object('kind', 'tool', 'checkpointId', 'padding-' || i), 0 FROM n`,
			events / 2,
			runId,
			runId,
			lease.epoch,
		);
		await shared.journal.append(lease, statusEvent(runId, { status }));
	}
	await createSession(
		shared.sessions,
		"session-1",
		sessionBlobs.map((blob) => snapshotEntry("/repo", blob.hash, syntheticSnapshot(blob.hash, [blob.hash]))),
	);
	await shared.database.run(
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO session_entries (session_id, seq, entry_id, entry_json) SELECT 'session-1', ? + i, 'padding-' || i,
			json_object('type', 'message', 'id', 'padding-' || i) FROM n`,
		events,
		sessionBlobs.length,
	);
	await ageBlobsTogether(shared, 10_000);
	const measure = async <T>(action: () => Promise<T>) => {
		counted.statements.length = 0;
		counted.counts.transactions = 0;
		const result = await action();
		return {
			result,
			statements: [...counted.statements],
			rows: counted.statements.reduce((sum, statement) => sum + statement.rows, 0),
			transactions: counted.counts.transactions,
		};
	};
	return { shared, counted, measure, keptBlobs: kept.length + 1 };
}

/**
 * Ages every blob of `shared` to `seconds` before the oldest. Each blob is stored with the database clock as its
 * statement runs, so a store that crosses a second boundary dates the blobs before it a second earlier; collection pages
 * go by age, and those earlier blobs, the failed run's, would then fill a page of their own and make the page's count
 * depend on the clock. One age for all keeps every page the same hash-ordered mix.
 */
async function ageBlobsTogether(shared: SharedSnapshotDatabase, seconds: number): Promise<void> {
	const table = shared.journal.snapshotBlobs.table;
	await shared.database.run(`UPDATE ${table} SET created_at = (SELECT MIN(created_at) FROM ${table}) - ?`, seconds);
}

async function queryPlan(shared: SharedSnapshotDatabase, statement: CountedStatement): Promise<string[]> {
	const rows = await shared.database.all<{ detail: string }>(
		`EXPLAIN QUERY PLAN ${statement.sql}`,
		...statement.params,
	);
	return rows.map((row) => row.detail);
}

/**
 * One check that the reference index is complete: which of the 3 referencing tables and 9 triggers exist (12 schema
 * rows) and how far each of the 3 sources is backfilled (3 rows), with the row that says the session entries'
 * triggers are this build's (#5065) and this build's own backfill progress of them (#5558). A collection makes one
 * before it sweeps and one inside each delete batch's own transaction.
 */
const INDEX_CHECK = { statements: 2, rows: 17 } as const;
/**
 * The chunk-delete trigger and two maintenance-index rows, then an indexed legacy-row probe, then whether the chunk
 * table still has to move to the row layout (#5541), which it has not, once per collection.
 */
const AGE_CHECK = { statements: 3, rows: 3 } as const;
/**
 * Each page of aged blobs (#5530): a range of the age index, the blobs of it no run or carried work keeps, and the
 * sessions whose snapshot records name those.
 */
const PAGE = { statements: 3 } as const;
/**
 * The sessions a sweep meets for the first time: what walking them costs, then the blobs their retained snapshots name,
 * one statement each for sessions this small (#5530).
 */
const WALK = { statements: 2 } as const;
/**
 * Each delete batch's transaction after its index check: one statement for the blobs of the batch it keeps, those the
 * retained snapshots of the sessions the sweep walked for them name and those another session names, and the delete
 * (#5530).
 */
const BATCH = { statements: 2 } as const;

const summary = (measured: { statements: readonly CountedStatement[]; rows: number; transactions: number }) => ({
	statements: measured.statements.length,
	rows: measured.rows,
	transactions: measured.transactions,
});

describe("collection cost follows the number of snapshots, never the number of journal events (#4355)", () => {
	test("a hundredfold longer history costs a collection the same statements and rows, while a full scan grows with it", async () => {
		const short = await history("short", 16, 200);
		const long = await history("long", 16, 20_000);
		const measured = [];
		for (const fixture of [short, long]) {
			const fullScan = await fixture.measure(() =>
				fullScanRetainedHashes(fixture.shared.journal, fixture.shared.sessions),
			);
			const collection = await fixture.measure(() => collectSnapshotGarbage(fixture.shared.journal.snapshotBlobs));
			measured.push({ fullScan, collection });
		}
		const [before, after] = measured as [(typeof measured)[0], (typeof measured)[0]];

		// The full scan the reference index replaces reads every event and entry: 40,027 rows at 20,000 events, with
		// the schema version rows the session listing and load check (#5065); the load reads its entries in growing batches.
		assert.equal(before.fullScan.rows, 427);
		assert.equal(after.fullScan.rows, 40_027);
		// At either length, collection checks the index twice and reads one page of the 16 aged blobs. It keeps the 8 the
		// failed run retains, walks the one session that names 4 of the other 8 and keeps the 1 its latest snapshot
		// retains, and deletes the other 7 in one batch, which walks that session again in one statement of its transaction.
		for (const { collection } of measured) {
			assert.deepEqual(summary(collection), {
				statements:
					2 * INDEX_CHECK.statements + AGE_CHECK.statements + PAGE.statements + WALK.statements + BATCH.statements,
				rows: 2 * INDEX_CHECK.rows + AGE_CHECK.rows + (16 + 8 + 4) + (1 + 1) + (0 + 7),
				transactions: 1,
			});
			assert.equal(collection.result.deleted.length, 7);
		}
		assert.deepEqual(
			after.collection.statements.map((statement) => [statement.sql, statement.rows]),
			before.collection.statements.map((statement) => [statement.sql, statement.rows]),
		);
		for (const statement of after.collection.statements) {
			assert.doesNotMatch(statement.sql, HISTORY_TABLES);
			for (const detail of await queryPlan(long.shared, statement))
				assert.doesNotMatch(detail, SCANS_OF_INDEX_STRUCTURES, `${statement.sql}\n${detail}`);
		}
	});

	test("a session tree with two branches and a hundredfold more messages costs a collection the same statements and rows", async () => {
		const costs = [];
		for (const messages of [200, 20_000]) {
			const counted = countingDatabase(await openNodeSqliteDatabase(join(directory, `tree-${messages}.sqlite`)));
			const shared = await openSharedSnapshotDatabase("", { database: counted.wrapped });
			opened.push(shared);
			const [early, left, right, orphan] = ["early", "left", "right", "orphan"].map((name) => textBlob(name));
			await shared.journal.snapshotBlobs.putBlobs([early!, left!, right!, orphan!]);
			const root = messageEntry("start");
			const base = snapshotEntry("/repo", "early", syntheticSnapshot("early", [early!.hash]), root.id);
			const leftEntry = snapshotEntry("/repo", "left", syntheticSnapshot("left", [left!.hash]), base.id);
			const rightEntry = snapshotEntry("/repo", "right", syntheticSnapshot("right", [right!.hash]), base.id);
			await createSession(shared.sessions, "session-1", [root, base, leftEntry, rightEntry]);
			await shared.database.run(
				`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				INSERT INTO session_entries (session_id, seq, entry_id, entry_json) SELECT 'session-1', 4 + i, 'chat-' || i,
					json_object('type', 'message', 'id', 'chat-' || i, 'parentId', CASE WHEN i = 1 THEN ? ELSE 'chat-' || (i - 1) END) FROM n`,
				messages,
				leftEntry.id,
			);
			await ageBlobs(shared.database, shared.journal.snapshotBlobs.table, 10_000);
			counted.statements.length = 0;
			counted.counts.transactions = 0;

			const { deleted } = await collectSnapshotGarbage(shared.journal.snapshotBlobs);

			assert.deepEqual([...deleted].sort(), [early!.hash, orphan!.hash].sort(), "only what no leaf's branch needs");
			costs.push({
				statements: counted.statements.length,
				rows: counted.statements.reduce((sum, statement) => sum + statement.rows, 0),
				transactions: counted.counts.transactions,
			});
		}
		assert.deepEqual(costs[0], costs[1]);
	});

	test("collection rows grow with the number of snapshots, a page of statements per 256 aged blobs", async () => {
		const few = await history("few", 16, 200);
		const many = await history("many", 600, 200);

		const small = await few.measure(() => collectSnapshotGarbage(few.shared.journal.snapshotBlobs));
		const large = await many.measure(() => collectSnapshotGarbage(many.shared.journal.snapshotBlobs));

		assert.deepEqual(summary(small), {
			statements:
				2 * INDEX_CHECK.statements + AGE_CHECK.statements + PAGE.statements + WALK.statements + BATCH.statements,
			rows: 2 * INDEX_CHECK.rows + AGE_CHECK.rows + (16 + 8 + 4) + (1 + 1) + (0 + 7),
			transactions: 1,
		});
		assert.equal(large.result.deleted.length, 150 + 149);
		// Three pages hold the 600 aged blobs: 300 of them the failed run keeps, and the one session names 150 of the
		// other 300. The 299 the rest leaves are deleted in batches of at most SNAPSHOT_COLLECTION_DELETE_BATCH, a page's
		// last batch possibly smaller.
		const pages = Math.ceil(600 / SNAPSHOT_COLLECTION_BATCH);
		const deletes = large.statements.filter((statement) => statement.sql.startsWith("DELETE"));
		const batches = deletes.length;
		assert.ok(deletes.every((statement) => statement.rows <= SNAPSHOT_COLLECTION_DELETE_BATCH));
		assert.ok(batches >= Math.ceil(299 / SNAPSHOT_COLLECTION_DELETE_BATCH));
		assert.ok(batches <= Math.ceil(299 / SNAPSHOT_COLLECTION_DELETE_BATCH) + pages - 1);
		// Each batch checks the index, finds the blobs of the batch it keeps (none) and deletes, in its transaction. The
		// session is walked once to nominate; then one statement of each batch's transaction walks the sessions the sweep
		// walked for the batch's blobs: that session, or none for a batch of blobs no session names (#5530).
		const walks = large.statements.filter((statement) => statement.sql.includes("open_anchors(")).length;
		assert.equal(walks, 1 + batches);
		assert.deepEqual(summary(large), {
			statements:
				INDEX_CHECK.statements +
				AGE_CHECK.statements +
				pages * PAGE.statements +
				WALK.statements +
				batches * (INDEX_CHECK.statements + BATCH.statements),
			rows: INDEX_CHECK.rows + AGE_CHECK.rows + (600 + 300 + 150) + (1 + 1) + batches * INDEX_CHECK.rows + 299,
			transactions: batches,
		});
	});

	test("with nothing old enough to collect, a collection reads no blob rows, takes no write lock and deletes nothing", async () => {
		const fixture = await history("fresh", 16, 200);
		await fixture.shared.database.run(
			`UPDATE ${fixture.shared.journal.snapshotBlobs.table} SET created_at = unixepoch()`,
		);

		const fresh = await fixture.measure(() => collectSnapshotGarbage(fixture.shared.journal.snapshotBlobs));

		assert.deepEqual(summary(fresh), {
			statements: INDEX_CHECK.statements + 1 + AGE_CHECK.statements,
			rows: INDEX_CHECK.rows + AGE_CHECK.rows,
			transactions: 0,
		});
		assert.deepEqual(fresh.result.deleted, []);
	});
});
