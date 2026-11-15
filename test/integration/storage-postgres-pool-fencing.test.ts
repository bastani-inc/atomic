import assert from "node:assert/strict";
import type { SqliteDatabase, SqliteExecutor } from "@bastani/atomic/storage";
import { afterEach, beforeEach, describe, test } from "vitest";
import { postgresDialect } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { observeSqlPoolTransactions, sqlPoolWrites } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { poolUsageTotalsSeed } from "../../packages/workflows/src/durable/journal/pool-stage-usage.js";
import { openSqlPoolQueue, type SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	isStaleLeaseError,
	JournalSchemaVersionError,
	type Lease,
} from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { syntheticSnapshot, textBlob } from "../helpers/snapshot-reference-index.js";
import { type StorageBackendScope, storageBackends } from "../helpers/storage-backends.js";

/**
 * How the PostgreSQL worker pool's writes exclude one another without the database-wide lock (#5102). Each test holds
 * a row lock, or the database-wide lock, in a transaction of its own on another connection, as a write in flight on
 * another host would, and shows which pool and journal writes wait for it and which go ahead.
 */

const postgres = storageBackends.find((backend) => backend.name === "Postgres")!;
/** Long enough that a write that should wait has not finished, short enough to keep the suite quick. */
const STILL_WAITING_MS = 400;
const definition = { definition: "fixture/child", digest: "sha256:child" };
const usage = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.25 };

/** A transaction on another connection that runs `hold`, then keeps its locks until `release()`. */
async function holding(database: SqliteDatabase, hold: (tx: SqliteExecutor) => Promise<unknown>, serial = false) {
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let held!: () => void;
	const holds = new Promise<void>((resolve) => {
		held = resolve;
	});
	const done = database.transaction(
		async (tx) => {
			await hold(tx);
			held();
			await released;
		},
		serial ? {} : { concurrency: { kind: "fenced", audit: "test-blocker" as never } },
	);
	await holds;
	return { release, done };
}

/** Whether `promise` is still pending after `ms`. */
async function pendingAfter(promise: Promise<unknown>, ms = STILL_WAITING_MS): Promise<boolean> {
	const marker = Symbol("pending");
	const outcome = await Promise.race([
		promise.then(
			() => undefined,
			() => undefined,
		),
		new Promise((resolve) => setTimeout(() => resolve(marker), ms)),
	]);
	return outcome === marker;
}

function toolCheckpoint(item: ReturnType<typeof poolWorkFixture>, step: number): DurableToolCheckpoint {
	const { scope } = item.work;
	return {
		kind: "tool",
		workflowId: "root",
		checkpointId: `${scope}:tool:${step}`,
		name: "tool",
		argsHash: `${scope}:args:${step}`,
		output: { step },
		completedAt: 1,
		topology: {
			version: 1,
			nodeId: `tool-${step}`,
			parentIds: [],
			ordinal: step,
			order: step,
			run: { ...item.boundary.topology!.boundary!.child },
		},
	};
}

describe.skipIf(postgres.skipReason !== undefined)("the worker pool's fenced writes on PostgreSQL (#5102)", () => {
	let scope: StorageBackendScope;
	let journal: SqlRunJournal;
	let backend: JournalDurableBackend;
	let pool: SqlPoolQueue;
	let lease: Lease;
	/** Another connection, as another host's. */
	let other: SqliteDatabase;
	const table = (name: string) => `${scope.prefix}${name}`;
	const item = poolWorkFixture();

	beforeEach(async () => {
		scope = await postgres.openScope();
		journal = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
		backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		await backend.commitWorkflowRegistration({
			workflowId: "root",
			name: "root",
			inputs: {},
			createdAt: 0,
			status: "running",
		});
		const acquired = await journal.acquire("root", backend.holderId);
		if (acquired.status !== "acquired") assert.fail("No lease");
		lease = acquired.lease;
		pool = await openSqlPoolQueue(journal);
		await pool.initialize(lease, 60_000);
		other = await scope.connect();
	});

	afterEach(async () => {
		await backend.close();
		await journal.close();
		await scope.close();
	});

	test("claims, heartbeats, commits and completions go ahead while a serial write holds the database-wide lock (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const blocker = await holding(other, (tx) => tx.all("SELECT 1"), true);
		try {
			const attempt = await pool.claim(lease, "worker", [definition], 60_000);
			assert.ok(attempt);
			await pool.renew(lease, attempt, 60_000);
			const receipt = await pool.commit(lease, attempt, "step", {
				kind: "checkpoint",
				checkpoint: toolCheckpoint(item, 0),
			});
			assert.ok(receipt.seq! > 0);
			await pool.complete(lease, attempt, { runId: attempt.childRunId, status: "completed" });
		} finally {
			blocker.release();
			await blocker.done;
		}
		assert.equal((await pool.inspect("root"))[0]!.state, "completed");
	});

	test("expiry waits for a heartbeat holding the attempt's work row, and sees the lease it extended (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const attempt = (await pool.claim(lease, "worker", [definition], 60_000))!;
		await other.run(`UPDATE ${table("wf_runs_work")} SET expires_at = 0`);
		const heartbeat = await holding(other, async (tx) => {
			await tx.all(`SELECT 1 FROM ${table("wf_runs_work")} WHERE id = ? FOR UPDATE`, attempt.id);
			await tx.run(`UPDATE ${table("wf_runs_work")} SET expires_at = 9007199254740000 WHERE id = ?`, attempt.id);
		});
		const expired = pool.expire(lease, attempt);
		assert.equal(await pendingAfter(expired), true, "expiry waits for the heartbeat");
		heartbeat.release();
		await heartbeat.done;
		assert.equal(await expired, false, "the extended lease is not expired");
	});

	test("releasing an exited attempt waits for its completion, and leaves the completed work (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const attempt = (await pool.claim(lease, "worker", [definition], 60_000))!;
		const completion = await holding(other, async (tx) => {
			await tx.all(`SELECT 1 FROM ${table("wf_runs_work")} WHERE id = ? FOR UPDATE`, attempt.id);
			await tx.run(`UPDATE ${table("wf_runs_work")} SET state = 'completed' WHERE id = ?`, attempt.id);
		});
		const released = pool.releaseExited(lease, attempt);
		assert.equal(await pendingAfter(released), true);
		completion.release();
		await completion.done;
		assert.equal(await released, false);
		assert.equal((await pool.inspect("root"))[0]!.state, "completed");
	});

	test("a heartbeat without a batched record extends the lease under the work row's lock (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const attempt = (await pool.claim(lease, "worker", [definition], 60_000))!;
		const holder = await holding(other, (tx) =>
			tx.all(`SELECT 1 FROM ${table("wf_runs_work")} WHERE id = ? FOR UPDATE`, attempt.id),
		);
		const beat = pool.heartbeat(lease, attempt, 120_000, async () => "recorded");
		assert.equal(await pendingAfter(beat), true);
		holder.release();
		await holder.done;
		const { work, recorded } = await beat;
		assert.equal(recorded, "recorded");
		assert.ok(work.expiresAt > attempt.expiresAt);
	});

	test("an earlier incarnation's work is released and reopened under its work row's lock (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const attempt = (await pool.claim(lease, "worker", [definition], 60_000))!;
		await other.run(`UPDATE ${table("wf_leases")} SET renewed_at = 0`);
		const takeover = await journal.takeoverExpired("root", "replacement", 60_000);
		if (takeover.status !== "acquired") assert.fail("No takeover");
		const next = takeover.lease;
		assert.equal(await pool.releaseRetained(next, attempt, true), true);
		await pool.enqueue(next, item.work, item.boundary);
		const again = (await pool.claim(next, "worker", [definition], 60_000))!;
		await pool.complete(next, again, { runId: again.childRunId, status: "completed" });
		const third = await journal.takeover("root", "third", "replacement");
		if (third.status !== "acquired") assert.fail("No second takeover");
		const reopened = await pool.reopenCompleted(third.lease, again.id, () => true);
		assert.equal(reopened?.state, "ready");
	});

	test("a journal append waits for a commit holding the run row, then takes the next sequence (#5102)", async () => {
		const events = table("wf_events");
		const last = Number((await other.get(`SELECT MAX(seq) AS seq FROM ${events} WHERE run_id = 'root'`))!.seq);
		const commit = await holding(other, async (tx) => {
			await tx.all(`SELECT 1 FROM ${table("wf_runs")} WHERE run_id = 'root' FOR UPDATE`);
			await tx.run(
				`INSERT INTO ${events} SELECT run_id, ?, epoch, 'held', type, payload, at FROM ${events} WHERE run_id = 'root' AND seq = ?`,
				last + 1,
				last,
			);
		});
		const append = journal.append(lease, { type: "StatusChanged", payload: { status: "running" } });
		assert.equal(await pendingAfter(append), true, "the append waits for the run row");
		commit.release();
		await commit.done;
		const outcome = await append;
		assert.equal(outcome.status, "appended");
		assert.equal(outcome.status === "appended" ? outcome.entry.seq : 0, last + 2);
	});

	test("a takeover waits for writes under the root's lease, and a renewal does not (#5102)", async () => {
		const write = await holding(other, (tx) =>
			tx.all(`SELECT 1 FROM ${table("wf_leases")} WHERE run_id = 'root' FOR KEY SHARE`),
		);
		try {
			const renewal = journal.renew(lease);
			assert.equal(await pendingAfter(renewal), false, "the renewal goes ahead");
			await renewal;
			const takeover = journal.takeover("root", "replacement", backend.holderId);
			assert.equal(await pendingAfter(takeover), true, "the takeover waits");
			write.release();
			await write.done;
			assert.equal((await takeover).status, "acquired");
		} finally {
			write.release();
		}
	});

	test("pausing waits for a claim under way and queueing waits for a commit's run row (#5102)", async () => {
		const claim = await holding(other, (tx) =>
			tx.all(`SELECT 1 FROM ${table("wf_runs")} WHERE run_id = 'root' FOR SHARE`),
		);
		const paused = pool.setControl(lease, "paused");
		assert.equal(await pendingAfter(paused), true);
		claim.release();
		await claim.done;
		assert.equal((await paused).state, "paused");
		await pool.setControl(lease, "running");
		const commit = await holding(other, (tx) =>
			tx.all(`SELECT 1 FROM ${table("wf_runs")} WHERE run_id = 'root' FOR UPDATE`),
		);
		const queued = pool.enqueue(lease, item.work, item.boundary);
		assert.equal(await pendingAfter(queued), true);
		commit.release();
		await commit.done;
		assert.equal((await queued).state, "ready");
	});

	test("a claim waiting on a pause that is committing is refused once the pause commits (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const pause = await holding(other, async (tx) => {
			await tx.all(`SELECT 1 FROM ${table("wf_runs")} WHERE run_id = 'root' FOR UPDATE`);
			await tx.run(
				`INSERT INTO ${table("wf_runs_pool_control")}(root, state, revision) VALUES ('root', 'paused', 1)`,
			);
		});
		const claim = pool.claim(lease, "worker", [definition], 60_000);
		const waited = await pendingAfter(claim);
		pause.release();
		await pause.done;
		assert.equal(await claim, undefined, "no work is handed out once the pause committed");
		assert.equal(waited, true, "the claim waited for the pause");
		assert.equal((await pool.inspect("root"))[0]!.state, "ready");
	});

	test("a commit waiting on a control change that is committing sees it, and a paused root resumed elsewhere refuses it (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const attempt = (await pool.claim(lease, "worker", [definition], 60_000))!;
		await pool.setControl(lease, "paused");
		await other.run(`UPDATE ${table("wf_runs")} SET status = 'paused' WHERE run_id = 'root'`);
		const resume = await holding(other, async (tx) => {
			await tx.all(`SELECT 1 FROM ${table("wf_runs")} WHERE run_id = 'root' FOR UPDATE`);
			await tx.run(`UPDATE ${table("wf_runs_pool_control")} SET state = 'running' WHERE root = 'root'`);
		});
		const commit = pool.commit(lease, attempt, "step", { kind: "checkpoint", checkpoint: toolCheckpoint(item, 0) });
		const waited = await pendingAfter(commit);
		resume.release();
		await resume.done;
		await assert.rejects(commit, /root-not-running/);
		assert.equal(waited, true);
	});

	test("usage recorded while another write creates the root's totals row is kept in the total (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const attempt = (await pool.claim(lease, "worker", [definition], 60_000))!;
		const ledger = await openSqlPoolUsage(journal);
		const seed = poolUsageTotalsSeed(postgresDialect, table("wf_runs"), "root");
		const creator = await holding(other, (tx) => tx.run(seed.sql, ...seed.params));
		const reported = ledger.report(lease, attempt, [{ key: "stage:child:a", usage }]);
		assert.equal(await pendingAfter(reported), true, "the report waits for the totals row");
		creator.release();
		await creator.done;
		assert.deepEqual(await reported, usage);
		assert.deepEqual(await ledger.total("root"), usage);
	});

	test("reading the total while another write creates the totals row returns that row (#5102)", async () => {
		const ledger = await openSqlPoolUsage(journal);
		const seed = poolUsageTotalsSeed(postgresDialect, table("wf_runs"), "root");
		const creator = await holding(other, (tx) => tx.run(seed.sql, ...seed.params));
		const total = ledger.total("root");
		assert.equal(await pendingAfter(total), true);
		creator.release();
		await creator.done;
		assert.deepEqual(await total, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	});

	test("a stage's usage committed while another write creates the root's totals row is kept in the total (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const attempt = (await pool.claim(lease, "worker", [definition], 60_000))!;
		const ledger = await openSqlPoolUsage(journal);
		const seed = poolUsageTotalsSeed(postgresDialect, table("wf_runs"), "root");
		const creator = await holding(other, (tx) => tx.run(seed.sql, ...seed.params));
		const { scope } = item.work;
		const billed = {
			kind: "stage" as const,
			workflowId: "root",
			checkpointId: `${scope}:session:billed`,
			name: "stage",
			replayKey: `${scope}:stage`,
			completedAt: 1,
			output: "done",
			modelAttempts: [{ model: "fixture", success: true, usage }],
			topology: {
				version: 1 as const,
				stageId: "stage",
				parentIds: [],
				sourceOrder: 0,
				status: "completed" as const,
				run: { ...item.boundary.topology!.boundary!.child },
			},
		};
		const committed = pool.commit(lease, attempt, "billed", { kind: "checkpoint", checkpoint: billed });
		const waited = await pendingAfter(committed);
		creator.release();
		await creator.done;
		await committed;
		assert.equal(waited, true, "the commit waits for the totals row");
		assert.deepEqual(await ledger.total("root"), usage);
	});

	test("a completion is refused once the root's lease is taken over or the attempt's lease lapsed (#5102)", async () => {
		const second = poolWorkFixture("second");
		await pool.enqueue(lease, item.work, item.boundary);
		await pool.enqueue(lease, second.work, second.boundary);
		const first = (await pool.claim(lease, "first", [definition], 60_000))!;
		const lapsed = (await pool.claim(lease, "second", [definition], 60_000))!;
		await other.run(`UPDATE ${table("wf_runs_work")} SET expires_at = 0 WHERE id = ?`, lapsed.id);
		await assert.rejects(pool.complete(lease, lapsed, { runId: lapsed.childRunId, status: "completed" }), /expired/);
		const takeover = await journal.takeover("root", "replacement", backend.holderId);
		assert.equal(takeover.status, "acquired");
		await assert.rejects(
			pool.complete(lease, first, { runId: first.childRunId, status: "completed" }),
			(error: Error) => isStaleLeaseError(error),
		);
		assert.deepEqual(
			(await pool.inspect("root")).map((work) => work.state),
			["leased", "leased"],
		);
	});

	test("another host completes an attempt it did not claim, under the same fences (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const attempt = (await pool.claim(lease, "worker", [definition], 60_000))!;
		const peer = await openSqlPoolQueue(await SqlRunJournal.open(other, { prefix: scope.prefix }));
		await peer.complete(lease, attempt, { runId: attempt.childRunId, status: "completed" });
		assert.equal((await pool.inspect("root"))[0]!.state, "completed");
	});

	test("a commit that records a worktree snapshot waits for snapshot garbage collection, and one without does not (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const attempt = (await pool.claim(lease, "worker", [definition], 60_000))!;
		const kept = textBlob("committed patch");
		await journal.snapshotBlobs.putBlobs([kept]);
		const snapshot = syntheticSnapshot("stored", [kept.hash]);
		// Garbage collection runs as a serial transaction over the whole database, as `collectSnapshotGarbage` does.
		const collection = await holding(other, (tx) => tx.all("SELECT 1"), true);
		const plain = pool.commit(lease, attempt, "plain", { kind: "checkpoint", checkpoint: toolCheckpoint(item, 0) });
		assert.equal(await pendingAfter(plain), false, "a commit without snapshots goes ahead");
		await plain;
		const carrying = pool.commit(lease, attempt, "carrying", {
			kind: "checkpoint",
			checkpoint: { ...toolCheckpoint(item, 1), worktreeSnapshots: [snapshot] } as DurableToolCheckpoint,
		});
		const waited = await pendingAfter(carrying);
		collection.release();
		await collection.done;
		await carrying;
		assert.equal(waited, true, "a commit recording a snapshot waits until collection ends");
	});

	test("a fenced claim, commit and completion are refused once a later build upgraded the journal (#5102)", async () => {
		await pool.enqueue(lease, item.work, item.boundary);
		const attempt = (await pool.claim(lease, "worker", [definition], 60_000))!;
		await pool.commit(lease, attempt, "before", { kind: "checkpoint", checkpoint: toolCheckpoint(item, 0) });
		const meta = table("wf_meta");
		const [{ schema_version: version }] = await other.all<{ schema_version: number }>(
			`SELECT schema_version FROM ${meta}`,
		);
		await other.run(`UPDATE ${meta} SET schema_version = ?`, Number(version) + 1);
		try {
			await assert.rejects(
				pool.complete(lease, attempt, { runId: attempt.childRunId, status: "completed" }),
				JournalSchemaVersionError,
			);
			await assert.rejects(
				pool.commit(lease, attempt, "after", { kind: "checkpoint", checkpoint: toolCheckpoint(item, 1) }),
				JournalSchemaVersionError,
			);
		} finally {
			await other.run(`UPDATE ${meta} SET schema_version = ?`, Number(version));
		}
		assert.equal((await pool.inspect("root"))[0]!.state, "leased", "nothing was written");
	});

	test("the pool's fenced writes are counted and watched like its other writes (#5102)", async () => {
		let observed = 0;
		observeSqlPoolTransactions(journal, () => observed++);
		const observedPool = await openSqlPoolQueue(journal);
		await observedPool.enqueue(lease, item.work, item.boundary);
		const before = observed;
		const attempt = (await observedPool.claim(lease, "worker", [definition], 60_000))!;
		assert.equal(observed, before + 1, "one fenced write per claim");
		const writes = sqlPoolWrites(journal)!;
		const runRow = await holding(other, (tx) =>
			tx.all(`SELECT 1 FROM ${table("wf_runs")} WHERE run_id = 'root' FOR UPDATE`),
		);
		const commit = observedPool.commit(lease, attempt, "step", {
			kind: "checkpoint",
			checkpoint: toolCheckpoint(item, 0),
		});
		assert.equal(await pendingAfter(commit), true);
		assert.ok((writes.oldestWaitingMs() ?? 0) > 0, "a waiting fenced write shows as waiting");
		runRow.release();
		await runRow.done;
		await commit;
		assert.equal(writes.oldestWaitingMs(), undefined);
	});
});
