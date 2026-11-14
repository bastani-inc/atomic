import assert from "node:assert/strict";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SessionEntry } from "@bastani/atomic";
import {
	createSqliteDatabase,
	type SqliteDriver,
	type SqliteDriverExecutor,
	type SqliteDriverResult,
	type SqliteStatement,
	StorageTransientError,
} from "@bastani/atomic/storage";
import { test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const { DatabaseSync: Database } = await import("node:sqlite");

type Request = "batch" | "transaction" | "statement";

/**
 * A driver over node:sqlite that, like a database server's, sends a batch as one request, and records every request it
 * gets: a batch, the start of an interactive transaction, or a statement outside one.
 */
function countingDriver(path: string) {
	const connection: DatabaseSync = new Database(path);
	const requests: Request[] = [];
	/** Whether each batch asked for the priority lane, in order. */
	const priorities: boolean[] = [];
	const hooks: { beforeBatch?: (connection: DatabaseSync) => void; afterCommit?: () => void } = {};
	const execute = (sql: string, params: readonly unknown[]): SqliteDriverResult => {
		const statement = connection.prepare(sql);
		statement.setReadBigInts(true);
		const columns = statement.columns().map((column) => column.name);
		if (columns.length === 0)
			return { columns, rows: [], changes: Number(statement.run(...(params as never[])).changes) };
		const rows = statement.all(...(params as never[])).map((row) => columns.map((name) => row[name]!));
		return { columns, rows, changes: 0 };
	};
	const outside: SqliteDriverExecutor = {
		execute(sql, params) {
			requests.push("statement");
			return execute(sql, params);
		},
		executeMultiple(sql) {
			requests.push("statement");
			connection.exec(sql);
		},
	};
	const inside: SqliteDriverExecutor = {
		execute: (sql, params) => execute(sql, params),
		executeMultiple: (sql) => connection.exec(sql),
	};
	const driver: SqliteDriver = {
		...outside,
		descriptor: { adapter: "counting", location: path },
		beginTransaction() {
			requests.push("transaction");
			connection.exec("BEGIN IMMEDIATE");
			return { ...inside, commit: () => connection.exec("COMMIT"), rollback: () => connection.exec("ROLLBACK") };
		},
		batch(statements: readonly SqliteStatement[], options?: { readonly priority?: boolean }) {
			requests.push("batch");
			priorities.push(options?.priority === true);
			hooks.beforeBatch?.(connection);
			connection.exec("BEGIN IMMEDIATE");
			let results: SqliteDriverResult[];
			try {
				results = statements.map(({ sql, params }) => execute(sql, params));
				connection.exec("COMMIT");
			} catch (error) {
				connection.exec("ROLLBACK");
				throw error;
			}
			hooks.afterCommit?.();
			return results;
		},
		close: () => connection.close(),
		// A request the client gave up waiting for, as the libSQL adapter abandons one: it may have committed.
		transientFailure: (failure) =>
			(failure as { name?: unknown }).name === "TimeoutError"
				? { code: "connection-lost", outcome: "unknown" }
				: undefined,
	};
	return { driver, requests, priorities, hooks, connection };
}

const { work, boundary } = poolWorkFixture();
const run = { ...boundary.topology!.boundary!.child };
const tool = (index: number): DurableToolCheckpoint => ({
	kind: "tool",
	workflowId: "root",
	checkpointId: `${work.scope}:tool:${index}`,
	name: "tool",
	argsHash: `${work.scope}:args:${index}`,
	output: { index },
	completedAt: 1,
	topology: { version: 1, nodeId: `tool-${index}`, parentIds: [], ordinal: index, order: index, run },
});
const header = { id: "session", version: 4 as const, createdAt: "2026-01-01T00:00:00Z", cwd: "/gone" };
const entry = (id: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: header.createdAt,
	message: { role: "user", content: id, timestamp: 1 },
});

/** `batched: false` drops the driver's batch, as a node:sqlite journal has none: pool writes then run in transactions. */
async function fixture(batched = true) {
	const directory = makeTempDirectory("pool-batched-writes-");
	const counting = countingDriver(join(directory, "journal.db"));
	const { batch: _batch, ...withoutBatch } = counting.driver;
	const database = createSqliteDatabase(batched ? counting.driver : withoutBatch);
	const journal = await SqlRunJournal.open(database, { prefix: "acme_" });
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire("root", backend.holderId);
	if (acquired.status !== "acquired") assert.fail("No root lease");
	const lease = acquired.lease;
	const pool = await openSqlPoolQueue(journal);
	const shared = await SqlSharedPool.open(journal, pool);
	const usage = await openSqlPoolUsage(journal);
	await pool.initialize(lease, 60_000);
	await pool.enqueue(lease, work, boundary);
	return {
		...counting,
		journal,
		pool,
		shared,
		usage,
		lease,
		/** The requests `operation` sent: what it wrote with, and whether it read inside a transaction. */
		async requestsOf<T>(operation: () => Promise<T>): Promise<{ readonly value: T; readonly sent: Request[] }> {
			counting.requests.length = 0;
			const value = await operation();
			return { value, sent: [...counting.requests] };
		},
		async close() {
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

/** One write request, and every read outside any transaction: nothing holds the write lock across a round trip. */
function assertOneWrite(label: string, sent: readonly Request[]): void {
	assert.equal(sent.filter((request) => request === "batch").length, 1, `${label}: ${sent.join(", ")}`);
	assert.equal(sent.includes("transaction"), false, `${label}: ${sent.join(", ")}`);
}

test("each shared-pool write on a database that takes batches is one request, with no transaction held across round trips (#4768)", async () => {
	const f = await fixture();
	try {
		const claimed = await f.requestsOf(() => f.pool.claim(f.lease, "host/w1", [work], 60_000));
		assertOneWrite("claim", claimed.sent);
		const attempt = claimed.value;
		assert.ok(attempt);
		const checkpoint = await f.requestsOf(() =>
			f.pool.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) }),
		);
		assertOneWrite("checkpoint commit", checkpoint.sent);
		assert.equal(typeof checkpoint.value.seq, "number");
		// The pool's session store opens its tables once per process, then every session write is one request.
		const stage = {
			kind: "stage" as const,
			workflowId: "root",
			checkpointId: `${work.scope}:session:0`,
			name: "stage",
			replayKey: `${work.scope}:stage`,
			sessionId: "session",
			completedAt: 0,
			topology: { version: 1 as const, stageId: "stage", parentIds: [], sourceOrder: 0, run },
		};
		await f.pool.commit(f.lease, attempt, "op-2", {
			kind: "session-create",
			checkpoint: stage,
			header,
			entries: [entry("m1")],
		});
		const appended = await f.requestsOf(() =>
			f.pool.commit(f.lease, attempt, "op-3", {
				kind: "session-append",
				sessionId: "session",
				entries: [entry("m2")],
				expectSeq: 1,
			}),
		);
		assertOneWrite("session append", appended.sent);
		assert.equal(appended.value.lastSeq, 2);
		const report = { key: "stage:x", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5 } };
		const beat = await f.requestsOf(() =>
			f.pool.heartbeat(f.lease, attempt, 60_000, f.usage.recording(f.lease, attempt, [report])),
		);
		// A heartbeat that is expected to succeed reads nothing first: its fences repeat every check.
		assert.deepEqual(beat.sent, ["batch"]);
		assert.equal(beat.value.recorded.cost, 0.5);
		assert.equal(beat.value.control.state, "running");
		assert.deepEqual((await f.requestsOf(() => f.pool.renew(f.lease, attempt, 60_000))).sent, ["batch"]);
		assert.deepEqual((await f.requestsOf(() => f.pool.extend(f.lease, attempt, 60_000))).sent, ["batch"]);
		const host = {
			host: "host",
			labels: {},
			git: "system" as const,
			restore: true,
			workers: 1,
			maxWorkers: 2,
			roots: ["root"],
		};
		assert.deepEqual((await f.requestsOf(() => f.shared.reportHost(host))).sent, ["batch"]);
		const input = {
			work: attempt.id,
			runId: run.runId,
			stageId: "stage",
			kind: "question-read" as const,
			op: "read-1",
		};
		const appendedInput = await f.requestsOf(() =>
			f.shared.appendStageInput(f.lease, { ...input, payload: JSON.stringify({ promptId: "q" }) }),
		);
		assert.deepEqual(appendedInput.sent, ["batch"]);
		assert.equal(appendedInput.value, 1);
		const taken = await f.requestsOf(() =>
			f.shared.takeStageInput(f.lease, attempt, { runId: run.runId, stageId: "stage" }, 30_000),
		);
		assertOneWrite("take stage input", taken.sent);
		assert.equal(taken.value?.seq, 1);
		assert.deepEqual((await f.requestsOf(() => f.shared.ackStageInput(f.lease, taken.value!, "{}"))).sent, ["batch"]);
		const relayed = await f.requestsOf(() =>
			f.shared.relayActivity(f.lease, [{ work: { ...attempt, renewedAt: 0, expiresAt: 0 }, runs: "[]" }]),
		);
		assert.deepEqual(relayed.sent, ["batch"]);
		assert.equal((await f.shared.activityAfter("root", 0)).length, 1);
		const completed = await f.requestsOf(() =>
			f.pool.complete(f.lease, attempt, { runId: work.childRunId, status: "completed" }),
		);
		assertOneWrite("complete", completed.sent);
		assert.equal((await f.pool.inspect("root"))[0]?.state, "completed");
	} finally {
		await f.close();
	}
});

test("a commit whose attempt loses its work between its read and its write writes nothing and is refused as stale (#4768)", async () => {
	const f = await fixture();
	try {
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		// Another host takes the work over after the commit read it and before its batch reaches the database.
		f.hooks.beforeBatch = (connection) => {
			f.hooks.beforeBatch = undefined;
			connection.exec(`UPDATE acme_wf_runs_work SET generation = generation + 1, worker = 'host/w2'`);
		};
		await assert.rejects(
			f.pool.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) }),
			(error: Error) =>
				error instanceof StaleWorkLeaseError && /generation-mismatch|worker-mismatch/.test(error.message),
		);
		assert.deepEqual(
			(await f.pool.inspect("root")).map((item) => item.worker),
			["host/w2"],
		);
		const recorded: unknown[] = [];
		for await (const item of f.journal.read("root")) recorded.push(item.event.payload);
		assert.equal(
			recorded.some((payload) => (payload as { checkpointId?: string }).checkpointId === tool(1).checkpointId),
			false,
		);
	} finally {
		await f.close();
	}
});

test("a commit whose answer never arrives is planned again and records its checkpoint once, with the receipt it stored (#4768)", async () => {
	const f = await fixture();
	try {
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		f.hooks.afterCommit = () => {
			f.hooks.afterCommit = undefined;
			throw Object.assign(new Error("the request timed out"), { name: "TimeoutError" });
		};
		const receipt = await f.pool.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) });
		const recorded: { seq: number; checkpointId?: string }[] = [];
		for await (const item of f.journal.read("root"))
			recorded.push({ seq: item.seq, checkpointId: (item.event.payload as { checkpointId?: string }).checkpointId });
		const mine = recorded.filter((item) => item.checkpointId === tool(1).checkpointId);
		assert.deepEqual(
			mine.map((item) => item.seq),
			[receipt.seq],
		);
	} finally {
		await f.close();
	}
});

test("an attempt's later checkpoint commits as one request with no read, planned from what its queue already knows (#4768)", async () => {
	const f = await fixture();
	try {
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		await f.pool.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) });
		const second = await f.requestsOf(() =>
			f.pool.commit(f.lease, attempt, "op-2", { kind: "checkpoint", checkpoint: tool(2) }),
		);
		assert.deepEqual(second.sent, ["batch"]);
		// A lost answer repeats the same operation: it is answered from the stored receipt.
		assert.deepEqual(
			await f.pool.commit(f.lease, attempt, "op-2", { kind: "checkpoint", checkpoint: tool(2) }),
			second.value,
		);
	} finally {
		await f.close();
	}
});

test("a commit planned without a read is refused when another writer recorded a checkpoint in its scope that it did not see (#4768)", async () => {
	const f = await fixture();
	try {
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		await f.pool.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) });
		// Another attempt's tool with node id `tool-2` and other arguments, which the queue never read.
		const foreign = {
			...tool(2),
			argsHash: `${work.scope}:args:foreign`,
			checkpointId: `${work.scope}:tool:foreign`,
		};
		f.hooks.beforeBatch = (connection) => {
			f.hooks.beforeBatch = undefined;
			connection
				.prepare(
					"INSERT INTO acme_wf_events SELECT 'root', MAX(seq) + 1, 1, ?, 'CheckpointRecorded', ?, 0 FROM acme_wf_events WHERE run_id = 'root'",
				)
				.run(JSON.stringify(["CheckpointRecorded", "tool", foreign.checkpointId]), JSON.stringify(foreign));
		};
		await assert.rejects(
			f.pool.commit(f.lease, attempt, "op-2", { kind: "checkpoint", checkpoint: tool(2) }),
			/Pool tool topology scope mismatch/,
		);
	} finally {
		await f.close();
	}
});

test("a write the server keeps leaving unanswered fails after a bounded number of plans, for the caller's outage handling (#4768)", async () => {
	const f = await fixture();
	try {
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		let sent = 0;
		f.hooks.beforeBatch = () => {
			sent++;
			throw Object.assign(new Error("the request timed out"), { name: "TimeoutError" });
		};
		await assert.rejects(
			f.pool.renew(f.lease, attempt, 60_000),
			(error: Error) => error instanceof StorageTransientError && error.outcome === "unknown",
		);
		assert.equal(sent, 3);
	} finally {
		await f.close();
	}
});

test("a claim whose answer was lost hands out the row it took instead of taking a second one (#4768)", async () => {
	const f = await fixture();
	try {
		const other = poolWorkFixture("other");
		await f.pool.enqueue(f.lease, other.work, other.boundary);
		f.hooks.afterCommit = () => {
			f.hooks.afterCommit = undefined;
			throw Object.assign(new Error("the request timed out"), { name: "TimeoutError" });
		};
		const claimed = await f.pool.claim(f.lease, "host/w1", [work, other.work], 60_000);
		assert.ok(claimed);
		const states = (await f.pool.inspect("root")).map((item) => [item.id === claimed.id, item.state, item.worker]);
		assert.deepEqual(states.sort(), [
			[false, "ready", null],
			[true, "leased", "host/w1"],
		]);
	} finally {
		await f.close();
	}
});

/** A refusal as its typed error and reason, for comparing the batched path's refusals with the transactional path's. */
const refusal = (reason: string) => (error: Error) =>
	error instanceof StaleWorkLeaseError && (error as Error & { reason?: string }).reason === reason;

test("batched writes refuse a paused root's attempt, an expired attempt and a lost root lease with the transactional path's typed errors (#4768)", async () => {
	const f = await fixture();
	try {
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		await f.pool.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) });
		// Paused: no writes of its attempts, and no claims.
		f.connection.exec("UPDATE acme_wf_runs SET status = 'paused'");
		await assert.rejects(
			f.pool.commit(f.lease, attempt, "op-2", { kind: "checkpoint", checkpoint: tool(2) }),
			refusal("root-not-running"),
		);
		await assert.rejects(f.pool.complete(f.lease, attempt, { runId: work.childRunId }), refusal("root-not-running"));
		assert.equal(await f.pool.claim(f.lease, "host/w2", [work], 60_000), undefined);
		// Paused by its pool control, the attempt writes again.
		await f.pool.setControl(f.lease, "paused");
		await f.pool.commit(f.lease, attempt, "op-2", { kind: "checkpoint", checkpoint: tool(2) });
		f.connection.exec("UPDATE acme_wf_runs SET status = 'running'");
		await f.pool.setControl(f.lease, "running");
		// Expired: refused, though a heartbeat still takes it back while the attempt holds the work.
		f.connection.exec("UPDATE acme_wf_runs_work SET expires_at = 1");
		await assert.rejects(
			f.pool.commit(f.lease, attempt, "op-3", { kind: "checkpoint", checkpoint: tool(3) }),
			refusal("expired"),
		);
		await assert.rejects(f.pool.renew(f.lease, attempt, 60_000), refusal("expired"));
		await assert.rejects(f.pool.complete(f.lease, attempt, { runId: work.childRunId }), refusal("expired"));
		const extended = await f.pool.extend(f.lease, attempt, 60_000);
		assert.ok(extended.expiresAt > Date.now());
		// The same operation with another request is a conflict, not a second write.
		await assert.rejects(
			f.pool.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(3) }),
			/Pool operation identity conflict/,
		);
		// A result for another child is refused; the right one completes, and completing it again is accepted.
		await assert.rejects(
			f.pool.complete(f.lease, attempt, { runId: "another-child" }),
			/Pool result identity mismatch/,
		);
		await f.pool.complete(f.lease, attempt, { runId: work.childRunId });
		await f.pool.complete(f.lease, attempt, { runId: work.childRunId });
		await assert.rejects(
			f.pool.complete(f.lease, attempt, { runId: work.childRunId, other: true }),
			/Pool result identity conflict/,
		);
		// The root's lease taken by another holder fences every write.
		f.connection.exec("UPDATE acme_wf_leases SET holder_id = 'another', epoch = epoch + 1");
		await assert.rejects(f.pool.claim(f.lease, "host/w2", [work], 60_000), StaleLeaseError);
		await assert.rejects(
			f.shared.appendStageInput(f.lease, {
				work: attempt.id,
				runId: run.runId,
				stageId: "stage",
				kind: "question-read",
				op: "read-2",
				payload: JSON.stringify({ promptId: "q" }),
			}),
			StaleLeaseError,
		);
	} finally {
		await f.close();
	}
});

test("a batched write planned from a stale cached attempt is refused by its fences and named from a read (#4768)", async () => {
	const f = await fixture();
	try {
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		await f.pool.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) });
		// Another host took the work over; this queue's cached row still says it holds it.
		f.connection.exec("UPDATE acme_wf_runs_work SET generation = generation + 1, worker = 'host/w2'");
		const counted = f.requestsOf(() =>
			f.pool.commit(f.lease, attempt, "op-2", { kind: "checkpoint", checkpoint: tool(2) }),
		);
		await assert.rejects(counted, (error: Error) => error instanceof StaleWorkLeaseError);
		await assert.rejects(f.pool.complete(f.lease, attempt, { runId: work.childRunId }), StaleWorkLeaseError);
		await assert.rejects(f.pool.renew(f.lease, attempt, 60_000), StaleWorkLeaseError);
		await assert.rejects(
			f.pool.heartbeat(f.lease, attempt, 60_000, f.usage.recording(f.lease, attempt, [])),
			StaleWorkLeaseError,
		);
	} finally {
		await f.close();
	}
});

const timedOut = () => Object.assign(new Error("the request timed out"), { name: "TimeoutError" });

test("lease renewals, heartbeats and host reports take the priority lane; commits, claims and completions do not (#4768)", async () => {
	const f = await fixture();
	try {
		const lanes = async (operation: () => Promise<unknown>) => {
			f.priorities.length = 0;
			await operation();
			return [...f.priorities];
		};
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		assert.deepEqual(f.priorities, [false]);
		assert.deepEqual(
			await lanes(() => f.pool.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) })),
			[false],
		);
		assert.deepEqual(await lanes(() => f.pool.renew(f.lease, attempt, 60_000)), [true]);
		assert.deepEqual(await lanes(() => f.pool.extend(f.lease, attempt, 60_000)), [true]);
		assert.deepEqual(
			await lanes(() => f.pool.heartbeat(f.lease, attempt, 60_000, f.usage.recording(f.lease, attempt, []))),
			[true],
		);
		const host = {
			host: "host",
			labels: {},
			git: "system" as const,
			restore: true,
			workers: 1,
			maxWorkers: 2,
			roots: ["root"],
		};
		assert.deepEqual(await lanes(() => f.shared.reportHost(host)), [true]);
		assert.deepEqual(await lanes(() => f.pool.complete(f.lease, attempt, { runId: work.childRunId })), [false]);
	} finally {
		await f.close();
	}
});

test("a commit or completion for a token its queue does not hold is refused from a read, without sending a write (#4768)", async () => {
	const f = await fixture();
	try {
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		await f.pool.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) });
		const forged = [
			{ ...attempt, worker: "host/other" },
			{ ...attempt, generation: attempt.generation + 1 },
			{ ...attempt, epoch: attempt.epoch + 1 },
			{ ...attempt, id: "missing-work" },
		];
		for (const token of forged) {
			const label = JSON.stringify(token);
			const committed = f.requestsOf(() =>
				f.pool.commit(f.lease, token, "op-2", { kind: "checkpoint", checkpoint: tool(2) }),
			);
			await assert.rejects(committed, StaleWorkLeaseError, label);
			assert.equal(f.requests.includes("batch"), false, label);
			f.requests.length = 0;
			await assert.rejects(f.pool.complete(f.lease, token, { runId: work.childRunId }), StaleWorkLeaseError, label);
			assert.equal(f.requests.includes("batch"), false, label);
		}
		// A root lease of another incarnation is refused the same way.
		f.requests.length = 0;
		await assert.rejects(
			f.pool.commit({ ...f.lease, epoch: f.lease.epoch + 1 }, attempt, "op-2", {
				kind: "checkpoint",
				checkpoint: tool(2),
			}),
		);
		assert.equal(f.requests.includes("batch"), false);
	} finally {
		await f.close();
	}
});

test("a queue that did not claim an attempt, as after its host restarted, commits and completes it from a read (#4768)", async () => {
	const f = await fixture();
	try {
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		const restarted = await openSqlPoolQueue(f.journal);
		const receipt = await restarted.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) });
		assert.equal(typeof receipt.seq, "number");
		await restarted.complete(f.lease, attempt, { runId: work.childRunId });
		assert.equal((await f.pool.inspect("root"))[0]?.state, "completed");
	} finally {
		await f.close();
	}
});

test("a heartbeat reports the root's pool control, and one whose record has no batched form still records in a transaction (#4768)", async () => {
	const f = await fixture();
	try {
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		await f.pool.setControl(f.lease, "paused");
		const paused = await f.pool.heartbeat(f.lease, attempt, 60_000, f.usage.recording(f.lease, attempt, []));
		assert.equal(paused.control.state, "paused");
		assert.ok(paused.control.revision > 0);
		assert.equal(paused.work.id, attempt.id);
		const plain = await f.requestsOf(() =>
			f.pool.heartbeat(f.lease, attempt, 60_000, async (tx) => Number((await tx.get("SELECT 7 AS seven"))!.seven)),
		);
		assert.equal(plain.value.recorded, 7);
		assert.equal(plain.value.control.state, "paused");
		assert.ok(plain.value.work.expiresAt > Date.now());
		assert.deepEqual(plain.sent.includes("transaction"), true);
	} finally {
		await f.close();
	}
});

test("a claim with no compatible definitions takes nothing, and a claim whose send failed before it committed claims once (#4768)", async () => {
	const f = await fixture();
	try {
		const none = await f.requestsOf(() => f.pool.claim(f.lease, "host/w1", [], 60_000));
		assert.equal(none.value, undefined);
		assert.equal(none.sent.includes("batch"), false);
		f.hooks.beforeBatch = () => {
			f.hooks.beforeBatch = undefined;
			throw timedOut();
		};
		const claimed = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.equal(claimed?.generation, 1);
		const items = await f.pool.inspect("root");
		assert.deepEqual(
			items.map((item) => [item.id === claimed?.id, item.state]),
			[[true, "leased"]],
		);
	} finally {
		await f.close();
	}
});

test("without batches, pool writes run in transactions and still refuse a token their queue does not hold (#4768)", async () => {
	const f = await fixture(false);
	try {
		const attempt = await f.pool.claim(f.lease, "host/w1", [work], 60_000);
		assert.ok(attempt);
		const forged = { ...attempt, worker: "host/other" };
		const sent = await f.requestsOf(async () => {
			await assert.rejects(f.pool.renew(f.lease, forged, 60_000), StaleWorkLeaseError);
			await assert.rejects(f.pool.extend(f.lease, forged, 60_000), StaleWorkLeaseError);
			await assert.rejects(
				f.pool.commit(f.lease, forged, "op-1", { kind: "checkpoint", checkpoint: tool(1) }),
				StaleWorkLeaseError,
			);
			await f.pool.commit(f.lease, attempt, "op-1", { kind: "checkpoint", checkpoint: tool(1) });
			await f.pool.commit(f.lease, attempt, "op-2", {
				kind: "session-create",
				checkpoint: {
					kind: "stage",
					workflowId: "root",
					checkpointId: `${work.scope}:session:0`,
					name: "stage",
					replayKey: `${work.scope}:stage`,
					sessionId: "session",
					completedAt: 0,
					topology: { version: 1, stageId: "stage", parentIds: [], sourceOrder: 0, run },
				},
				header,
				entries: [entry("m1")],
			});
			const beat = await f.pool.heartbeat(f.lease, attempt, 60_000, f.usage.recording(f.lease, attempt, []));
			assert.equal(beat.control.state, "running");
		});
		assert.equal(sent.sent.includes("batch"), false);
		assert.ok(sent.sent.includes("transaction"));
	} finally {
		await f.close();
	}
});
