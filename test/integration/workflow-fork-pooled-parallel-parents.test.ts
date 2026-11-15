/**
 * A fork of a run whose child ran on a two-worker local pool keeps the source's parent edges for every stage of the
 * child, the stage it forks from included (#5042). The fork's events end before the fork point's first record, so the
 * fork point used to take the replayed stage beside it as its parent.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createStore, loadWorkerWorkflow, run, workflow } from "../../packages/workflows/src/index.js";
import { forkRun, listForkPoints } from "../../packages/workflows/src/runs/foreground/sdk-fork.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

const childPath = fileURLToPath(new URL("../fixtures/pool-parallel-stages-child.ts", import.meta.url));
/** The source's pool, and one for the fork from each of the child's stages. */
const BUDGET = poolTestBudgetMs(6);

useTemporaryAgentDir();

/** Each node of every run as `run:name<-parents`, by name. */
function edges(view: readonly RunSnapshot[]): string[] {
	return view
		.flatMap((snapshot) => {
			const nodes = [...snapshot.stages, ...(snapshot.toolNodes ?? [])];
			const names = new Map(nodes.map((node) => [node.id, node.name]));
			return nodes.map(
				(node) =>
					`${snapshot.name}:${node.name}<-${node.parentIds
						.map((id) => names.get(id) ?? `?${id}`)
						.sort()
						.join("+")}`,
			);
		})
		.sort();
}

test.skipIf(process.platform === "win32").each([true, false])(
	"a fork from each stage of a pooled parallel child keeps the source's parent edges, with tools %s (#5042)",
	async (tools) => {
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		const directory = makeTempDirectory("fork-pooled-parallel-parents-");
		const backend = await JournalDurableBackend.open(
			await resolveRunJournal({ journal: { path: join(directory, "journal.sqlite") } }),
		);
		const child = await loadWorkerWorkflow(childPath, "child");
		const parent = workflow({
			name: "fork-pooled-parallel-parents-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child, { inputs: { directory, tools } });
				return {};
			},
		});
		const view = async (runId: string) =>
			edges(durableWorkflowRunSnapshots(backend, backend.getWorkflow(runId)!, await backend.readCheckpoints(runId)));
		try {
			const root = testRunId(`fork-pooled-parallel-parents-${tools}`);
			const source = await run(
				parent,
				{},
				{
					runId: root,
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					localWorkers: { count: 2, definitions: [{ path: childPath, exportName: "child" }] },
					signal: budget,
				},
			);
			assert.equal(source.status, "completed", source.error);
			const sourceEdges = await view(root);
			assert.ok(
				sourceEdges.some((edge) => edge.endsWith(":finish<-a+b")),
				JSON.stringify(sourceEdges),
			);
			const points: string[] = [];
			for await (const point of listForkPoints(root, { durableBackend: backend })) points.push(point.stagePath);
			const childPoints = points.filter((point) => point.includes("."));
			assert.equal(childPoints.length, tools ? 3 : 5, JSON.stringify(points));
			for (const fromStage of childPoints) {
				const forked = await forkRun(root, {
					fromStage,
					durableBackend: backend,
					cwd: directory,
					definition: parent,
					store: createStore(),
					signal: budget,
				});
				const result = await forked.result;
				assert.equal(result.status, "completed", `from ${fromStage}: ${result.error}`);
				assert.deepEqual(await view(forked.runId), sourceEdges, `from ${fromStage}`);
			}
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
