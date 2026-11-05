import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteRow,
	SqliteStatement,
} from "../../packages/coding-agent/src/core/storage/database.ts";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.ts";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import type { WorktreeSnapshot } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease, RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import { serializeJson } from "../../packages/workflows/src/durable/journal/values.js";
import { countingDatabase } from "../helpers/counting-database.js";
import {
	ageBlobs,
	checkpointEvent,
	createSession,
	fullScanRetainedHashes,
	messageEntry,
	type RunStatusPayload,
	snapshotEntry,
	startRun,
	statusEvent,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";

let directory: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-index-parity-"));
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()?.();
	rmSync(directory, { recursive: true, force: true });
});

/** A database whose writes of several statements go out as one `batch`, as libSQL's do. */
function batching(database: SqliteDatabase): SqliteDatabase {
	return {
		descriptor: database.descriptor,
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: (sql, ...params) => database.get(sql, ...params),
		all: (sql, ...params) => database.all(sql, ...params),
		transaction: (callback, options) => database.transaction(callback, options),
		close: () => database.close(),
		batch: (statements: readonly SqliteStatement[]) =>
			database.transaction(async (transaction) => {
				const rows: SqliteRow[][] = [];
				for (const statement of statements) rows.push(await transaction.all(statement.sql, ...statement.params));
				return rows;
			}),
	};
}

/** A deterministic generator, so a failing seed reproduces. */
function random(seed: number) {
	let state = seed >>> 0 || 1;
	const next = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
	return {
		int: (bound: number) => Math.floor(next() * bound),
		pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
		chance: (probability: number) => next() < probability,
	};
}

const STATUSES: readonly RunStatusPayload[] = [
	{ status: "running" },
	{ status: "paused" },
	{ status: "failed" },
	{ status: "blocked" },
	{ status: "completed" },
	{ status: "cancelled" },
	{ status: "killed" },
	{ status: "failed", resumable: false },
	{ status: "running", resumable: false },
	{ status: "failed", rootWorkflowId: "another-root" },
	{ status: "blocked", rootWorkflowId: null },
];

type AppendPath = "append" | "appendMany" | "batch" | "raw";

async function writeRandomHistory(seed: number) {
	const rng = random(seed);
	const database = await openNodeSqliteDatabase(join(directory, `parity-${seed}.sqlite`));
	const batchDatabase = batching(await openNodeSqliteDatabase(join(directory, `parity-${seed}.sqlite`)));
	const { SqlSessionStore } = await import(
		"../../packages/coding-agent/src/core/storage/session/sql-session-store.ts"
	);
	const sessions = await SqlSessionStore.open(database);
	const journal = await SqlRunJournal.open(database);
	const batchJournal = await SqlRunJournal.open(batchDatabase);
	closers.push(async () => {
		await batchJournal.close();
		await journal.close();
		await sessions.close();
		await batchDatabase.close();
		await database.close();
	});
	const blobs = Array.from({ length: 40 }, (_, index) => textBlob(`blob-${seed}-${index}`));
	await journal.snapshotBlobs.putBlobs(blobs);
	const hash = () => rng.pick(blobs).hash;
	const snapshot = (root = "/repo"): WorktreeSnapshot =>
		syntheticSnapshot(
			`snap-${rng.int(1_000_000)}`,
			Array.from({ length: 1 + rng.int(3) }, () => (rng.chance(0.2) ? null : hash())),
			{ root, ...(rng.chance(0.3) ? { bundle: hash() } : {}) },
		);
	const paths: Record<AppendPath, number> = { append: 0, appendMany: 0, batch: 0, raw: 0 };

	async function appendEvents(lease: Lease, events: readonly RunEvent[]): Promise<void> {
		const path = rng.pick<AppendPath>(["append", "appendMany", "batch", "raw"]);
		paths[path]++;
		if (path === "append") for (const event of events) await journal.append(lease, event);
		else if (path === "appendMany" || path === "batch") {
			const target = path === "batch" ? batchJournal : journal;
			const results = await target.appendMany(
				lease,
				events.map((event) => ({ event, context: <T>(read: () => T) => read() })),
			);
			for (const result of results) assert.equal(result.status, "fulfilled");
		} else {
			for (const event of events) {
				const row = await database.get<SqliteRow & { seq: number }>(
					"SELECT COALESCE(MAX(seq), 0) AS seq FROM wf_events WHERE run_id = ?",
					lease.runId,
				);
				await database.run(
					"INSERT INTO wf_events VALUES (?, ?, ?, ?, ?, ?, ?)",
					lease.runId,
					Number(row!.seq) + 1,
					lease.epoch,
					null,
					event.type,
					serializeJson(event.payload),
					Date.now(),
				);
			}
		}
	}

	const runs = Array.from({ length: 6 + rng.int(6) }, (_, index) => `run-${index}`);
	for (const runId of runs) {
		const lease = await startRun(journal, runId, rng.pick(["running", "failed", "completed", "cancelled"]));
		if (rng.chance(0.7)) await appendEvents(lease, [statusEvent(runId, { status: "running" }, "RunStarted")]);
		for (let step = 0; step < 2 + rng.int(6); step++) {
			const events: RunEvent[] = [];
			for (let index = 0; index < 1 + rng.int(3); index++) {
				if (rng.chance(0.6))
					events.push(
						checkpointEvent(
							Array.from({ length: rng.int(3) }, () => snapshot()),
							rng.pick(["tool", "stage", "tool", "ui", "task"] as const),
						),
					);
				else if (rng.chance(0.8)) events.push(statusEvent(runId, rng.pick(STATUSES)));
				else
					events.push({
						type: "StatusChanged",
						payload: { status: rng.pick(STATUSES).status },
					} as unknown as RunEvent);
			}
			await appendEvents(lease, events);
		}
	}
	for (const runId of runs) if (rng.chance(0.2)) await journal.deleteRun(runId);

	const roots = ["/a", "/b", "/c"];
	const sessionIds = Array.from({ length: 4 + rng.int(4) }, (_, index) => `session-${index}`);
	const recorded: WorktreeSnapshot[] = [];
	const sessionEntries = () =>
		Array.from({ length: 1 + rng.int(5) }, () => {
			if (rng.chance(0.25)) return messageEntry("hello");
			const root = rng.pick(roots);
			if (recorded.length > 0 && rng.chance(0.3)) {
				const earlier = rng.pick(recorded);
				return snapshotEntry(earlier.root, earlier.id);
			}
			const record = snapshot(root);
			recorded.push(record);
			return snapshotEntry(root, record.id, record);
		});
	for (const sessionId of sessionIds) {
		let { lastSeq } = await createSession(sessions, sessionId, sessionEntries());
		for (let write = 0; write < rng.int(4); write++) {
			if (rng.chance(0.25)) {
				const { header } = await sessions.load(sessionId);
				({ lastSeq } = await sessions.replace(sessionId, header, sessionEntries(), { expectSeq: lastSeq }));
			} else ({ lastSeq } = await sessions.append(sessionId, sessionEntries(), { expectSeq: lastSeq }));
		}
		if (rng.chance(0.2)) await sessions.delete(sessionId);
	}
	return { database, sessions, journal, blobs, paths };
}

describe("the reference index keeps exactly what a full scan of every journal and session retains (#4355)", () => {
	test.each(Array.from({ length: 24 }, (_, index) => index + 1))(
		"random history %i, written through single appends, savepoint and batched appendMany, raw inserts, and every session write",
		async (seed) => {
			const { database, sessions, journal, blobs, paths } = await writeRandomHistory(seed);
			const expected = await fullScanRetainedHashes(journal, sessions);
			await ageBlobs(database, journal.snapshotBlobs.table, 10_000);

			const { deleted } = await collectSnapshotGarbage(journal.snapshotBlobs);

			const remaining = new Set(await journal.snapshotBlobs.listBlobHashes());
			assert.deepEqual([...remaining].sort(), [...expected].sort());
			assert.deepEqual(
				[...deleted].sort(),
				blobs
					.map((blob) => blob.hash)
					.filter((hash, index, all) => !expected.has(hash) && all.indexOf(hash) === index)
					.sort(),
			);
			assert.ok(Object.values(paths).reduce((sum, count) => sum + count, 0) > 0);
		},
	);

	test("across the seeds every write path was exercised and both kept and collected blobs occurred", async () => {
		const totals: Record<AppendPath, number> = { append: 0, appendMany: 0, batch: 0, raw: 0 };
		let kept = 0;
		let collected = 0;
		for (const seed of [1, 2, 3, 4]) {
			const { database, sessions, journal, paths } = await writeRandomHistory(seed);
			for (const path of Object.keys(totals) as AppendPath[]) totals[path] += paths[path];
			kept += (await fullScanRetainedHashes(journal, sessions)).size;
			await ageBlobs(database, journal.snapshotBlobs.table, 10_000);
			collected += (await collectSnapshotGarbage(journal.snapshotBlobs)).deleted.length;
		}
		for (const [path, count] of Object.entries(totals)) assert.ok(count > 0, `${path} was never used`);
		assert.ok(kept > 0 && collected > 0, `kept ${kept}, collected ${collected}`);
	});
});

test("a checkpoint payload SQLite cannot parse is stored and references nothing, so a write never fails on the index", async () => {
	const database = await openNodeSqliteDatabase(join(directory, "malformed.sqlite"));
	const journal = await SqlRunJournal.open(database);
	closers.push(async () => {
		await journal.close();
		await database.close();
	});
	const lease = await startRun(journal, "run-1");
	await database.run(
		"INSERT INTO wf_events VALUES (?, 2, ?, NULL, 'CheckpointRecorded', ?, 0)",
		"run-1",
		lease.epoch,
		'{"kind":"tool","worktreeSnapshots":[{"chain":[{"patch":"x"}',
	);
	await journal.append(lease, {
		type: "CheckpointRecorded",
		payload: {
			kind: "tool",
			worktreeSnapshots: [{ chain: "not a list", bundle: 7 }, 3, { chain: [5, { patch: 9 }] }],
		},
	} as unknown as RunEvent);
	assert.deepEqual(await database.all("SELECT * FROM snapshot_run_refs"), []);
});

test("reopening a session store and run journal finds their index triggers and creates none (#4355)", async () => {
	const { SqlSessionStore } = await import(
		"../../packages/coding-agent/src/core/storage/session/sql-session-store.ts"
	);
	const path = join(directory, "reopen.sqlite");
	const opens = [];
	for (let attempt = 0; attempt < 2; attempt++) {
		const counted = countingDatabase(await openNodeSqliteDatabase(path));
		const sessions = await SqlSessionStore.open(counted.wrapped);
		const journal = await SqlRunJournal.open(counted.wrapped);
		opens.push(counted.statements.filter((statement) => statement.sql.includes("CREATE TRIGGER")).length);
		closers.push(async () => {
			await journal.close();
			await sessions.close();
			await counted.wrapped.close();
		});
	}
	const database = await openNodeSqliteDatabase(path);
	closers.push(() => database.close());

	assert.deepEqual(opens, [2, 0], "the first open creates both trigger sets, the second finds them");
	assert.deepEqual(
		(
			await database.all<{ name: string; tbl_name: string }>(
				"SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '%snapshot%' ORDER BY name",
			)
		).map((row) => [row.name, row.tbl_name]),
		[
			["session_entries_snapshot_refs", "session_entries"],
			["session_entries_snapshot_refs_delete", "session_entries"],
			["wf_events_snapshot_refs", "wf_events"],
			["wf_events_snapshot_state", "wf_events"],
			["wf_runs_snapshot_refs_delete", "wf_runs"],
			["wf_runs_snapshot_state_insert", "wf_runs"],
			["wf_runs_snapshot_state_status", "wf_runs"],
		],
	);
});
