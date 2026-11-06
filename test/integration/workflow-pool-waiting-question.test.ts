/**
 * A real pooled child whose stage waits released on `ask_user_question` stops occupying the pool (#4374). On a
 * one-worker pool, the child asks and its stage gives up its session; the pool starts one more worker, which runs the
 * other two children while the question waits; the answer reaches the waiting child on its own worker, which continues
 * the same turn, and the pool then ends the worker it no longer needs.
 *
 * The pool forks the packaged worker bundle (`test/setup-packaged-local-worker.ts`), so this test exercises worker
 * sources only once `npm run build` in packages/coding-agent has rebuilt it.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/** Structural: a coordinator process and up to two worker processes, one running a child with an agent stage. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 180_000;
/** How long the other children may take while the question waits, before the test answers it regardless. */
const OTHERS_DEADLINE_MS = 60_000;

const childPath = fileURLToPath(new URL("../fixtures/pool-waiting-question-child.ts", import.meta.url));

async function until(holds: () => boolean, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (!holds() && Date.now() < deadline) await sleep(50);
	return holds();
}

test.skipIf(process.platform === "win32")(
	"a pooled child waiting released on its question frees the pool for the next children, gets its answer on its own worker, and the pool shrinks back (#4374)",
	async () => {
		const directory = makeTempDirectory("pool-waiting-question-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const store = createStore();
		const broker = new StageUiBroker(store);
		const digest = await definitionDigest(childPath);
		const questionChild = await loadWorkerDefinition({ path: childPath, exportName: "questionChild", digest });
		const quickChild = await loadWorkerDefinition({ path: childPath, exportName: "quickChild", digest });
		const workers = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [
				{ definition: questionChild, path: childPath, exportName: "questionChild" },
				{ definition: quickChild, path: childPath, exportName: "quickChild" },
			],
		});
		const asked = Promise.withResolvers<{ readonly runId: string; readonly stageId: string }>();
		const stopWatching = broker.onStageRequestRegistered(() => {
			for (const candidate of store.runs())
				for (const stage of candidate.stages)
					if (broker.peekStagePrompt(candidate.id, stage.id) !== undefined)
						asked.resolve({ runId: candidate.id, stageId: stage.id });
		});
		const seen = { othersFirst: false, workersWhileWaiting: 0, waitingStage: "", shrunk: false };
		try {
			const result = await run(
				workflow({
					name: "pool-waiting-question-root",
					description: "Root whose first child waits on a question while two others run",
					inputs: {},
					outputs: {},
					async run(ctx) {
						const question = ctx.workflow(questionChild, {});
						const { runId, stageId } = await asked.promise;
						const stage = store.run(runId)?.stages.find((candidate) => candidate.id === stageId);
						seen.waitingStage = `${stage?.status}:${stage?.wait?.kind}`;
						const others = [1, 2].map((index) => ctx.workflow(quickChild, { inputs: { index } }));
						seen.othersFirst = await Promise.race([
							Promise.all(others).then(() => true),
							sleep(OTHERS_DEADLINE_MS).then(() => false),
						]);
						seen.workersWhileWaiting = workers.workerPids.length;
						assert.equal(broker.answerStagePrompt(runId, stageId, { optionLabels: ["yes"] }), true);
						const answered = await question;
						const ran = await Promise.all(others);
						assert.equal(answered.status, "completed", JSON.stringify(answered));
						assert.match(String(answered.outputs.text), /answered: .*yes/s);
						for (const outcome of ran) assert.notEqual(outcome.outputs.pid, answered.outputs.pid);
						seen.shrunk = await until(() => workers.workerPids.length === 1, 30_000);
						return {};
					},
				}),
				{},
				{
					runId: testRunId("pool-waiting-question"),
					cwd: directory,
					store,
					stageUiBroker: broker,
					durableBackend: backend,
					signal: AbortSignal.timeout(LOCAL_WORKER_PROCESS_TIMEOUT_MS - 10_000),
				},
			);

			assert.equal(result.status, "completed", JSON.stringify(result.error));
			assert.equal(
				seen.waitingStage,
				"awaiting_input:tool",
				"the asking stage waited released, still awaiting input",
			);
			assert.equal(seen.othersFirst, true, "the other children ran while the question waited");
			assert.equal(seen.workersWhileWaiting, 2, "the pool started one worker for its one waiting child");
			assert.equal(seen.shrunk, true, "the pool ended the worker it no longer needed");
			assert.deepEqual(workers.health, []);
		} finally {
			stopWatching();
			await workers.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
