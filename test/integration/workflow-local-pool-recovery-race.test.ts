/**
 * Lease recovery reads the pool's expired attempts, then acts on each in turn. An attempt can change hands meanwhile:
 * its worker's exit releases it for replay, or the worker completes it. Recovery's expiry of such an attempt used to
 * throw `Stale work lease` out of recovery, which failed the whole pool, and every unfinished child of the pool then
 * failed with `stale_work_lease` at the same moment. An attempt that already changed hands has nothing left to expire.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExistsSync, makeTempDirectory, readTextSync, removeTempDirectory, sleep } from "../helpers/runtime.js";

const CHILDREN = 3;
/** The child whose first worker stops answering, so recovery finds its attempt expired. */
const STALLED = 0;
/** The shortest work lease a pool accepts, so the stalled attempt expires soon. */
const WORK_LEASE_MS = 2_000;
/** How long the other children run: they are still running when recovery meets the stalled attempt. */
const HOLD_MS = 8_000;
const BUDGET = poolTestBudgetMs(1);
const childPath = fileURLToPath(new URL("../fixtures/pool-load-child.ts", import.meta.url));
const stubWorker = fileURLToPath(new URL("../fixtures/pool-cascade-stub-worker.mjs", import.meta.url));

interface ChildOutcome {
	readonly index: number;
	readonly status?: string;
	readonly error?: unknown;
}

test.skipIf(process.platform === "win32")(
	"an expired attempt that changes hands while recovery acts on it fails no child",
	async () => {
		const directory = makeTempDirectory("pool-recovery-race-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		process.env.ATOMIC_TEST_CASCADE_STALL_INDEX = String(STALLED);
		process.env.ATOMIC_TEST_CASCADE_HOLD_MS = String(HOLD_MS);
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 2,
			admission: {},
			leaseMs: WORK_LEASE_MS,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const marker = join(directory, "stalled-worker");
		const reader = () => new DatabaseSync(path, { readOnly: true, timeout: 60_000 });
		// Recovery reads the stalled attempt as expired. Before it acts on what it read, the attempt's worker exits and the
		// exit releases the attempt for replay, as an exit that lands while recovery walks a long list does.
		let raced = false;
		const inspect = SqlPoolQueue.prototype.inspect;
		vi.spyOn(SqlPoolQueue.prototype, "inspect").mockImplementation(async function (this: SqlPoolQueue, ...args) {
			const works = await inspect.apply(this, args);
			const stalled = works.find(
				(work) =>
					work.state === "leased" &&
					work.expiresAt < Date.now() &&
					(work.inputs as { readonly index?: number }).index === STALLED,
			);
			if (raced || stalled === undefined || !fileExistsSync(marker)) return works;
			raced = true;
			process.kill(Number(readTextSync(marker, "utf8")), "SIGKILL");
			const database = reader();
			try {
				const current = database.prepare("SELECT state, generation FROM wf_runs_work WHERE id = ?");
				for (;;) {
					const row = current.get(stalled.id) as { state: string; generation: number } | undefined;
					if (row?.state !== "leased" || row.generation !== stalled.generation) break;
					await sleep(10);
				}
			} finally {
				database.close();
			}
			return works;
		});
		const outcomes: ChildOutcome[] = [];
		try {
			const result = await run(
				workflow({
					name: "pool-recovery-race-root",
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
				{
					runId: testRunId("pool-recovery-race-root"),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: AbortSignal.timeout(BUDGET.waitMs),
				},
			);
			assert.equal(result.status, "completed", result.error);
			assert.ok(raced, "recovery acted on the stalled attempt after it changed hands");
			assert.deepEqual(
				outcomes.map(({ index, status, error }) => ({
					index,
					status,
					error: error === undefined ? undefined : String(error),
				})),
				Array.from({ length: CHILDREN }, (_, index) => ({ index, status: "completed", error: undefined })),
				"no child failed, and the stalled child replayed on another worker",
			);
		} finally {
			delete process.env.ATOMIC_TEST_CASCADE_STALL_INDEX;
			delete process.env.ATOMIC_TEST_CASCADE_HOLD_MS;
			vi.restoreAllMocks();
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
