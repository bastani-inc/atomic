import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { findStageWaitError, StageRehydrationError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { REHYDRATION_FIELDS } from "../fixtures/pool-typed-failure-child.js";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** Starts a pool coordinator and a worker process, which load the packaged workflows runtime. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

test(
	"a pooled child failing with StageRehydrationError puts it in the root's error chain (#4309)",
	async () => {
		const directory = makeTempDirectory("pool-typed-failure-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const childPath = fileURLToPath(new URL("../fixtures/pool-typed-failure-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const caught: unknown[] = [];
		const root = workflow({
			name: "pool-typed-failure-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				try {
					await ctx.workflow(child);
				} catch (error) {
					caught.push(error);
					throw error;
				}
				return {};
			},
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
		});
		try {
			const result = await run(
				root,
				{},
				{ runId: "pool-typed-root", cwd: directory, store: createStore(), durableBackend: backend },
			);

			assert.equal(caught.length, 1, JSON.stringify(result));
			const found = findStageWaitError(caught[0]);
			assert.ok(found instanceof StageRehydrationError, `no StageRehydrationError in ${String(caught[0])}`);
			assert.equal(found.code, "session-unavailable");
			assert.deepEqual(found.fields, REHYDRATION_FIELDS);
			assert.equal((found.cause as Error | undefined)?.message, "session store unreachable");
			assert.equal(result.failureDetail?.name, "StageRehydrationError", JSON.stringify(result));
			// The child ran on a worker: its result, with the detail, reached the root through the pool's journal.
			const queue = await openSqlPoolQueue(journal);
			const [work] = await queue.inspect("pool-typed-root");
			assert.ok(work, "the child was not dispatched to the pool");
			const stored = (await queue.result("pool-typed-root", work.id)) as { failureDetail?: { name?: string } };
			assert.equal(stored?.failureDetail?.name, "StageRehydrationError", JSON.stringify(stored));
		} finally {
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
