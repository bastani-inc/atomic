/**
 * `localWorkers.maxLoadPerCpu`: on a machine loaded past it, pooled stages start one at a time, spaced out, instead of
 * all at once.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createStore, loadWorkerWorkflow, run, workflow } from "../../packages/workflows/src/index.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeTextSync } from "../helpers/runtime.js";

const BUDGET = poolTestBudgetMs(1);
/** Below any load a machine running this test has, so the gate is always closed while a stage runs. */
const OVERLOADED_AT = 1e-9;

test.skipIf(process.platform === "win32")(
	"pooled stages start one at a time on an overloaded machine instead of all at once, and the run completes",
	async () => {
		const directory = makeTempDirectory("pool-stage-start-pressure-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const childPath = fileURLToPath(new URL("../fixtures/pool-live-stage-child.ts", import.meta.url));
		const child = await loadWorkerWorkflow(childPath, "child");
		const gatePath = join(directory, "release-stage");
		const permits = await openNodeSqliteDatabase(path);
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		try {
			const execution = run(
				workflow({
					name: "pool-stage-start-pressure-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						await Promise.all([0, 1].map(() => ctx.workflow(child, { inputs: { gatePath } })));
						return {};
					},
				}),
				{},
				{
					runId: testRunId("pool-stage-start-pressure"),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: budget,
					localWorkers: {
						count: 2,
						definitions: [{ path: childPath, exportName: "child" }],
						maxLoadPerCpu: OVERLOADED_AT,
					},
				},
			);
			// The pool creates its permit table with its first worker; until then no session has a permit.
			const sessions = async (state: string, reason?: string) =>
				(
					await permits
						.all<{ count: number }>(
							`SELECT COUNT(*) AS count FROM wf_runs_resource_permits WHERE kind = 'session' AND state = ?${reason === undefined ? "" : " AND reason = ?"}`,
							...(reason === undefined ? [state] : [state, reason]),
						)
						.catch(() => [{ count: 0 }])
				)[0]!.count;
			while ((await sessions("granted")) < 1 || (await sessions("waiting", "host load")) < 1) {
				budget.throwIfAborted();
				await sleep(50);
			}
			await sleep(500);
			assert.equal(await sessions("granted"), 1, "the second stage did not start together with the first");
			writeTextSync(gatePath, "");
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
		} finally {
			writeTextSync(gatePath, "");
			await permits.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
