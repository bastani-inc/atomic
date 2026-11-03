import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { loadWorkerWorkflow, run, workflow } from "../../packages/workflows/src/index.js";
import {
	assertSingleRootRecovered,
	childPath,
	committedWorker,
	crashAfterFirstStep,
	observe,
	pidAlive,
	queuedWork,
	ROOT,
	STALE_COORDINATOR_AGE_MS,
	startCoordinator,
	until,
	workItems,
} from "../helpers/public-pool-lifecycle.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

/** Structural: each case starts, crashes and resumes root processes that each fork a pool coordinator and a worker. */
const PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS = 180_000;

test.skipIf(process.platform === "win32")(
	"a SIGKILLed public coordinator is replaced by a fresh process that finishes the same root from settings stored on it (#3869)",
	async () => {
		const directory = makeTempDirectory("public-pool-crash-");
		const first = startCoordinator(directory, "fresh");
		let second: ReturnType<typeof startCoordinator> | undefined;
		try {
			const firstReady = await first.next("ready");
			const worker = await committedWorker(directory);
			const workerPid = worker.pid;
			assert.notEqual(worker.instance, firstReady.instance);
			const [before] = workItems(directory);
			await first.stop();
			await until("the orphaned worker to exit", () => (pidAlive(workerPid) ? undefined : true));
			observe(directory, (database) =>
				database.run(
					"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? WHERE run_id = ?",
					STALE_COORDINATOR_AGE_MS,
					ROOT,
				),
			);
			await writeFileEnsuringDir(join(directory, "release"), "ready");
			second = startCoordinator(directory, "restart");
			const secondReady = await second.next("ready");
			const result = await second.next("result");
			assertSingleRootRecovered(directory, worker, result, [firstReady, secondReady]);
			const after = workItems(directory);
			assert.equal(after.length, 1);
			assert.equal(after[0]!.id, before!.id);
			assert.equal(after[0]!.state, "completed");
			assert.ok(after[0]!.generation > before!.generation, "the restart takes a new fenced attempt");
		} finally {
			await first.stop();
			await second?.stop();
			removeTempDirectory(directory);
		}
	},
	PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a crashed root resumes under another execution mode than it launched with, and its queued child runs under the new one (#4200)",
	async () => {
		const directory = makeTempDirectory("public-pool-resume-mode-");
		const first = startCoordinator(directory, "fresh", { settings: { executionMode: "interactive" } });
		let second: ReturnType<typeof startCoordinator> | undefined;
		try {
			const firstReady = await first.next("ready");
			const recorded = await crashAfterFirstStep(directory, first);
			const queued = queuedWork(directory);
			assert.equal(queued.execution.executionMode, "interactive");
			await writeFileEnsuringDir(join(directory, "release"), "ready");
			// A headless resume of an interactive launch.
			second = startCoordinator(directory, "restart", { settings: { executionMode: "non_interactive" } });
			const secondReady = await second.next("ready");
			const result = await second.next("result");
			assertSingleRootRecovered(directory, recorded, result, [firstReady, secondReady]);
			const rebound = queuedWork(directory);
			assert.equal(rebound.id, queued.id, "the queued child is the same work, not a second one");
			assert.equal(rebound.execution.executionMode, "non_interactive");
		} finally {
			await first.stop();
			await second?.stop();
			removeTempDirectory(directory);
		}
	},
	PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS,
);

test.runIf(process.platform === "win32")(
	"the public worker opt-in refuses Windows before registering a root or launching a worker (#3869)",
	async () => {
		const directory = makeTempDirectory("public-pool-windows-");
		const journal = await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } });
		const backend = await JournalDurableBackend.open(journal);
		try {
			const child = await loadWorkerWorkflow(childPath, "child");
			const parent = workflow({
				name: "public-windows-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.workflow(child, { inputs: { releasePath: join(directory, "release") } });
					return {};
				},
			});
			await assert.rejects(
				run(
					parent,
					{},
					{
						runId: ROOT,
						cwd: directory,
						durableBackend: backend,
						localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
					},
				),
				/containment.*Windows/i,
			);
			assert.equal(
				observe(directory, (database) =>
					Number(database.query("SELECT COUNT(*) AS count FROM wf_runs").get()!.count),
				),
				0,
			);
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	PUBLIC_POOL_LIFECYCLE_TIMEOUT_MS,
);
