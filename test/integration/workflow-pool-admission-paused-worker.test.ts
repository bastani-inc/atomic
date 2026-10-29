import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run as engineRun } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** A paused live worker keeps its admission capacity until its termination is confirmed (#3869). */

/** The paused child's worker is replaced once: two worker cold starts, plus the child's work. */
const REPLACED_WORKER = poolTestBudgetMs(4);

test.skipIf(process.platform === "win32")(
	"a paused live worker retains capacity until confirmed termination (#3869)",
	async () => {
		const directory = makeTempDirectory("paused-admission-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const childPath = fileURLToPath(new URL("../fixtures/pool-admission-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "paused",
			digest: await definitionDigest(childPath),
		});
		const admission = await SqlResourceAdmission.open(journal, {
			root: "root",
			holder: "observer",
			limits: { session: 1 },
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "paused" }],
			admission: { limits: { session: 1 } },
		});
		try {
			const parent = workflow({
				name: "paused-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const result = await ctx.workflow(child);
					assert.equal(result.status, "completed");
					assert.notEqual(result.outputs.finalInstance, result.outputs.firstInstance);
					return {};
				},
			});
			const result = await engineRun(
				parent,
				{},
				{
					runId: "root",
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: AbortSignal.timeout(REPLACED_WORKER.waitMs),
				},
			);
			assert.equal(result.status, "completed", JSON.stringify(result));
			const permits = await admission.inspect();
			assert.equal(permits.filter((row) => row.kind === "session").length, 2);
			assert.ok(permits.every((row) => row.state === "released"));
		} finally {
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	REPLACED_WORKER.timeoutMs,
);
