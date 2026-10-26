/**
 * Human-input prompts of children that run on local workers (#3996).
 *
 * A pooled child asks `ctx.ui.input`. Its prompt reaches the root, the root answers it the way
 * the stage chat and `workflow answer` do (or through an SDK caller's `ui`), and the answer
 * reaches the worker.
 */
import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { beforeAll, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run as engineRun } from "../../packages/workflows/src/engine/run.js";
import { createStore, loadWorkerWorkflow, run } from "../../packages/workflows/src/index.js";
import type { WorkflowUIAdapter } from "../../packages/workflows/src/shared/types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: a coordinator process and a worker process running a child workflow. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;
const CONDITION_TIMEOUT_MS = 60_000;

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { fileURLToPath } = await import("node:url");
	const sourceEntry = fileURLToPath(
		new URL("../../packages/workflows/src/workers/local-worker-entry.mjs", import.meta.url),
	);
	const packagedEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	return {
		...actual,
		fork: (modulePath: string | URL, args: readonly string[], options: ForkOptions) =>
			actual.fork(modulePath === sourceEntry ? packagedEntry : modulePath, args, options),
	};
});

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

const childPath = fileURLToPath(new URL("../fixtures/pool-prompt-child.ts", import.meta.url));

function parentOf(child: Awaited<ReturnType<typeof loadWorkerWorkflow>>) {
	return workflow({
		name: "pool-prompt-root",
		description: "",
		inputs: {},
		outputs: { branch: Type.String() },
		async run(ctx) {
			const result = await ctx.workflow(child, {});
			return { branch: String(result.outputs.branch) };
		},
	});
}

test.skipIf(process.platform === "win32")(
	"a pooled child's ctx.ui prompt shows at the root and the root's answer reaches its worker (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-stage-prompt-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
		});
		const store = createStore();
		try {
			const execution = engineRun(
				parentOf(child),
				{},
				// Prompt nodes are how the interactive host shows ctx.ui prompts.
				{
					runId: testRunId("pool-stage-prompt"),
					cwd: directory,
					store,
					durableBackend: backend,
					usePromptNodesForUi: true,
				},
			);
			let target: { runId: string; stageId: string; promptId: string; message: string } | undefined;
			await untilOrRunEnds(
				async () => {
					for (const candidate of store.runs())
						for (const stage of candidate.stages)
							if (stage.pendingPrompt !== undefined && stage.workerExecution !== undefined)
								target = {
									runId: candidate.id,
									stageId: stage.id,
									promptId: stage.pendingPrompt.id,
									message: stage.pendingPrompt.message,
								};
					return target !== undefined;
				},
				execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(target !== undefined);
			assert.equal(target.message, "Which branch should the worker use?");
			// What the stage chat's prompt card and `workflow answer` do with the user's answer.
			assert.equal(
				store.resolveStagePendingPrompt(target.runId, target.stageId, target.promptId, "release/2.0"),
				true,
			);
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "release/2.0" });
		} finally {
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"an SDK caller's ui answers the ctx.ui prompts of children on local workers (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-stage-prompt-sdk-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerWorkflow(childPath, "child");
		const asked: string[] = [];
		const ui: WorkflowUIAdapter = {
			async input(prompt) {
				asked.push(prompt);
				return "main";
			},
			async confirm() {
				return false;
			},
			async select(_message, options) {
				return options[0]!;
			},
			async editor(initial) {
				return initial ?? "";
			},
			async custom() {
				throw new Error("not used");
			},
		};
		try {
			const outcome = await run(
				parentOf(child),
				{},
				{
					runId: testRunId("pool-stage-prompt-sdk"),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					ui,
					localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
				},
			);
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "main" });
			assert.deepEqual(asked, ["Which branch should the worker use?"]);
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
