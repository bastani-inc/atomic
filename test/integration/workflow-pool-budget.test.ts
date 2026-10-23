import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const LOCAL_WORKER_BUDGET_TIMEOUT_MS = 120_000;
test(
	"pooled usage is charged once and restored before cached children replay (#3869)",
	async () => {
		const directory = makeTempDirectory("pool-budget-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const childPath = fileURLToPath(new URL("../fixtures/pool-admission-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		let pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
		});
		try {
			const parent = workflow({
				name: "budgeted-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					assert.equal((await ctx.workflow(child)).status, "completed");
					return {};
				},
			});
			const store = createStore();
			const result = await run(
				parent,
				{},
				{ runId: "root", cwd: directory, store, durableBackend: backend, budget: { maxTokens: 1_000 } },
			);
			assert.equal(result.status, "completed", JSON.stringify(result));
			const ledger = await (await openSqlPoolUsage(journal)).total("root");
			assert.equal(ledger.input + ledger.output, 2);
			assert.deepEqual(
				store.runs().map((entry) => entry.id),
				["root"],
			);
			assert.equal(store.runs().find((entry) => entry.id === "root")?.budgetState?.accounting?.tokens, 2);
			await pool.close();
			const database = await openNodeSqliteDatabase(path);
			try {
				await database.run("UPDATE wf_runs_pool_usage SET input = 10, output = 10");
			} finally {
				await database.close();
			}
			pool = new LocalWorkerPool(backend, {
				journalPath: path,
				workers: 1,
				definitions: [{ definition: child, path: childPath, exportName: "child" }],
			});
			const recovered = createStore();
			const replay = await run(
				parent,
				{},
				{ runId: "root", cwd: directory, store: recovered, durableBackend: backend, budget: { maxTokens: 1_000 } },
			);
			assert.equal(replay.status, "completed", JSON.stringify(replay));
			assert.equal(pool.workerPids.length, 0, "cached children do not dispatch workers");
			assert.equal(recovered.runs().find((entry) => entry.id === "root")?.budgetState?.accounting?.tokens, 20);
		} finally {
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_BUDGET_TIMEOUT_MS,
);
