import assert from "node:assert/strict";
import type { SessionEntry } from "@bastani/atomic";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { describe } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { poolStageUsageKey } from "../../packages/workflows/src/durable/journal/pool-stage-usage.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { openPoolSessions } from "../../packages/workflows/src/workers/pool-session-store.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
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
		/** A journal on another connection to the same database, as another host opens. */
		async peer() {
			const peer = await SqlRunJournal.open(await scope.connect(), { prefix: scope.prefix });
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
	const test = (title: string, body: (f: Awaited<ReturnType<typeof rootFixture>>) => Promise<void>) =>
		run_(title, async () => {
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
		});

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
			assert.deepEqual(snapshot.roots, [{ root: "root", ready: 2, leased: 1, sessionLimit: 2, blocked: false }]);
			assert.deepEqual([...snapshot.leased], [["h1", 1]]);
			await shared.publishBudget(f.lease, true);
			assert.equal((await store.snapshot()).roots[0]?.blocked, true);
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
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
