/**
 * A pooled child's worker that dies right after the root accepted a `ctx.ui` answer (#4941).
 *
 * A real two-worker pool runs a child that checkpoints a tool, asks the user, then runs stages with the answer. The
 * worker running it is SIGKILLed at several points after the root accepted the answer. Whatever the dead attempt
 * committed, the replacement uses that first answer exactly once: the prompt is never shown again, and the root
 * completes. Run repeatedly (`POOL_UI_ANSWER_REPEAT`, or `azure-ci exec --repeat`) to cover the timing windows.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterEach, beforeAll, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run as engineRun } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/index.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import type { PooledPromptAnswer, PromptResult } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: a coordinator process and worker processes in turn running one child workflow. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 240_000;
const CONDITION_TIMEOUT_MS = 90_000;
const KILL_DELAYS_MS = [0, 50, 200, 1500] as const;
const REPEAT = Math.max(1, Number(process.env.POOL_UI_ANSWER_REPEAT ?? 1));

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

afterEach(() => {
	// Restoring alone keeps each spy, with its record of every call (`this`, arguments and result), for the rest of
	// the file: about 11 MB a test here, since each call's `this` is a whole worker pool. Resetting first drops them.
	vi.resetAllMocks();
	vi.restoreAllMocks();
});

/**
 * Resolves once the root's answer to the child's prompt came back accepted by the worker that asked it: from then
 * on the attempt holds the answer, and commits the prompt's completion and its answer.
 */
function answerDelivered(): Promise<void> {
	const answer = LocalWorkerPool.prototype.answerPooledStagePrompt;
	const delivered = Promise.withResolvers<void>();
	vi.spyOn(LocalWorkerPool.prototype, "answerPooledStagePrompt").mockImplementation(async function (
		this: LocalWorkerPool,
		runId: string,
		stageId: string,
		reply: PooledPromptAnswer,
	): Promise<PromptResult> {
		const result = await answer.call(this, runId, stageId, reply);
		if (reply.kind === "prompt" && result.ok) delivered.resolve();
		return result;
	});
	return delivered.promise;
}

const childPath = fileURLToPath(new URL("../fixtures/pool-ui-answer-child.ts", import.meta.url));

/** The pooled child's pending `which?` prompt, and the attempt that asks it. */
function pendingPrompt(store: ReturnType<typeof createStore>) {
	for (const candidate of store.runs())
		for (const stage of candidate.stages)
			if (stage.pendingPrompt?.message === "which?" && stage.workerExecution !== undefined)
				return {
					runId: candidate.id,
					stageId: stage.id,
					promptId: stage.pendingPrompt.id,
					generation: stage.workerExecution.generation,
				};
	return undefined;
}

function attemptPids(directory: string): number[] {
	return readFileSync(join(directory, "attempt-pids"), "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map(Number);
}

/** `root`: the delay runs from the root accepting the answer; `worker`: from the worker taking it. */
const cases = (["root", "worker"] as const).flatMap((from) =>
	KILL_DELAYS_MS.flatMap((delay) => Array.from({ length: REPEAT }, (_, index) => ({ from, delay, index: index + 1 }))),
);

test.skipIf(process.platform === "win32").each(cases)(
	"a worker killed $delay ms after the $from took a ctx.ui answer: the replacement uses that answer once without asking again, and the root completes (#4941) [run $index]",
	async ({ from, delay }) => {
		const delivered = answerDelivered();
		const directory = makeTempDirectory(`pool-ui-answer-${delay}-`);
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "answeredChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 2,
			definitions: [{ definition: child, path: childPath, exportName: "answeredChild" }],
		});
		const store = createStore();
		const execution = engineRun(
			workflow({
				name: "pool-ui-answer-root",
				description: "",
				inputs: {},
				outputs: { branch: Type.String(), stages: Type.Number() },
				async run(ctx) {
					const result = await ctx.workflow(child, {});
					return { branch: String(result.outputs.branch), stages: Number(result.outputs.stages) };
				},
			}),
			{},
			{
				runId: testRunId(`pool-ui-answer-${delay}`),
				cwd: directory,
				store,
				durableBackend: backend,
				usePromptNodesForUi: true,
			},
		);
		let settled = false;
		void execution.finally(() => {
			settled = true;
		});
		try {
			let first: ReturnType<typeof pendingPrompt>;
			await untilOrRunEnds(
				async () => {
					first = pendingPrompt(store);
					return first !== undefined;
				},
				execution,
				CONDITION_TIMEOUT_MS,
			);
			const asked = first!;
			const [pid] = attemptPids(directory);
			assert.ok(pid !== undefined);
			assert.equal(
				store.resolveStagePendingPrompt(asked.runId, asked.stageId, asked.promptId, "first-answer"),
				true,
				"the root accepted the answer",
			);
			if (from === "worker") await delivered;
			if (delay > 0) await sleep(delay);
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
			// A prompt the replacement shows again is answered differently, so the run settles and the test sees it.
			let reshown = 0;
			while (!settled) {
				const again = pendingPrompt(store);
				if (again !== undefined && again.generation > asked.generation) {
					reshown++;
					store.resolveStagePendingPrompt(again.runId, again.stageId, again.promptId, "second-answer");
				}
				await sleep(10);
			}
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "first-answer", stages: 2 });
			assert.equal(reshown, 0, "the accepted answer answers the replacement; the prompt is not shown again");
		} finally {
			await pool.close();
			await execution.catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
