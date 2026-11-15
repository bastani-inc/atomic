import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "vitest";
import { STORED_JSON_CHUNK_BYTES } from "../../packages/coding-agent/src/core/storage/run-journal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	JournalSchemaVersionError,
	RUN_EVENT_TYPES,
	type RunEvent,
} from "../../packages/workflows/src/durable/journal/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * A process of an older build that opened a journal before this build upgraded it never reads the schema version again
 * (#4965, M8): it would read a payload stored in chunks as its stub. This build writes payloads whole while a live lease
 * holder or worker host detectably belongs to an older build, records its own build where a later one can check it, and
 * checks the schema version in every read and write, so that a later upgrade is safe against this build in turn.
 */

let root: string;
let path: string;
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
	root = makeTempDirectory("journal-live-older-");
	path = join(root, "journal.sqlite");
});
afterEach(async () => {
	while (closers.length > 0) await closers.pop()!();
	removeTempDirectory(root);
});

function sql(statement: string, ...params: (string | number | null)[]): Record<string, unknown>[] {
	const database = new DatabaseSync(path);
	try {
		return database.prepare(statement).all(...params) as Record<string, unknown>[];
	} finally {
		database.close();
	}
}

const large = (id: string): RunEvent =>
	({
		type: RUN_EVENT_TYPES.checkpointRecorded,
		payload: { kind: "tool", checkpointId: id, output: "x".repeat(2 * STORED_JSON_CHUNK_BYTES) },
	}) as RunEvent;

/** How the event under `key` of `run` is stored: in how many chunks, and how long its row's payload is. */
function stored(run: string, key: string): { chunks: number; length: number } {
	const [row] = sql("SELECT chunks, length(payload) AS length FROM wf_events WHERE run_id = ? AND key = ?", run, key);
	return { chunks: Number(row?.chunks), length: Number(row?.length) };
}

async function openWithRun(run = "run") {
	const journal = await openSqlRunJournal(path);
	closers.push(() => journal.close());
	await journal.createRun({ runId: run, name: run, cwd: "/repo", createdAt: 1, status: "running" });
	const acquired = await journal.acquire(run, "this-build");
	if (acquired.status !== "acquired") assert.fail("no lease");
	return { journal, lease: acquired.lease };
}

test("a large event is stored whole while another run's live lease holder is of an older build, in chunks once it is not (#4965)", async () => {
	const { journal, lease } = await openWithRun();
	// A lease granted by an older build: its row carries no record of the granting build.
	await journal.createRun({ runId: "older", name: "older", cwd: "/repo", createdAt: 1, status: "running" });
	sql(
		"INSERT INTO wf_leases(run_id, holder_id, epoch, renewed_at) VALUES ('older', 'older-build', 1, CAST(unixepoch('subsec') * 1000 AS INTEGER))",
	);
	await journal.append(lease, large("while-older"), { key: "while-older" });
	assert.deepEqual(stored("run", "while-older").chunks, 0, "stored whole, as the older build reads it");
	assert.deepEqual((await journal.readKey("run", "while-older"))?.event, large("while-older"));

	// An older build's lease that it stopped renewing is not live.
	sql("UPDATE wf_leases SET renewed_at = renewed_at - 600000 WHERE run_id = 'older'");
	await journal.append(lease, large("stale"), { key: "stale" });
	assert.ok(stored("run", "stale").chunks > 0, "stored in chunks");
	assert.ok(stored("run", "stale").length <= STORED_JSON_CHUNK_BYTES);

	// A lease this build granted carries its record, so it never counts as older, renewed or not.
	const other = await journal.createRun({
		runId: "mine",
		name: "mine",
		cwd: "/repo",
		createdAt: 1,
		status: "running",
	});
	assert.equal(other, "created");
	assert.equal((await journal.acquire("mine", "this-build-too")).status, "acquired");
	await journal.append(lease, large("mine"), { key: "mine" });
	assert.ok(stored("run", "mine").chunks > 0);
});

test("a large event is stored whole while a live worker host of an older build reports (#4965)", async () => {
	const { journal, lease } = await openWithRun();
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	closers.push(() => backend.close());
	const queue = await openSqlPoolQueue(journal);
	const shared = await SqlSharedPool.open(journal, queue);
	await shared.reportHost({
		host: "this-build-host",
		labels: {},
		git: "unavailable",
		restore: false,
		workers: 1,
		maxWorkers: 1,
		roots: [],
	});
	await journal.append(lease, large("new-host"), { key: "new-host" });
	assert.ok(stored("run", "new-host").chunks > 0, "a host of this build is not older");

	// An older host's report sets every column it knows of, and none recording its build.
	sql(
		"INSERT INTO wf_runs_pool_hosts(host, labels, git, restore, workers, max_workers, heartbeat_at) VALUES ('older-host', '{}', 'none', 0, 1, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER))",
	);
	await journal.append(lease, large("older-host"), { key: "older-host" });
	assert.equal(stored("run", "older-host").chunks, 0);
	sql("UPDATE wf_runs_pool_hosts SET heartbeat_at = heartbeat_at - 600000 WHERE host = 'older-host'");
	await journal.append(lease, large("gone-host"), { key: "gone-host" });
	assert.ok(stored("run", "gone-host").chunks > 0, "a host that stopped reporting is not live");
});

test("a journal opened before a later build upgraded it refuses every read and write after the upgrade (#4965)", async () => {
	const { journal, lease } = await openWithRun();
	await journal.append(lease, large("before"), { key: "before" });
	// A later build upgrades the journal while this process keeps it open.
	sql("UPDATE wf_meta SET schema_version = 3");
	const refused = (error: unknown) => {
		assert.ok(error instanceof JournalSchemaVersionError, String(error));
		assert.deepEqual([error.found, error.supported], [3, 2]);
		return true;
	};
	await assert.rejects(journal.readKey("run", "before"), refused);
	await assert.rejects(
		(async () => {
			for await (const _ of journal.read("run")) {
			}
		})(),
		refused,
	);
	await assert.rejects(journal.snapshotTail("run"), refused);
	await assert.rejects(journal.getRun("run"), refused);
	await assert.rejects(journal.append(lease, large("after"), { key: "after" }), refused);
	await assert.rejects(journal.renew(lease), refused);
	await assert.rejects(journal.acquire("run", "another"), refused);
	assert.equal(sql("SELECT count(*) AS count FROM wf_events WHERE key = 'after'")[0]?.count, 0, "nothing was written");
});

test("pool inputs and results stay whole while an older build is live, and an upgraded pool journal is refused (#4965)", async () => {
	const journal = await openSqlRunJournal(path);
	closers.push(() => journal.close());
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	closers.push(() => backend.close());
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire("root", backend.holderId);
	if (acquired.status !== "acquired") assert.fail("no root lease");
	await journal.createRun({ runId: "older", name: "older", cwd: "/repo", createdAt: 1, status: "running" });
	sql(
		"INSERT INTO wf_leases(run_id, holder_id, epoch, renewed_at) VALUES ('older', 'older-build', 1, CAST(unixepoch('subsec') * 1000 AS INTEGER))",
	);
	const { work: fixture, boundary } = poolWorkFixture();
	const inputs = { text: "i".repeat(2 * STORED_JSON_CHUNK_BYTES) };
	const work = { ...fixture, inputs };
	const queue = await openSqlPoolQueue(journal);
	await queue.initialize(acquired.lease, 60_000);
	await queue.enqueue(acquired.lease, work, boundary);
	assert.equal(
		Number(sql("SELECT inputs_chunks FROM wf_runs_work")[0]?.inputs_chunks),
		0,
		"inputs stay in the work row",
	);
	const attempt = await queue.claim(acquired.lease, "worker", [work], 60_000);
	assert.deepEqual(attempt?.inputs, inputs);
	const result = { runId: work.childRunId, result: "r".repeat(2 * STORED_JSON_CHUNK_BYTES) };
	await queue.complete(acquired.lease, attempt!, result);
	assert.equal(Number(sql("SELECT chunks FROM wf_runs_work_results")[0]?.chunks), 0, "the result stays in its row");
	assert.deepEqual(await queue.result("root", attempt!.id), result);

	sql("UPDATE wf_meta SET schema_version = 3");
	await assert.rejects(queue.inspect("root"), JournalSchemaVersionError);
	await assert.rejects(queue.result("root", attempt!.id), JournalSchemaVersionError);
	// Back at this build's version, so the backend's own writes as it closes go through.
	sql("UPDATE wf_meta SET schema_version = 2");
});
