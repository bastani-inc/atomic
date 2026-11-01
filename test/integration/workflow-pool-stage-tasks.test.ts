/**
 * The background tasks of a stage that runs on a local worker, seen and driven from the root (#3996).
 *
 * A real one-worker pool runs a child whose agent stage starts a background shell and then holds its
 * turn. The root's watch of the stage receives the stage's tasks, reads the shell's output on the
 * worker and stops it there, as an in-process stage chat's `/tasks` does.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import type {
	PooledStageTasks,
	PooledStageWatch,
	PooledStageWatchMessage,
} from "../../packages/workflows/src/workers/stage-watch-types.js";
import { POOL_TASK_OUTPUT } from "../fixtures/pool-task-stage-child.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep, writeTextSync } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: a coordinator process, a worker process, and a real agent stage with a real shell in it. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;
const CONDITION_TIMEOUT_MS = 60_000;

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

async function until<T>(read: () => T | undefined): Promise<T> {
	const timedOut = AbortSignal.timeout(CONDITION_TIMEOUT_MS);
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		timedOut.throwIfAborted();
		await sleep(25);
	}
}

test.skipIf(process.platform === "win32")(
	"a pooled stage's background shell is listed, read and stopped from the root (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-stage-tasks-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const gatePath = join(directory, "release-stage");
		const childPath = fileURLToPath(new URL("../fixtures/pool-task-stage-child.ts", import.meta.url));
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
			const execution = run(
				workflow({
					name: "pool-stage-tasks-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						await ctx.workflow(child, { inputs: { gatePath } });
						return {};
					},
				}),
				{},
				{ runId: testRunId("pool-stage-tasks"), cwd: directory, store, durableBackend: backend },
			);
			const received: PooledStageWatchMessage[] = [];
			let watch: PooledStageWatch | undefined;
			await untilOrRunEnds(
				async () => {
					const target = store
						.runs()
						.flatMap((candidate) => candidate.stages.map((stage) => ({ runId: candidate.id, stage })))
						.find(({ stage }) => stage.name === "agent" && stage.workerExecution !== undefined);
					if (target?.stage.sessionId === undefined) return false;
					const result = await pool.watchPooledStage(
						{ runId: target.runId, stageId: target.stage.id },
						(message) => received.push(message),
					);
					if (!result.ok) return false;
					watch = result.watch;
					return true;
				},
				execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(watch !== undefined);
			const latestTasks = () =>
				received
					.flatMap((message) => (message.kind === "events" ? message.events : []))
					.map(({ event }) => event as never as { type: string; tasks?: PooledStageTasks })
					.filter((event) => event.type === "atomic_pooled_stage_tasks")
					.at(-1)?.tasks;
			const shell = await until(() =>
				latestTasks()?.tasks.find((task) => task.kind === "command" && task.execution.kind === "running"),
			);
			assert.ok(latestTasks()?.background.includes(shell.ref.taskId), "/tasks lists the shell");

			let text = "";
			for (
				const deadline = Date.now() + CONDITION_TIMEOUT_MS;
				Date.now() < deadline && !text.includes(POOL_TASK_OUTPUT);
			) {
				const read = await pool.sessionCommandOnPooledStage(watch.id, {
					kind: "task",
					taskId: shell.ref.taskId,
					action: { kind: "output", start: "0", maximumBytes: 8192 },
				});
				assert.ok(read.ok);
				if (read.task?.kind === "output" && read.task.result.ok) text = read.task.result.value.text;
				if (!text.includes(POOL_TASK_OUTPUT)) await sleep(50);
			}
			assert.match(text, new RegExp(POOL_TASK_OUTPUT), "the shell's output is read on the worker");

			const cancelled = await pool.sessionCommandOnPooledStage(watch.id, {
				kind: "task",
				taskId: shell.ref.taskId,
				action: { kind: "cancel" },
			});
			// JSON drops the undefined value of a successful stop.
			assert.deepEqual(cancelled, { ok: true, task: { kind: "cancel", result: { ok: true } } });
			await until(() =>
				latestTasks()?.tasks.find(
					(task) => task.ref.taskId === shell.ref.taskId && task.execution.kind !== "running",
				),
			);

			writeTextSync(gatePath, "");
			assert.equal((await execution).status, "completed");
		} finally {
			await pool.close();
			await backend.close();
			await sleep(0);
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
