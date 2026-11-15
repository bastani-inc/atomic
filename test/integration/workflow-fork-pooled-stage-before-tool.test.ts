/**
 * A fork of a pooled run whose stage is created before the tool its first call follows (#4945): the fork, a fresh-id
 * continuation of the run's records, replays the stage when it is created, before the tool replays, with the tool as its
 * parent.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import type { RunContinuationOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { forkRun, listForkPoints } from "../../packages/workflows/src/runs/foreground/sdk-fork.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { loadWorkerWorkflow } from "../../packages/workflows/src/workers/definitions.js";
import { hostWorkerBindings } from "../../packages/workflows/src/workers/host-options.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** The source and the fork each cold-start a pool. */
const BUDGET = poolTestBudgetMs(2);
const childPath = fileURLToPath(new URL("../fixtures/pool-tool-stage-child.ts", import.meta.url));

/** The edges of a root and each of its child runs, by run and node name, so runs with different node ids compare. */
function runEdges(runs: readonly RunSnapshot[]): readonly string[] {
	return runs
		.flatMap((snapshot) => {
			const nodes = [...snapshot.stages, ...snapshot.toolNodes];
			const names = new Map(nodes.map((node) => [node.id, node.name]));
			const runName = snapshot.parentRunId === undefined ? "root" : snapshot.name;
			return nodes.map(
				(node) =>
					`${runName}: ${node.name} <- ${node.parentIds
						.map((id) => names.get(id) ?? id)
						.sort()
						.join("+")}`,
			);
		})
		.sort();
}

/** The root's runs as a fresh connection to the journal rebuilds them, with every record the pool's processes wrote. */
async function recordedRuns(path: string, runId: string): Promise<readonly RunSnapshot[]> {
	const records = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	try {
		return durableWorkflowRunSnapshots(records, records.getWorkflow(runId)!);
	} finally {
		await records.close();
	}
}

/** Each stage's parents, by node name, so runs with different node ids compare. */
function stageParents(snapshot: Pick<RunSnapshot, "stages" | "toolNodes">): Record<string, readonly string[]> {
	const names = new Map([...snapshot.stages, ...snapshot.toolNodes].map((node) => [node.id, node.name]));
	return Object.fromEntries(
		snapshot.stages.map((stage) => [stage.name, stage.parentIds.map((id) => names.get(id) ?? id).sort()]),
	);
}

test.skipIf(process.platform === "win32")(
	"a fork of a pooled run replays a stage created before its tool, with the tool as its parent (#4945)",
	async () => {
		const directory = makeTempDirectory("fork-pooled-stage-before-tool-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerWorkflow(childPath, "child");
		const state = { reviewFails: true };
		// `agent` and `review` are each created before the tool their call follows; the source fails in review's call.
		const root: WorkflowDefinition = workflow({
			name: "fork-pooled-stage-before-tool-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const agent = ctx.stage("agent");
				await ctx.tool("start", {}, async () => "started");
				await agent.prompt("agent");
				const result = await ctx.workflow(child, { inputs: { directory, hold: "none", intercom: false } });
				assert.equal(result.status, "completed");
				const review = ctx.stage("review");
				await ctx.tool("check", {}, async () => "checked");
				await review.prompt("review");
				return {};
			},
		}) as WorkflowDefinition;
		const start = (runId: string, continuation?: RunContinuationOpts) =>
			run(
				root,
				{},
				{
					runId,
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: AbortSignal.timeout(BUDGET.waitMs),
					toolControlRegistry: createToolControlRegistry(),
					// The root's own stage answers in this process; the pool's child stage answers on its worker.
					adapters: {
						prompt: {
							prompt: async (text: string) => {
								if (text === "review" && state.reviewFails) throw new Error("planned review failure");
								return text;
							},
						},
					},
					[hostWorkerBindings]: true,
					localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
					...(continuation === undefined ? {} : { continuation }),
				},
			);
		try {
			const sourceId = testRunId("fork-pooled-stage-before-tool-source");
			const failed = await start(sourceId);
			assert.equal(failed.status, "failed");
			assert.match(failed.error ?? "", /planned review failure/);

			// The fork continues the source as its records hold it, as a fork of a pooled run does.
			// A fresh connection reads every record the pool's processes wrote.
			const records = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
			let source: RunSnapshot | undefined;
			try {
				source = durableWorkflowRunSnapshots(records, records.getWorkflow(sourceId)!).find(
					(candidate) => candidate.id === sourceId,
				);
			} finally {
				await records.close();
			}
			assert.ok(source, "the source's records rebuild it");
			const review = source.stages.find((stage) => stage.name === "review");
			assert.ok(review, "the source recorded its failed stage");

			state.reviewFails = false;
			const fork = await start(testRunId("fork-pooled-stage-before-tool-fork"), {
				source,
				resumeFromStageId: review.id,
			});
			assert.equal(fork.status, "completed", fork.error);
			const agent = fork.stages.find((stage) => stage.name === "agent");
			assert.equal(agent?.replayed, true, "the stage replays");
			assert.deepEqual(agent?.parentIds, [source.toolNodes.find((node) => node.name === "start")!.id]);
			// Every stage the source recorded keeps its parents in the fork.
			const forkParents = stageParents(fork);
			for (const [name, parents] of Object.entries(stageParents(source)))
				assert.deepEqual(forkParents[name], parents, name);
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a fork of a pooled run, from each stage, completes with the source's prefix and edges (#4945)",
	async () => {
		const directory = makeTempDirectory("fork-pooled-each-stage-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerWorkflow(childPath, "child");
		// Two pooled children of the stage-before-tool shape, then a tool: each child's `agent` is created before the
		// `start` its call follows.
		const root: WorkflowDefinition = workflow({
			name: "fork-pooled-each-stage-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				for (let index = 0; index < 2; index++) {
					const result = await ctx.workflow(child, { inputs: { directory, hold: "none", intercom: false } });
					assert.equal(result.status, "completed");
				}
				await ctx.tool("after", {}, async () => "after");
				return {};
			},
		}) as WorkflowDefinition;
		try {
			const sourceId = testRunId("fork-pooled-each-stage-source");
			const source = await run(
				root,
				{},
				{
					runId: sourceId,
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: AbortSignal.timeout(BUDGET.waitMs),
					toolControlRegistry: createToolControlRegistry(),
					localWorkers: { count: 2, definitions: [{ path: childPath, exportName: "child" }] },
				},
			);
			assert.equal(source.status, "completed", source.error);
			const sourceRuns = await recordedRuns(path, sourceId);
			const expected = runEdges(sourceRuns);
			assert.ok(
				expected.some((edge) => edge.endsWith(": agent <- start")),
				expected.join("\n"),
			);

			const points: string[] = [];
			for await (const point of listForkPoints(sourceId, { durableBackend: backend, cwd: directory }))
				points.push(point.stagePath);
			assert.ok(points.length >= 4, `the source has a fork point per stage: ${points.join(", ")}`);
			for (const fromStage of points) {
				const forked = await forkRun(sourceId, {
					fromStage,
					durableBackend: backend,
					cwd: directory,
					definition: root,
					store: createStore(),
					signal: AbortSignal.timeout(BUDGET.waitMs),
				});
				const result = await forked.result;
				assert.equal(result.status, "completed", `${fromStage}: ${result.error}`);
				assert.deepEqual(runEdges(await recordedRuns(path, forked.runId)), expected, fromStage);
			}
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	poolTestBudgetMs(10).timeoutMs,
);
