/**
 * A pool of many workers whose coordinator stalls past the old five-second exit wait right after it sends SIGKILL, as a
 * coordinator serving hundreds of workers does, while one child's enqueue fails on a transient storage fault. That
 * child's failure used to close the whole pool; the close's exit wait then lost its race with the stalled event loop,
 * and every other child, those already finished included, failed with the retryable `Local worker cleanup was not
 * confirmed`, as did every child the root started afterwards.
 */
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { WorkflowInfrastructureError } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExistsSync, makeTempDirectory, readTextSync, removeTempDirectory } from "../helpers/runtime.js";

const WORKERS = 50;
const CHILDREN = 60;
/** The child whose enqueue fails on a transient storage fault. */
const FAULTED = 7;
/** Longer than the five seconds the pool used to wait for a worker's exit event after SIGKILL. */
const COORDINATOR_STALL_MS = 6_000;
const BUDGET = poolTestBudgetMs(1);
/** The shortest work lease a pool accepts, so lease recovery stops the silent worker soon. */
const UNKILLABLE_LEASE_MS = 2_000;
const childPath = fileURLToPath(new URL("../fixtures/pool-load-child.ts", import.meta.url));
const stubWorker = fileURLToPath(new URL("../fixtures/pool-cascade-stub-worker.mjs", import.meta.url));

interface ChildOutcome {
	readonly index: number;
	readonly status?: string;
	readonly error?: unknown;
}

/** Blocks this thread, as a coordinator's event loop busy with hundreds of workers is blocked. */
function stall(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test.skipIf(process.platform === "win32")(
	"one child's fault and a coordinator stall at SIGKILL fail only that child on a many-worker pool",
	async () => {
		const directory = makeTempDirectory("pool-cleanup-cascade-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: WORKERS,
			admission: {},
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const enqueue = SqlPoolQueue.prototype.enqueue;
		vi.spyOn(SqlPoolQueue.prototype, "enqueue").mockImplementation(function (this: SqlPoolQueue, ...args) {
			if ((args[1].inputs as { readonly index?: number }).index === FAULTED)
				return Promise.reject(new Error("Storage unavailable: injected transient fault"));
			return enqueue.apply(this, args);
		});
		// The first SIGKILL the pool sends is followed by a stall of the event loop that would handle the worker's exit.
		const kill = ChildProcess.prototype.kill;
		let stalled = false;
		vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, signal) {
			const sent = kill.call(this, signal);
			if (signal === "SIGKILL" && !stalled) {
				stalled = true;
				stall(COORDINATOR_STALL_MS);
			}
			return sent;
		});
		const outcomes: ChildOutcome[] = [];
		const store = createStore();
		const root = testRunId("pool-cleanup-cascade-root");
		try {
			const result = await run(
				workflow({
					name: "pool-cleanup-cascade-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						const settled = await Promise.allSettled(
							Array.from({ length: CHILDREN }, (_, index) => ctx.workflow(child, { inputs: { index } })),
						);
						for (const [index, outcome] of settled.entries())
							outcomes.push(
								outcome.status === "fulfilled"
									? { index, status: outcome.value.status }
									: { index, error: outcome.reason },
							);
						return {};
					},
				}),
				{},
				{ runId: root, cwd: directory, store, durableBackend: backend, signal: AbortSignal.timeout(BUDGET.waitMs) },
			);
			assert.equal(result.status, "completed", result.error);
			const others = outcomes.filter(({ index }) => index !== FAULTED);
			assert.equal(others.length, CHILDREN - 1);
			const failedOthers = others.filter(({ status }) => status !== "completed");
			assert.equal(
				failedOthers.length,
				0,
				`one child's fault failed ${failedOthers.length} other children: ${String(failedOthers[0]?.error)}`,
			);
			const faulted = outcomes[FAULTED]?.error;
			assert.ok(faulted instanceof WorkflowInfrastructureError, String(faulted));
			assert.equal(faulted.code, "storage_unavailable", "the faulted child keeps its own fault");
			// The root's own end closes the pool: the stall after its first SIGKILL confirms every worker's exit anyway.
			await pool.close();
			assert.ok(stalled, "the pool sent SIGKILL under the stall");
			assert.deepEqual(pool.health, [], "every worker's exit was confirmed");
		} finally {
			vi.restoreAllMocks();
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a worker that outlives SIGKILL is retired and replaced, and its child replays",
	async () => {
		const directory = makeTempDirectory("pool-cleanup-unkillable-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		process.env.ATOMIC_TEST_CASCADE_STALL_INDEX = "0";
		process.env.ATOMIC_TEST_CASCADE_HOLD_MS = "100";
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 2,
			admission: {},
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
			leaseMs: UNKILLABLE_LEASE_MS,
		});
		// The worker that stops answering ignores SIGKILL: the signal is never delivered to it.
		const stalledWorker = () => {
			const marker = join(directory, "stalled-worker");
			return fileExistsSync(marker) ? Number(readTextSync(marker, "utf8")) : undefined;
		};
		const kill = ChildProcess.prototype.kill;
		vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, signal) {
			if (signal === "SIGKILL" && this.pid !== undefined && this.pid === stalledWorker()) return true;
			return kill.call(this, signal);
		});
		const outcomes: ChildOutcome[] = [];
		try {
			const result = await run(
				workflow({
					name: "pool-cleanup-unkillable-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						const settled = await Promise.allSettled(
							Array.from({ length: 3 }, (_, index) => ctx.workflow(child, { inputs: { index } })),
						);
						for (const [index, outcome] of settled.entries())
							outcomes.push(
								outcome.status === "fulfilled"
									? { index, status: outcome.value.status }
									: { index, error: outcome.reason },
							);
						return {};
					},
				}),
				{},
				{
					runId: testRunId("pool-cleanup-unkillable-root"),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: AbortSignal.timeout(BUDGET.waitMs),
				},
			);
			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(
				outcomes,
				[0, 1, 2].map((index) => ({ index, status: "completed" })),
				"the stuck worker's child replayed on a replacement",
			);
			const stuck = stalledWorker();
			assert.ok(stuck !== undefined);
			assert.equal(pool.health.length, 1, pool.health.join("\n"));
			assert.match(pool.health[0]!, new RegExp(`worker process ${stuck} was still running .* retired and replaced`));
		} finally {
			delete process.env.ATOMIC_TEST_CASCADE_STALL_INDEX;
			delete process.env.ATOMIC_TEST_CASCADE_HOLD_MS;
			vi.restoreAllMocks();
			await pool.close().catch(() => {});
			const stuck = stalledWorker();
			if (stuck !== undefined)
				try {
					process.kill(stuck, "SIGKILL");
				} catch {}
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
