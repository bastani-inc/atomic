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
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { POOL_CLEANUP_HEADROOM_MS, poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

/** Quit and resumed pooled roots: re-enqueued children, retry budgets across incarnations, fenced attempts (#3979). */

/**
 * The most any one test in this file may take. An integration shard job is cancelled after 15 minutes, and in that
 * time it also installs, builds, runs the shard's other files and reports; a test allowed longer would be cancelled with the
 * job instead of failing with its own timeout and message.
 */
const TEST_BUDGET_CAP_MS = 600_000;

/**
 * A test's budget for the cold starts it makes: one per root process (the root loads the workflow runtime through
 * jiti itself) and three per pool it starts (its coordinator, its worker, and the child's own work and teardown),
 * capped at {@link TEST_BUDGET_CAP_MS}. Every process and run of the test shares one deadline, so a slow cold start
 * leaves less for the rest instead of each getting its own bound.
 */
function testBudget(coldStarts: number): { readonly waitMs: number; readonly timeoutMs: number } {
	const waitMs = Math.min(poolTestBudgetMs(coldStarts).waitMs, TEST_BUDGET_CAP_MS - POOL_CLEANUP_HEADROOM_MS);
	return { waitMs, timeoutMs: waitMs + POOL_CLEANUP_HEADROOM_MS };
}

/** What is left of a test's budget at `deadline`, as a run signal. */
function remaining(deadline: number): AbortSignal {
	return AbortSignal.timeout(Math.max(0, deadline - Date.now()));
}

/** An in-process root over one pool. */
const POOL_COLD_STARTS = 3;
const CHILDREN = 3;

/** Polls until the condition holds, or fails once `signal` (the test's budget) is spent. */
async function waitUntil(predicate: () => boolean, signal: AbortSignal): Promise<void> {
	while (!predicate()) {
		if (signal.aborted) throw new Error("Pool resume condition timed out: the test's budget is spent");
		await sleep(20);
	}
}

function startedWorkers(directory: string): number[] {
	return readdirSync(directory)
		.filter((name) => name.startsWith("started-"))
		.map((name) => Number(name.split("-")[2]));
}

/** A quit root and its resumed incarnation each start their own pool, one after the other. */
const QUIT_RESUME = testBudget(2 * POOL_COLD_STARTS);
const childPath = fileURLToPath(new URL("../fixtures/pool-resume-child.ts", import.meta.url));

function startedChildren(directory: string): { readonly index: number; readonly pid: number }[] {
	return readdirSync(directory)
		.filter((name) => name.startsWith("started-"))
		.map((name) => ({ index: Number(name.split("-")[1]), pid: Number(name.split("-")[2]) }));
}

test.skipIf(process.platform === "win32")(
	"resuming a quit root hands its in-flight children to workers only once the root re-enqueues them (#3979)",
	async () => {
		const directory = makeTempDirectory("pool-quit-resume-");
		const path = join(directory, "journal.sqlite");
		const root = randomUUID();
		const exportName = "resumedChild";
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName,
			digest: await definitionDigest(childPath),
		});
		// Coordinator-side queue calls of the resumed root, observed in this process.
		let resuming = false;
		const enqueued = new Set<string>();
		const idleClaimsAfter: number[] = [];
		const claimedBeforeEnqueue: string[] = [];
		const enqueue = SqlPoolQueue.prototype.enqueue;
		const claim = SqlPoolQueue.prototype.claim;
		vi.spyOn(SqlPoolQueue.prototype, "enqueue").mockImplementation(async function (this: SqlPoolQueue, ...args) {
			const work = await enqueue.apply(this, args);
			if (resuming) enqueued.add(work.childRunId);
			return work;
		});
		vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (this: SqlPoolQueue, ...args) {
			const enqueuedBefore = enqueued.size;
			const work = await claim.apply(this, args);
			if (resuming) {
				if (work === undefined) idleClaimsAfter.push(enqueuedBefore);
				else if (!enqueued.has(work.childRunId)) claimedBeforeEnqueue.push(work.childRunId);
			}
			return work;
		});
		// The root enqueues its children one at a time. Before the next one, the first run waits until the
		// previous child runs on a worker; the resumed run waits until an idle worker found nothing claimable
		// after the previous enqueue, which on a queue that exposes unenqueued work only happens after a worker
		// claimed it.
		const parent = workflow({
			name: "pool-quit-resume-root",
			description: "Root that enqueues pooled children sequentially",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const pending: Promise<{ readonly status: string }>[] = [];
				for (let index = 0; index < CHILDREN; index++) {
					const running = ctx.workflow(child, { inputs: { directory, index } });
					running.catch(() => {});
					pending.push(running);
					if (index === CHILDREN - 1) break;
					if (resuming)
						await waitUntil(
							() => claimedBeforeEnqueue.length > 0 || idleClaimsAfter.some((count) => count > index),
							budget,
						);
					else await waitUntil(() => startedChildren(directory).some((entry) => entry.index === index), budget);
				}
				for (const result of await Promise.all(pending)) assert.equal(result.status, "completed");
				return {};
			},
		});
		// Both incarnations share the test's budget: what is left of it is each run's signal and bounds its waits.
		const deadline = Date.now() + QUIT_RESUME.waitMs;
		let budget = remaining(deadline);
		const open = async () => {
			budget = remaining(deadline);
			const database = await openNodeSqliteDatabase(path);
			const journal = await SqlRunJournal.open(database);
			const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
			const pool = new LocalWorkerPool(backend, {
				journalPath: path,
				workers: CHILDREN,
				definitions: [{ definition: child, path: childPath, exportName }],
				coordinator: "in-process",
			});
			return {
				backend,
				pool,
				run: () =>
					run(
						parent,
						{},
						{
							runId: root,
							cwd: directory,
							store: createStore(),
							durableBackend: backend,
							signal: budget,
						},
					),
				async close() {
					await pool.close();
					await backend.close();
					await journal.close();
					await database.close();
				},
			};
		};
		let first: Awaited<ReturnType<typeof open>> | undefined;
		let resumed: Awaited<ReturnType<typeof open>> | undefined;
		try {
			first = await open();
			const running = first.run();
			await waitUntil(() => startedWorkers(directory).length === CHILDREN, budget);
			await toolControlRegistry.runControl(root)!.quit();
			assert.equal((await running).status, "paused");
			await first.close();
			first = undefined;

			await writeFileEnsuringDir(join(directory, "release"), "");
			resuming = true;
			resumed = await open();
			// Workers exit once the completed root releases its lease, so the pool's live pid list can already be
			// empty when the run returns. Record every worker pid the resumed pool has while its run is in progress.
			const resumedPids = new Set<number>();
			const pool = resumed.pool;
			let resumedRunning = true;
			const recording = (async () => {
				while (resumedRunning) {
					for (const pid of pool.workerPids) resumedPids.add(pid);
					await sleep(5);
				}
			})();
			const result = await resumed.run().finally(() => {
				resumedRunning = false;
			});
			await recording;
			assert.deepEqual(claimedBeforeEnqueue, [], "a worker claimed a child the resumed root had not enqueued");
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.equal(enqueued.size, CHILDREN);
			const works = await (await openSqlPoolQueue(resumed.backend.journal)).inspect(root);
			assert.deepEqual(
				works.map((work) => [work.state, work.generation]),
				Array.from({ length: CHILDREN }, () => ["completed", 2]),
				"each child took exactly one attempt per incarnation; no worker crashed",
			);
			const finished = startedChildren(directory).filter((entry) => resumedPids.has(entry.pid));
			assert.deepEqual(
				finished.map((entry) => entry.index).sort(),
				[0, 1, 2],
				"every in-flight child finished on a worker of the resumed root",
			);
		} finally {
			vi.restoreAllMocks();
			await first?.close();
			await resumed?.close();
			removeTempDirectory(directory);
		}
	},
	QUIT_RESUME.timeoutMs,
);

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A root over one pooled child, reopened on the same journal for every incarnation. */
async function singleChildRoot(
	directory: string,
	workers: number,
	afterChild?: (budget: AbortSignal) => Promise<void>,
) {
	const path = join(directory, "journal.sqlite");
	const root = randomUUID();
	const exportName = "resumedChild";
	const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
	// The open incarnation's budget, which bounds the waits its root makes.
	let budget = AbortSignal.timeout(0);
	const parent = workflow({
		name: "pool-single-child-root",
		description: "Root over one pooled child",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const result = await ctx.workflow(child, { inputs: { directory, index: 0 } });
			assert.equal(result.status, "completed");
			await afterChild?.(budget);
			return {};
		},
	});
	return {
		root,
		/** One incarnation over its own pool; what is left before `deadline` bounds its run (`budget`) and its waits. */
		async open(deadline: number) {
			budget = remaining(deadline);
			const database = await openNodeSqliteDatabase(path);
			const journal = await SqlRunJournal.open(database);
			const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
			const pool = new LocalWorkerPool(backend, {
				journalPath: path,
				workers,
				definitions: [{ definition: child, path: childPath, exportName }],
				coordinator: "in-process",
			});
			return {
				budget,
				database,
				journal,
				pool,
				run: () =>
					run(
						parent,
						{},
						{
							runId: root,
							cwd: directory,
							store: createStore(),
							durableBackend: backend,
							signal: budget,
						},
					),
				async close() {
					await pool.close();
					await backend.close();
					await journal.close();
					await database.close();
				},
			};
		},
	};
}

const RESUMES = 4;

/**
 * One pool per incarnation, one after the other, and the last incarnation's killed worker replaced. Worst-case cold
 * starts for all of them exceed {@link TEST_BUDGET_CAP_MS}, so they share the capped budget: the incarnations are
 * not all at their worst at once in practice, and a slow one leaves less for the rest instead of failing alone.
 */
const RESUME_CYCLES = testBudget((RESUMES + 1) * POOL_COLD_STARTS + 1);

test.skipIf(process.platform === "win32")(
	"a child resumed many times keeps its full retry budget in each incarnation (#3979)",
	async () => {
		const directory = makeTempDirectory("pool-repeated-resume-");
		const deadline = Date.now() + RESUME_CYCLES.waitMs;
		const f = await singleChildRoot(directory, 1);
		let current: Awaited<ReturnType<typeof f.open>> | undefined;
		try {
			for (let incarnation = 1; incarnation <= RESUMES; incarnation++) {
				current = await f.open(deadline);
				const running = current.run();
				await waitUntil(() => startedChildren(directory).length === incarnation, current.budget);
				await toolControlRegistry.runControl(f.root)!.quit();
				assert.equal((await running).status, "paused");
				await current.close();
				current = undefined;
			}
			// The last incarnation loses its worker once; the child still has attempts left in this incarnation.
			current = await f.open(deadline);
			const running = current.run();
			await waitUntil(() => startedChildren(directory).length === RESUMES + 1, current.budget);
			const [crashed] = startedChildren(directory).filter((entry) => current!.pool.workerPids.includes(entry.pid));
			assert.ok(crashed, "the resumed worker runs the child");
			let settled = false;
			void running.finally(() => {
				settled = true;
			});
			process.kill(crashed.pid, "SIGKILL");
			await waitUntil(() => settled || startedChildren(directory).length === RESUMES + 2, current.budget);
			await writeFileEnsuringDir(join(directory, "release"), "");
			const result = await running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			const [work] = await (await openSqlPoolQueue(current.journal)).inspect(f.root);
			assert.equal(work?.state, "completed");
			assert.equal(work.generation, RESUMES + 2, "one attempt per incarnation plus the replayed crash");
		} finally {
			await current?.close();
			removeTempDirectory(directory);
		}
	},
	RESUME_CYCLES.timeoutMs,
);

/** One pool, whose two workers start together. */
const FENCED_ATTEMPT = testBudget(POOL_COLD_STARTS);

test.skipIf(process.platform === "win32")(
	"a worker whose attempt is fenced ends it without crashing or consuming an attempt (#3979)",
	async () => {
		const directory = makeTempDirectory("pool-fenced-attempt-");
		// Claims by the fenced worker after the fence, observed in this process.
		let fencedWorker: string | undefined;
		let fencedPid: number | undefined;
		let reclaimed = false;
		// The root outlives the fenced attempt, so its worker meets the fence and not the root's release.
		const f = await singleChildRoot(directory, 2, (budget) =>
			waitUntil(() => reclaimed || !isAlive(fencedPid!), budget),
		);
		const current = await f.open(Date.now() + FENCED_ATTEMPT.waitMs);
		const claim = SqlPoolQueue.prototype.claim;
		vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (this: SqlPoolQueue, ...args) {
			if (args[1] === fencedWorker) reclaimed = true;
			return claim.apply(this, args);
		});
		try {
			const running = current.run();
			await waitUntil(() => startedChildren(directory).length === 1, current.budget);
			const [fenced] = startedChildren(directory);
			fencedPid = fenced!.pid;
			const workers = [...current.pool.workerPids].sort();
			const queue = await openSqlPoolQueue(current.journal);
			const [held] = await queue.inspect(f.root);
			assert.equal(held?.generation, 1);
			fencedWorker = held.worker!;
			// Reassign the attempt behind the live worker's back, as a lease recovery would.
			await current.database.run(
				"UPDATE wf_runs_work SET state = 'ready', worker = NULL, expires_at = 0 WHERE id = ?",
				held.id,
			);
			await waitUntil(() => startedChildren(directory).some((entry) => entry.pid !== fenced!.pid), current.budget);
			// Both attempts finish their tool; the fenced one then asks for new work, or exits.
			await writeFileEnsuringDir(join(directory, "release"), "");
			const result = await running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.ok(isAlive(fenced!.pid), "the fenced worker crashed");
			const [work] = await queue.inspect(f.root);
			assert.equal(work?.generation, 2, "the fenced attempt consumed no further attempt");
			assert.deepEqual([...current.pool.workerPids].sort(), workers, "no worker exited");
		} finally {
			vi.restoreAllMocks();
			await current.close();
			removeTempDirectory(directory);
		}
	},
	FENCED_ATTEMPT.timeoutMs,
);
