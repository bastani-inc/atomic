/**
 * A pool that closes while a child is on its way to its coordinator refuses the child's enqueue itself (#4822): a
 * closed pool's coordinator may already be gone without telling, so an enqueue sent to it could wait forever.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

afterEach(() => {
	vi.restoreAllMocks();
});

/** Structural: one stand-in worker process, its start, and the pool's close. */
const STUB_WORKER_TIMEOUT_MS = 120_000;

test.skipIf(process.platform === "win32")(
	"a child whose pool closes before its enqueue is sent fails as the pool closed, and its coordinator never receives it (#4822)",
	async () => {
		const directory = makeTempDirectory("pool-closed-enqueue-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const childPath = fileURLToPath(new URL("../fixtures/pool-heartbeat-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
			workerEntry: fileURLToPath(new URL("../fixtures/pool-handoff-stub-worker.mjs", import.meta.url)),
			coordinator: "in-process",
		});
		const enqueue = vi.spyOn(PoolCoordinator.prototype as never as { enqueue: () => Promise<void> }, "enqueue");
		// The child's last step before its enqueue: the pool closes while it runs.
		const flush = vi.spyOn(
			LocalWorkerPool.prototype as never as { flushRootRun: () => Promise<void> },
			"flushRootRun",
		);
		flush.mockImplementationOnce(function (this: LocalWorkerPool) {
			void pool.close();
			return Promise.resolve();
		});
		let failure: string | undefined;
		try {
			await run(
				workflow({
					name: "pool-closed-enqueue",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						try {
							await ctx.workflow(child, { inputs: { releasePath: join(directory, "release"), tools: 0 } });
						} catch (error) {
							failure = (error as Error).message;
						}
						return {};
					},
				}),
				{},
				{
					runId: testRunId("pool-closed-enqueue"),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
				},
			).catch(() => undefined);
			assert.equal(flush.mock.calls.length >= 1, true, "the child reached its enqueue");
			assert.match(failure ?? "", /Local worker pool is closed/);
			assert.equal(enqueue.mock.calls.length, 0, "the closed pool's coordinator never receives the enqueue");
			// Only the enqueue is refused: the closed pool still tells its coordinator to close, and its close succeeds.
			await pool.close();
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	STUB_WORKER_TIMEOUT_MS,
);
