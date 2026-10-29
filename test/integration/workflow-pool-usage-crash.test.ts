import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const LOCAL_WORKER_USAGE_CRASH_TIMEOUT_MS = 120_000;

test.skipIf(process.platform === "win32")(
	"a worker killed after a billed checkpoint commit and before usage reporting is charged once on replacement (#3869)",
	async () => {
		const directory = makeTempDirectory("pool-usage-crash-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const childPath = fileURLToPath(new URL("../fixtures/pool-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "billedCrashChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "billedCrashChild" }],
		});
		try {
			const parent = workflow({
				name: "usage-crash-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const result = await ctx.workflow(child);
					assert.equal(result.status, "completed");
					assert.notEqual(result.outputs.firstInstance, result.outputs.finalInstance);
					return {};
				},
			});
			const store = createStore();
			const result = await run(
				parent,
				{},
				{ runId: "usage-crash-root", cwd: directory, store, durableBackend: backend, budget: { maxTokens: 1_000 } },
			);
			assert.equal(result.status, "completed", JSON.stringify(result));
			const ledger = await (await openSqlPoolUsage(journal)).total("usage-crash-root");
			assert.equal(ledger.input + ledger.output, 2, "the billed stage is in the ledger once");
			assert.equal(
				store.runs().find((entry) => entry.id === "usage-crash-root")?.budgetState?.accounting?.tokens,
				2,
				"root spending includes the stage once",
			);
		} finally {
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_USAGE_CRASH_TIMEOUT_MS,
);
