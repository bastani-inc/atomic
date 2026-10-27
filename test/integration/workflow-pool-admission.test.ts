import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { poolStageOptions } from "../fixtures/pool-stage-options.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** One pool's cold start (its coordinator and workers start together), plus the children's stages and the root's local stage. */
const SHARED_PERMITS = poolTestBudgetMs(3);

test.skipIf(process.platform === "win32").each([false, true])(
	"public worker and non-pooled sessions share two permits, cross-run=%s (#3869)",
	async (crossRun) => {
		const directory = makeTempDirectory("pool-admission-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const ordinary = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const config = {
			limits: { session: 2 },
			...(crossRun ? { userLimits: { session: 2 }, userDatabase: path } : {}),
		};
		const db = await openNodeSqliteDatabase(path);
		const admission = await SqlResourceAdmission.open(journal, {
			root: "root",
			holder: "observer",
			...config,
		});
		await db.exec(`CREATE TABLE observed(active INTEGER NOT NULL);
		CREATE TRIGGER observe_permit AFTER UPDATE OF state ON wf_runs_resource_permits
		WHEN NEW.state = 'granted' AND OLD.state = 'waiting' BEGIN
		INSERT INTO observed SELECT COUNT(*) FROM wf_runs_resource_permits WHERE kind = 'session' AND state = 'granted'; END;`);
		const childPath = fileURLToPath(new URL("../fixtures/pool-admission-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const localWorkers = { count: 3, definitions: [{ path: childPath, exportName: "child" }] };
		try {
			const parent = workflow({
				name: "admitted-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const children = Promise.all(Array.from({ length: 3 }, () => ctx.workflow(child)));
					const local = ctx.stage("local", (await poolStageOptions(directory, false, 0)) as never);
					await local.complete("Reply with your PID");
					assert.ok((await children).every((result) => result.status === "completed"));
					return {};
				},
			});
			const nested = workflow({
				name: "nested",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					assert.equal((await ctx.workflow(child)).status, "completed");
					return {};
				},
			});
			const ordinaryRun = workflow({
				name: "ordinary",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					assert.equal((await ctx.workflow(nested)).status, "completed");
					return {};
				},
			});
			const store = createStore();
			const [result, other] = await Promise.all([
				run(
					parent,
					{},
					{
						runId: "root",
						cwd: directory,
						store,
						durableBackend: backend,
						budget: { maxTokens: 100 },
						localWorkers,
						admission: config,
						signal: AbortSignal.timeout(SHARED_PERMITS.waitMs),
					},
				),
				crossRun
					? run(
							ordinaryRun,
							{},
							{
								runId: "ordinary",
								cwd: directory,
								store: createStore(),
								durableBackend: ordinary,
								admission: config,
								signal: AbortSignal.timeout(SHARED_PERMITS.waitMs),
							},
						)
					: undefined,
			]);
			if (crossRun) assert.equal(other?.status, "completed", JSON.stringify(other));
			assert.equal(result.status, "completed", JSON.stringify(result));
			const observations = await db.all("SELECT active FROM observed");
			assert.equal(observations.length, crossRun ? 5 : 4);
			assert.ok(observations.every((row) => Number(row.active) <= 2));
			assert.equal(store.runs().find((entry) => entry.id === "root")?.budgetState?.accounting?.tokens, 8);
			assert.equal((await admission.inspect()).filter((row) => row.state === "granted").length, 0);
		} finally {
			await backend.close();
			await ordinary.close();
			await db.close();
			removeTempDirectory(directory);
		}
	},
	SHARED_PERMITS.timeoutMs,
);
