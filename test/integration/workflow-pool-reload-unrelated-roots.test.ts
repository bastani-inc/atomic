import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { releaseDurableBackendsHeldBy } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createStore, loadWorkerWorkflow, workflow } from "../../packages/workflows/src/index.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

const CHILDREN = 2;
const UNRELATED_ROOTS = 3;
const childPath = fileURLToPath(new URL("../fixtures/pool-resume-child.ts", import.meta.url));
const BUDGET = poolTestBudgetMs(2);

async function waitUntil(predicate: () => boolean, what: string, budget: AbortSignal): Promise<void> {
	while (!predicate()) {
		if (budget.aborted) throw new Error(`Timed out waiting for ${what}`);
		await sleep(20);
	}
}

test.skipIf(process.platform === "win32")(
	"a reload and unrelated roots leave a live pooled root's lease and children alone, and start no pool",
	async () => {
		const directory = makeTempDirectory("pool-reload-unrelated-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const child = await loadWorkerWorkflow(childPath, "resumedChild");
		const pooledRoot = workflow({
			name: "pooled-root",
			description: "A root over pooled children",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const results = await Promise.all(
					Array.from({ length: CHILDREN }, (_, index) => ctx.workflow(child, { inputs: { directory, index } })),
				);
				for (const result of results) assert.equal(result.status, "completed", JSON.stringify(result));
				return {};
			},
		});
		const unrelatedRoot = workflow({
			name: "unrelated-root",
			description: "A root with tool steps and no child workflows",
			inputs: {},
			outputs: {},
			async run(ctx) {
				for (const step of [1, 2, 3]) await ctx.tool(`step-${step}`, { step }, async () => step);
				return {};
			},
		});
		// Every launch in this session reads the same worker settings, as roots launched from a project do.
		const resources = { localWorkers: { count: 2, definitions: [{ path: childPath, exportName: "resumedChild" }] } };
		const store = createStore();
		const jobs = createJobTracker();
		const runtimeOptions = {
			definitions: [pooledRoot, unrelatedRoot],
			journal,
			store,
			jobs,
			cwd: directory,
			adapters: {},
			resolveJournalSettings: () => ({ workflows: resources }),
		};
		// Pool coordinator processes started while the test runs, whichever root started them.
		const coordinators: number[] = [];
		const emit = ChildProcess.prototype.emit as (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) => boolean;
		vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) {
			if (event === "spawn" && this.spawnargs.some((arg) => arg.includes('"role":"pool-coordinator"')))
				coordinators.push(this.pid ?? -1);
			return emit.call(this, event, ...args);
		});
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		try {
			const runtime = createExtensionRuntime(runtimeOptions);
			const started = await runtime.dispatch({ action: "run", workflow: pooledRoot.name });
			if (started.action !== "run" || !started.runId) assert.fail(JSON.stringify(started));
			const rootId = started.runId;
			await waitUntil(
				() => readdirSync(directory).filter((name) => name.startsWith("started-")).length === CHILDREN,
				"every pooled child to start",
				budget,
			);
			const leaseBefore = await journal.leaseState(rootId);
			assert.ok(leaseBefore, "the pooled root holds its lease");
			assert.equal(coordinators.length, 1, "the pooled root started its pool");

			// A workflow reload replaces the session's runtime; the pooled root keeps running on the old one.
			const reloaded = createExtensionRuntime(runtimeOptions);
			const unrelated: string[] = [];
			for (let index = 0; index < UNRELATED_ROOTS; index++) {
				const launched = await reloaded.dispatch({ action: "run", workflow: unrelatedRoot.name });
				if (launched.action !== "run" || !launched.runId) assert.fail(JSON.stringify(launched));
				unrelated.push(launched.runId);
			}
			for (const runId of unrelated) await jobs.get(runId)?.outcome;
			for (const runId of unrelated)
				assert.equal(store.runs().find((run) => run.id === runId)?.status, "completed", runId);
			assert.equal(coordinators.length, 1, "roots that never run a pooled child start no pool coordinator");

			const leaseAfter = await journal.leaseState(rootId);
			assert.equal(leaseAfter?.holderId, leaseBefore.holderId, "the pooled root's lease holder is unchanged");
			assert.equal(leaseAfter?.epoch, leaseBefore.epoch, "the pooled root's lease epoch is unchanged");

			await writeFileEnsuringDir(join(directory, "release"), "");
			await jobs.get(rootId)?.outcome;
			const root = store.runs().find((run) => run.id === rootId);
			assert.equal(root?.status, "completed", JSON.stringify(root?.error));
			assert.equal(store.runs().filter((run) => run.parentRunId === rootId).length, CHILDREN);
		} finally {
			vi.restoreAllMocks();
			await releaseDurableBackendsHeldBy(store);
			await journal.close().catch(() => {});
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
