import assert from "node:assert/strict";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import type { SessionEntry } from "@bastani/atomic";
import type { SqliteExecutor } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	ForkSessionClaimError,
	type ForkSessionClaimReason,
	isForkSessionClaimError,
} from "../../packages/workflows/src/durable/fork-errors.js";
import { type SqlPoolStorage, sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { poolTransactionSessionStore } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import { PoolRemoteJournal } from "../../packages/workflows/src/durable/journal/pool-remote-journal.js";
import {
	openSqlPoolQueue,
	type PoolSessionClaim,
	type SqlPoolQueue,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import {
	type CoordinatorReply,
	coordinatorReplyError,
	failedCoordinatorReply,
} from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const { work, boundary } = poolWorkFixture();
const other = poolWorkFixture("other");
const message = (id: string, parentId: string | null): SessionEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00Z",
	message: { role: "user", content: id, timestamp: 1 },
});
const copyHeader = (id: string, runId = work.childRunId) => ({
	id,
	version: 4 as const,
	createdAt: "2026-01-01T00:00:00Z",
	cwd: "/fork",
	parentSessionId: `source-of-${id}`,
	internal: true as const,
	workflow: { runId, stageId: "stage", stageName: "stage" },
});
const claimOf = (sessionId: string, replayKey = `${work.scope}:stage`, runId = work.childRunId): PoolSessionClaim => ({
	sessionId,
	replayKey,
	runId,
});

interface Harness {
	readonly pool: SqlPoolQueue;
	readonly lease: Lease;
	readonly storage: SqlPoolStorage;
	close(): Promise<void>;
}

/** The root's journal and the pool share one SQLite database. */
async function localJournal(): Promise<Harness> {
	const directory = makeTempDirectory("pool-session-claims-");
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const journal = await SqlRunJournal.open(database);
	await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "coordinator");
	if (acquired.status !== "acquired") assert.fail("No root lease");
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(acquired.lease, 60_000);
	return {
		pool,
		lease: acquired.lease,
		storage: sqlPoolStorage(journal)!,
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

/** The root's journal is another database, so the pool's tables live in the machine's coordination database. */
async function coordinationDatabase(): Promise<Harness> {
	const directory = makeTempDirectory("pool-session-claims-remote-");
	const durable = new MemoryRunJournal({ adapter: "remote", location: "memory" });
	await durable.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
	const acquired = await durable.acquire("root", "holder");
	if (acquired.status !== "acquired") assert.fail("No root lease");
	const coordination = await openSqlRunJournal(join(directory, "pool.sqlite"));
	const storage = sqlPoolStorage(coordination)!;
	const remote = new PoolRemoteJournal(durable, storage);
	await remote.mirror(acquired.lease);
	const pool = await openSqlPoolQueue(coordination, remote);
	await pool.initialize(acquired.lease, 60_000);
	return {
		pool,
		lease: acquired.lease,
		storage,
		async close() {
			await coordination.close();
			removeTempDirectory(directory);
		},
	};
}

async function withPoolSessions<T>(
	h: Harness,
	body: (sessions: Awaited<ReturnType<typeof poolTransactionSessionStore>>, tx: SqliteExecutor) => Promise<T>,
): Promise<T> {
	return h.storage.transaction(async (tx) => {
		const sessions = await poolTransactionSessionStore(tx, `${h.storage.tables.runs}_pool_`);
		try {
			return await body(sessions, tx);
		} finally {
			await sessions.close();
		}
	});
}

/** What a fork does for a pooled stage: copy its session into the pool tables, with no work owning it yet. */
function stageForkCopy(h: Harness, header: ReturnType<typeof copyHeader>): Promise<unknown> {
	return withPoolSessions(h, (sessions) => sessions.create(header, [message("copied", null)]));
}

const append = (sessionId: string, id: string) => ({
	kind: "session-append" as const,
	sessionId,
	entries: [message(id, "copied")],
	expectSeq: 1,
});

for (const [label, open] of [
	["a journal shared with the pool", localJournal],
	["a coordination database", coordinationDatabase],
] as const) {
	test(`a forked child's work claims the fork's copy of its stage session, once, so its attempt continues it, on ${label} (#4321)`, async () => {
		const h = await open();
		try {
			await stageForkCopy(h, copyHeader("fork-copy"));
			const queued = await h.pool.enqueue(h.lease, work, boundary);
			const attempt = (await h.pool.claim(h.lease, "worker", [work], 60_000))!;
			await assert.rejects(
				h.pool.commit(h.lease, attempt, "unclaimed", append("fork-copy", "unclaimed")),
				/Pool session scope mismatch/,
				"an unclaimed copy belongs to no work",
			);
			const claims = [claimOf("fork-copy")];
			const requeued = await h.pool.enqueue(h.lease, work, boundary, { claimSessions: claims });
			assert.equal(requeued.id, queued.id);
			assert.equal((await h.pool.enqueue(h.lease, work, boundary, { claimSessions: claims })).id, queued.id);
			const receipt = await h.pool.commit(h.lease, attempt, "continue", append("fork-copy", "continued"));
			assert.equal(receipt.lastSeq, 2);
			const snapshot = await withPoolSessions(h, (sessions) => sessions.load("fork-copy"));
			assert.deepEqual(
				snapshot.entries.map((entry) => entry.id),
				["copied", "continued"],
			);
			assert.equal(snapshot.header.workflow?.runId, work.childRunId);
		} finally {
			await h.close();
		}
	});

	test(`a claim refuses another work's session, a session the fork did not copy, and one outside the work, leaving nothing queued, on ${label} (#4321)`, async () => {
		const h = await open();
		try {
			await h.pool.enqueue(h.lease, other.work, other.boundary);
			const attempt = (await h.pool.claim(h.lease, "worker", [other.work], 60_000))!;
			const owned = {
				kind: "stage" as const,
				workflowId: "root",
				checkpointId: `${other.work.scope}:session:0`,
				name: "stage",
				replayKey: `${other.work.scope}:stage`,
				sessionId: "owned",
				completedAt: 0,
				topology: {
					version: 1 as const,
					stageId: "stage",
					parentIds: [],
					sourceOrder: 0,
					run: { ...other.boundary.topology!.boundary!.child },
				},
			};
			await h.pool.commit(h.lease, attempt, "create", {
				kind: "session-create",
				checkpoint: owned,
				header: { id: "owned", version: 4, createdAt: "2026-01-01T00:00:00Z", cwd: "/worker" },
				entries: [message("copied", null)],
			});
			const { parentSessionId: _parent, ...notACopy } = copyHeader("not-a-copy");
			await withPoolSessions(h, (sessions) => sessions.create(notACopy, [message("copied", null)]));
			await stageForkCopy(h, copyHeader("other-run", "another-run"));
			const { internal: _internal, ...notInternal } = copyHeader("not-internal");
			await withPoolSessions(h, (sessions) => sessions.create(notInternal, [message("copied", null)]));
			const { workflow: _workflow, ...runless } = copyHeader("runless");
			await withPoolSessions(h, (sessions) => sessions.create(runless, [message("copied", null)]));
			await stageForkCopy(h, copyHeader("in-scope"));
			await stageForkCopy(h, copyHeader("elsewhere"));
			const refusals: readonly [ForkSessionClaimReason, PoolSessionClaim][] = [
				["owned-by-other-work", claimOf("owned")],
				["not-fork-copy", claimOf("not-a-copy")],
				["not-fork-copy", claimOf("not-internal")],
				["run-mismatch", claimOf("other-run")],
				["run-mismatch", claimOf("runless")],
				["missing", claimOf("missing")],
				["outside-scope", claimOf("elsewhere", `${other.work.scope}:stage`)],
			];
			for (const [what, claim] of refusals) {
				await assert.rejects(
					h.pool.enqueue(h.lease, work, boundary, { claimSessions: [claimOf("in-scope"), claim] }),
					(error: unknown) => {
						assert.ok(error instanceof ForkSessionClaimError, what);
						assert.ok(isForkSessionClaimError(error));
						assert.deepEqual(
							[error.code, error.reason, error.retryable, error.cleanupCause],
							["session-claim-refused", what, false, undefined],
						);
						assert.deepEqual(error.fields, {
							reason: what,
							sessionId: claim.sessionId,
							rootRunId: "root",
							childRunId: work.childRunId,
							scope: work.scope,
							replayKey: claim.replayKey,
							stageRunId: claim.runId,
						});
						return true;
					},
				);
				assert.deepEqual(
					(await h.pool.inspect("root")).map((queued) => queued.childRunId),
					[other.work.childRunId],
					`${what}: the refused work was not queued`,
				);
			}
			const owner = await withPoolSessions(h, (_sessions, tx) =>
				tx.get(`SELECT work FROM ${h.storage.tables.runs}_pool_session_owners WHERE session = ?`, "in-scope"),
			);
			assert.equal(owner, undefined, "a refused claim takes over nothing");
			assert.equal(
				(await h.pool.commit(h.lease, attempt, "kept", append("owned", "kept"))).lastSeq,
				2,
				"the owner keeps its session",
			);
		} finally {
			await h.close();
		}
	});
}

test("a refused claim crosses coordinator IPC as the same ForkSessionClaimError (#4321)", async () => {
	const h = await localJournal();
	const { port1, port2 } = new MessageChannel();
	try {
		const failure = await h.pool
			.enqueue(h.lease, work, boundary, { claimSessions: [claimOf("missing")] })
			.catch((error: Error) => error);
		assert.ok(failure instanceof ForkSessionClaimError);
		const reply = failedCoordinatorReply(7, failure);
		const receivedText = new Promise<string>((resolve) => port2.once("message", resolve));
		port1.postMessage(JSON.stringify(reply));
		const received = JSON.parse(await receivedText) as CoordinatorReply;
		assert.equal(received.id, 7);
		const error = coordinatorReplyError(received);
		assert.ok(error instanceof ForkSessionClaimError);
		assert.ok(isForkSessionClaimError(error));
		assert.deepEqual(
			[error.code, error.reason, error.sessionId, error.rootRunId, error.childRunId, error.scope, error.stageRunId],
			["session-claim-refused", "missing", "missing", "root", work.childRunId, work.scope, work.childRunId],
		);
		assert.equal(error.message, received.error?.message);
		assert.deepEqual(error.fields, failure.fields);
		assert.deepEqual(await h.pool.inspect("root"), [], "nothing was queued");
		const plain = coordinatorReplyError(failedCoordinatorReply(8, new Error("Pool boundary identity mismatch")));
		assert.equal(plain.constructor, Error, "a failure outside the fork family still crosses as its message");
		assert.equal(plain.message, "Pool boundary identity mismatch");
	} finally {
		port1.close();
		port2.close();
		await h.close();
	}
});

test("a pool session store that fails to close after a refused claim is attached to the refusal, never in its place (#4321)", async () => {
	const h = await localJournal();
	try {
		const closeFailure = new Error("close failed");
		vi.spyOn(SqlSessionStore.prototype, "close").mockRejectedValue(closeFailure);
		await assert.rejects(
			h.pool.enqueue(h.lease, work, boundary, { claimSessions: [claimOf("missing")] }),
			(error: unknown) => {
				assert.ok(error instanceof ForkSessionClaimError);
				assert.equal(error.reason, "missing");
				assert.equal(error.cleanupCause, closeFailure);
				return true;
			},
		);
		assert.deepEqual(await h.pool.inspect("root"), []);
	} finally {
		vi.restoreAllMocks();
		await h.close();
	}
});

/** A second root in the same journal whose child has the same scope as the first root's: forks of one source do. */
async function secondRoot() {
	const directory = makeTempDirectory("pool-session-claims-two-roots-");
	const database = await openNodeSqliteDatabase(join(directory, "journal.sqlite"));
	const journal = await SqlRunJournal.open(database);
	const leases: Lease[] = [];
	for (const runId of ["root", "root-b"]) {
		await journal.createRun({ runId, name: runId, cwd: "", createdAt: 0, status: "running" });
		const acquired = await journal.acquire(runId, "coordinator");
		if (acquired.status !== "acquired") assert.fail("No root lease");
		leases.push(acquired.lease);
	}
	const pool = await openSqlPoolQueue(journal);
	for (const lease of leases) await pool.initialize(lease, 60_000);
	const rebased = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('"root"', '"root-b"')) as T;
	const workB = { ...work, childRunId: "child-b" };
	const boundaryB = rebased(boundary);
	(boundaryB.topology!.boundary!.child as { runId: string }).runId = "child-b";
	return {
		pool,
		leases: leases as [Lease, Lease],
		storage: sqlPoolStorage(journal)!,
		workB,
		boundaryB,
		async close() {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

test("a claim never takes a session another root's work owns for the same stage of the same scope (#4321)", async () => {
	const f = await secondRoot();
	try {
		const [rootLease, otherLease] = f.leases;
		await f.pool.enqueue(otherLease, f.workB, f.boundaryB);
		const attempt = (await f.pool.claim(otherLease, "worker", [f.workB], 60_000))!;
		await f.pool.commit(otherLease, attempt, "create", {
			kind: "session-create",
			checkpoint: {
				kind: "stage",
				workflowId: "root-b",
				checkpointId: `${work.scope}:session:0`,
				name: "stage",
				replayKey: `${work.scope}:stage`,
				sessionId: "shared",
				completedAt: 0,
				topology: {
					version: 1,
					stageId: "stage",
					parentIds: [],
					sourceOrder: 0,
					run: { ...f.boundaryB.topology!.boundary!.child },
				},
			},
			header: { id: "shared", version: 4, createdAt: "2026-01-01T00:00:00Z", cwd: "/worker" },
			entries: [message("copied", null)],
		});
		await assert.rejects(
			f.pool.enqueue(rootLease, work, boundary, { claimSessions: [claimOf("shared")] }),
			(error: unknown) => error instanceof ForkSessionClaimError && error.reason === "owned-by-other-work",
		);
		assert.deepEqual(await f.pool.inspect("root"), []);
	} finally {
		await f.close();
	}
});

test("a session the work took over for one stage is refused for another stage (#4321)", async () => {
	const h = await localJournal();
	try {
		await stageForkCopy(h, copyHeader("fork-copy"));
		const queued = await h.pool.enqueue(h.lease, work, boundary, { claimSessions: [claimOf("fork-copy")] });
		await assert.rejects(
			h.pool.enqueue(h.lease, work, boundary, { claimSessions: [claimOf("fork-copy", `${work.scope}:other`)] }),
			(error: unknown) => {
				assert.ok(error instanceof ForkSessionClaimError);
				assert.deepEqual([error.reason, error.replayKey], ["claimed-for-other-stage", `${work.scope}:other`]);
				return true;
			},
		);
		assert.deepEqual(
			(await h.pool.inspect("root")).map((entry) => entry.id),
			[queued.id],
		);
	} finally {
		await h.close();
	}
});

test("an empty claim list opens no pool session store (#4321)", async () => {
	const h = await localJournal();
	try {
		vi.spyOn(SqlSessionStore.prototype, "close").mockRejectedValue(new Error("close failed"));
		assert.equal((await h.pool.enqueue(h.lease, work, boundary, { claimSessions: [] })).childRunId, work.childRunId);
	} finally {
		vi.restoreAllMocks();
		await h.close();
	}
});

test("a pool session store that fails to close after accepted claims fails the enqueue, which queues nothing (#4321)", async () => {
	const h = await localJournal();
	try {
		await stageForkCopy(h, copyHeader("fork-copy"));
		const closeFailure = new Error("close failed");
		vi.spyOn(SqlSessionStore.prototype, "close").mockRejectedValue(closeFailure);
		await assert.rejects(
			h.pool.enqueue(h.lease, work, boundary, { claimSessions: [claimOf("fork-copy")] }),
			(error: unknown) => error === closeFailure,
		);
		vi.restoreAllMocks();
		assert.deepEqual(await h.pool.inspect("root"), []);
	} finally {
		vi.restoreAllMocks();
		await h.close();
	}
});

test("a claim that fails outside the fork family keeps its failure and logs the store's close failure once (#4321)", async () => {
	const h = await localJournal();
	try {
		await stageForkCopy(h, copyHeader("fork-copy"));
		const readFailure = new Error("read failed");
		const closeFailure = new Error("close failed");
		vi.spyOn(SqlSessionStore.prototype, "readHeader").mockRejectedValue(readFailure);
		vi.spyOn(SqlSessionStore.prototype, "close").mockRejectedValue(closeFailure);
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		await assert.rejects(
			h.pool.enqueue(h.lease, work, boundary, { claimSessions: [claimOf("fork-copy")] }),
			(error: unknown) => error === readFailure,
		);
		assert.deepEqual(warned.mock.calls, [
			["atomic-workflows: closing the pool sessions of a failed claim failed", closeFailure],
		]);
	} finally {
		vi.restoreAllMocks();
		await h.close();
	}
});
