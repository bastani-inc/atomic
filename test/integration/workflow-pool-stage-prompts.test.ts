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
import { answerPooledStage } from "../../packages/workflows/src/workers/pooled-stage-sources.js";
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

/** A host-mode root (prompt nodes) whose children run on a pool of its own over `store`. */
async function hostRun(prefix: string, store: ReturnType<typeof createStore>, exportName = "child") {
	const directory = makeTempDirectory(prefix);
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName }],
	});
	const execution = engineRun(
		parentOf(child),
		{},
		{ runId: testRunId(prefix), cwd: directory, store, durableBackend: backend, usePromptNodesForUi: true },
	);
	const close = async () => {
		await execution.catch(() => {});
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	};
	return { execution, close, pool };
}

/** The pending prompt of a pooled stage in `store` whose run is not one of `seen`. */
function pooledPrompt(store: ReturnType<typeof createStore>, seen: readonly string[] = []) {
	for (const candidate of store.runs())
		for (const stage of candidate.stages)
			if (stage.pendingPrompt !== undefined && stage.workerExecution !== undefined && !seen.includes(candidate.id))
				return { runId: candidate.id, stageId: stage.id, promptId: stage.pendingPrompt.id };
	return undefined;
}

test.skipIf(process.platform === "win32")(
	"with two pools on one store, an answer for the second pool's stage passes the first pool and reaches its worker (#3996)",
	async () => {
		const store = createStore();
		const first = await hostRun("pool-stage-prompt-first-", store);
		let second: Awaited<ReturnType<typeof hostRun>> | undefined;
		try {
			let firstPrompt: ReturnType<typeof pooledPrompt>;
			await untilOrRunEnds(
				async () => {
					firstPrompt = pooledPrompt(store);
					return firstPrompt !== undefined;
				},
				first.execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(firstPrompt !== undefined);
			// The second pool registers on the store after the first.
			second = await hostRun("pool-stage-prompt-second-", store);
			let secondPrompt: ReturnType<typeof pooledPrompt>;
			await untilOrRunEnds(
				async () => {
					secondPrompt = pooledPrompt(store, [firstPrompt!.runId]);
					return secondPrompt !== undefined;
				},
				second.execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(secondPrompt !== undefined);
			const answered = await answerPooledStage(store, secondPrompt.runId, secondPrompt.stageId, {
				kind: "prompt",
				promptId: secondPrompt.promptId,
				response: "second-branch",
			});
			assert.deepEqual(answered, { ok: true });
			const secondOutcome = await second.execution;
			assert.deepEqual(secondOutcome.result, { branch: "second-branch" }, JSON.stringify(secondOutcome.error));
			assert.equal(
				store.resolveStagePendingPrompt(
					firstPrompt.runId,
					firstPrompt.stageId,
					firstPrompt.promptId,
					"first-branch",
				),
				true,
			);
			const firstOutcome = await first.execution;
			assert.deepEqual(firstOutcome.result, { branch: "first-branch" }, JSON.stringify(firstOutcome.error));
		} finally {
			await first.close();
			await second?.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"an SDK ui that rejects fails the pooled child with that error, and the root settles (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-stage-prompt-sdk-reject-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerWorkflow(childPath, "child");
		let asked = 0;
		const ui: WorkflowUIAdapter = {
			async input() {
				asked++;
				throw new Error("the caller's prompt window was closed");
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
					runId: testRunId("pool-stage-prompt-sdk-reject"),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					ui,
					localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
				},
			);
			assert.equal(outcome.status, "failed", JSON.stringify(outcome));
			assert.match(JSON.stringify(outcome.error), /the caller's prompt window was closed/);
			assert.equal(asked, 1, "a rejecting ui is not asked again");
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"ctx.ui.custom in a pooled child fails the child with an error naming the limitation, instead of waiting (#3996)",
	async () => {
		const store = createStore();
		const custom = await hostRun("pool-stage-prompt-custom-", store, "customChild");
		try {
			const outcome = await custom.execution;
			assert.equal(outcome.status, "failed", JSON.stringify(outcome));
			assert.match(
				JSON.stringify(outcome.error),
				/ctx\.ui\.custom is not available in a child workflow running on a local worker/,
			);
		} finally {
			await custom.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a ctx.ui prompt pending when its worker dies is asked again by the replacement, and the answer reaches it once (#3996)",
	async () => {
		const store = createStore();
		const run = await hostRun("pool-stage-prompt-kill-", store);
		try {
			let first: ReturnType<typeof pooledPrompt>;
			await untilOrRunEnds(
				async () => {
					first = pooledPrompt(store);
					return first !== undefined;
				},
				run.execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(first !== undefined);
			const generationOf = () =>
				store
					.runs()
					.find((candidate) => candidate.id === first!.runId)
					?.stages.find((stage) => stage.id === first!.stageId)?.workerExecution?.generation ?? 0;
			const killed = generationOf();
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			// The replacement asks the same question again.
			let again: ReturnType<typeof pooledPrompt>;
			await untilOrRunEnds(
				async () => {
					again = generationOf() > killed ? pooledPrompt(store) : undefined;
					return again !== undefined;
				},
				run.execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(again !== undefined);
			assert.equal(store.resolveStagePendingPrompt(again.runId, again.stageId, again.promptId, "after-kill"), true);
			const outcome = await run.execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "after-kill" });
		} finally {
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a ctx.ui answer given before its worker dies reaches the child once: the replacement replays it instead of asking again (#3996)",
	async () => {
		const store = createStore();
		const asked = new Map<string, string>();
		const unsubscribe = store.subscribe(() => {
			for (const candidate of store.runs())
				for (const stage of candidate.stages)
					if (stage.pendingPrompt !== undefined && stage.workerExecution !== undefined)
						asked.set(stage.pendingPrompt.id, stage.pendingPrompt.message);
		});
		const run = await hostRun("pool-stage-prompt-kill-answered-", store, "twoPromptChild");
		try {
			const pendingWith = (message: string) => {
				for (const candidate of store.runs())
					for (const stage of candidate.stages)
						if (stage.pendingPrompt?.message === message && stage.workerExecution !== undefined)
							return {
								runId: candidate.id,
								stageId: stage.id,
								promptId: stage.pendingPrompt.id,
								generation: stage.workerExecution.generation,
							};
				return undefined;
			};
			let first: ReturnType<typeof pendingWith>;
			await untilOrRunEnds(
				async () => {
					first = pendingWith("Which branch should the worker use?");
					return first !== undefined;
				},
				run.execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(first !== undefined);
			assert.equal(store.resolveStagePendingPrompt(first.runId, first.stageId, first.promptId, "before-kill"), true);
			// The child received the first answer: it asks its second question.
			let second: ReturnType<typeof pendingWith>;
			await untilOrRunEnds(
				async () => {
					second = pendingWith("Which remote should the worker push to?");
					return second !== undefined;
				},
				run.execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(second !== undefined);
			const [worker] = run.pool.workerPids;
			assert.ok(worker !== undefined);
			process.kill(worker, "SIGKILL");
			// The replacement asks only the unanswered question again.
			let again: ReturnType<typeof pendingWith>;
			await untilOrRunEnds(
				async () => {
					again = pendingWith("Which remote should the worker push to?");
					return again !== undefined && again.generation > second!.generation;
				},
				run.execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(again !== undefined);
			assert.equal(store.resolveStagePendingPrompt(again.runId, again.stageId, again.promptId, "origin"), true);
			const outcome = await run.execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "before-kill@origin" });
			assert.deepEqual(
				[...asked.values()].filter((message) => message === "Which branch should the worker use?"),
				["Which branch should the worker use?"],
				"the answered question is not asked again",
			);
		} finally {
			unsubscribe();
			await run.close();
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
