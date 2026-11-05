import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import type { CountedStatement } from "../helpers/counting-database.js";
import { countingDatabase } from "../helpers/counting-database.js";
import {
	ageBlobs,
	checkpointEvent,
	createSession,
	fullScanRetainedHashes,
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
			INSERT INTO wf_events SELECT ?, (SELECT MAX(seq) FROM wf_events WHERE run_id = ?) + i, ?, NULL,
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
		INSERT INTO session_entries SELECT 'session-1', ? + i, 'padding-' || i,
			json_object('type', 'message', 'id', 'padding-' || i) FROM n`,
		events,
		sessionBlobs.length,
	);
	await ageBlobs(shared.database, shared.journal.snapshotBlobs.table, 10_000);
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

async function queryPlan(shared: SharedSnapshotDatabase, statement: CountedStatement): Promise<string[]> {
	const rows = await shared.database.all<{ detail: string }>(
		`EXPLAIN QUERY PLAN ${statement.sql}`,
		...statement.params,
	);
	return rows.map((row) => row.detail);
}

/**
 * One check that the reference index is complete: which of the 3 referencing tables and 7 triggers exist (10 schema
 * rows) and how far each of the 3 sources is backfilled (3 rows). A collection makes one before it sweeps and one
 * inside each batch's own transaction.
 */
const INDEX_CHECK = { statements: 2, rows: 13 } as const;

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

		// The full scan the reference index replaces reads every event and entry: 40,025 rows at 20,000 events.
		assert.deepEqual(summary(before.fullScan), { statements: 7, rows: 425, transactions: 1 });
		assert.deepEqual(summary(after.fullScan), { statements: 85, rows: 40_025, transactions: 1 });
		// Collection checks the index twice, pages through the 7 aged blobs nothing retains and deletes them, in one
		// batch, at either length.
		for (const { collection } of measured) {
			assert.deepEqual(summary(collection), {
				statements: 2 * INDEX_CHECK.statements + 2,
				rows: 2 * INDEX_CHECK.rows + 7 + 7,
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
				assert.doesNotMatch(
					detail,
					/^SCAN (?!json_each|sqlite_schema|snapshot_index_sources)/u,
					`${statement.sql}\n${detail}`,
				);
		}
	});

	test("collection rows grow with the number of snapshots, a batch of statements per 256 blobs it deletes", async () => {
		const few = await history("few", 16, 200);
		const many = await history("many", 600, 200);

		const small = await few.measure(() => collectSnapshotGarbage(few.shared.journal.snapshotBlobs));
		const large = await many.measure(() => collectSnapshotGarbage(many.shared.journal.snapshotBlobs));

		assert.deepEqual(summary(small), {
			statements: 2 * INDEX_CHECK.statements + 2,
			rows: 2 * INDEX_CHECK.rows + 7 + 7,
			transactions: 1,
		});
		assert.equal(large.result.deleted.length, 150 + 149);
		assert.deepEqual(summary(large), {
			statements: INDEX_CHECK.statements + 2 * (INDEX_CHECK.statements + 2),
			rows: INDEX_CHECK.rows + 2 * INDEX_CHECK.rows + 299 + 299,
			transactions: 2,
		});
	});

	test("with nothing old enough to collect, a collection reads no blob rows and deletes nothing", async () => {
		const fixture = await history("fresh", 16, 200);
		await fixture.shared.database.run(
			`UPDATE ${fixture.shared.journal.snapshotBlobs.table} SET created_at = unixepoch()`,
		);

		const fresh = await fixture.measure(() => collectSnapshotGarbage(fixture.shared.journal.snapshotBlobs));

		assert.deepEqual(summary(fresh), {
			statements: 2 * INDEX_CHECK.statements + 1,
			rows: 2 * INDEX_CHECK.rows,
			transactions: 1,
		});
		assert.deepEqual(fresh.result.deleted, []);
	});

	test("publishing a snapshot reference costs a checkpoint append no statement beyond an append without one", async () => {
		const fixture = await history("writes", 4, 0);
		const lease = await startRun(fixture.shared.journal, "run-writes");
		const blob = textBlob("published");
		const plain = await fixture.measure(() => fixture.shared.journal.append(lease, checkpointEvent([])));
		const referencing = await fixture.measure(() =>
			fixture.shared.journal.append(lease, checkpointEvent([syntheticSnapshot("published", [blob.hash])])),
		);

		assert.deepEqual(
			referencing.statements.map((statement) => statement.sql),
			plain.statements.map((statement) => statement.sql),
		);
		assert.deepEqual(
			await fixture.shared.database.all("SELECT hash FROM snapshot_run_refs WHERE run_id = 'run-writes'"),
			[{ hash: blob.hash }],
		);
	});
});
