/**
 * Task heartbeats for a stage that runs on a local worker.
 *
 * A real two-worker pool runs a child whose agent stage starts a background shell and a background subagent, each
 * launched with a one-minute heartbeat, then holds its turn. The stage's own session on the worker receives the task
 * heartbeat for both, as an in-process stage would, and the root's `/tasks` view of the stage shows the same cadence.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, test } from "vitest";
import type { TaskHeartbeatDetails } from "../../packages/coding-agent/src/core/tasks/heartbeat-notice.js";
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
import { POOL_HEARTBEAT_MS, POOL_HEARTBEAT_SHELL_OUTPUT } from "../fixtures/pool-task-heartbeat-child.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep, writeTextSync } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Coordinator and worker processes, a real stage, shell and subagent, and the one-minute minimum heartbeat cadence. */
const POOLED_TASK_HEARTBEAT_TIMEOUT_MS = 240_000;
const CONDITION_TIMEOUT_MS = 60_000;
/** The first heartbeat is due one cadence after both tasks start; allow the worker to deliver it. */
const HEARTBEAT_TIMEOUT_MS = POOL_HEARTBEAT_MS + 60_000;

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

async function until<T>(read: () => T | undefined, timeoutMs = CONDITION_TIMEOUT_MS): Promise<T> {
	const timedOut = AbortSignal.timeout(timeoutMs);
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		timedOut.throwIfAborted();
		await sleep(50);
	}
}

test.skipIf(process.platform === "win32")(
	"a pooled stage's own session receives task heartbeats for its background shell and subagent",
	async () => {
		const directory = makeTempDirectory("pool-task-heartbeat-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const gatePath = join(directory, "release-stage");
		const childPath = fileURLToPath(new URL("../fixtures/pool-task-heartbeat-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 2,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
		});
		const store = createStore();
		try {
			const execution = run(
				workflow({
					name: "pool-task-heartbeat-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						await ctx.workflow(child, { inputs: { gatePath } });
						return {};
					},
				}),
				{},
				{ runId: testRunId("pool-task-heartbeat"), cwd: directory, store, durableBackend: backend },
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
			const events = () =>
				received
					.flatMap((message) => (message.kind === "events" ? message.events : []))
					.map(({ event }) => event as never as { type: string; tasks?: PooledStageTasks; message?: unknown });

			// The root's /tasks view of the stage lists both tasks with the cadence they launched with.
			const tasks = await until(() => {
				const latest = events()
					.filter((event) => event.type === "atomic_pooled_stage_tasks")
					.at(-1)?.tasks;
				const running = latest?.tasks.filter((task) => task.execution.kind === "running") ?? [];
				return running.length === 2 ? running : undefined;
			});
			assert.deepEqual(tasks.map((task) => [task.kind, task.heartbeatMs]).sort(), [
				["agent", POOL_HEARTBEAT_MS],
				["command", POOL_HEARTBEAT_MS],
			]);

			// The stage's own session on the worker receives one heartbeat naming both tasks.
			const heartbeat = await until(
				() =>
					events()
						.map((event) => event.message as { customType?: string; details?: TaskHeartbeatDetails } | undefined)
						.find((message) => message?.customType === "task-heartbeat")?.details,
				HEARTBEAT_TIMEOUT_MS,
			);
			assert.deepEqual(new Set(heartbeat.tasks.map((task) => task.kind)), new Set(["agent", "command"]));
			for (const task of heartbeat.tasks) assert.equal(task.intervalMs, POOL_HEARTBEAT_MS);
			const shell = heartbeat.tasks.find((task) => task.kind === "command");
			assert.deepEqual(shell?.output?.tail, [POOL_HEARTBEAT_SHELL_OUTPUT]);

			writeTextSync(gatePath, "");
			assert.equal((await execution).status, "completed");
		} finally {
			await pool.close();
			await backend.close();
			await sleep(0);
			removeTempDirectory(directory);
		}
	},
	POOLED_TASK_HEARTBEAT_TIMEOUT_MS,
);
