import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test, vi } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";

/**
 * A libSQL server grants its one write lock in turn, and an interactive write transaction holds it from its first
 * statement until its commit arrives, across every round trip in between, while every other host's writes wait
 * (#4768). The writes a shared pool makes for every child — queueing it, opening its admission, releasing it, and the
 * root's lease renewals and event appends — each go as one request, so the lock is held for one server-side execution.
 */
const header = { runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" };
const LEASE_MS = 60_000;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A journal over a libSQL database file, the adapter a shared server uses, with its root's lease and pool. */
async function libsqlRoot() {
	const directory = makeLibsqlDirectory("pool-one-request-");
	cleanups.push(() => removeLibsqlDirectory(directory));
	const database = await openLibsqlDatabase({ url: pathToFileURL(join(directory, "shared.db")).href });
	cleanups.push(() => database.close());
	const journal = await SqlRunJournal.open(database);
	cleanups.push(() => journal.close());
	await journal.createRun(header);
	const acquired = await journal.acquire(header.runId, "coordinator");
	if (acquired.status !== "acquired") assert.fail("lease not acquired");
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(acquired.lease, LEASE_MS);
	// Opened once, as the root's first child does, so the schema exists when the transactions are counted.
	const first = await SqlResourceAdmission.open(journal, { root: header.runId, holder: "worker", crossHost: true });
	await first.releaseStoppedSessions("warm-up");
	return { database, journal, pool, lease: acquired.lease, transactions: vi.spyOn(database, "transaction") };
}

test("a root renews its lease and appends its events without an interactive transaction (#4768)", async () => {
	const { journal, lease, transactions } = await libsqlRoot();
	await journal.renew(lease);
	const appended = await journal.append(lease, { type: "SummaryRecorded", payload: { step: 1 } }, { key: "step-1" });
	assert.equal(appended.status, "appended");
	assert.equal(
		(await journal.append(lease, { type: "SummaryRecorded", payload: { step: 1 } }, { key: "step-1" })).status,
		"exists",
	);
	await assert.rejects(journal.renew({ ...lease, epoch: lease.epoch + 1 }), StaleLeaseError);
	await assert.rejects(
		journal.append({ ...lease, holderId: "another" }, { type: "SummaryRecorded", payload: {} }),
		StaleLeaseError,
	);
	assert.equal(transactions.mock.calls.length, 0, "a renewal or an append held the write lock across a round trip");
});

test("a root queues a new child, and a worker opens and releases its admission, without an interactive transaction (#4768)", async () => {
	const { journal, pool, lease, transactions } = await libsqlRoot();
	const child = poolWorkFixture("child");
	const queued = await pool.enqueue(lease, child.work, child.boundary);
	assert.equal(queued.childRunId, child.work.childRunId);
	assert.equal(queued.state, "ready");
	const again = await pool.enqueue(lease, child.work, child.boundary);
	assert.equal(again.id, queued.id, "queueing the same child again finds its work");
	const admission = await SqlResourceAdmission.open(journal, {
		root: header.runId,
		holder: "worker",
		crossHost: true,
	});
	assert.equal(await admission.releaseStoppedSessions("worker"), 0);
	// Only queueing work the root queued already, which may rebind it, takes the transaction.
	assert.equal(transactions.mock.calls.length, 1, "queueing a new child or opening admission held the write lock");
});

test("admission on a libSQL journal whose pool was never opened opens and releases in transactions (#4768)", async () => {
	const directory = makeLibsqlDirectory("pool-one-request-no-pool-");
	cleanups.push(() => removeLibsqlDirectory(directory));
	const database = await openLibsqlDatabase({ url: pathToFileURL(join(directory, "shared.db")).href });
	cleanups.push(() => database.close());
	const journal = await SqlRunJournal.open(database);
	cleanups.push(() => journal.close());
	// Without the pool's tables there is no fence table for a batch's fences: admission keeps to its transactions.
	for (let open = 0; open < 2; open++) {
		const admission = await SqlResourceAdmission.open(journal, { root: header.runId, holder: "worker" });
		assert.equal(await admission.releaseStoppedSessions("worker"), 0);
	}
});
