/**
 * Pooled children that wait released stop occupying the pool (#4374). A child that takes the pool's worker reports its
 * stage waiting released on a tool result until the test opens its gate. The pool starts one more worker for each such
 * child, at most its `count`, which runs the next children meanwhile; the waiting child stays on its worker and
 * completes there; the pool then ends the worker it no longer needs, without replacing it. Each child runs once.
 *
 * The workers are protocol stand-ins (`test/fixtures/pool-waiting-stub-worker.mjs`) and the coordinator runs in this
 * process: the waiting is what a worker publishes, so the tests count what the pool does with it, not how a stage waits.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
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
import { makeTempDirectory, readTextSync, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const childPath = fileURLToPath(new URL("../fixtures/pool-waiting-child.ts", import.meta.url));
const stubWorker = fileURLToPath(new URL("../fixtures/pool-waiting-stub-worker.mjs", import.meta.url));
const BUDGET = poolTestBudgetMs(1);
/** How long a test waits for what the pool should do before it checks that the pool did it. */
const STEP_DEADLINE_MS = 20_000;
/** How long a test watches for a worker the pool should not start, after the step that would start one. */
const NO_MORE_WORKERS_WINDOW_MS = 2_000;

interface Step {
	readonly event: "ready" | "claimed" | "completing" | "retired";
	readonly pid: number;
	readonly index?: number;
}

type PooledChild = Awaited<ReturnType<typeof loadWorkerDefinition>>;
type RootContext = Parameters<Parameters<typeof workflow>[0]["run"]>[0];

interface Pool {
	readonly directory: string;
	readonly workers: LocalWorkerPool;
	readonly child: PooledChild;
	readonly backend: JournalDurableBackend;
	readonly root: string;
	steps(): Step[];
	until(holds: (seen: Step[]) => boolean, deadlineMs?: number): Promise<boolean>;
	gate(name: string): { readonly path: string; open(): void };
	logs(): string[];
	close(): Promise<void>;
}

async function pool(
	count: number,
	faults: { readonly failFrom?: number; readonly exitAfterReady?: number } = {},
): Promise<Pool> {
	const directory = makeTempDirectory("pool-waiting-workers-");
	const log = join(directory, "steps.jsonl");
	process.env.ATOMIC_TEST_WAITING_LOG = log;
	process.env.ATOMIC_TEST_WAITING_FAIL_FROM = String(faults.failFrom ?? 0);
	process.env.ATOMIC_TEST_WAITING_EXIT_AFTER_READY = String(faults.exitAfterReady ?? 0);
	const root = randomUUID();
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const journalPath = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path: journalPath } }));
	const workers = new LocalWorkerPool(backend, {
		journalPath,
		workers: count,
		workerEntry: stubWorker,
		coordinator: "in-process",
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
	});
	const steps = (): Step[] =>
		existsSync(log)
			? readTextSync(log, "utf8")
					.trim()
					.split("\n")
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line) as Step)
			: [];
	const logDirectory = join(directory, "worker-logs", encodeURIComponent(root));
	return {
		directory,
		workers,
		child,
		backend,
		root,
		steps,
		async until(holds, deadlineMs = STEP_DEADLINE_MS) {
			const deadline = Date.now() + deadlineMs;
			while (!holds(steps()) && Date.now() < deadline) await sleep(50);
			return holds(steps());
		},
		gate(name) {
			const path = join(directory, name);
			return { path, open: () => writeFileSync(path, "") };
		},
		logs: () => (existsSync(logDirectory) ? readdirSync(logDirectory) : []),
		async close() {
			delete process.env.ATOMIC_TEST_WAITING_LOG;
			delete process.env.ATOMIC_TEST_WAITING_FAIL_FROM;
			delete process.env.ATOMIC_TEST_WAITING_EXIT_AFTER_READY;
			await workers.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		},
	};
}

function runRoot(p: Pool, body: (ctx: RootContext) => Promise<void>) {
	return run(
		workflow({
			name: "pool-waiting-workers-root",
			description: "Root of children that wait released",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await body(ctx);
				return {};
			},
		}),
		{},
		{
			runId: p.root,
			cwd: p.directory,
			store: createStore(),
			durableBackend: p.backend,
			signal: AbortSignal.timeout(BUDGET.waitMs),
		},
	);
}

function start(ctx: RootContext, p: Pool, index: number, mode: "waits" | "holds" | "quick", gate: string) {
	return ctx.workflow(p.child, { inputs: { index, mode, gate } });
}

const count = (seen: Step[], event: Step["event"]) => seen.filter((step) => step.event === event).length;
const completed = (seen: Step[], index: number) =>
	seen.some((step) => step.event === "completing" && step.index === index);
const readyWorkers = (seen: Step[]) => new Set(seen.filter((step) => step.event === "ready").map((step) => step.pid));

test.skipIf(process.platform === "win32")(
	"a pooled child waiting released frees its worker's place for the next children, and the pool shrinks back without replacing the worker it ends (#4374)",
	async () => {
		const p = await pool(1);
		const gate = p.gate("gate-0");
		const seen = { othersFirst: false, retired: false, logsAfterRetire: [] as string[], replaced: true };
		try {
			const result = await runRoot(p, async (ctx) => {
				const waiting = start(ctx, p, 0, "waits", gate.path);
				assert.equal(
					await p.until((steps) => count(steps, "claimed") === 1),
					true,
					"the waiting child took the worker",
				);
				const others = [1, 2].map((index) => start(ctx, p, index, "quick", gate.path));
				seen.othersFirst = await p.until(
					(steps) => completed(steps, 1) && completed(steps, 2) && !completed(steps, 0),
				);
				gate.open();
				for (const outcome of await Promise.all([waiting, ...others]))
					assert.equal(outcome.status, "completed", JSON.stringify(outcome));
				seen.retired = await p.until((steps) => count(steps, "retired") === 1);
				await p.until(() => p.logs().length === 1);
				seen.logsAfterRetire = p.logs();
				seen.replaced = await p.until((steps) => readyWorkers(steps).size > 2, NO_MORE_WORKERS_WINDOW_MS);
			});
			const steps = p.steps();
			const claims = steps.filter((step) => step.event === "claimed");
			const waitingWorker = claims.find((step) => step.index === 0)?.pid;

			assert.equal(result.status, "completed", JSON.stringify(result.error));
			assert.equal(
				seen.othersFirst,
				true,
				`the other children waited for the waiting one: ${JSON.stringify(steps)}`,
			);
			assert.deepEqual(
				claims.map((step) => step.index).sort(),
				[0, 1, 2],
				"each child was claimed once: nothing ran twice",
			);
			assert.equal(
				steps.find((step) => step.event === "completing" && step.index === 0)?.pid,
				waitingWorker,
				"the waiting child completed on the worker it waited on",
			);
			assert.deepEqual(
				claims.filter((step) => step.index !== 0).map((step) => step.pid === waitingWorker),
				[false, false],
				"the other children ran on the worker started for the waiting one",
			);
			assert.equal(readyWorkers(steps).size, 2, "one worker was started for the one waiting child, and no more");
			assert.equal(seen.retired, true, `the pool ended one worker it no longer needed: ${JSON.stringify(steps)}`);
			assert.equal(count(steps, "retired"), 1);
			assert.equal(seen.logsAfterRetire.length, 1, "the ended worker's log went with it");
			assert.equal(seen.replaced, false, "nothing replaced the worker the pool ended");
			assert.deepEqual(p.workers.health, []);
		} finally {
			await p.close();
		}
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"only children that wait released free their places: a busy child keeps its own (#4374)",
	async () => {
		const p = await pool(2);
		const waitingGate = p.gate("gate-waiting");
		const busyGate = p.gate("gate-busy");
		const seen = { quickDone: false, readyWhileWaiting: 0 };
		try {
			const result = await runRoot(p, async (ctx) => {
				const waiting = start(ctx, p, 0, "waits", waitingGate.path);
				const busy = start(ctx, p, 1, "holds", busyGate.path);
				assert.equal(await p.until((steps) => count(steps, "claimed") === 2), true, "both took a worker");
				const quick = [2, 3].map((index) => start(ctx, p, index, "quick", waitingGate.path));
				seen.quickDone = await p.until((steps) => completed(steps, 2) && completed(steps, 3));
				await p.until((steps) => readyWorkers(steps).size > 3, NO_MORE_WORKERS_WINDOW_MS);
				seen.readyWhileWaiting = readyWorkers(p.steps()).size;
				waitingGate.open();
				busyGate.open();
				for (const outcome of await Promise.all([waiting, busy, ...quick]))
					assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			});

			assert.equal(result.status, "completed", JSON.stringify(result.error));
			assert.equal(seen.quickDone, true, "the next children ran while one child waited and one was busy");
			assert.equal(seen.readyWhileWaiting, 3, "the pool started one worker, for its one waiting child only");
		} finally {
			await p.close();
		}
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a worker started for a waiting child that cannot start is reported once, and the children still all complete (#4374)",
	async () => {
		const p = await pool(1, { failFrom: 2 });
		const gate = p.gate("gate-0");
		const seen = { health: [] as string[] };
		try {
			const result = await runRoot(p, async (ctx) => {
				const waiting = start(ctx, p, 0, "waits", gate.path);
				assert.equal(
					await p.until((steps) => count(steps, "claimed") === 1),
					true,
					"the waiting child took the worker",
				);
				const others = [1, 2].map((index) => start(ctx, p, index, "quick", gate.path));
				const deadline = Date.now() + STEP_DEADLINE_MS;
				while (p.workers.health.length === 0 && Date.now() < deadline) await sleep(50);
				await sleep(NO_MORE_WORKERS_WINDOW_MS);
				seen.health = [...p.workers.health];
				gate.open();
				for (const outcome of await Promise.all([waiting, ...others]))
					assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			});

			assert.equal(result.status, "completed", JSON.stringify(result.error));
			assert.equal(seen.health.length, 1, JSON.stringify(seen.health));
			assert.match(seen.health[0]!, /A worker started while children wait could not start/);
			assert.equal(readyWorkers(p.steps()).size, 1);
		} finally {
			await p.close();
		}
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"once fewer children wait, the pool ends a worker even while a child is ready, and the child runs on a worker it keeps (#4374)",
	async () => {
		const p = await pool(1);
		const waitingGate = p.gate("gate-waiting");
		const busyGate = p.gate("gate-busy");
		try {
			const result = await runRoot(p, async (ctx) => {
				const waiting = start(ctx, p, 0, "waits", waitingGate.path);
				assert.equal(
					await p.until((steps) => count(steps, "claimed") === 1),
					true,
					"the waiting child took the worker",
				);
				const busy = start(ctx, p, 1, "holds", busyGate.path);
				assert.equal(await p.until((steps) => count(steps, "claimed") === 2), true, "a worker started for it");
				const ready = start(ctx, p, 2, "quick", busyGate.path);
				waitingGate.open();
				assert.equal(await p.until((steps) => count(steps, "retired") === 1), true, "a worker ended");
				busyGate.open();
				for (const outcome of await Promise.all([waiting, busy, ready]))
					assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			});
			const steps = p.steps();
			const retiredWorker = steps.find((step) => step.event === "retired")?.pid;
			const readyChildWorker = steps.find((step) => step.event === "claimed" && step.index === 2)?.pid;

			assert.equal(result.status, "completed", JSON.stringify(result.error));
			assert.notEqual(readyChildWorker, retiredWorker, "the worker that ended took no child once told to end");
			assert.equal(count(steps, "retired"), 1);
		} finally {
			await p.close();
		}
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a worker that exits without a child is still replaced: only a worker the pool ended is not (#4374)",
	async () => {
		const p = await pool(1, { exitAfterReady: 1 });
		const gate = p.gate("gate-0");
		const seen = { ran: false };
		try {
			const result = await runRoot(p, async (ctx) => {
				const child = start(ctx, p, 0, "quick", gate.path);
				seen.ran = await Promise.race([child.then(() => true), sleep(STEP_DEADLINE_MS).then(() => false)]);
			});

			assert.equal(result.status, "completed", JSON.stringify(result.error));
			assert.equal(seen.ran, true, `the child ran on the replacement worker: ${JSON.stringify(p.steps())}`);
			assert.equal(readyWorkers(p.steps()).size, 2);
		} finally {
			await p.close();
		}
	},
	BUDGET.timeoutMs,
);
