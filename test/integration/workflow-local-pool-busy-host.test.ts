/**
 * A pooled child on a busy host: its worker's commits reach the journal late, or a pool fault reaches it. Both are the
 * pool's trouble, not the child's: the child keeps its attempt, or replays from its last checkpoint, and completes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

/** Children that commit a checkpoint every few milliseconds until the test releases them. */
const childPath = fileURLToPath(new URL("../fixtures/pool-committing-child.ts", import.meta.url));
const BUDGET = poolTestBudgetMs(1);
/** Checkpoint commits the coordinator meets trouble with before the test releases the child. */
const TROUBLED_COMMITS = 2;

type Commit = SqlPoolQueue["commit"];

async function waitUntil(predicate: () => boolean, what: string, budget: AbortSignal): Promise<void> {
	while (!predicate()) {
		if (budget.aborted) throw new Error(`Timed out waiting for ${what}`);
		await sleep(20);
	}
}

/**
 * Runs one pooled child on one worker, with the coordinator in this process. `trouble` runs before the first
 * {@link TROUBLED_COMMITS} distinct checkpoint commits reach the journal. Returns the root's status, the child's, and
 * the generation of every work item.
 */
async function runWithTroubledCommits(
	trouble: (clock: Awaited<ReturnType<typeof openNodeSqliteDatabase>>, ...args: Parameters<Commit>) => Promise<void>,
): Promise<{ readonly root: string; readonly child: string | undefined; readonly generations: readonly number[] }> {
	const directory = makeTempDirectory("pool-busy-host-");
	const path = join(directory, "journal.sqlite");
	const exportName = "committingChild";
	const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
	let childStatus: string | undefined;
	const parent = workflow({
		name: "pool-busy-host-root",
		description: "Root over a pooled child whose commits meet a busy host",
		inputs: {},
		outputs: {},
		async run(ctx) {
			childStatus = (await ctx.workflow(child, { inputs: { directory, index: 0 } })).status;
			return {};
		},
	});
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName }],
		coordinator: "in-process",
	});
	const clock = await openNodeSqliteDatabase(path);
	const commit = SqlPoolQueue.prototype.commit;
	const troubled = new Set<string>();
	const spy = vi.spyOn(SqlPoolQueue.prototype, "commit").mockImplementation(async function (
		this: SqlPoolQueue,
		...args: Parameters<Commit>
	) {
		const [, , operation, mutation] = args;
		if (troubled.size < TROUBLED_COMMITS && mutation.kind === "checkpoint" && !troubled.has(operation)) {
			troubled.add(operation);
			await trouble(clock, ...args);
		}
		return commit.apply(this, args);
	});
	const runId = randomUUID();
	const budget = AbortSignal.timeout(BUDGET.waitMs);
	try {
		const running = run(
			parent,
			{},
			{ runId, cwd: directory, store: createStore(), durableBackend: backend, signal: budget },
		);
		await waitUntil(
			() => readdirSync(directory).some((name) => name.startsWith("started-")),
			"the child to start",
			budget,
		);
		await waitUntil(() => troubled.size === TROUBLED_COMMITS, "troubled commits", budget);
		await writeFileEnsuringDir(join(directory, "release"), "");
		const result = await running;
		const work = await (await openSqlPoolQueue(journal)).inspect(runId);
		return { root: result.status, child: childStatus, generations: work.map((item) => item.generation) };
	} finally {
		spy.mockRestore();
		await pool.close().catch(() => {});
		await clock.close();
		await backend.close();
		await journal.close();
		await database.close();
		removeTempDirectory(directory);
	}
}

test.skipIf(process.platform === "win32")(
	"a live worker's commit whose work lease lapsed on its way to a busy journal is recorded, not fenced and replayed",
	async () => {
		// The lease the commit was sent under has lapsed by the time it reaches the journal, and the coordinator has not
		// extended it yet, as when the coordinator is starved of CPU or other writers hold the journal's lock.
		const outcome = await runWithTroubledCommits(async (clock, _lease, work) => {
			await clock.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", work.id);
		});
		assert.equal(outcome.root, "completed", JSON.stringify(outcome));
		assert.equal(outcome.child, "completed", JSON.stringify(outcome));
		assert.deepEqual(outcome.generations, [1], "a lapsed lease alone neither fenced nor replayed the child");
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a pool infrastructure fault that reaches a pooled child replays the child instead of failing it",
	async () => {
		let faults = 0;
		const outcome = await runWithTroubledCommits(async () => {
			// Once: the replay's own commits reach the journal.
			if (faults++ === 0) throw new Error("Storage unavailable: the journal refused a write");
		});
		assert.equal(outcome.root, "completed", JSON.stringify(outcome));
		assert.equal(outcome.child, "completed", JSON.stringify(outcome));
		assert.deepEqual(outcome.generations, [2], "the faulted attempt was replayed once");
	},
	BUDGET.timeoutMs,
);

/** Longer than a control change waits for its next worker acknowledgement, as on a host too busy to answer sooner. */
const SLOW_ACKNOWLEDGEMENT_MS = 7_000;

test.skipIf(process.platform === "win32")(
	"pausing a pooled root whose workers acknowledge slowly pauses it instead of failing, and it resumes and completes",
	async () => {
		const directory = makeTempDirectory("pool-busy-host-pause-");
		const path = join(directory, "journal.sqlite");
		const exportName = "committingChild";
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName,
			digest: await definitionDigest(childPath),
		});
		const parent = workflow({
			name: "pool-busy-host-pause-root",
			description: "Root over a pooled child whose worker answers control slowly",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child, { inputs: { directory, index: 0 } });
				return {};
			},
		});
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName }],
			coordinator: "in-process",
		});
		const control = SqlPoolQueue.prototype.control;
		let slow = false;
		const spy = vi.spyOn(SqlPoolQueue.prototype, "control").mockImplementation(async function (
			this: SqlPoolQueue,
			...args: Parameters<SqlPoolQueue["control"]>
		) {
			if (slow) await sleep(SLOW_ACKNOWLEDGEMENT_MS);
			return control.apply(this, args);
		});
		const store = createStore();
		const toolControlRegistry = createToolControlRegistry();
		const runId = randomUUID();
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		try {
			const running = run(
				parent,
				{},
				{ runId, cwd: directory, store, toolControlRegistry, durableBackend: backend, signal: budget },
			);
			await waitUntil(
				() => readdirSync(directory).some((name) => name.startsWith("started-")),
				"the child to start",
				budget,
			);
			slow = true;
			await toolControlRegistry.runControl(runId)!.pause();
			slow = false;
			assert.equal(store.runs().find((candidate) => candidate.id === runId)?.status, "paused");
			assert.equal((await journal.getRun(runId))?.status, "paused");
			await toolControlRegistry.runControl(runId)!.resume();
			await writeFileEnsuringDir(join(directory, "release"), "");
			assert.equal((await running).status, "completed");
		} finally {
			slow = false;
			spy.mockRestore();
			await pool.close().catch(() => {});
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
