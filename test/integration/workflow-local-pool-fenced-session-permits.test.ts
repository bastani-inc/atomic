/**
 * A real local worker whose attempt is fenced while its stage's session is open, under `admission.limits.session` = 1.
 *
 * The pooled child's first run starts its agent stage, whose turn holds, and fails on a fault of the pool meanwhile: the
 * attempt ends and the child replays on the same, still live, worker. The fenced attempt's stage session must be closed
 * and its session permit released when the attempt ends: the replay's stage needs the root's only session, and a
 * worker that keeps the stale session open keeps that permit granted for as long as it lives, so the replay never
 * starts while the worker keeps its lease alive.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { fileExistsSync, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const childPath = fileURLToPath(new URL("../fixtures/pool-fenced-stage-child.ts", import.meta.url));
const BUDGET = poolTestBudgetMs(1);
const ADMISSION = { limits: { session: 1 } };

/** The root's session permits, by attempt generation, as `[generation, state, reason]`. */
function sessionPermits(path: string, root: string): (readonly [number, string, string | null])[] {
	const journal = new DatabaseSync(path, { readOnly: true });
	try {
		return journal
			.prepare(
				"SELECT json_extract(attempt, '$.generation') AS generation, state, reason FROM wf_runs_resource_permits WHERE root = ? AND kind = 'session' ORDER BY ticket",
			)
			.all(root)
			.map(
				(row) =>
					[Number(row.generation), String(row.state), row.reason === null ? null : String(row.reason)] as const,
			);
	} finally {
		journal.close();
	}
}

test.skipIf(process.platform === "win32")(
	"a fenced attempt's stage session gives its session permit back, so its replay on the same live worker is admitted",
	async () => {
		const directory = makeTempDirectory("pool-fenced-session-permits-");
		const path = join(directory, "journal.sqlite");
		const root = randomUUID();
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const statuses: string[] = [];
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			admission: ADMISSION,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
		});
		try {
			const result = await run(
				workflow({
					name: "pool-fenced-session-permits-root",
					description: "Root over a pooled child whose first attempt is fenced while its stage is open",
					inputs: {},
					outputs: {},
					async run(ctx) {
						statuses.push((await ctx.workflow(child, { inputs: { directory } })).status);
						return {};
					},
				}),
				{},
				{
					runId: root,
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: AbortSignal.timeout(BUDGET.waitMs),
				},
			);
			const permits = sessionPermits(path, root);
			assert.equal(result.status, "completed", `${JSON.stringify(result.error)} ${JSON.stringify(permits)}`);
			assert.deepEqual(statuses, ["completed"], "the replay completed the child");
			assert.ok(fileExistsSync(join(directory, "turn-2")), "the replay's stage started a turn");
			// Read while the worker is still alive: only closing the session, never the worker's exit, released it.
			assert.deepEqual(
				permits.filter(([generation]) => generation === 1),
				[[1, "released", "resource cleanup confirmed"]],
				"the fenced attempt's stage session released its permit when the attempt ended",
			);
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
