/**
 * Resuming a pooled root in a new process after a child of it failed on a pool infrastructure fault, as stages of a
 * 0.9.57 pool did on a busy host. The fault was the pool's, not the child's, so the resumed root runs the child again
 * instead of replaying its failure from the earlier incarnation's work queue.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { fileExistsSync, makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

const childPath = fileURLToPath(new URL("../fixtures/pool-infrastructure-fault-child.ts", import.meta.url));
/** The first incarnation's pool and the resumed one's. */
const BUDGET = poolTestBudgetMs(2);

test.skipIf(process.platform === "win32")(
	"a pooled child whose run fails on a pool infrastructure fault replays in the same root incarnation instead of keeping the failure",
	async () => {
		const directory = makeTempDirectory("pool-infrastructure-replay-");
		const path = join(directory, "journal.sqlite");
		const exportName = "faultedChild";
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName,
			digest: await definitionDigest(childPath),
		});
		const statuses: string[] = [];
		const parent = workflow({
			name: "pool-infrastructure-replay-root",
			description: "Root over a pooled child whose first run fails on a pool fault",
			inputs: {},
			outputs: {},
			async run(ctx) {
				statuses.push((await ctx.workflow(child, { inputs: { directory } })).status);
				return {};
			},
		});
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName }],
			coordinator: "in-process",
		});
		try {
			const result = await run(
				parent,
				{},
				{
					runId: randomUUID(),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: AbortSignal.timeout(BUDGET.waitMs),
				},
			);
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(statuses, ["completed"], "the fault was the pool's: the child replayed rather than failed");
			assert.ok(fileExistsSync(join(directory, "run-2")), "the child ran a second time");
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a resumed pooled root runs again a child that an earlier incarnation failed on a pool infrastructure fault",
	async () => {
		const directory = makeTempDirectory("pool-infrastructure-resume-");
		const path = join(directory, "journal.sqlite");
		const exportName = "faultedChild";
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName,
			digest: await definitionDigest(childPath),
		});
		const statuses: string[] = [];
		const parent = workflow({
			name: "pool-infrastructure-resume-root",
			description: "Root over a pooled child that failed on a pool fault",
			inputs: {},
			outputs: {},
			async run(ctx) {
				// The fault lasts the whole first incarnation: the child fails there on every attempt.
				const result = await ctx.workflow(child, { inputs: { directory, persistent: true } });
				statuses.push(result.status);
				if (result.status !== "completed") throw new Error(`child ${result.status}`);
				return {};
			},
		});
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const runId = randomUUID();
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		const pool = (backend: JournalDurableBackend) =>
			new LocalWorkerPool(backend, {
				journalPath: path,
				workers: 1,
				definitions: [{ definition: child, path: childPath, exportName }],
				coordinator: "in-process",
			});
		try {
			const first = await JournalDurableBackend.open(journal, { ownsJournal: false });
			const firstPool = pool(first);
			try {
				const failed = await run(
					parent,
					{},
					{ runId, cwd: directory, store: createStore(), durableBackend: first, signal: budget },
				);
				assert.equal(failed.status, "failed", JSON.stringify(failed));
			} finally {
				await firstPool.close().catch(() => {});
				await first.close();
			}
			// The earlier process is gone: its lease is old enough for another process to take the root over.
			await database.run("UPDATE wf_leases SET renewed_at = 0 WHERE run_id = ?", runId);
			await writeFileEnsuringDir(join(directory, "recovered"), "");

			const second = await JournalDurableBackend.open(journal, { ownsJournal: false });
			const secondPool = pool(second);
			try {
				const jobs = createJobTracker();
				const store = createStore();
				let completion: Promise<unknown> | undefined;
				const resumed = await resumeDurableWorkflow(runId, {
					registry: createRegistry().register(parent),
					baseRunOpts: { store, cwd: directory, signal: budget },
					durableBackend: second,
					jobs,
					onRunAccepted: (id: string) => {
						completion = jobs.get(id)?.promise;
					},
				});
				assert.equal(resumed.ok, true, resumed.message);
				await completion;
				const root = store.runs().find((candidate) => candidate.id === runId);
				assert.equal(root?.status, "completed", JSON.stringify({ status: root?.status, error: root?.error }));
				assert.deepEqual(
					statuses,
					["completed"],
					"the resumed root got the child it ran again, not its replayed failure",
				);
				const work = await (await openSqlPoolQueue(journal)).inspect(runId);
				assert.deepEqual(
					work.map((item) => item.state),
					["completed"],
				);
			} finally {
				await secondPool.close().catch(() => {});
				await second.close();
			}
		} finally {
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
