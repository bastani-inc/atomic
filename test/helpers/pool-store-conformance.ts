import assert from "node:assert/strict";
import type { SessionEntry } from "@bastani/atomic";
import { dialectOf, type SqliteDatabase, type SqliteRow, type SqliteValue } from "@bastani/atomic/storage";
import { describe } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { poolStageUsageKey } from "../../packages/workflows/src/durable/journal/pool-stage-usage.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import type { PoolMutation, PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { readFleetRateUsage, SqlRateBuckets } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	readSharedPoolFleet,
	readSharedPoolStats,
	SqlSharedPool,
} from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { isStaleLeaseError, type Lease, RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { isStaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { CheckpointShipping } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { openPoolSessions } from "../../packages/workflows/src/workers/pool-session-store.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { ShipShard } from "../../packages/workflows/src/workers/ship-shard.js";
import { interceptingDatabase } from "./intercepting-database.js";
import { staleWorkLease } from "./pool-errors.js";
import { poolWorkFixture } from "./pool-journal.js";

/**
 * The worker pool's stores on one backend (#4793): the work queue with its commits, pooled-stage sessions and usage,
 * shared placement, the fleet controller's tables and resource admission. Each test opens journals on independent
 * connections to one database, as a root and its worker hosts do.
 */

type Runner = (name: string, body: () => Promise<void>, timeoutMs?: number) => void;

/** An isolated database: every `connect` is another connection to it, as another host would open. */
export interface PoolStoreScope {
	readonly prefix: string;
	connect(): Promise<SqliteDatabase>;
	close(): Promise<void>;
}

const { work, boundary } = poolWorkFixture();
const definition = { definition: work.definition, digest: work.digest };
const run = { ...boundary.topology!.boundary!.child };
const checkpoint: DurableToolCheckpoint = {
	kind: "tool",
	workflowId: "root",
	checkpointId: `${work.scope}:tool:1`,
	name: "tool",
	argsHash: `${work.scope}:args`,
	output: { saved: true },
	completedAt: 1,
	topology: { version: 1, nodeId: "tool", parentIds: [], ordinal: 0, order: 0, run },
};
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
const messages: SessionEntry[] = [
	{
		type: "message",
		id: "message",
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		// A NUL escape in an entry: Postgres reads JSON with it, as SQLite does.
		message: { role: "user", content: "durable prompt \u0000", timestamp: 1 },
	},
];
const createSession = {
	kind: "session-create" as const,
	checkpoint: stage,
	header: { id: "session", version: 4 as const, createdAt: "2026-01-01T00:00:00Z", cwd: "/gone/scratch" },
	entries: messages,
};
const sharedConfig = {
	definitions: [],
	admission: { limits: { session: 2 } },
	leaseMs: 60_000,
	heartbeatMs: 15_000,
	startupTimeoutMs: 60_000,
	claimWindowMs: 60_000,
};

/** A root registered in a journal on its own connection, holding its lease, with its pool initialized. */
async function rootFixture(scope: PoolStoreScope) {
	const database = await scope.connect();
	const journal = await SqlRunJournal.open(database, { prefix: scope.prefix });
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire("root", backend.holderId);
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(lease, 60_000);
	const peers: SqlRunJournal[] = [];
	return {
		database,
		journal,
		backend,
		pool,
		lease,
		/** A table of this scope's journal. */
		table: (name: string) => `${scope.prefix}${name}`,
		/**
		 * A journal on another connection to the same database, as another host opens. `failures` collects every lock
		 * conflict (deadlock or serialization failure) a statement of it met, including those its writes ran again.
		 */
		async peer(failures?: Error[]) {
			const connection = await scope.connect();
			const database =
				failures === undefined
					? connection
					: interceptingDatabase(connection, {
							all: (sql: string, params: readonly SqliteValue[], next) =>
								next(sql, ...params).catch((error: Error) => {
									if ((error as Error & { code?: string }).code === "lock-conflict") failures.push(error);
									throw error;
								}),
						});
			const peer = await SqlRunJournal.open(database, { prefix: scope.prefix });
			peers.push(peer);
			return peer;
		},
		async close() {
			for (const peer of peers) await peer.close();
			await backend.close();
			await journal.close();
		},
	};
}

export function registerPoolStoreConformance(run_: Runner, name: string, openScope: () => Promise<PoolStoreScope>) {
	const test = (
		title: string,
		body: (f: Awaited<ReturnType<typeof rootFixture>>) => Promise<void>,
		timeoutMs?: number,
	) =>
		run_(
			title,
			async () => {
				const scope = await openScope();
				try {
					const f = await rootFixture(scope);
					try {
						await body(f);
					} finally {
						await f.close();
					}
				} finally {
					await scope.close();
				}
			},
			timeoutMs,
		);

	describe(name, () => {
		test("control revisions survive reopening and close admission without deleting work", async (f) => {
			const queued = await f.pool.enqueue(f.lease, work, boundary);
			const paused = await f.pool.setControl(f.lease, "paused");
			assert.equal(paused.revision, 1);
			assert.equal(await f.pool.claim(f.lease, "worker", [definition], 60_000), undefined);
			const recovered = await openSqlPoolQueue(await f.peer());
			assert.deepEqual(await recovered.control(f.lease), paused);
			assert.deepEqual(await recovered.inspect("root"), [queued]);
			assert.equal((await recovered.setControl(f.lease, "running")).revision, 2);
			assert.equal(
				(await recovered.setControl(f.lease, "running")).revision,
				2,
				"the same state keeps its revision",
			);
			const claimed = await recovered.claim(f.lease, "worker", [definition], 60_000);
			assert.ok(claimed);
			await recovered.assertCurrent(f.lease, claimed);
			await assert.rejects(
				recovered.assertCurrent(f.lease, { ...claimed, generation: 0 }),
				staleWorkLease({ root: "root", workId: claimed.id, generation: 0, reason: "generation-mismatch" }),
			);
			assert.equal((await recovered.setControl(f.lease, "quit")).revision, 3);
			assert.equal((await recovered.inspect("root"))[0]?.id, queued.id);
		});

		test("another host discovers exited and unplaced releases without notifications (#5230)", async (f) => {
			await f.pool.enqueue(f.lease, work, boundary);
			const peer = await openSqlPoolQueue(await f.peer());
			const marks = new Set<string>();
			const first = await peer.readyMark("root");
			assert.ok(first !== undefined);
			marks.add(first);
			for (const kind of ["exited", "unplaced", "exited", "unplaced"] as const) {
				const claim = await f.pool.claim(f.lease, "worker", [definition], 60_000);
				assert.ok(claim);
				assert.equal(await peer.readyMark("root"), undefined);
				assert.equal(
					await (kind === "exited"
						? f.pool.releaseExited(f.lease, claim)
						: f.pool.releaseUnplaced(f.lease, claim)),
					true,
				);
				const released = await peer.readyMark("root");
				assert.ok(released !== undefined);
				assert.equal(marks.has(released), false, `${kind} release must change the other host's ready mark`);
				marks.add(released);
				assert.equal(await peer.readyMark("root"), released);
			}
			assert.deepEqual(await peer.control(f.lease), { state: "running", revision: 0 });
		});

		test("work is enqueued once, by boundary, scope or child, and a conflicting identity is refused", async (f) => {
			const first = await f.pool.enqueue(f.lease, work, boundary);
			assert.deepEqual(await f.pool.enqueue(f.lease, work, boundary), first);
			await assert.rejects(f.pool.enqueue(f.lease, { ...work, digest: "changed" }, boundary), /identity conflict/);
			const nested = poolWorkFixture("nested", "child-nested", `${work.scope}:inner`);
			await assert.rejects(f.pool.enqueue(f.lease, nested.work, nested.boundary), /scopes overlap/);
			const other = poolWorkFixture("other");
			await f.pool.enqueue(f.lease, other.work, other.boundary);
			const peer = await openSqlPoolQueue(await f.peer());
			assert.deepEqual(
				(await peer.inspect("root")).map((item) => item.boundaryId),
				["boundary", "other"],
				"work lists in the order it was queued",
			);
			assert.deepEqual(
				(await peer.readyCandidates(f.lease, [definition], 10)).map((candidate) => candidate.generation),
				[0, 0],
			);
		});

		test("independent connections claim once, renewals never shorten a lease, and expiry hands work back", async (f) => {
			const peer = await openSqlPoolQueue(await f.peer());
			await f.pool.enqueue(f.lease, work, boundary);
			assert.equal(
				await peer.claim(f.lease, "incompatible", [{ definition: work.definition, digest: "wrong" }], 60_000),
				undefined,
			);
			const claims = await Promise.all([
				f.pool.claim(f.lease, "one", [definition], 60_000),
				peer.claim(f.lease, "two", [definition], 60_000),
			]);
			assert.equal(claims.filter(Boolean).length, 1);
			const held = claims.find((claim) => claim !== undefined)!;
			assert.equal(held.generation, 1);
			assert.equal(held.expiresAt - held.renewedAt, 60_000);
			const renewed = await f.pool.renew(f.lease, held, 60_000);
			const later = await peer.renew(f.lease, held, 70_000);
			assert.ok(later.expiresAt > renewed.expiresAt);
			assert.equal((await peer.renew(f.lease, held, 60_000)).expiresAt, later.expiresAt, "renewal never shortens");
			assert.equal(await f.pool.expire(f.lease, held), false);
			await f.database.run(`UPDATE ${f.table("wf_runs_work")} SET expires_at = 0`);
			await assert.rejects(
				f.pool.renew(f.lease, held, 60_000),
				staleWorkLease({ workId: held.id, generation: held.generation, reason: "expired" }),
			);
			assert.equal(await f.pool.expire(f.lease, held, { handOffUnconfirmed: true }), true);
			assert.deepEqual((await f.pool.inspect("root"))[0]?.handoffs, [held.generation]);
			const replacement = await peer.claim(f.lease, held.worker!, [definition], 60_000);
			assert.equal(replacement?.generation, 2);
			assert.equal(await peer.confirmed(replacement!), false);
		});

		test("checkpoints and stage sessions commit once, survive reopening, and fence a replaced attempt", async (f) => {
			await f.pool.enqueue(f.lease, work, boundary);
			const attempt = await f.pool.claim(f.lease, "worker", [definition], 60_000);
			assert.ok(attempt);
			const saved = await f.pool.commit(f.lease, attempt, "save", { kind: "checkpoint", checkpoint });
			assert.deepEqual(await f.pool.commit(f.lease, attempt, "save", { kind: "checkpoint", checkpoint }), saved);
			await assert.rejects(
				f.pool.commit(f.lease, attempt, "save", { kind: "checkpoint", checkpoint: { ...checkpoint, output: "x" } }),
				/identity conflict/,
			);
			const created = await f.pool.commit(f.lease, attempt, "create", createSession);
			assert.equal(created.lastSeq, 1);
			const journal = await f.peer();
			const peer = await openSqlPoolQueue(journal);
			const projection = await JournalDurableBackend.open(journal, { ownsJournal: false });
			const sessions = await openPoolSessions(sqlPoolStorage(journal)!);
			try {
				assert.deepEqual(await peer.commit(f.lease, attempt, "save", { kind: "checkpoint", checkpoint }), saved);
				assert.deepEqual(projection.getToolOutput("root", checkpoint.argsHash), { saved: true });
				assert.deepEqual((await sessions.load("session")).entries, messages);
				await f.database.run(`UPDATE ${f.table("wf_leases")} SET renewed_at = 0`);
				const takeover = await journal.takeoverExpired("root", "replacement-coordinator", 60_000);
				if (takeover.status !== "acquired") assert.fail("No takeover");
				await peer.expire(takeover.lease, attempt);
				await peer.enqueue(takeover.lease, work, boundary);
				const next = await peer.claim(takeover.lease, "replacement-worker", [definition], 60_000);
				assert.ok(next);
				assert.equal(next.generation, attempt.generation + 1);
				await assert.rejects(
					peer.commit(takeover.lease, attempt, "late", { kind: "checkpoint", checkpoint }),
					staleWorkLease({ workId: attempt.id, generation: attempt.generation, reason: "epoch-mismatch" }),
				);
				assert.deepEqual(
					await peer.commit(takeover.lease, next, "save", { kind: "checkpoint", checkpoint }),
					saved,
				);
				const append = {
					kind: "session-append" as const,
					sessionId: "session",
					entries: [{ ...messages[0]!, id: "continued", parentId: "message" }],
					expectSeq: 1,
				};
				await assert.rejects(
					peer.commit(takeover.lease, next, "wrong-session", { ...append, sessionId: "unowned-session" }),
					/scope/,
				);
				assert.equal((await peer.commit(takeover.lease, next, "continue", append)).lastSeq, 2);
				assert.deepEqual((await sessions.load("session")).entries, [...messages, ...append.entries]);
			} finally {
				await sessions.close();
				await projection.close();
			}
		});

		for (const size of [3, 1_000])
			test(`a host's shipped batch of ${size} records each checkpoint once, a retried batch nothing, and a replaced attempt's batch is fenced (#4768)`, async (f) => {
				await f.pool.enqueue(f.lease, work, boundary);
				const attempt = await f.pool.claim(f.lease, "worker", [definition], 60_000);
				assert.ok(attempt);
				const item = { work, boundary };
				const events = Array.from({ length: size }, (_, index) => {
					const shipped = toolCheckpointOf(item, index + 1);
					return {
						localSeq: index + 1,
						key: JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, "tool", shipped.checkpointId]),
						payload: JSON.stringify(shipped),
					};
				});
				const batch = { id: "batch-1", host: "host-A", events };
				const journal = await f.peer();
				const host = await openSqlPoolQueue(journal);
				await host.shipBatch(f.lease, attempt, batch);
				await f.pool.shipBatch(f.lease, attempt, batch);
				await assertDenseEvents(f, size + 1);
				const ledger = await f.database.all<{ events: number }>(
					`SELECT events FROM ${f.table("wf_runs_ship_batches")}`,
				);
				assert.deepEqual(
					ledger.map((row) => Number(row.events)),
					[size],
				);
				await host.releaseExited(f.lease, attempt);
				const next = await host.claim(f.lease, "replacement-worker", [definition], 60_000);
				assert.ok(next);
				const late = toolCheckpointOf(item, size + 1);
				await assert.rejects(
					f.pool.shipBatch(f.lease, attempt, {
						id: "batch-late",
						host: "host-A",
						events: [
							{
								localSeq: size + 1,
								key: JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, "tool", late.checkpointId]),
								payload: JSON.stringify(late),
							},
						],
					}),
					staleWorkLease({ workId: attempt.id, generation: attempt.generation }),
				);
				await assertDenseEvents(f, size + 1);
			});
		for (const maxBatch of [1_000, 2])
			test(`a host's shipped session writes, checkpoints and billed usage, ${maxBatch === 2 ? "in batches of two" : "in one batch"}, leave what committing them one by one leaves (#4768)`, async (f) => {
				const direct = poolWorkFixture("direct");
				const shipped = poolWorkFixture("shipped");
				for (const item of [direct, shipped]) await f.pool.enqueue(f.lease, item.work, item.boundary);
				const claimed = async (item: ReturnType<typeof poolWorkFixture>) => {
					const attempt = await f.pool.claim(
						f.lease,
						`worker-${item.work.boundaryId}`,
						[{ definition: item.work.definition, digest: item.work.digest }],
						60_000,
						{
							kind: "work",
							id: (await f.pool.inspect("root")).find((queued) => queued.boundaryId === item.work.boundaryId)!
								.id,
							generation: 0,
						},
					);
					assert.ok(attempt);
					return attempt;
				};
				const directAttempt = await claimed(direct);
				const shippedAttempt = await claimed(shipped);
				const journal = await f.peer();
				const host = await openSqlPoolQueue(journal);
				const ledger = await openSqlPoolUsage(journal);
				for (const [index, mutation] of sessionWrites(direct, "direct-session").entries())
					await f.pool.commit(f.lease, directAttempt, `op-${index}`, mutation);
				const { shipping, receipts } = await shippingHost(host, f.lease, shippedAttempt, maxBatch);
				for (const [index, mutation] of sessionWrites(shipped, "shipped-session").entries())
					receipts.push(await shipping.commit(shippedAttempt, mutation, unshipped, { operation: `op-${index}` }));
				assert.ok(
					receipts.every((receipt) => receipt.local === true),
					"the host acknowledged every write locally",
				);
				assert.deepEqual(
					receipts.flatMap((receipt) => (receipt.lastSeq === undefined ? [] : [receipt.lastSeq])),
					[1, 2, 4, 2, 3],
					"each session write's receipt carries the sequence the session store gives it",
				);
				const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5 };
				assert.deepEqual(
					await ledger.total("root"),
					{ ...usage, input: 14, output: 6, cost: 1 },
					"billed as accepted",
				);
				await shipping.flush(shippedAttempt);
				await shipping.close();
				assert.deepEqual(await ledger.total("root"), { ...usage, input: 14, output: 6, cost: 1 }, "never twice");
				const sessions = await openPoolSessions(sqlPoolStorage(journal)!);
				try {
					const [one, other] = [await sessions.load("direct-session"), await sessions.load("shipped-session")];
					assert.equal(other.lastSeq, one.lastSeq);
					assert.deepEqual(other.entries, one.entries);
					assert.deepEqual({ ...other.header, id: "" }, { ...one.header, id: "" });
					const listed = new Map<string, unknown>();
					for await (const summary of sessions.list({ cwd: "/gone/scratch", includeInternal: true }))
						listed.set(summary.id, { messageCount: summary.messageCount, firstMessage: summary.firstMessage });
					assert.deepEqual(listed.get("shipped-session"), listed.get("direct-session"));
					if (sessions.readResume !== undefined) {
						const [a, b] = [
							await sessions.readResume("direct-session"),
							await sessions.readResume("shipped-session"),
						];
						assert.deepEqual(
							b.branch.map((stored) => [stored.seq, stored.entry.id]),
							a.branch.map((stored) => [stored.seq, stored.entry.id]),
						);
					}
				} finally {
					await sessions.close();
				}
				// The same checkpoints, each the same value, in the same order: a session write's event records only the
				// checkpoint it binds with.
				const recorded = async (scope: string, name: string) =>
					(
						await f.database.all<{ key: string; payload: string }>(
							`SELECT key, payload FROM ${f.table("wf_events")} WHERE run_id = ? AND key LIKE ? ORDER BY seq`,
							"root",
							`%${scope}:%`,
						)
					).map((row) => JSON.parse(`[${row.key},${row.payload}]`.replaceAll(name, "child")));
				const shippedEvents = await recorded(shipped.work.scope, "shipped");
				assert.equal(shippedEvents.length, 4, "two session bindings, a tool checkpoint and the stage's end");
				assert.deepEqual(shippedEvents, await recorded(direct.work.scope, "direct"));
				await assertDenseEvents(f);
			});

		test("a replaced attempt's unshipped session writes never reach its session, and the replacement continues it from what was shipped (#4768)", async (f) => {
			const item = poolWorkFixture("takeover");
			await f.pool.enqueue(f.lease, item.work, item.boundary);
			const definitionOf = [{ definition: item.work.definition, digest: item.work.digest }];
			const first = (await f.pool.claim(f.lease, "worker-1", definitionOf, 60_000)) as PoolWork;
			assert.ok(first);
			const writes = sessionWrites(item, "taken-over");
			const hostA = await openSqlPoolQueue(await f.peer());
			const a = await shippingHost(hostA, f.lease, first, 1_000);
			// Host A ships the create and the first append, then keeps the next append and dies before it ships it.
			await a.shipping.commit(first, writes[0]!, unshipped);
			await a.shipping.commit(first, writes[1]!, unshipped, { operation: "a-1" });
			await a.shipping.flush(first);
			await a.shipping.commit(first, writes[3]!, unshipped, { operation: "a-3" });
			await f.database.run(`UPDATE ${f.table("wf_runs_work")} SET expires_at = 0`);
			assert.equal(await f.pool.expire(f.lease, first), true);
			const second = (await f.pool.claim(f.lease, "worker-2", definitionOf, 60_000)) as PoolWork;
			assert.equal(second.generation, first.generation + 1);
			// Host A's late batch is refused as a whole, and what it held is dropped.
			await assert.rejects(a.shipping.flush(first), isStaleWorkLeaseError);
			await a.shipping.close();
			const hostB = await openSqlPoolQueue(await f.peer());
			const b = await shippingHost(hostB, f.lease, second, 1_000);
			const resumed = {
				kind: "session-append",
				sessionId: "taken-over",
				entries: [{ ...messages[0]!, id: "replayed", parentId: "m-2" }],
				expectSeq: 2,
			} as PoolMutation;
			assert.equal((await b.shipping.commit(second, resumed, unshipped, { operation: "b-1" })).lastSeq, 3);
			await b.shipping.flush(second);
			await b.shipping.close();
			const sessions = await openPoolSessions(sqlPoolStorage(f.journal)!);
			try {
				assert.deepEqual(
					(await sessions.load("taken-over")).entries.map((entry) => entry.id),
					["m-1", "m-2", "replayed"],
				);
			} finally {
				await sessions.close();
			}
		});

		const CHECKPOINT_INTEGRITY_TIMEOUT_MS = 600_000;
		test(
			"1000 commits of 256 KiB checkpoints, one after another, all commit and read back intact (#5637)",
			async (f) => {
				await f.pool.enqueue(f.lease, work, boundary);
				const attempt = await f.pool.claim(f.lease, "worker", [definition], CHECKPOINT_INTEGRITY_TIMEOUT_MS);
				assert.ok(attempt);
				// Each commit past the 64 a queue keeps of its own reads the root's checkpoints since its watermark, 16 MiB
				// of them here: no value, row or response of that read may pass a libSQL server's limits.
				const sized = (step: number) => ({
					...toolCheckpointOf({ work, boundary }, step),
					output: largeOutput(step),
				});
				const seqs: number[] = [];
				for (let step = 0; step < 1000; step++) {
					const receipt = await f.pool
						.commit(f.lease, attempt, `step-${step}`, { kind: "checkpoint", checkpoint: sized(step) })
						.catch((error: Error) => assert.fail(`commit ${step + 1} of 1000 failed: ${error.message}`));
					seqs.push(receipt.seq!);
				}
				assert.deepEqual(
					seqs,
					seqs.map((_, index) => seqs[0]! + index),
					"each commit recorded the next event",
				);
				let read = 0;
				for await (const entry of (await f.peer()).read("root")) {
					// The child's boundary start, which queueing it recorded, comes first.
					if (entry.event.type !== RUN_EVENT_TYPES.checkpointRecorded || entry.event.payload.kind !== "tool")
						continue;
					assert.deepEqual(entry.event.payload, sized(read), `checkpoint ${read} reads back intact`);
					read++;
				}
				assert.equal(read, 1000);
			},
			CHECKPOINT_INTEGRITY_TIMEOUT_MS,
		);

		test("a completed child keeps its result and fences later writes", async (f) => {
			await f.pool.enqueue(f.lease, work, boundary);
			const attempt = await f.pool.claim(f.lease, "worker", [definition], 60_000);
			assert.ok(attempt);
			const result = { runId: work.childRunId, status: "completed", result: { saved: true } };
			await f.pool.complete(f.lease, attempt, result);
			await f.pool.complete(f.lease, attempt, result);
			const peer = await openSqlPoolQueue(await f.peer());
			assert.deepEqual(await peer.result("root", attempt.id), result);
			assert.equal((await peer.inspect("root"))[0]!.state, "completed");
			assert.equal(await peer.claim(f.lease, "another", [definition], 60_000), undefined);
			await assert.rejects(
				peer.commit(f.lease, attempt, "late", { kind: "checkpoint", checkpoint }),
				staleWorkLease({ workId: attempt.id, generation: attempt.generation, reason: "not-leased" }),
			);
			await assert.rejects(peer.complete(f.lease, attempt, { ...result, status: "failed" }), /identity conflict/);
		});

		test("usage reports keep each field's largest value and the root's running total", async (f) => {
			await f.pool.enqueue(f.lease, work, boundary);
			const attempt = await f.pool.claim(f.lease, "worker", [definition], 60_000);
			assert.ok(attempt);
			const ledger = await openSqlPoolUsage(f.journal);
			const key = poolStageUsageKey(run.runId, "stage");
			const first = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5 };
			assert.deepEqual(await ledger.report(f.lease, attempt, [{ key, usage: first }]), first);
			const lower = { ...first, input: 1, output: 9 };
			assert.deepEqual(await ledger.report(f.lease, attempt, [{ key, usage: lower }]), { ...first, output: 9 });
			const peer = await openSqlPoolUsage(await f.peer());
			assert.deepEqual(await peer.total("root"), { ...first, output: 9 });
		});

		test("shared placement publishes roots and host reports that the fleet store counts", async (f) => {
			const shared = await SqlSharedPool.open(f.journal, f.pool);
			await shared.publishConfig(f.lease, sharedConfig);
			for (const id of ["a", "b", "c"]) {
				const item = poolWorkFixture(id);
				await f.pool.enqueue(f.lease, item.work, item.boundary);
			}
			assert.ok(await f.pool.claim(f.lease, "h1/worker-1", [definition], 60_000));
			const report = (host: string, providerId?: string) =>
				shared.reportHost({
					host,
					labels: { zone: "a" },
					git: "unavailable",
					restore: false,
					workers: 1,
					maxWorkers: 1,
					roots: ["root"],
					...(providerId === undefined ? {} : { providerId }),
				});
			await report("h1", "vm-1");
			await report("h2");
			const peerJournal = await f.peer();
			const peer = await SqlSharedPool.open(peerJournal, await openSqlPoolQueue(peerJournal));
			assert.deepEqual(
				(await peer.roots()).map((root) => [root.root, root.status, root.fresh]),
				[["root", "running", true]],
			);
			assert.deepEqual(
				(await peer.registeredHosts()).map((host) => [host.host, host.providerId, host.labels]),
				[
					["h1", "vm-1", { zone: "a" }],
					["h2", undefined, { zone: "a" }],
				],
			);
			const store = await SqlFleetStore.open(peerJournal);
			const snapshot = await store.snapshot();
			assert.deepEqual(snapshot.roots, [
				{ root: "root", ready: 2, leased: 1, started: 0, sessionLimit: 2, blocked: false },
			]);
			assert.deepEqual([...snapshot.leased], [["h1", 1]]);
			await shared.publishBudget(f.lease, true);
			assert.equal((await store.snapshot()).roots[0]?.blocked, true);
		});

		test("fleet rate observations count started attempts, not restore renewals or earlier generations (#4768)", async (f) => {
			const shared = await SqlSharedPool.open(f.journal, f.pool);
			await shared.publishConfig(f.lease, sharedConfig);
			await f.pool.enqueue(f.lease, work, boundary);
			const peer = await SqlFleetStore.open(await f.peer());
			const counts = async () => {
				const [root] = (await peer.snapshot()).roots;
				return [root?.leased, root?.started];
			};
			const claim = async () => {
				const claimed = await f.pool.claim(f.lease, "h1/worker-1", [definition], 60_000);
				assert.ok(claimed);
				return claimed;
			};
			const restoring = await claim();
			assert.deepEqual(await counts(), [1, 0]);
			await f.pool.renew(f.lease, restoring, 60_000);
			await f.pool.extend(f.lease, restoring, 60_000);
			assert.deepEqual(await counts(), [1, 0], "lease maintenance during restore does not start the child");
			assert.equal(await f.pool.releaseUnplaced(f.lease, restoring), true);
			const started = await claim();
			assert.deepEqual(await counts(), [1, 0], "a placement handoff does not confirm the next claim");
			await f.pool.heartbeat(f.lease, started, 60_000, async () => {});
			assert.deepEqual(await counts(), [1, 1], "the worker's first heartbeat starts the observation");
			assert.equal(await f.pool.releaseExited(f.lease, started), true);
			assert.deepEqual(await counts(), [0, 0]);
			const replay = await claim();
			assert.ok(replay.generation > started.generation);
			assert.deepEqual(await counts(), [1, 0], "a previous generation's confirmation cannot start its replay");
			await f.pool.heartbeat(f.lease, replay, 60_000, async () => {});
			assert.deepEqual(await counts(), [1, 1]);
			await f.pool.complete(f.lease, replay, {
				runId: replay.childRunId,
				status: "completed",
				stages: [],
				toolNodes: [],
			});
			assert.deepEqual(await counts(), [0, 0], "completed attempts stop contributing busy time");
		});

		test("fleet status reads the controller that holds the fleet's lease, its latest decisions and every rate limit, from any connection (#4768)", async (f) => {
			const shared = await SqlSharedPool.open(f.journal, f.pool);
			await shared.publishConfig(f.lease, sharedConfig);
			const controller = await SqlFleetStore.open(f.journal);
			assert.deepEqual(await controller.acquire("controller-a", undefined, 60_000), { held: true, epoch: 1 });
			const fence = { holder: "controller-a", epoch: 1 };
			for (let step = 1; step <= 7; step++)
				await controller.record(fence, { kind: "scale-up", target: step + 1, live: step, reason: `step ${step}` });
			await controller.record(fence, {
				kind: "error",
				reason: "scaleTo https://me:secret@vault.example/x failed",
				error: "WorkerProvisionerError: az: https://me:secret@vault.example/x denied",
			});
			const buckets = await SqlRateBuckets.open(f.journal);
			await buckets.acquire("anthropic", 1, { intervalMs: 1_000, burst: 2 });
			await buckets.cooldown("openai/gpt", 30_000);
			await buckets.cooldown("expired", 1);
			const cooledBy = await databaseNow(f.database);
			while ((await databaseNow(f.database)) <= cooledBy + 2) await delay(1);
			const peer = await f.peer();
			const fleet = (await readSharedPoolStats(peer, "root"))!.fleet;
			assert.deepEqual(
				{ holder: fleet.controller?.holder, epoch: fleet.controller?.epoch },
				{ holder: "controller-a", epoch: 1 },
			);
			assert.ok(
				fleet.controller !== undefined &&
					fleet.controller.renewedAgoMs >= 0 &&
					fleet.controller.renewedAgoMs < 60_000,
				JSON.stringify(fleet.controller),
			);
			assert.deepEqual(
				fleet.scaleEvents?.map((event) => [
					event.seq,
					event.kind,
					event.target,
					event.live,
					event.reason,
					event.error,
				]),
				[
					[
						8,
						"error",
						undefined,
						undefined,
						"scaleTo https://vault.example/x failed",
						{ name: "WorkerProvisionerError", message: "az: https://vault.example/x denied" },
					],
					[7, "scale-up", 8, 7, "step 7", undefined],
					[6, "scale-up", 7, 6, "step 6", undefined],
					[5, "scale-up", 6, 5, "step 5", undefined],
					[4, "scale-up", 5, 4, "step 4", undefined],
				],
			);
			assert.deepEqual(
				fleet.rateLimits?.map((limit) => [limit.scope, limit.requestsPerMinute, limit.cooldownInMs > 0]),
				[
					["anthropic", 60, false],
					["openai/gpt", undefined, true],
				],
			);
			const cooling = fleet.rateLimits![1]!.cooldownInMs;
			assert.ok(cooling > 0 && cooling <= 30_000, String(cooling));
			const fromFleet = (await readSharedPoolFleet(peer))!.fleet;
			assert.deepEqual(
				[
					fromFleet.controller?.holder,
					fromFleet.scaleEvents?.map((event) => event.seq),
					fromFleet.rateLimits?.length,
				],
				["controller-a", [8, 7, 6, 5, 4], 2],
			);
			await controller.release(fence);
			const after = (await readSharedPoolStats(peer, "root"))!.fleet;
			assert.equal(after.controller, undefined, "a controller that gave its lease up holds no fleet");
			assert.equal(after.scaleEvents?.length, 5);
		});

		test("a host's checkpoint shipping and its children's progress reach fleet status from any connection, until a host of 0.9.88 reports in its place (#4768)", async (f) => {
			const shared = await SqlSharedPool.open(f.journal, f.pool);
			await shared.publishConfig(f.lease, sharedConfig);
			const item = poolWorkFixture("progress");
			await f.pool.enqueue(f.lease, item.work, item.boundary);
			const claimed = await f.pool.claim(f.lease, "h1/worker-1", [definition], 60_000);
			assert.ok(claimed);
			const report = {
				host: "h1",
				labels: {},
				git: "unavailable" as const,
				restore: false,
				workers: 1,
				maxWorkers: 1,
				roots: ["root"],
				busy: 1,
			};
			await shared.reportHost({
				...report,
				shipping: {
					lagMs: 1_500,
					pending: 4,
					lagging: true,
					error: { name: "StorageError", message: "fetch libsql://me:pw@db.example/x failed" },
				},
				progress: [{ work: claimed.id, agoMs: 250, checkpoints: 3 }],
			});
			const reportedBy = await databaseNow(f.database);
			const reportAgeMs = 50;
			while ((await databaseNow(f.database)) < reportedBy + reportAgeMs) await delay(1);
			const peer = await f.peer();
			const stats = (await readSharedPoolStats(peer, "root"))!;
			assert.deepEqual(stats.hosts.find((host) => host.host === "h1")?.shipping, {
				lagMs: 1_500,
				pending: 4,
				lagging: true,
				error: { name: "StorageError", message: "fetch libsql://db.example/x failed" },
			});
			const [lease] = stats.leases;
			assert.equal(lease?.checkpoints, 3);
			assert.ok(
				lease?.lastProgressAgoMs !== undefined &&
					lease.lastProgressAgoMs >= 250 + reportAgeMs &&
					lease.lastProgressAgoMs < 60_250,
				JSON.stringify(lease),
			);
			const older = await release0988();
			const olderJournal = await f.peer();
			older.adopt(olderJournal);
			const olderPool = await older.SqlSharedPool.open(olderJournal, await openSqlPoolQueue(olderJournal));
			const reported = await databaseNow(f.database);
			while ((await databaseNow(f.database)) <= reported) await delay(1);
			await olderPool.reportHost(report);
			const replaced = (await readSharedPoolStats(peer, "root"))!;
			assert.equal(replaced.hosts.find((host) => host.host === "h1")?.shipping, undefined);
			assert.deepEqual(
				replaced.leases.map((entry) => [entry.lastProgressAgoMs, entry.checkpoints]),
				[[undefined, undefined]],
				"a report of a version that sends no progress hides what an earlier report of the host sent",
			);
		});

		for (const first of ["0.9.88", "this version"] as const)
			test(`a 0.9.88 host and this version share one pool's registry and rate buckets when ${first} opens them first (#4768)`, async (f) => {
				const older = await release0988();
				const olderJournal = await f.peer();
				older.adopt(olderJournal);
				const newerJournal = await f.peer();
				const openOlder = async () => ({
					pool: await older.SqlSharedPool.open(olderJournal, await openSqlPoolQueue(olderJournal)),
					buckets: await older.SqlRateBuckets.open(olderJournal),
				});
				const openNewer = async () => ({
					pool: await SqlSharedPool.open(newerJournal, await openSqlPoolQueue(newerJournal)),
					buckets: await SqlRateBuckets.open(newerJournal),
				});
				const [olderStores, newerStores] =
					first === "0.9.88"
						? [await openOlder(), await openNewer()]
						: await (async () => {
								const newer = await openNewer();
								return [await openOlder(), newer] as const;
							})();
				await newerStores.pool.publishConfig(f.lease, sharedConfig);
				const host = (name: string) => ({
					host: name,
					labels: {},
					git: "unavailable" as const,
					restore: false,
					workers: 1,
					maxWorkers: 2,
					roots: ["root"],
					busy: 0,
				});
				await olderStores.pool.reportHost(host("h-0.9.88"));
				await newerStores.pool.reportHost({ ...host("h-new"), shipping: { lagMs: 0, pending: 0 } });
				const shape = { intervalMs: 1_000, burst: 10 };
				assert.deepEqual(await olderStores.buckets.acquire("anthropic", 2, shape), { granted: 2 });
				assert.deepEqual(await newerStores.buckets.acquire("anthropic", 3, shape), { granted: 3 });
				const reopened = await openOlder();
				await reopened.pool.reportHost(host("h-0.9.88"));
				assert.deepEqual(await reopened.buckets.acquire("anthropic", 1, shape), { granted: 1 });
				assert.deepEqual(
					(await reopened.pool.registeredHosts()).map((entry: { host: string; maxWorkers: number }) => [
						entry.host,
						entry.maxWorkers,
					]),
					[
						["h-0.9.88", 2],
						["h-new", 2],
					],
				);
				const stats = (await readSharedPoolStats(newerJournal, "root"))!;
				assert.deepEqual(
					stats.hosts.map((entry) => [entry.host, entry.shipping]),
					[
						["h-0.9.88", undefined],
						["h-new", { lagMs: 0, pending: 0 }],
					],
				);
				const epoch = await newerStores.buckets.registerWaiting("anthropic", "h-new");
				await newerStores.buckets.reportWaiting([{ reporter: "h-new", scope: "anthropic", waitingMs: 750, epoch }]);
				await newerStores.buckets.reportWaiting([{ reporter: "h-new", scope: "anthropic", waitingMs: 750, epoch }]);
				await newerStores.buckets.reportWaiting([{ reporter: "h-new", scope: "anthropic", waitingMs: 500, epoch }]);
				assert.deepEqual(
					(await readFleetRateUsage(newerJournal)).map((usage) => [usage.scope, usage.acquired, usage.waitingMs]),
					[["anthropic", 3, 750]],
					"0.9.88 hosts change neither counter, so their unmeasured waits make mixed-version caps more permissive",
				);
			});

		test("concurrent rate reporters compact retired totals and reject late registrations and updates (#4768)", async (f) => {
			const store = await SqlRateBuckets.open(f.journal);
			await store.acquire("p", 0, { intervalMs: 1_000, burst: 1 });
			const epochs = new Map<string, number>();
			for (const reporter of ["old-a", "old-b"]) {
				const epoch = await store.registerWaiting("p", reporter);
				epochs.set(reporter, epoch);
				await store.reportWaiting([{ scope: "p", reporter, waitingMs: 100, epoch }]);
			}
			const runs = sqlPoolStorage(f.journal)!.tables.runs;
			await f.database.run(`UPDATE ${runs}_rate_waiting SET updated_at = 0`);
			const other = await SqlRateBuckets.open(await f.peer());
			const [one, two] = await Promise.all([
				store.registerWaiting("p", "live-a"),
				other.registerWaiting("p", "live-b"),
			]);
			await Promise.all([
				store.reportWaiting([{ scope: "p", reporter: "live-a", waitingMs: 50, epoch: one }]),
				other.reportWaiting([{ scope: "p", reporter: "live-b", waitingMs: 50, epoch: two }]),
			]);
			assert.equal(Number((await f.database.get(`SELECT COUNT(*) AS count FROM ${runs}_rate_waiting`))?.count), 2);
			assert.equal((await readFleetRateUsage(f.journal))[0]?.waitingMs, 300);
			assert.deepEqual(
				(
					await store.reportWaiting([
						{ scope: "p", reporter: "old-a", waitingMs: 100, epoch: epochs.get("old-a")! },
					])
				).expired,
				[{ scope: "p", reporter: "old-a" }],
			);
			const late = await other.registerWaiting("p", "old-a");
			assert.notEqual(late, epochs.get("old-a"));
			await store.reportWaiting([{ scope: "p", reporter: "old-a", waitingMs: 100, epoch: epochs.get("old-a")! }]);
			assert.equal((await readFleetRateUsage(f.journal))[0]?.waitingMs, 300);
		});

		test("one fleet controller holds the lease and records under it until another takes it over", async (f) => {
			const store = await SqlFleetStore.open(f.journal);
			const other = await SqlFleetStore.open(await f.peer());
			const held = await store.acquire("one", undefined, 60_000);
			assert.deepEqual(held, { held: true, epoch: 1 });
			assert.deepEqual(await other.acquire("two", undefined, 60_000), { held: false, holder: "one", epoch: 1 });
			assert.equal(
				await store.record({ holder: "one", epoch: 1 }, { kind: "scale", target: 2, live: 1, reason: "r" }),
				true,
			);
			assert.equal(await store.requestDrain({ holder: "one", epoch: 1 }, "idle-host", "vm-9"), true);
			await store.release({ holder: "one", epoch: 1 });
			assert.deepEqual(await other.acquire("two", undefined, 60_000), { held: true, epoch: 2 });
			assert.equal(await store.record({ holder: "one", epoch: 1 }, { kind: "late", reason: "fenced" }), false);
			assert.deepEqual(
				(await other.recent(10)).map((event) => [event.seq, event.kind, event.target, event.live]),
				[[1, "scale", 2, 1]],
			);
			const [drain, ...more] = (await other.snapshot()).drains;
			assert.deepEqual(more, []);
			assert.deepEqual(
				{ host: drain?.host, providerId: drain?.providerId },
				{ host: "idle-host", providerId: "vm-9" },
			);
			// How long ago it was asked, on the database clock: a controller times a drain out by it (#5072).
			assert.ok(drain !== undefined && drain.agoMs >= 0 && drain.agoMs < 60_000, String(drain?.agoMs));
		});

		test("resource admission grants up to the root's limit across connections and waits for released capacity", async (f) => {
			const options = { root: "root", limits: { session: 1 } };
			const first = await SqlResourceAdmission.open(f.journal, { ...options, holder: "first" });
			const second = await SqlResourceAdmission.open(await f.peer(), { ...options, holder: "second" });
			const held = await first.acquire("session");
			const waiting = second.acquire("session");
			const outcome = await Promise.race([waiting.then(() => "granted"), delay(500).then(() => "waiting")]);
			assert.equal(outcome, "waiting");
			await held();
			const granted = await waiting;
			assert.deepEqual(
				(await second.inspect()).map((permit) => [permit.holder, permit.state]),
				[
					["first", "released"],
					["second", "granted"],
				],
			);
			await granted();
		});

		test("many hosts acquire from one rate bucket concurrently and never take more than it allows (#4768)", async (f) => {
			// One token a minute: nothing refills during the test, so exactly the burst is granted across every host.
			const shape = { intervalMs: 60_000, burst: 5 };
			const failures: Error[] = [];
			const hosts = await Promise.all(
				Array.from({ length: 8 }, async () => SqlRateBuckets.open(await f.peer(failures))),
			);
			const outcomes = await Promise.all(
				hosts.flatMap((store) => Array.from({ length: 3 }, () => store.acquire("anthropic", 1, shape))),
			);
			assert.equal(
				outcomes.reduce((sum, outcome) => sum + outcome.granted, 0),
				5,
			);
			for (const outcome of outcomes)
				if (outcome.granted === 0) {
					assert.ok(
						"waitMs" in outcome && outcome.waitMs > 0 && outcome.waitMs <= 60_000,
						JSON.stringify(outcome),
					);
					assert.equal(outcome.cooldownMs, 0);
				}
			assert.deepEqual(failures, []);
		});

		test("a rate bucket whose interval is not a whole number of milliseconds grants no more than its rate (#4768)", async (f) => {
			// About 17 391 requests a minute: the bucket keeps its schedule in whole milliseconds, and a schedule rounded
			// down by a fraction of the interval at each grant would let every host through faster than the rate.
			const shape = { intervalMs: 3.45, burst: 50 };
			const failures: Error[] = [];
			const hosts = await Promise.all(
				Array.from({ length: 6 }, async () => SqlRateBuckets.open(await f.peer(failures))),
			);
			// Each host has written to the bucket once, taking nothing, before the clock starts: the elapsed time is the
			// acquires' own, not their connections' setup.
			await Promise.all(hosts.map((store) => store.acquire("anthropic", 0, shape)));
			const started = await databaseNow(f.database);
			const outcomes = await Promise.all(
				hosts.flatMap((store) => Array.from({ length: 25 }, () => store.acquire("anthropic", 1, shape))),
			);
			const elapsedMs = (await databaseNow(f.database)) - started;
			const granted = outcomes.reduce((sum, outcome) => sum + outcome.granted, 0);
			// GCRA's bound: its burst, plus one token per interval of the database's clock that passed.
			assert.ok(
				granted <= shape.burst + elapsedMs / shape.intervalMs + 1e-6,
				JSON.stringify({ granted, elapsedMs }),
			);
			assert.deepEqual(failures, []);
		});

		test("a 429 cooldown one host shares holds every host's acquires and reaches their polls (#4768)", async (f) => {
			const one = await SqlRateBuckets.open(f.journal);
			const other = await SqlRateBuckets.open(await f.peer());
			// The cooldown runs on the database's clock: what is left of it is measured against the time that clock says
			// passed since it was recorded, however slowly a loaded server answers.
			const recorded = await databaseNow(f.database);
			await one.cooldown("anthropic/opus", 30_000);
			// A bucket shaped after its cooldown was recorded keeps that cooldown.
			const held = await other.acquire("anthropic/opus", 1, { intervalMs: 10, burst: 10 });
			const acquired = await databaseNow(f.database);
			assert.ok(
				"cooldownMs" in held && held.cooldownMs >= 30_000 - (acquired - recorded) && held.cooldownMs <= 30_000,
				JSON.stringify({ held, elapsedMs: acquired - recorded }),
			);
			// A shorter cooldown never shortens it.
			await other.cooldown("anthropic/opus", 5);
			const { cooldowns } = await other.poll();
			const polled = await databaseNow(f.database);
			assert.deepEqual(
				cooldowns.map((cooldown) => cooldown.scope),
				["anthropic/opus"],
			);
			const { remainingMs } = cooldowns[0]!;
			assert.ok(
				remainingMs >= 30_000 - (polled - recorded) && remainingMs <= held.cooldownMs,
				JSON.stringify({ remainingMs, elapsedMs: polled - recorded, held }),
			);
		});

		test("many hosts claim, commit and complete concurrently: no double claim, no lost settle (#5102)", async (f) => {
			const children = Array.from({ length: 24 }, (_, index) => poolWorkFixture(`many-${index}`));
			for (const item of children) await f.pool.enqueue(f.lease, item.work, item.boundary);
			const failures: Error[] = [];
			const hosts = await Promise.all(
				Array.from({ length: 6 }, async () => openSqlPoolQueue(await f.peer(failures))),
			);
			const claimed: string[] = [];
			const settled: string[] = [];
			await Promise.all(
				hosts.flatMap((queue, host) =>
					Array.from({ length: 4 }, async (_, slot) => {
						for (;;) {
							const attempt = await queue.claim(f.lease, `h${host}/w${slot}`, [definition], 60_000);
							if (attempt === undefined) {
								if ((await queue.readyCandidates(f.lease, [definition], 1)).length === 0) return;
								continue;
							}
							claimed.push(attempt.id);
							const item = children.find((candidate) => candidate.work.childRunId === attempt.childRunId)!;
							for (let step = 0; step < 2; step++)
								await queue.commit(f.lease, attempt, `step-${step}`, {
									kind: "checkpoint",
									checkpoint: toolCheckpointOf(item, step),
								});
							await queue.complete(f.lease, attempt, { runId: attempt.childRunId, status: "completed" });
							settled.push(attempt.id);
						}
					}),
				),
			);
			assert.equal(claimed.length, children.length);
			assert.equal(new Set(claimed).size, children.length, "no child was claimed twice");
			assert.deepEqual([...settled].sort(), [...claimed].sort());
			const work = await f.pool.inspect("root");
			assert.deepEqual(
				work.map((item) => [item.state, item.generation]),
				work.map(() => ["completed", 1]),
			);
			for (const item of work) assert.ok(await f.pool.result("root", item.id), "every completion kept its result");
			await assertDenseEvents(f, children.length * 3);
			assert.deepEqual(failures, []);
		});

		test("32 concurrent writers commit one event per key with a dense sequence (#5102)", async (f) => {
			const children = Array.from({ length: 32 }, (_, index) => poolWorkFixture(`writer-${index}`));
			for (const item of children) await f.pool.enqueue(f.lease, item.work, item.boundary);
			const failures: Error[] = [];
			const hosts = await Promise.all(
				Array.from({ length: 8 }, async () => openSqlPoolQueue(await f.peer(failures))),
			);
			const attempts = [];
			for (let index = 0; index < children.length; index++)
				attempts.push((await hosts[index % hosts.length]!.claim(f.lease, `w${index}`, [definition], 60_000))!);
			const receipts = await Promise.all(
				attempts.map(async (attempt, index) => {
					const queue = hosts[index % hosts.length]!;
					const item = children.find((candidate) => candidate.work.childRunId === attempt.childRunId)!;
					const seqs: number[] = [];
					for (let step = 0; step < 3; step++) {
						const checkpoint = toolCheckpointOf(item, step);
						// The same operation twice at once is one event.
						const [first, again] = await Promise.all([
							queue.commit(f.lease, attempt, `step-${step}`, { kind: "checkpoint", checkpoint }),
							queue.commit(f.lease, attempt, `step-${step}`, { kind: "checkpoint", checkpoint }),
						]);
						assert.deepEqual(again, first);
						seqs.push(first.seq!);
					}
					return seqs;
				}),
			);
			const seqs = receipts.flat();
			assert.equal(new Set(seqs).size, seqs.length, "every commit took its own sequence number");
			await assertDenseEvents(f, children.length * 4);
			assert.deepEqual(failures, [], "no writer met a deadlock");
		});

		test("claim, commit, heartbeat, complete and takeover run concurrently without a deadlock (#5102)", async (f) => {
			const children = Array.from({ length: 16 }, (_, index) => poolWorkFixture(`mixed-${index}`));
			for (const item of children) await f.pool.enqueue(f.lease, item.work, item.boundary);
			const failures: Error[] = [];
			const journals = await Promise.all(Array.from({ length: 4 }, () => f.peer(failures)));
			const hosts = await Promise.all(journals.map((journal) => openSqlPoolQueue(journal)));
			const ledgers = await Promise.all(journals.map((journal) => openSqlPoolUsage(journal)));
			const refused: Error[] = [];
			const fenced = (error: Error) => {
				if (!isStaleLeaseError(error) && !isStaleWorkLeaseError(error)) throw error;
				refused.push(error);
			};
			let takenOver: Lease | undefined;
			const worker = async (host: number, slot: number) => {
				const queue = hosts[host]!;
				for (let round = 0; round < 4 && takenOver === undefined; round++) {
					const attempt = await queue.claim(f.lease, `h${host}/w${slot}`, [definition], 60_000).catch(fenced);
					if (!attempt) return;
					const item = children.find((candidate) => candidate.work.childRunId === attempt.childRunId)!;
					try {
						for (let step = 0; step < 3; step++) {
							await queue.heartbeat(
								f.lease,
								attempt,
								60_000,
								ledgers[host]!.recording(f.lease, attempt, [
									{
										key: `usage:${attempt.id}`,
										usage: { input: step, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
									},
								]),
							);
							await queue.commit(f.lease, attempt, `step-${step}`, {
								kind: "checkpoint",
								checkpoint: toolCheckpointOf(item, step),
							});
						}
						await queue.complete(f.lease, attempt, { runId: attempt.childRunId, status: "completed" });
					} catch (error) {
						fenced(error as Error);
					}
				}
			};
			const takeover = (async () => {
				await delay(50);
				const outcome = await journals[0]!.takeover("root", "replacement", f.backend.holderId);
				if (outcome.status !== "acquired") assert.fail("No takeover");
				takenOver = outcome.lease;
			})();
			await Promise.all([
				takeover,
				...hosts.flatMap((_, host) => Array.from({ length: 4 }, (_, slot) => worker(host, slot))),
			]);
			assert.deepEqual(failures, [], "no statement met a deadlock");
			// Every write under the replaced lease is refused from now on.
			const leased = (await f.pool.inspect("root")).find((item) => item.state === "leased");
			if (leased !== undefined)
				await assert.rejects(
					hosts[0]!.commit(f.lease, leased, "late", {
						kind: "checkpoint",
						checkpoint: toolCheckpointOf(children.find((item) => item.work.childRunId === leased.childRunId)!, 9),
					}),
					(error: Error) => isStaleLeaseError(error) || isStaleWorkLeaseError(error),
				);
			await assert.rejects(hosts[1]!.claim(f.lease, "late", [definition], 60_000), isStaleLeaseError);
			await assertDenseEvents(f);
		});
	});
}

/** The `step`th tool checkpoint of the child `item` queues. */
function toolCheckpointOf(item: ReturnType<typeof poolWorkFixture>, step: number): DurableToolCheckpoint {
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

const unshipped = async (): Promise<never> => assert.fail("a write the host keeps is not committed directly");

/** A host's shipping of `attempt` into `queue`, through a local journal of its own. */
async function shippingHost(
	queue: Awaited<ReturnType<typeof openSqlPoolQueue>>,
	lease: Lease,
	attempt: PoolWork,
	maxBatch: number,
) {
	const shard = await ShipShard.open(":memory:", "root");
	const shipping = new CheckpointShipping(shard, {
		intervalMs: 60_000,
		maxBatch,
		maxLagMs: 600_000,
		host: `host-${attempt.worker}`,
		deliver: (held, batch) => queue.shipBatch(lease, held, batch),
		sessionState: (held, session) => queue.poolSessionState(held.id, session),
		snapshotsStored: (checkpoint) => queue.assertSnapshotsStored(checkpoint),
	});
	await shipping.hold(attempt, 60_000);
	return { shipping, receipts: [] as { readonly local?: true; readonly lastSeq?: number }[] };
}

/**
 * A stage's session writes and checkpoints, as an agent stage of `item`'s child makes them: a create, appends, a tool
 * checkpoint between them, a replace, and the checkpoint that ends the stage and bills its usage.
 */
function sessionWrites(item: ReturnType<typeof poolWorkFixture>, sessionId: string): PoolMutation[] {
	const { scope } = item.work;
	const childRun = { ...item.boundary.topology!.boundary!.child };
	const stage = {
		kind: "stage" as const,
		workflowId: "root",
		name: "stage",
		replayKey: `${scope}:stage`,
		sessionId,
		completedAt: 1,
		topology: { version: 1 as const, stageId: "stage", parentIds: [], sourceOrder: 0, run: childRun },
	};
	const header = { id: sessionId, version: 4 as const, createdAt: "2026-01-01T00:00:00Z", cwd: "/gone/scratch" };
	const entry = (id: string, parentId: string | null, text: string): SessionEntry => ({
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00Z",
		message: { role: "user", content: text, timestamp: 1 },
	});
	return [
		{
			kind: "session-create",
			checkpoint: { ...stage, checkpointId: `${scope}:session:0` },
			header,
			entries: [entry("m-1", null, "first \u0000 prompt")],
		},
		{ kind: "session-append", sessionId, entries: [entry("m-2", "m-1", "second")], expectSeq: 1 },
		{ kind: "checkpoint", checkpoint: toolCheckpointOf(item, 1) },
		{
			kind: "session-append",
			sessionId,
			entries: [entry("m-3", "m-2", "third"), entry("m-4", "m-3", "fourth")],
			expectSeq: 2,
		},
		{
			kind: "session-replace",
			checkpoint: { ...stage, checkpointId: `${scope}:session:1`, completedAt: 2 },
			header,
			entries: [entry("m-1", null, "first \u0000 prompt"), entry("c-1", "m-1", "compacted")],
			expectSeq: 4,
		},
		{ kind: "session-append", sessionId, entries: [entry("m-5", "c-1", "after")], expectSeq: 2 },
		{
			kind: "checkpoint",
			checkpoint: {
				...stage,
				checkpointId: `${scope}:stage:complete`,
				completedAt: 3,
				output: "done",
				topology: { ...stage.topology, status: "completed" },
				modelAttempts: [
					{
						model: "fixture",
						success: true,
						usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
					},
				],
			} as unknown as DurableToolCheckpoint,
		},
	] as PoolMutation[];
}

/** A tool output of about 256 KiB, its text distinct for each `step`. */
function largeOutput(step: number): { readonly step: number; readonly text: string } {
	const unit = `${step}:"quoted" \\ é;`;
	return { step, text: unit.repeat(Math.ceil((256 * 1024) / unit.length)).slice(0, 256 * 1024) };
}

/** The root's events: one per key, numbered 1 to their count, with `count` checkpoints when given. */
async function assertDenseEvents(f: { database: SqliteDatabase; table: (name: string) => string }, count?: number) {
	const events = await f.database.all<{ seq: number; key: string | null }>(
		`SELECT seq, key FROM ${f.table("wf_events")} WHERE run_id = ? ORDER BY seq`,
		"root",
	);
	assert.deepEqual(
		events.map((event) => Number(event.seq)),
		events.map((_, index) => index + 1),
		"the sequence is dense",
	);
	const keys = events.flatMap((event) => (event.key === null ? [] : [event.key]));
	assert.equal(new Set(keys).size, keys.length, "one event per key");
	if (count !== undefined)
		assert.equal(
			keys.filter((key) => key.startsWith(`[${JSON.stringify(RUN_EVENT_TYPES.checkpointRecorded)},`)).length,
			count,
			"every checkpoint was recorded",
		);
}

interface Release0988Stores {
	readonly SqlSharedPool: {
		open(
			journal: SqlRunJournal,
			queue: Awaited<ReturnType<typeof openSqlPoolQueue>>,
		): Promise<{
			reportHost(host: Parameters<SqlSharedPool["reportHost"]>[0]): Promise<void>;
			registeredHosts(): Promise<readonly { readonly host: string; readonly maxWorkers: number }[]>;
		}>;
	};
	readonly SqlRateBuckets: {
		open(journal: SqlRunJournal): Promise<Pick<SqlRateBuckets, "acquire">>;
	};
	adopt(journal: SqlRunJournal): void;
}

let release0988Promise: Promise<Release0988Stores> | undefined;

function release0988(): Promise<Release0988Stores> {
	const fixture = (name: string) => `../fixtures/shared-pool-0.9.88/durable/journal/${name}`;
	if (release0988Promise === undefined) {
		release0988Promise = (async () => {
			const internal = await import(fixture("internal.ts"));
			const pool = await import(fixture("sql-shared-pool.ts"));
			const buckets = await import(fixture("sql-rate-buckets.ts"));
			return {
				SqlSharedPool: pool.SqlSharedPool,
				SqlRateBuckets: buckets.SqlRateBuckets,
				adopt: (journal) => internal.registerSqlPoolStorage(journal, sqlPoolStorage(journal)!),
			};
		})();
	}
	return release0988Promise;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Now on `database`'s own clock, in milliseconds: the clock its stores record and measure shared times on. */
async function databaseNow(database: SqliteDatabase): Promise<number> {
	const row = await database.get<SqliteRow & { now: number | string }>(`SELECT ${dialectOf(database).nowMs} AS now`);
	return Number(row!.now);
}
