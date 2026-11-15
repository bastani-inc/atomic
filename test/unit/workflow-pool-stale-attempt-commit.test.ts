/**
 * A commit an ended attempt still sends must never land in the attempt that replaced it (#4768): the pool refuses a
 * commit made for another attempt than the one the worker's slot holds, before it reaches the journal.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { type PoolCommitReceipt, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExistsSync, makeTempDirectory, readTextSync, removeTempDirectory, sleep } from "../helpers/runtime.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

afterEach(() => {
	vi.restoreAllMocks();
});

/** How long the pool and the stub worker may take to reach a state before the test fails. */
const STATE_DEADLINE_MS = 60_000;
/** Structural: one real worker process, its start, and the pool's close. */
const STUB_WORKER_TIMEOUT_MS = 120_000;

test.skipIf(process.platform === "win32")(
	"a commit made for an earlier attempt of the work, or for another work item, is refused as superseded and never reaches the journal (#4768)",
	async () => {
		const directory = makeTempDirectory("pool-stale-commit-");
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
			workerEntry: fileURLToPath(new URL("../fixtures/pool-stale-commit-stub-worker.mjs", import.meta.url)),
			coordinator: "in-process",
		});
		const committed: string[] = [];
		vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(
			async (_lease, _work, operation): Promise<PoolCommitReceipt> => {
				committed.push(operation);
				return { at: 1, lastSeq: 1 };
			},
		);
		const execution = run(
			workflow({
				name: "pool-stale-commit",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.workflow(child, { inputs: { releasePath: join(directory, "release"), tools: 0 } });
					return {};
				},
			}),
			{},
			{ runId: testRunId("pool-stale-commit"), cwd: directory, store: createStore(), durableBackend: backend },
		).catch((error: Error) => error);
		const replies = join(directory, "stale-commit-replies.log");
		const received = () =>
			fileExistsSync(replies)
				? readTextSync(replies, "utf8")
						.split("\n")
						.filter((line) => line !== "")
						.map((line) => JSON.parse(line) as { label: string; outcome: string; reason?: string })
				: [];
		try {
			const deadline = performance.now() + STATE_DEADLINE_MS;
			while (received().length < 3) {
				assert.ok(performance.now() < deadline, `timed out; replies ${JSON.stringify(received())}`);
				await sleep(25);
			}
			assert.deepEqual(
				received().map((reply) => [reply.label, reply.outcome, reply.reason]),
				[
					["earlier", "refused", "superseded"],
					["other work", "refused", "superseded"],
					["held", "answered", undefined],
				],
			);
			assert.deepEqual(committed, ["held-operation"]);
		} finally {
			await pool.close().catch(() => {});
			await execution;
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	STUB_WORKER_TIMEOUT_MS,
);
