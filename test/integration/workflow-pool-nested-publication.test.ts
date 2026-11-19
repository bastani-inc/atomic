import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { loadWorkerWorkflow } from "../../packages/workflows/src/workers/definitions.js";
import { startWorkflowWorkerHost } from "../../packages/workflows/src/workers/worker-host.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

const path = fileURLToPath(new URL("../fixtures/pool-nested-publication-child.ts", import.meta.url));
const adapter = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const exportName = "nestedChild";

for (const remote of [false, true]) {
	const budget = poolTestBudgetMs(remote ? 2 : 1);
	for (const slow of [false, true]) {
		// Worker processes require process-group containment. The separate host restores the bound tree so only it can claim.
		test.skipIf(process.platform === "win32")(
			`a ${remote ? "separate host" : "local worker"} publishes a ${slow ? "live" : "quick"} nested run through its final graph state (#5616)`,
			async () => {
				const directory = makeTempDirectory("pool-nested-publication-");
				const sharedJournal = { adapter, options: { url: pathToFileURL(join(directory, "shared.db")).href } };
				const host = remote
					? await startWorkflowWorkerHost({
							journal: sharedJournal,
							agentDir: join(directory, "host"),
							hostId: "nested-host",
							maxWorkers: 1,
							restore: async () => directory,
						})
					: undefined;
				try {
					const child = await loadWorkerWorkflow(path, exportName);
					const store = createStore();
					const release = slow ? join(directory, "release") : "";
					const deep = slow !== remote;
					const observed: string[] = [];
					let releaseWrite: Promise<void> | undefined;
					const unsubscribe = store.subscribeInvalidation(() => {
						if (!slow || releaseWrite) return;
						const leaf = store.runs().find((r) => r.name === "publication-leaf");
						if (leaf?.toolNodes.some((t) => t.status === "running")) {
							observed.push(leaf.id);
							releaseWrite = writeFileEnsuringDir(release, "");
						}
					});
					try {
						const result = await run(
							workflow({
								name: "publication-root",
								description: "",
								inputs: {},
								outputs: {},
								async run(ctx) {
									await ctx.workflow(child, { inputs: { deep, release } });
									return {};
								},
							}),
							{},
							{
								cwd: directory,
								config: {
									maxDepth: 4,
									defaultConcurrency: 1,
									persistRuns: true,
									statusFile: false,
									resumeInFlight: "never",
								},
								store,
								signal: AbortSignal.timeout(budget.waitMs),
								journal: remote ? sharedJournal : { path: join(directory, "journal.sqlite") },
								localWorkers: { count: 1, definitions: [{ path, exportName }] },
								...(remote
									? {
											workers: {
												placement: "shared",
												workspace: {
													remotes: ["https://example.invalid/repo.git"],
													tree: "2".repeat(40),
													head: "1".repeat(40),
													envHash: "nested",
												},
											},
										}
									: {}),
							},
						);
						assert.match(result.error ?? "", /nested check failed/);
						const runs = store.runs();
						assert.deepEqual(
							runs.map((r) => [r.name, r.status]),
							[
								"publication-root",
								"publication-child",
								...(deep ? ["publication-middle"] : []),
								"publication-leaf",
							].map((name) => [name, "failed"]),
						);
						const leaf = runs.at(-1)!;
						if (remote) assert.match(runs[1]!.stages[0]!.workerExecution!.worker, /^nested-host\//);
						if (slow) assert.deepEqual(observed, [leaf.id]);
						const graph = expandWorkflowGraph(store.graphSnapshot(), result.runId);
						assert.deepEqual(
							graph.tools.map((t) => [t.name, t.status, t.runId, t.depth]),
							[["check", "failed", leaf.id, deep ? 3 : 2]],
						);
					} finally {
						unsubscribe();
						await releaseWrite;
					}
				} finally {
					await host?.stop();
					removeTempDirectory(directory);
				}
			},
			budget.timeoutMs,
		);
	}
}
