/**
 * The durable view of a root resumed with a child on a local worker shows what the latest attempt reached (#4874). The
 * worker stamps the checkpoints it commits with the root's attempt, so a child re-run on a worker is read as the
 * attempt that ran it.
 */
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createStore, loadWorkerWorkflow, run, workflow } from "../../packages/workflows/src/index.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

/** Structural: each of the two attempts cold-starts its own pool coordinator and worker. */
const TWO_POOLS = poolTestBudgetMs(2);
const childPath = fileURLToPath(new URL("../fixtures/pool-attempt-child.ts", import.meta.url));

useTemporaryAgentDir();

/** Names and statuses of the root and the runs reached through its boundary stages. */
function graph(runs: readonly RunSnapshot[], rootId: string): readonly string[] {
	const lines: string[] = [];
	const visit = (snapshot: RunSnapshot) => {
		lines.push(
			`${snapshot.name} [${snapshot.stages.map((stage) => `${stage.name}:${stage.status}`)}] [${snapshot.toolNodes.map(
				(tool) => `${tool.name}:${tool.status === "completed" ? "cached" : tool.status}`,
			)}]`,
		);
		const boundaries = new Set(
			snapshot.stages
				.filter((stage) => stage.status !== "failed" && stage.status !== "skipped")
				.map((stage) => stage.id),
		);
		for (const childRun of runs)
			if (childRun.parentRunId === snapshot.id && boundaries.has(childRun.parentStageId ?? "")) visit(childRun);
	};
	const root = runs.find((candidate) => candidate.id === rootId);
	if (root !== undefined) visit(root);
	return lines;
}

/**
 * `completes`: the root fails before its child, and its resumed attempt runs the child on a worker for the first time.
 * `exits before the child`: the child fails on a worker, and the resumed attempt exits before reaching it.
 */
for (const second of ["completes", "exits before the child"] as const) {
	test.skipIf(process.platform === "win32")(
		`a pooled root resumed after a failure, whose second attempt ${second}, reads durably as each attempt ran live (#4874)`,
		async () => {
			const budget = AbortSignal.timeout(TWO_POOLS.waitMs);
			const directory = makeTempDirectory("pool-attempt-identity-");
			const journalPath = join(directory, "journal.sqlite");
			const failPath = join(directory, "fail-child");
			const failRootPath = join(directory, "fail-root");
			const exitPath = join(directory, "exit-before-child");
			const child = await loadWorkerWorkflow(childPath, "child");
			const parent = workflow({
				name: "pool-attempt-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.tool("pt", {}, async () => {
						if (existsSync(failRootPath)) throw new Error("planned root failure");
						return "pt";
					});
					if (existsSync(exitPath)) ctx.exit({ reason: "stop before the child" });
					await ctx.workflow(child, { inputs: { failPath } });
					return {};
				},
			});
			const root = testRunId("pool-attempt-identity");
			/** One attempt in a backend of its own, as a resume in a new process opens the journal. */
			const attempt = async (label: string) => {
				const backend = await JournalDurableBackend.open(
					await resolveRunJournal({ journal: { path: journalPath } }),
				);
				try {
					const store = createStore();
					const result = await run(
						parent,
						{},
						{
							runId: root,
							cwd: directory,
							store,
							durableBackend: backend,
							localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
							signal: budget,
						},
					);
					const handle = backend.getWorkflow(root);
					assert.ok(handle);
					// A pooled root keeps only its own checkpoints in memory; inspection reads the rest from the journal.
					const checkpoints = await backend.readCheckpoints(root);
					assert.deepEqual(
						graph(durableWorkflowRunSnapshots(backend, handle, checkpoints), root),
						graph(store.runs(), root),
						`${label}: the durable view is the live run`,
					);
					return { result, checkpoints };
				} finally {
					await backend.close();
				}
			};
			try {
				const failure = second === "completes" ? failRootPath : failPath;
				await writeFileEnsuringDir(failure, "fail");
				assert.equal((await attempt("the first attempt failed")).result.status, "failed");
				rmSync(failure);
				if (second === "exits before the child") await writeFileEnsuringDir(exitPath, "exit");
				const { result, checkpoints } = await attempt(`the resumed root ${second}`);
				assert.equal(result.status, "completed", result.error);
				if (second === "completes") {
					// The worker ran the child in the root's second attempt and stamped what it committed with that attempt.
					const stamped = checkpoints.flatMap((checkpoint) =>
						checkpoint.kind === "tool" &&
						checkpoint.attempt === 1 &&
						checkpoint.topology?.run?.runId !== undefined &&
						checkpoint.topology.run.runId !== root
							? [checkpoint.name]
							: [],
					);
					assert.deepEqual([...new Set(stamped)].sort(), ["ct1", "ct2"]);
				}
			} finally {
				removeTempDirectory(directory);
			}
		},
		TWO_POOLS.timeoutMs,
	);
}
