/**
 * What a local worker keeps in memory from one child to the next (#4197).
 *
 * A worker serves many children in turn. Each child here records one large durable `ctx.tool` output, so the root's
 * journal grows by that much per child. The worker must keep only what its current child needs: the heap it still
 * holds when a child starts, after a full collection, stays within a budget well below what the earlier children
 * recorded together. A worker that kept every finished child's checkpoints grew by every one of them, on every worker
 * of the pool, until the host ran out of memory.
 *
 * As a backstop for memory a worker accumulates anyway, `localWorkers.maxWorkerRssBytes` replaces a worker that has
 * grown past it with a fresh one once its child ends. Those replacements are not crashes: however many workers end
 * that way, the pool keeps running.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
import { makeTempDirectory, readTextSync, removeTempDirectory } from "../helpers/runtime.js";

const toolChildPath = fileURLToPath(new URL("../fixtures/pool-memory-child.ts", import.meta.url));
const stageChildPath = fileURLToPath(new URL("../fixtures/pool-memory-stage-child.ts", import.meta.url));
const recycleStubWorker = fileURLToPath(new URL("../fixtures/pool-recycle-stub-worker.mjs", import.meta.url));
const BUDGET = poolTestBudgetMs(1);
/** Each child's durable tool output. */
const CHILD_BYTES = 4 * 1024 * 1024;

interface ChildStart {
	readonly index: number;
	readonly pid: number;
	readonly heapUsed: number;
}

interface PooledRun {
	readonly status: string;
	readonly error?: unknown;
	readonly starts: readonly ChildStart[];
	readonly health: readonly string[];
	/** The worker logs left once the pool closed, with their sizes and contents. */
	readonly logsLeft: readonly { readonly name: string; readonly text: string }[];
}

function workerLogs(logDirectory: string): PooledRun["logsLeft"] {
	if (!existsSync(logDirectory)) return [];
	return readdirSync(logDirectory).map((name) => ({ name, text: readTextSync(join(logDirectory, name), "utf8") }));
}

/**
 * Runs `children` pooled children one after another on a one-worker pool, and closes the pool. Each child is the tool
 * child (one large durable tool output) unless `childPath` names another.
 */
async function runChildren(
	children: number,
	pool: Partial<ConstructorParameters<typeof LocalWorkerPool>[1]> = {},
	childPath = toolChildPath,
	bytes = CHILD_BYTES,
): Promise<PooledRun> {
	const directory = makeTempDirectory("pool-worker-memory-");
	const path = join(directory, "journal.sqlite");
	const log = join(directory, "child-starts.jsonl");
	const root = randomUUID();
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const workers = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		...pool,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
	});
	try {
		const result = await run(
			workflow({
				name: "pool-worker-memory-root",
				description: "Root running children one after another on one local worker",
				inputs: {},
				outputs: {},
				async run(ctx) {
					for (let index = 0; index < children; index++) {
						const outcome = await ctx.workflow(child, {
							inputs:
								childPath === toolChildPath ? { index, bytes, log } : { index, bytes, log, cwd: directory },
						});
						assert.equal(outcome.status, "completed", JSON.stringify(outcome));
					}
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
		const starts = existsSync(log)
			? readTextSync(log, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as ChildStart)
			: [];
		await workers.close();
		return {
			status: result.status,
			error: result.error,
			starts,
			health: workers.health,
			logsLeft: workerLogs(join(directory, "worker-logs", encodeURIComponent(root))),
		};
	} finally {
		await workers.close().catch(() => {});
		await backend.close();
		removeTempDirectory(directory);
	}
}

test.skipIf(process.platform === "win32")(
	"a local worker keeps only its current child's checkpoints in memory, not every finished child's (#4197)",
	async () => {
		const children = 12;
		const { status, error, starts } = await runChildren(children);
		assert.equal(status, "completed", JSON.stringify(error));
		assert.equal(new Set(starts.map((start) => start.pid)).size, 1, "every child ran on the one worker");
		assert.deepEqual(
			starts.map((start) => start.index),
			Array.from({ length: children }, (_, index) => index),
		);
		// The first child loads the worker's modules and sessions; from the second on, the worker is warm.
		const growth = starts.at(-1)!.heapUsed - starts[1]!.heapUsed;
		const recorded = (children - 2) * CHILD_BYTES;
		assert.ok(
			growth < 2 * CHILD_BYTES,
			`the worker's heap grew by ${(growth / 1048576).toFixed(1)} MB over ${children - 2} finished children that recorded ${(recorded / 1048576).toFixed(0)} MB (budget ${(2 * CHILD_BYTES) / 1048576} MB): ${starts.map((start) => (start.heapUsed / 1048576).toFixed(0)).join(" ")}`,
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a local worker keeps nothing of a finished child's stages or run once it runs the next child (#4197)",
	async () => {
		const children = 12;
		/** Each child's stage reply, which is also the child's output. */
		const bytes = 8 * 1024 * 1024;
		const { status, error, starts } = await runChildren(children, {}, stageChildPath, bytes);
		assert.equal(status, "completed", JSON.stringify(error));
		assert.equal(new Set(starts.map((start) => start.pid)).size, 1, "every child ran on the one worker");
		// Measured once the worker has run a few children, so its warm-up does not count.
		const from = 3;
		const growth = starts.at(-1)!.heapUsed - starts[from]!.heapUsed;
		assert.ok(
			growth < 2 * bytes,
			`the worker's heap grew by ${(growth / 1048576).toFixed(1)} MB over ${children - 1 - from} finished children whose stages replied ${(((children - 1 - from) * bytes) / 1048576).toFixed(0)} MB (budget ${(2 * bytes) / 1048576} MB): ${starts.map((start) => (start.heapUsed / 1048576).toFixed(0)).join(" ")}`,
		);
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a local worker past localWorkers.maxWorkerRssBytes is replaced by a fresh one once its child ends (#4197)",
	async () => {
		// One byte: every worker is past it once its child ends.
		const { status, error, starts, health, logsLeft } = await runChildren(4, { maxWorkerRssBytes: 1 });
		assert.equal(status, "completed", JSON.stringify(error));
		assert.deepEqual(
			starts.map((start) => start.index),
			[0, 1, 2, 3],
			"each child ran once, from start to end",
		);
		assert.equal(new Set(starts.map((start) => start.pid)).size, 4, "each child ran on a fresh worker");
		assert.deepEqual(health, [], "a worker replaced for its memory is no health event");
		assert.deepEqual(logsLeft, [], "the logs of workers replaced for their memory went with them");
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"workers that end between children for their memory are replaced without failing the pool, however many end (#4197)",
	async () => {
		// The first five workers end before they claim anything, as five workers past their limit at once would; the
		// pool's limit on workers that end without work is three.
		const { status, error, health } = await runChildren(1, { workerEntry: recycleStubWorker });
		assert.equal(status, "completed", JSON.stringify(error));
		assert.deepEqual(health, []);
	},
	BUDGET.timeoutMs,
);
