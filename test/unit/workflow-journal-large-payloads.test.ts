import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "vitest";
import type {
	SqliteDatabase,
	SqliteRow,
	SqliteStatement,
} from "../../packages/coding-agent/src/core/storage/database.js";
import {
	JournalAdoptError,
	StorageError,
	StorageSchemaVersionError,
} from "../../packages/coding-agent/src/core/storage/errors.js";
import {
	adoptJournals,
	consolidateJournalStore,
	ensureRunJournalSchema,
	inspectJournalFile,
} from "../../packages/coding-agent/src/core/storage/journal-adoption.js";
import { JournalCatalog } from "../../packages/coding-agent/src/core/storage/journal-catalog.js";
import { STORED_JSON_CHUNK_BYTES } from "../../packages/coding-agent/src/core/storage/journal-event-payloads.js";
import { exportWorkflowRuns } from "../../packages/coding-agent/src/core/storage/journal-transfer.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { RUN_EVENT_TYPES, type RunEvent } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Journal events, pool inputs and pool results longer than one chunk (#4965), through the paths the backend matrix in
 * test/integration/workflow-large-events-sqld.test.ts does not reach on a SQLite file: batched appends, consolidation,
 * export, schema checks, pool identity checks and corrupt chunks.
 */

const MB = 1_000_000;
let root: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	root = makeTempDirectory("journal-large-payloads-");
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()!();
	removeTempDirectory(root);
});

function text(bytes: number, seed = "a"): string {
	return `${seed}é😀`.repeat(Math.ceil(bytes / 7));
}

function checkpoint(id: string, output: string): RunEvent {
	return { type: RUN_EVENT_TYPES.checkpointRecorded, payload: { kind: "tool", checkpointId: id, output } } as RunEvent;
}

function raw(path: string, sql: string): void {
	const database = new DatabaseSync(path);
	try {
		database.exec(sql);
	} finally {
		database.close();
	}
}

/** The most bytes of UTF-8 the payload of one events row of the file at `path` holds. */
function longestPayload(path: string): number {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		return Number(
			database.prepare("SELECT max(length(CAST(payload AS BLOB))) AS longest FROM wf_events").get()?.longest ?? 0,
		);
	} finally {
		database.close();
	}
}

/** A database whose `batch` runs its statements in one transaction, as a libSQL server's one request does. */
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
			database.transaction(async (tx) => {
				const rows: SqliteRow[][] = [];
				for (const statement of statements) rows.push(await tx.all(statement.sql, ...statement.params));
				return rows;
			}),
	};
}

test("a batched appendMany stores a large event in chunks, not in one request's row (#4965)", async () => {
	const path = join(root, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	closers.push(() => database.close());
	const journal = await SqlRunJournal.open(batching(database));
	closers.push(() => journal.close());
	await journal.createRun({ runId: "run", name: "run", cwd: "/repo", createdAt: 1, status: "running" });
	const acquired = await journal.acquire("run", "holder");
	assert.equal(acquired.status, "acquired");
	if (acquired.status !== "acquired") return;
	const large = checkpoint("large", text(2 * MB));
	const small = checkpoint("small", "x");
	const settled = await journal.appendMany(acquired.lease, [
		{ event: small, key: "small", context: (read) => read() },
		{ event: large, key: "large", context: (read) => read() },
	]);
	assert.deepEqual(
		settled.map((result) => result.status),
		["fulfilled", "fulfilled"],
	);
	assert.ok(longestPayload(path) <= STORED_JSON_CHUNK_BYTES, "no events row holds more than one chunk");
	assert.deepEqual((await journal.readKey("run", "large"))?.event, large);
	// A batch whose appends are all short still goes as one request and reads back.
	await journal.appendMany(acquired.lease, [
		{ event: checkpoint("short", "y"), key: "short", context: (read) => read() },
	]);
	assert.deepEqual((await journal.readKey("run", "short"))?.event, checkpoint("short", "y"));
});

test("a batched appendMany still checks each pool append guard, so a guarded append never goes as one request (#4965)", async () => {
	const database = await openNodeSqliteDatabase(join(root, "guarded.sqlite"));
	closers.push(() => database.close());
	const journal = await SqlRunJournal.open(batching(database));
	closers.push(() => journal.close());
	await journal.createRun({ runId: "run", name: "run", cwd: "/repo", createdAt: 1, status: "running" });
	const acquired = await journal.acquire("run", "holder");
	if (acquired.status !== "acquired") assert.fail("no lease");
	const refused = new Error("the attempt no longer holds its work");
	const settled = await sqlPoolStorage(journal)!.withAppendGuard(
		async () => {
			throw refused;
		},
		() =>
			journal.appendMany(acquired.lease, [
				{
					event: { type: RUN_EVENT_TYPES.messageQueued, payload: { id: "m" } } as RunEvent,
					context: (read) => read(),
				},
			]),
	);
	assert.deepEqual(settled, [{ status: "rejected", reason: refused }]);
});

test("a run journal's schema is created, upgraded from version 1, and refused when newer or ambiguous (#4965)", async () => {
	const database = await openNodeSqliteDatabase(":memory:");
	closers.push(() => database.close());
	const version = async () => Number((await database.get("SELECT schema_version FROM wf_meta"))?.schema_version);
	await database.transaction((tx) => ensureRunJournalSchema(tx));
	assert.equal(await version(), 2);
	await database.run("UPDATE wf_meta SET schema_version = 1");
	await database.transaction((tx) => ensureRunJournalSchema(tx));
	assert.equal(await version(), 2, "a journal of version 1 is upgraded");
	await database.run("UPDATE wf_meta SET schema_version = 3");
	await assert.rejects(
		database.transaction((tx) => ensureRunJournalSchema(tx)),
		(error: unknown) => {
			assert.ok(error instanceof StorageSchemaVersionError);
			assert.deepEqual([error.domain, error.found, error.supported], ["journal", 3, 2]);
			return true;
		},
	);
	await database.run("UPDATE wf_meta SET schema_version = 2");
	await database.run("INSERT INTO wf_meta VALUES (2)");
	await assert.rejects(
		database.transaction((tx) => ensureRunJournalSchema(tx)),
		(error: unknown) => error instanceof StorageSchemaVersionError && error.found === "2 rows",
	);
});

test("a pre-0.9.38 journal is adoptable only at its own schema version, 1 (#4965)", async () => {
	const path = join(root, "legacy.sqlite");
	raw(
		path,
		`CREATE TABLE meta(schema_version INTEGER NOT NULL);
		CREATE TABLE runs(run_id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, header_json TEXT NOT NULL);
		CREATE TABLE events(run_id TEXT NOT NULL, seq INTEGER NOT NULL, epoch INTEGER NOT NULL, key TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(run_id, seq));
		INSERT INTO meta VALUES (1);`,
	);
	assert.deepEqual((await inspectJournalFile(path)).runs, []);
	raw(path, "UPDATE meta SET schema_version = 2");
	await assert.rejects(inspectJournalFile(path), (error: unknown) => {
		assert.ok(error instanceof JournalAdoptError);
		assert.deepEqual([error.code, error.fields.found], ["schema-version", 2]);
		return true;
	});
});

test("an export skips a journal of a newer schema version, and reads a large event whole (#4965)", async () => {
	const path = join(root, "journal.sqlite");
	const journal = await openSqlRunJournal(path);
	await journal.createRun({ runId: "run", name: "run", cwd: "/repo", createdAt: 1, status: "completed" });
	const acquired = await journal.acquire("run", "holder");
	if (acquired.status !== "acquired") assert.fail("no lease");
	const large = checkpoint("large", text(2 * MB));
	await journal.append(acquired.lease, large, { key: "large" });
	await journal.release(acquired.lease);
	await journal.close();

	const exported = await exportWorkflowRuns({ kind: "sqlite", path }, join(root, "export"));
	assert.equal(exported.written.length, 1);
	assert.deepEqual(exported.skipped, []);

	raw(path, "UPDATE wf_meta SET schema_version = 3");
	const refused = await exportWorkflowRuns({ kind: "sqlite", path }, join(root, "refused"));
	assert.deepEqual(refused.written, []);
	assert.deepEqual(
		refused.skipped.map((skip) => skip.reason),
		["unsupported journal schema version 3"],
	);
});

test("consolidation moves a large event whole and leaves no chunk behind, from a journal of either version (#4965)", async () => {
	const store = join(root, "workflows", "journal");
	const large = checkpoint("large", text(2 * MB));
	const paths: string[] = [];
	for (const [index, runId] of ["chunked", "unchunked"].entries()) {
		const path = join(root, `source-${index}`, "journal.sqlite");
		mkdirSync(join(path, ".."), { recursive: true });
		const journal = await openSqlRunJournal(path);
		await journal.createRun({ runId, name: runId, cwd: "/repo", createdAt: 1, status: "completed" });
		const acquired = await journal.acquire(runId, "holder");
		if (acquired.status !== "acquired") assert.fail("no lease");
		await journal.append(acquired.lease, runId === "chunked" ? large : checkpoint("small", "x"), { key: "event" });
		await journal.release(acquired.lease);
		await journal.close();
		paths.push(path);
	}
	// The second source as a build before chunks left it: no chunk table, no chunks column, version 1.
	raw(
		paths[1]!,
		"DROP TABLE wf_event_chunks; ALTER TABLE wf_events DROP COLUMN chunks; UPDATE wf_meta SET schema_version = 1;",
	);
	await adoptJournals(store, paths);
	const report = await consolidateJournalStore(store);
	assert.deepEqual(report.runs.map((run) => [run.runId, run.outcome]).sort(), [
		["chunked", "moved"],
		["unchunked", "moved"],
	]);
	const source = new DatabaseSync(paths[0]!, { readOnly: true });
	try {
		assert.equal(Number(source.prepare("SELECT count(*) AS count FROM wf_event_chunks").get()?.count), 0);
	} finally {
		source.close();
	}
	const catalog = await JournalCatalog.open(store);
	const located = await catalog.locate("chunked").finally(() => catalog.close());
	const target = await openSqlRunJournal(located!.shard.path);
	closers.push(() => target.close());
	assert.deepEqual((await target.readKey("chunked", "event"))?.event, large);
	assert.ok(longestPayload(located!.shard.path) <= STORED_JSON_CHUNK_BYTES);
});

async function poolFixture() {
	const path = join(root, "pool.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	closers.push(async () => {
		await backend.close();
		await journal.close();
		await database.close();
	});
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire("root", backend.holderId);
	if (acquired.status !== "acquired") assert.fail("no root lease");
	const { work: fixture, boundary } = poolWorkFixture();
	const inputs = { text: text(2 * MB, "i") };
	const work = { ...fixture, inputs };
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(acquired.lease, 60_000);
	await pool.enqueue(acquired.lease, work, boundary);
	const attempt = await pool.claim(acquired.lease, "worker", [work], 60_000);
	assert.ok(attempt);
	const run = { ...boundary.topology!.boundary!.child };
	const step = (index: number, output: string): DurableToolCheckpoint => ({
		kind: "tool",
		workflowId: "root",
		checkpointId: `${work.scope}:tool:${index}`,
		name: "tool",
		argsHash: `${work.scope}:args:${index}`,
		output,
		completedAt: 1,
		topology: { version: 1, nodeId: `tool-${index}`, parentIds: [], ordinal: index, order: index, run },
	});
	return { path, database, journal, pool, attempt, lease: acquired.lease, work, inputs, step };
}

test("a large pooled checkpoint is the same checkpoint under another operation, and a new queue validates past it (#4965)", async () => {
	const f = await poolFixture();
	const large = f.step(1, text(2 * MB, "s"));
	const receipt = await f.pool.commit(f.lease, f.attempt, "first", { kind: "checkpoint", checkpoint: large });
	assert.deepEqual(
		(await f.pool.commit(f.lease, f.attempt, "second", { kind: "checkpoint", checkpoint: large })).seq,
		receipt.seq,
		"the recorded checkpoint is compared whole, not as its stub",
	);
	await assert.rejects(
		f.pool.commit(f.lease, f.attempt, "third", {
			kind: "checkpoint",
			checkpoint: { ...large, output: text(2 * MB, "t") },
		}),
		/identity conflict/,
	);
	// A queue that has not read the root reads its checkpoints, the large one's chunks included, to validate.
	const fresh = await openSqlPoolQueue(f.journal);
	const next = await fresh.commit(f.lease, f.attempt, "next", { kind: "checkpoint", checkpoint: f.step(2, "small") });
	assert.ok(next.seq! > receipt.seq!);
});

test("a large pool result completes once, is reopened whole, and a different one conflicts (#4965)", async () => {
	const f = await poolFixture();
	const result = { runId: f.work.childRunId, result: text(2 * MB, "r") };
	await f.pool.complete(f.lease, f.attempt, result);
	await assert.rejects(
		f.pool.complete(f.lease, f.attempt, { runId: f.work.childRunId, result: text(2 * MB, "x") }),
		/Pool result identity conflict/,
	);
	assert.deepEqual(await f.pool.result("root", f.attempt.id), result);

	await f.journal.release(f.lease);
	const next = await f.journal.acquire("root", "next-holder");
	if (next.status !== "acquired") assert.fail("no second lease");
	const seen: unknown[] = [];
	assert.equal(
		await f.pool.reopenCompleted(next.lease, f.attempt.id, (stored) => {
			seen.push(stored);
			return false;
		}),
		undefined,
	);
	assert.deepEqual(seen, [result], "the rerun decision sees the whole result");
	const reopened = await f.pool.reopenCompleted(next.lease, f.attempt.id, () => true);
	assert.equal(reopened?.state, "ready");
	assert.deepEqual(reopened?.inputs, f.inputs, "reopened work carries its whole inputs");
	assert.equal(await f.pool.result("root", f.attempt.id), undefined);
});

test("a missing chunk of pool inputs or of a pool result is a storage error naming the work (#4965)", async () => {
	const f = await poolFixture();
	await f.pool.complete(f.lease, f.attempt, { runId: f.work.childRunId, result: text(2 * MB, "r") });
	await f.database.run("DELETE FROM wf_runs_work_result_chunks WHERE idx = 1");
	await assert.rejects(f.pool.result("root", f.attempt.id), (error: unknown) => {
		assert.ok(error instanceof StorageError);
		assert.match(error.message, new RegExp(`^Pool work ${f.attempt.id} result is missing chunk 1 of \\d+$`));
		return true;
	});
	await f.journal.release(f.lease);
	const next = await f.journal.acquire("root", "next-holder");
	if (next.status !== "acquired") assert.fail("no second lease");
	await f.database.run("DELETE FROM wf_runs_work_input_chunks WHERE idx = 1");
	await assert.rejects(f.pool.enqueue(next.lease, f.work, poolWorkFixture().boundary), (error: unknown) => {
		assert.ok(error instanceof StorageError);
		assert.match(error.message, new RegExp(`^Pool work ${f.attempt.id} inputs is missing chunk 1 of \\d+$`));
		return true;
	});
});

test("a pool of the previous schema version is upgraded, and a newer one refused (#4965)", async () => {
	const f = await poolFixture();
	const version = async () => Number((await f.database.get("SELECT version FROM wf_runs_pool_meta"))?.version);
	assert.equal(await version(), 3);
	await f.database.run("UPDATE wf_runs_pool_meta SET version = 2");
	await openSqlPoolQueue(f.journal);
	assert.equal(await version(), 3, "a pool of version 2 is upgraded");
	await f.database.run("UPDATE wf_runs_pool_meta SET version = 4");
	await assert.rejects(openSqlPoolQueue(f.journal), (error: unknown) => {
		assert.ok(error instanceof StorageSchemaVersionError);
		assert.deepEqual([error.domain, error.found, error.supported], ["journal", 4, 3]);
		return true;
	});
});

test("pre-0.9.38 runs are read in place only from tables of schema version 1, their snapshot tail included (#4965)", async () => {
	const path = join(root, "legacy-runs.sqlite");
	raw(
		path,
		`CREATE TABLE meta(schema_version INTEGER NOT NULL);
		INSERT INTO meta VALUES (1);
		CREATE TABLE runs(run_id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, header_json TEXT NOT NULL);
		CREATE TABLE events(run_id TEXT NOT NULL, seq INTEGER NOT NULL, epoch INTEGER NOT NULL, key TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(run_id, seq), UNIQUE(run_id, key));
		CREATE TABLE leases(run_id TEXT PRIMARY KEY, holder_id TEXT, epoch INTEGER NOT NULL, renewed_at INTEGER NOT NULL);
		INSERT INTO runs VALUES ('old', 'old', '/repo', 1, 'failed', '{"runId":"old","name":"old","cwd":"/repo","createdAt":1,"status":"failed"}');
		INSERT INTO events VALUES ('old', 1, 1, NULL, 'RunStarted', '{"workflowId":"old"}', 5);`,
	);
	const listed = async () => {
		const journal = await openSqlRunJournal(path);
		try {
			return {
				runs: (await journal.listRuns()).map((run) => run.runId),
				tail: (await journal.snapshotTail("old"))?.snapshot.event,
			};
		} finally {
			await journal.close();
		}
	};
	assert.deepEqual(await listed(), {
		runs: ["old"],
		tail: { type: RUN_EVENT_TYPES.runStarted, payload: { workflowId: "old" } },
	});
	raw(path, "INSERT INTO meta VALUES (1)");
	assert.deepEqual(await listed(), { runs: [], tail: undefined }, "tables with two schema versions are not either");
	raw(path, "DELETE FROM meta; INSERT INTO meta VALUES (2)");
	assert.deepEqual(
		await listed(),
		{ runs: [], tail: undefined },
		"tables of another version are not a pre-0.9.38 journal",
	);
});
