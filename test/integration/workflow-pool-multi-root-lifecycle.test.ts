import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { releaseDurableBackendsHeldBy } from "../../packages/workflows/src/durable/backend-process-owner.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createStore, loadWorkerWorkflow, workflow } from "../../packages/workflows/src/index.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

const CHILDREN = 3;
const childPath = fileURLToPath(new URL("../fixtures/pool-resume-child.ts", import.meta.url));
/** Three roots each cold-start their own pool. */
const BUDGET = poolTestBudgetMs(3);
/** How long the first root's children keep running after the other roots came and went, before they are released. */
const SETTLE_MS = 8_000;

async function waitUntil(predicate: () => boolean, what: string, budget: AbortSignal): Promise<void> {
	while (!predicate()) {
		if (budget.aborted) throw new Error(`Timed out waiting for ${what}`);
		await sleep(20);
	}
}

test.skipIf(process.platform === "win32")(
	"a pooled root keeps every child running while another pooled root quits, a reload happens and a third pooled root starts",
	async () => {
		const directory = makeTempDirectory("pool-multi-root-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const child = await loadWorkerWorkflow(childPath, "resumedChild");
		// Each root's children wait in their own directory for their own release file.
		const pooledRoot = (name: string) =>
			workflow({
				name,
				description: "A root over pooled children",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const own = join(directory, name);
					const results = await Promise.all(
						Array.from({ length: CHILDREN }, (_, index) =>
							ctx.workflow(child, { inputs: { directory: own, index } }),
						),
					);
					for (const result of results) assert.equal(result.status, "completed", JSON.stringify(result));
					return {};
				},
			});
		const first = pooledRoot("first-root");
		const second = pooledRoot("second-root");
		const third = pooledRoot("third-root");
		const resources = {
			localWorkers: { count: CHILDREN, definitions: [{ path: childPath, exportName: "resumedChild" }] },
		};
		const store = createStore();
		const jobs = createJobTracker();
		const runtimeOptions = {
			definitions: [first, second, third],
			journal,
			store,
			jobs,
			cwd: directory,
			adapters: {},
			resolveJournalSettings: () => ({ workflows: resources }),
		};
		const started = (name: string) =>
			readdirSync(join(directory, name)).filter((entry) => entry.startsWith("started-")).length;
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		try {
			for (const name of ["first-root", "second-root", "third-root"])
				await writeFileEnsuringDir(join(directory, name, ".keep"), "");
			const runtime = createExtensionRuntime(runtimeOptions);
			const launched = await runtime.dispatch({ action: "run", workflow: first.name });
			if (launched.action !== "run" || !launched.runId) assert.fail(JSON.stringify(launched));
			const firstId = launched.runId;
			await waitUntil(() => started("first-root") === CHILDREN, "the first root's children to start", budget);
			const leaseBefore = await journal.leaseState(firstId);
			assert.ok(leaseBefore);

			// A second pooled root starts its children and is quit.
			const secondLaunch = await runtime.dispatch({ action: "run", workflow: second.name });
			if (secondLaunch.action !== "run" || !secondLaunch.runId) assert.fail(JSON.stringify(secondLaunch));
			await waitUntil(() => started("second-root") === CHILDREN, "the second root's children to start", budget);
			const quit = await quitRun(secondLaunch.runId, { store, jobs, awaitSettlement: true });
			assert.equal(quit.ok, true, JSON.stringify(quit));
			await jobs.get(secondLaunch.runId)?.outcome?.catch(() => {});

			// A workflow reload replaces the session's runtime, and a third pooled root starts on the new one.
			const reloaded = createExtensionRuntime(runtimeOptions);
			const thirdLaunch = await reloaded.dispatch({ action: "run", workflow: third.name });
			if (thirdLaunch.action !== "run" || !thirdLaunch.runId) assert.fail(JSON.stringify(thirdLaunch));
			await waitUntil(() => started("third-root") === CHILDREN, "the third root's children to start", budget);
			await sleep(SETTLE_MS);

			const firstRun = () => store.runs().find((run) => run.id === firstId);
			assert.equal(firstRun()?.status, "running", JSON.stringify(firstRun()?.error));
			const children = store.runs().filter((run) => run.parentRunId === firstId);
			assert.equal(children.length, CHILDREN);
			for (const run of children)
				assert.ok(run.endedAt === undefined, `child ${run.id} ended: ${run.status} ${run.error ?? ""}`);
			const leaseAfter = await journal.leaseState(firstId);
			assert.equal(leaseAfter?.holderId, leaseBefore.holderId, "the first root's lease holder is unchanged");
			assert.equal(leaseAfter?.epoch, leaseBefore.epoch, "the first root's lease epoch is unchanged");

			await writeFileEnsuringDir(join(directory, "first-root", "release"), "");
			await writeFileEnsuringDir(join(directory, "third-root", "release"), "");
			await jobs.get(firstId)?.outcome;
			await jobs.get(thirdLaunch.runId)?.outcome;
			for (const id of [firstId, thirdLaunch.runId]) {
				const root = store.runs().find((run) => run.id === id);
				assert.equal(root?.status, "completed", JSON.stringify(root?.error));
				const failed = store
					.runs()
					.filter((run) => run.parentRunId === id)
					.filter((run) => run.status !== "completed");
				assert.deepEqual(
					failed.map((run) => [run.id, run.status, run.error]),
					[],
				);
			}
		} finally {
			await releaseDurableBackendsHeldBy(store);
			await journal.close().catch(() => {});
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
