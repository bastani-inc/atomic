/**
 * Which attempts of a pooled child count toward its attempt limit (#4768): an attempt the shared store's refusals
 * handed on does not, wherever the pool counts (a worker's exit, a fenced attempt); a write no host can ever make
 * does, so its child fails after the limit with an error that names the refusal instead of moving between hosts.
 */
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StorageTransientError, StorageUnavailableError } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import {
	openSqlPoolQueue,
	type PoolWork,
	SqlPoolQueue,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import {
	type AdmissionConfiguration,
	SqlResourceAdmission,
} from "../../packages/workflows/src/workers/resource-admission.js";
import { PoolStageHandoff } from "../../packages/workflows/src/workers/stage-handoff.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { fileExistsSync, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const BUDGET = poolTestBudgetMs(2);

/** A refusal no host gets through: sqld's answer to a response past its size limit. */
const tooLarge = () =>
	new StorageUnavailableError(
		{ adapter: "libsql", location: "http://127.0.0.1:1" },
		Object.assign(new Error("RESPONSE_TOO_LARGE: Response is too large"), { code: "RESPONSE_TOO_LARGE" }),
	);

/** Runs one pooled child of `exportName` in `fixture` under `fault`; its outcome and its work item after the run. */
async function runOneChild(
	fixture: string,
	exportName: string,
	fault: (database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>, directory: string) => void,
	/** A stand-in worker module instead of the real worker. */
	workerEntry?: string,
	/** Pool options the case sets: its workers, its work lease, how soon a worker hands a refused child on. */
	options: {
		readonly workers?: number;
		readonly leaseMs?: number;
		readonly outageHandoffMs?: number;
		readonly admission?: AdmissionConfiguration;
		/** How many children of `exportName` the root runs at once; the outcome is the first that failed, if any. */
		readonly children?: number;
	} = {},
) {
	const directory = makeTempDirectory("pool-attempt-counting-");
	const path = join(directory, "journal.sqlite");
	const childPath = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url));
	const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
	let outcome: { status: string; error?: string } | undefined;
	const parent = workflow({
		name: "pool-attempt-counting-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			try {
				const results = await Promise.all(
					Array.from({ length: options.children ?? 1 }, () => ctx.workflow(child, { inputs: { directory } })),
				);
				outcome = { status: results.find((result) => result.status !== "completed")?.status ?? "completed" };
			} catch (error) {
				const chain: string[] = [];
				for (
					let e = error as Error | undefined, depth = 0;
					e && depth < 8;
					e = e.cause as Error | undefined, depth++
				)
					chain.push(
						`${e.name}: ${e.message}${(e as { code?: unknown }).code === undefined ? "" : ` [${String((e as { code?: unknown }).code)}]`}`,
					);
				outcome = { status: "rejected", error: chain.join(" <- ") };
			}
			return {};
		},
	});
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: options.workers ?? 1,
		...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
		...(options.outageHandoffMs === undefined ? {} : { outageHandoffMs: options.outageHandoffMs }),
		...(options.admission === undefined ? {} : { admission: options.admission }),
		definitions: [{ definition: child, path: childPath, exportName }],
		coordinator: "in-process",
		...(workerEntry === undefined ? {} : { workerEntry }),
	});
	fault(database, directory);
	const runId = randomUUID();
	try {
		const result = await run(
			parent,
			{},
			{
				runId,
				cwd: directory,
				store: createStore(),
				durableBackend: backend,
				signal: AbortSignal.timeout(BUDGET.waitMs),
			},
		);
		vi.restoreAllMocks();
		const items = await (await openSqlPoolQueue(journal)).inspect(runId);
		// Every session permit the run's attempts took and have not given back.
		const permits =
			options.admission === undefined
				? []
				: (
						await (
							await SqlResourceAdmission.open(journal, { ...options.admission, root: runId, holder: "test" })
						).inspect()
					)
						.filter((permit) => permit.kind === "session" && permit.state !== "released")
						.map((permit) => [permit.attempt, permit.state]);
		return { root: result.status, outcome, items, permits };
	} finally {
		vi.restoreAllMocks();
		await pool.close().catch(() => {});
		await backend.close();
		await journal.close();
		await database.close();
		removeTempDirectory(directory);
	}
}

test.skipIf(process.platform === "win32")(
	"a child whose checkpoint no host can ever commit fails after its attempt limit, with an error naming the refusal (#4768)",
	async () => {
		const result = await runOneChild("pool-crash-once-child.ts", "crashOnceChild", () => {
			vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async () => {
				throw new StorageUnavailableError(
					{ adapter: "libsql", location: "http://127.0.0.1:1" },
					Object.assign(new Error("RESPONSE_TOO_LARGE: Response is too large"), { code: "RESPONSE_TOO_LARGE" }),
				);
			});
		});
		assert.equal(result.outcome?.status, "rejected", JSON.stringify(result));
		assert.match(result.outcome!.error!, /WorkerRetryLimitError/);
		assert.match(result.outcome!.error!, /RESPONSE_TOO_LARGE|Response is too large/);
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation, item.handoffs ?? []]),
			[["failed", 3, []]],
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"attempts the store handed on do not count when a later attempt's worker crashes (#4768)",
	async () => {
		const result = await runOneChild("pool-crash-once-child.ts", "crashOnceChild", () => {
			// The first two claims are handed on at once, as attempts the store's refusals ended would be.
			const claim = SqlPoolQueue.prototype.claim;
			let handedOn = 0;
			vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (
				this: SqlPoolQueue,
				...args: Parameters<SqlPoolQueue["claim"]>
			) {
				const work = (await claim.apply(this, args)) as PoolWork | undefined;
				if (work === undefined || handedOn >= 2) return work;
				handedOn++;
				await this.releaseExited(args[0], work, { delayMs: 0 });
				return undefined;
			});
		});
		assert.equal(result.outcome?.status, "completed", JSON.stringify(result));
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation, item.handoffs]),
			[["completed", 4, [1, 2]]],
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a resumed root counts only the handoffs of its own incarnation toward its child's attempt limit (#4768)",
	async () => {
		/** Attempts, all handed on, of the child's earlier incarnations: they belong to those, not to this one. */
		const EARLIER = 10;
		const result = await runOneChild("pool-crash-once-child.ts", "crashOnceChild", (database) => {
			const enqueue = SqlPoolQueue.prototype.enqueue;
			vi.spyOn(SqlPoolQueue.prototype, "enqueue").mockImplementation(async function (
				this: SqlPoolQueue,
				...args: Parameters<SqlPoolQueue["enqueue"]>
			) {
				const work = await enqueue.apply(this, args);
				// The work as a resumed root finds it: ready again after earlier incarnations handed it on EARLIER times.
				const [{ name }] = await database.all<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_pool_operations'",
				);
				const workTable = name.replace(/_pool_operations$/, "_work");
				await database.run(`UPDATE ${workTable} SET generation = ? WHERE id = ?`, EARLIER, work.id);
				for (let generation = 1; generation <= EARLIER; generation++)
					await database.run(
						`INSERT INTO ${name}(work, generation, operation, request, receipt) VALUES (?, ?, 'pool-handoff', 'pool-handoff', '{}')`,
						work.id,
						generation,
					);
				return { ...work, generation: EARLIER };
			});
			vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async () => {
				throw tooLarge();
			});
		});
		assert.equal(result.outcome?.status, "rejected", JSON.stringify(result));
		// Three attempts of this incarnation, the attempt limit: the earlier handoffs added none.
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation]),
			[["failed", EARLIER + 3]],
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"handoffs are capped: past the cap a handoff counts as an attempt, so a child no host gets through fails (#4768)",
	async () => {
		/** MAX_CHILD_HANDOFFS in pool-coordinator.ts. */
		const CAP = 20;
		const delays: number[] = [];
		const result = await runOneChild(
			"pool-crash-once-child.ts",
			"crashOnceChild",
			() => {
				// The growing wait before a handed-on child is claimable again is recorded, then skipped, to keep the test short.
				const releaseExited = SqlPoolQueue.prototype.releaseExited;
				vi.spyOn(SqlPoolQueue.prototype, "releaseExited").mockImplementation(function (
					this: SqlPoolQueue,
					lease,
					work,
					handoff,
				) {
					if (handoff !== undefined) delays.push(handoff.delayMs);
					return releaseExited.call(this, lease, work, handoff === undefined ? undefined : { delayMs: 0 });
				});
			},
			fileURLToPath(new URL("../fixtures/pool-handoff-stub-worker.mjs", import.meta.url)),
		);
		assert.equal(result.outcome?.status, "rejected", JSON.stringify(result.outcome));
		assert.match(result.outcome!.error!, /WorkerRetryLimitError/);
		assert.equal(delays.length, CAP);
		for (const [index, waited] of delays.entries())
			assert.ok(waited >= 0 && waited <= Math.min(30_000, 500 * 2 ** index), `handoff ${index} waited ${waited} ms`);
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation, item.handoffs?.length]),
			[["failed", CAP + 3, CAP]],
		);
	},
	BUDGET.timeoutMs,
);

/** The store refusing for a while: its write lock stayed busy. */
const busy = () =>
	new StorageUnavailableError(
		{ adapter: "libsql", location: "http://127.0.0.1:1" },
		Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" }),
	);

/** A work lease short enough that a lease nobody renews expires within the test. */
const SHORT_LEASE_MS = 2_000;

/** How soon a real worker hands its child on when the store keeps refusing it, instead of two minutes. */
const SHORT_HANDOFF_MS = 400;

test.skipIf(process.platform === "win32")(
	"a real worker whose commits the store keeps refusing for a while hands its child on uncounted, and the child completes (#4768)",
	async () => {
		const result = await runOneChild(
			"pool-checkpoint-child.ts",
			"checkpointChild",
			() => {
				const commit = SqlPoolQueue.prototype.commit;
				vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["commit"]>
				) {
					// The first attempt's commits never get through; the next attempt's do.
					if (args[1].generation === 1) throw busy();
					return commit.apply(this, args);
				});
			},
			undefined,
			{ workers: 2, outageHandoffMs: SHORT_HANDOFF_MS },
		);
		assert.equal(result.outcome?.status, "completed", JSON.stringify(result));
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation, item.handoffs]),
			[["completed", 2, [1]]],
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a real worker whose attempt is displaced while it resends a refused commit sends none of it afterwards, and its next attempt is never fenced (#4768)",
	async () => {
		/** Each commit a worker sent, with the attempt it was made for, in order. */
		const sent: { generation: number | undefined; afterReplay: boolean }[] = [];
		let replayClaimed = false;
		const emit = ChildProcess.prototype.emit;
		vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) {
			const message = args[0] as { kind?: string; attempt?: { generation: number } } | undefined;
			if (event === "message" && message?.kind === "commit")
				sent.push({ generation: message.attempt?.generation, afterReplay: replayClaimed });
			return (emit as (this: ChildProcess, event: string | symbol, ...rest: unknown[]) => boolean).call(
				this,
				event,
				...args,
			);
		} as never);
		const result = await runOneChild(
			"pool-checkpoint-child.ts",
			"checkpointChild",
			() => {
				const commit = SqlPoolQueue.prototype.commit;
				vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["commit"]>
				) {
					if (args[1].generation === 1) throw busy();
					return commit.apply(this, args);
				});
				// While the first attempt resends its refused commit, its work lease is taken over: its heartbeat is
				// refused as stale, which ends the attempt, and the child is claimed again.
				const heartbeat = SqlPoolQueue.prototype.heartbeat;
				vi.spyOn(SqlPoolQueue.prototype, "heartbeat").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["heartbeat"]>
				) {
					if (args[1].generation === 1)
						throw new StaleWorkLeaseError({
							root: args[0].runId,
							workId: args[1].id,
							generation: 1,
							reason: "expired",
						});
					return heartbeat.apply(this, args);
				});
				const claim = SqlPoolQueue.prototype.claim;
				vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["claim"]>
				) {
					const work = (await claim.apply(this, args)) as PoolWork | undefined;
					if (work !== undefined && work.generation > 1) replayClaimed = true;
					return work;
				});
			},
			undefined,
			{ workers: 1, outageHandoffMs: 60_000 },
		);
		assert.equal(result.outcome?.status, "completed", JSON.stringify(result));
		// The replay, generation 2, completed: the first attempt's late refusals never fenced it.
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation]),
			[["completed", 2]],
		);
		assert.ok(
			sent.some((commit) => commit.generation === 1),
			JSON.stringify(sent),
		);
		assert.deepEqual(
			sent.filter((commit) => commit.afterReplay && commit.generation === 1),
			[],
			"the displaced attempt sent no commit once its replay was claimed",
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a real worker whose attempt is displaced while it resends a refused stage-session write sends none of it afterwards, and its next attempt is never fenced (#4768)",
	async () => {
		/** Each commit a worker sent, with the attempt it was made for, in order. */
		const sent: { generation: number | undefined; afterReplay: boolean }[] = [];
		let replayClaimed = false;
		let refusedAppends = 0;
		const emit = ChildProcess.prototype.emit;
		vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) {
			const message = args[0] as { kind?: string; attempt?: { generation: number } } | undefined;
			if (event === "message" && message?.kind === "commit")
				sent.push({ generation: message.attempt?.generation, afterReplay: replayClaimed });
			return (emit as (this: ChildProcess, event: string | symbol, ...rest: unknown[]) => boolean).call(
				this,
				event,
				...args,
			);
		} as never);
		const result = await runOneChild(
			"pool-checkpoint-child.ts",
			"stageChild",
			() => {
				const commit = SqlPoolQueue.prototype.commit;
				vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["commit"]>
				) {
					// The first attempt's stage-session writes never get through; its checkpoints and every later write do.
					if (args[1].generation === 1 && args[3].kind === "session-append") {
						refusedAppends++;
						throw busy();
					}
					return commit.apply(this, args);
				});
				// While the first attempt resends its refused commit, its work lease is taken over: its heartbeat is
				// refused as stale, which ends the attempt, and the child is claimed again.
				const heartbeat = SqlPoolQueue.prototype.heartbeat;
				vi.spyOn(SqlPoolQueue.prototype, "heartbeat").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["heartbeat"]>
				) {
					if (args[1].generation === 1 && refusedAppends > 0)
						throw new StaleWorkLeaseError({
							root: args[0].runId,
							workId: args[1].id,
							generation: 1,
							reason: "expired",
						});
					return heartbeat.apply(this, args);
				});
				const claim = SqlPoolQueue.prototype.claim;
				vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["claim"]>
				) {
					const work = (await claim.apply(this, args)) as PoolWork | undefined;
					if (work !== undefined && work.generation > 1) replayClaimed = true;
					return work;
				});
			},
			undefined,
			{ workers: 1, outageHandoffMs: 60_000 },
		);
		assert.equal(result.outcome?.status, "completed", JSON.stringify(result));
		// The replay, generation 2, completed: the first attempt's late refusals never fenced it.
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation]),
			[["completed", 2]],
		);
		assert.ok(
			sent.some((commit) => commit.generation === 1),
			JSON.stringify(sent),
		);
		assert.deepEqual(
			sent.filter((commit) => commit.afterReplay && commit.generation === 1),
			[],
			"the displaced attempt sent no commit once its replay was claimed",
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a child whose worker dies on every attempt fails at the attempt limit on the worker-exit path (#4768)",
	async () => {
		const result = await runOneChild("pool-crash-once-child.ts", "crashAlwaysChild", () => {});
		assert.equal(result.outcome?.status, "rejected", JSON.stringify(result));
		assert.match(result.outcome!.error!, /WorkerRetryLimitError/);
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation]),
			[["failed", 3]],
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a real worker whose attempt is fenced while its stage session is open still commits that session's last entries and gives its permit back (#4768)",
	async () => {
		let fenced = false;
		/** What the first attempt committed after its fence: its stage session's closing writes. */
		const afterFence: string[] = [];
		const result = await runOneChild(
			"pool-checkpoint-child.ts",
			"heldStageChild",
			(_database, directory) => {
				const commit = SqlPoolQueue.prototype.commit;
				vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["commit"]>
				) {
					if (args[1].generation === 1 && fenced) afterFence.push(args[3].kind);
					return commit.apply(this, args);
				});
				// While the first attempt's stage waits for its model's reply, its heartbeat finds the work lease taken:
				// the attempt is fenced mid-turn, and the reply then arrives, so the session has entries to write as it closes.
				const heartbeat = SqlPoolQueue.prototype.heartbeat;
				vi.spyOn(SqlPoolQueue.prototype, "heartbeat").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["heartbeat"]>
				) {
					if (args[1].generation === 1 && fileExistsSync(join(directory, "waiting"))) {
						fenced = true;
						writeFileSync(join(directory, "release"), "");
						throw new StaleWorkLeaseError({
							root: args[0].runId,
							workId: args[1].id,
							generation: 1,
							reason: "expired",
						});
					}
					return heartbeat.apply(this, args);
				});
			},
			undefined,
			{ workers: 1, admission: { limits: { session: 4 } } },
		);
		assert.equal(result.outcome?.status, "completed", JSON.stringify(result));
		assert.equal(result.items[0]?.generation, 2, JSON.stringify(result.items));
		assert.ok(
			afterFence.length > 0,
			`the fenced attempt's session wrote its last entries as it closed: ${JSON.stringify(afterFence)}`,
		);
		assert.deepEqual(result.permits, [], "every ended attempt gave its stage's session permit back");
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a child whose claim committed but whose answer was lost is recovered after its lease expires, though its worker lives on (#4768)",
	async () => {
		let lost = false;
		const result = await runOneChild(
			"pool-checkpoint-child.ts",
			"checkpointChild",
			() => {
				// The first claim takes the child, but the worker never learns it: the answer is lost as a connection that
				// broke after the request reached the server. The worker lives on and keeps asking for work.
				const claim = SqlPoolQueue.prototype.claim;
				vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["claim"]>
				) {
					const work = await claim.apply(this, args);
					if (work !== undefined && !lost) {
						lost = true;
						throw new StorageTransientError(
							{ adapter: "libsql", location: "http://127.0.0.1:1" },
							{ code: "connection-lost", outcome: "unknown", attempts: 1 },
						);
					}
					return work;
				});
			},
			undefined,
			{ workers: 1, leaseMs: SHORT_LEASE_MS },
		);
		assert.ok(lost);
		assert.equal(result.outcome?.status, "completed", JSON.stringify(result));
		// The lost claim's generation went back as a handoff: no worker ever ran it, so it spent none of the attempts.
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation, item.handoffs]),
			[["completed", 2, [1]]],
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"workers whose handoffs the store refuses to record wait the outage out: the pool survives, each handoff is recorded, and every child completes uncounted (#4768)",
	async () => {
		/** Workers, and children, going through the outage at once: more than the pool's worker replacements allow. */
		const WORKERS = 4;
		const refusedReleases = new Map<string, number>();
		const result = await runOneChild(
			"pool-checkpoint-child.ts",
			"checkpointChild",
			() => {
				const commit = SqlPoolQueue.prototype.commit;
				vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["commit"]>
				) {
					// Each child's first attempt's commits never get through: the attempt hands the child on.
					if (args[1].generation === 1) throw busy();
					return commit.apply(this, args);
				});
				// The outage outlasts the handoff: recording it is refused twice for each child before the store takes it.
				const releaseExited = SqlPoolQueue.prototype.releaseExited;
				vi.spyOn(SqlPoolQueue.prototype, "releaseExited").mockImplementation(async function (
					this: SqlPoolQueue,
					...args: Parameters<SqlPoolQueue["releaseExited"]>
				) {
					const refused = refusedReleases.get(args[1].id) ?? 0;
					if (args[2] !== undefined && refused < 2) {
						refusedReleases.set(args[1].id, refused + 1);
						throw busy();
					}
					return releaseExited.apply(this, args);
				});
			},
			undefined,
			{ workers: WORKERS, children: WORKERS, outageHandoffMs: SHORT_HANDOFF_MS },
		);
		assert.equal(result.outcome?.status, "completed", JSON.stringify(result.outcome));
		assert.equal(result.root, "completed");
		assert.equal(refusedReleases.size, WORKERS);
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation, item.handoffs]),
			Array.from({ length: WORKERS }, () => ["completed", 2, [1]]),
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a stage publication the root's store refuses for a while is sent again in full, and its child completes without spending an attempt (#4768)",
	async () => {
		let refused = 0;
		const result = await runOneChild(
			"pool-checkpoint-child.ts",
			"stageChild",
			() => {
				// The root's store refuses the attempt's first stage publication, busy, before applying any of it.
				const prepare = (
					PoolStageHandoff.prototype as unknown as { prepare: (...args: unknown[]) => Promise<unknown> }
				).prepare;
				const handoff = PoolStageHandoff.prototype as unknown as {
					prepare: (...args: unknown[]) => Promise<unknown>;
				};
				vi.spyOn(handoff, "prepare").mockImplementation(async function (
					this: PoolStageHandoff,
					...args: unknown[]
				) {
					if (refused === 0) {
						refused++;
						throw busy();
					}
					return prepare.apply(this, args);
				});
			},
			undefined,
			{ workers: 1 },
		);
		assert.equal(refused, 1);
		assert.equal(result.outcome?.status, "completed", JSON.stringify(result));
		assert.deepEqual(
			result.items.map((item) => [item.state, item.generation]),
			[["completed", 1]],
		);
	},
	BUDGET.timeoutMs,
);
