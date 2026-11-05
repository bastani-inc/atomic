/**
 * Chaos runs for #4315 with a real worker process: a pool worker sends two commits back to back, the second before the
 * first is answered, while the test holds the first one's journal transaction. The worker is then killed, stopped, or
 * its first commit refused as on a full disk, and the coordinator must still apply the worker's commits one at a time
 * in the order it sent them, and end the worker's attempt only after every request of it has settled.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StorageUnavailableError } from "@bastani/atomic/storage";
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

const POLL_MS = 25;
/** How long a wait for the pool or the worker to reach a state may take before the test fails. */
const STATE_DEADLINE_MS = 60_000;
/** Event-loop time given to a coordinator that would wrongly move on, before the test checks that it did not. */
const SETTLE_MS = 500;
/** Structural: one real worker process, its start, and its kill or stop. */
const PIPELINED_CHAOS_TIMEOUT_MS = 120_000;

type Fault = "none" | "disk-full";

/** A pool with one real stub worker whose first commit's transaction the test holds. */
async function pipelinedWorker(name: string, fault: Fault) {
	const directory = makeTempDirectory("pool-pipelined-chaos-");
	const path = join(directory, "journal.sqlite");
	const replies = join(directory, "pipelined-replies.log");
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
		workerEntry: fileURLToPath(new URL("../fixtures/pool-pipelined-stub-worker.mjs", import.meta.url)),
		coordinator: "in-process",
	});
	/** What reached the journal, in order: each commit's start and end, and the attempt's release. */
	const events: string[] = [];
	const hold = Promise.withResolvers<void>();
	let held = false;
	// The pool journal's own validation is not under test: each commit is recorded and answered with a receipt.
	vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(
		async (_lease, _work, operation): Promise<PoolCommitReceipt> => {
			events.push(`start ${operation}`);
			const first = !held && operation === "first-operation";
			if (first) {
				held = true;
				await hold.promise;
			}
			events.push(`end ${operation}`);
			if (first && fault === "disk-full")
				throw new StorageUnavailableError(
					{ adapter: "node-sqlite", location: path },
					{ errcode: 13, errstr: "database or disk is full" },
					"database or disk is full",
				);
			return { at: 1, lastSeq: 1 };
		},
	);
	const releaseExited = SqlPoolQueue.prototype.releaseExited;
	vi.spyOn(SqlPoolQueue.prototype, "releaseExited").mockImplementation(function (this: SqlPoolQueue, lease, work) {
		events.push("attempt released");
		return releaseExited.call(this, lease, work);
	});
	const execution = run(
		workflow({
			name: `pool-pipelined-chaos-${name}`,
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child, { inputs: { releasePath: join(directory, "release"), tools: 0 } });
				return {};
			},
		}),
		{},
		{
			runId: testRunId(`pool-pipelined-chaos-${name}`),
			cwd: directory,
			store: createStore(),
			durableBackend: backend,
		},
	).catch((error: Error) => error);
	const until = async (state: string, reached: () => boolean) => {
		const deadline = performance.now() + STATE_DEADLINE_MS;
		while (!reached()) {
			assert.ok(performance.now() < deadline, `timed out waiting until ${state}; journal saw ${events.join(", ")}`);
			await sleep(POLL_MS);
		}
	};
	const receivedReplies = () =>
		fileExistsSync(replies)
			? readTextSync(replies, "utf8")
					.split("\n")
					.filter((line) => line !== "")
					.map((line) => JSON.parse(line) as { readonly label: string; readonly outcome: string })
			: [];
	await until("the first commit is in its transaction", () => events.includes("start first-operation"));
	const pid = pool.workerPids[0]!;
	return {
		events,
		pid,
		pool,
		until,
		receivedReplies,
		releaseFirst: () => hold.resolve(),
		/** Closes the pool and removes the run; a cleanup failure never replaces the test's own. */
		async close(failure: Error | undefined) {
			hold.resolve();
			const closed = await Promise.allSettled([pool.close()]);
			await execution;
			await backend.close();
			removeTempDirectory(directory);
			if (failure !== undefined) throw failure;
			for (const result of closed) if (result.status === "rejected") throw result.reason;
		},
	};
}

test.skipIf(process.platform === "win32")(
	"a worker killed while its first commit holds a transaction has both commits applied in order before its attempt is released (#4315)",
	async () => {
		const worker = await pipelinedWorker("sigkill", "none");
		let failure: Error | undefined;
		try {
			assert.deepEqual(worker.events, ["start first-operation"], "the second commit waits for the first");
			process.kill(worker.pid, "SIGKILL");
			await worker.until("the pool sees its worker exit", () => !worker.pool.workerPids.includes(worker.pid));
			await sleep(SETTLE_MS);
			assert.deepEqual(worker.events, ["start first-operation"], "nothing moves while the first commit is held");
			worker.releaseFirst();
			await worker.until("the attempt is released", () => worker.events.includes("attempt released"));
			assert.deepEqual(worker.events.slice(0, worker.events.indexOf("attempt released") + 1), [
				"start first-operation",
				"end first-operation",
				"start second-operation",
				"end second-operation",
				"attempt released",
			]);
		} catch (error) {
			failure = error as Error;
		}
		await worker.close(failure);
	},
	PIPELINED_CHAOS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a stopped worker's pipelined commits apply in order while it is stopped, and it gets both answers in order once it runs again (#4315)",
	async () => {
		const worker = await pipelinedWorker("sigstop", "none");
		let failure: Error | undefined;
		try {
			process.kill(worker.pid, "SIGSTOP");
			worker.releaseFirst();
			await worker.until("both commits applied", () => worker.events.includes("end second-operation"));
			assert.deepEqual(worker.events, [
				"start first-operation",
				"end first-operation",
				"start second-operation",
				"end second-operation",
			]);
			assert.deepEqual(worker.receivedReplies(), [], "a stopped worker reads nothing");
			process.kill(worker.pid, "SIGCONT");
			await worker.until("the worker records both answers", () => worker.receivedReplies().length === 2);
			assert.deepEqual(worker.receivedReplies(), [
				{ label: "first", outcome: "answered" },
				{ label: "second", outcome: "answered" },
			]);
			assert.ok(!worker.events.includes("attempt released"), "a stopped worker that is still asked is not fenced");
		} catch (error) {
			failure = error as Error;
		}
		process.kill(worker.pid, "SIGCONT");
		await worker.close(failure);
	},
	PIPELINED_CHAOS_TIMEOUT_MS,
);

test(
	"a commit refused by a full disk fails only itself: the worker's next commit starts after it and is answered (#4315)",
	async () => {
		const worker = await pipelinedWorker("disk-full", "disk-full");
		let failure: Error | undefined;
		try {
			worker.releaseFirst();
			await worker.until("the worker records both answers", () => worker.receivedReplies().length === 2);
			assert.deepEqual(worker.events, [
				"start first-operation",
				"end first-operation",
				"start second-operation",
				"end second-operation",
			]);
			assert.deepEqual(worker.receivedReplies(), [
				{ label: "first", outcome: "refused" },
				{ label: "second", outcome: "answered" },
			]);
		} catch (error) {
			failure = error as Error;
		}
		await worker.close(failure);
	},
	PIPELINED_CHAOS_TIMEOUT_MS,
);
