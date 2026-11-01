/**
 * Workflow heartbeats with local worker pools.
 *
 * Only top-level runs heartbeat, to the session that launched them; a root's `ctx.workflow` children never do, and a
 * stage cannot launch a workflow of its own. So with a pool, the root keeps heartbeating to its owner from the main
 * process while its children run on workers, including across a worker crash and the replay of its child elsewhere.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { installWorkflowHeartbeatScheduler } from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowHeartbeatEventDetails } from "../../packages/workflows/src/shared/workflow-heartbeat-contract.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep, writeTextSync } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: coordinator and worker processes, and a worker crash with its replacement. */
const POOLED_WORKFLOW_HEARTBEAT_TIMEOUT_MS = 120_000;
const CONDITION_TIMEOUT_MS = 60_000;
/** Three-second cadence: three heartbeats arrive well within this. */
const HEARTBEATS_TIMEOUT_MS = 30_000;
const ROOT_HEARTBEAT_MINUTES = 0.05;

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

async function pooledChild(fixture: string, directory: string) {
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const childPath = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url));
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
	return { backend, child, pool };
}

test.skipIf(process.platform === "win32")(
	"a root whose children run on local workers keeps heartbeating to its own owner, and its children do not",
	async () => {
		const directory = makeTempDirectory("pool-root-heartbeat-");
		const releasePath = join(directory, "release");
		const { backend, child, pool } = await pooledChild("pool-heartbeat-child.ts", directory);
		const store = createStore();
		const sent: WorkflowHeartbeatEventDetails[] = [];
		const rootName = "pool-root-heartbeat";
		const scheduler = installWorkflowHeartbeatScheduler({
			store,
			sendMessage: async (message) => {
				sent.push((message as { details: WorkflowHeartbeatEventDetails }).details);
			},
			resolveIntervalMinutes: (name) => (name === rootName ? ROOT_HEARTBEAT_MINUTES : undefined),
		});
		try {
			const execution = run(
				workflow({
					name: rootName,
					description: "",
					inputs: {},
					outputs: {},
					heartbeatIntervalMinutes: ROOT_HEARTBEAT_MINUTES,
					async run(ctx) {
						await Promise.all([
							ctx.workflow(child, { inputs: { releasePath, tools: 1 } }),
							ctx.workflow(child, { inputs: { releasePath, tools: 1 } }),
						]);
						return {};
					},
				}),
				{},
				{ runId: testRunId("pool-root-heartbeat"), cwd: directory, store, durableBackend: backend },
			);
			await untilOrRunEnds(
				async () => store.runs().filter((candidate) => candidate.parentRunId !== undefined).length === 2,
				execution,
				CONDITION_TIMEOUT_MS,
			);
			await until(() => (sent.length >= 2 ? true : undefined), HEARTBEATS_TIMEOUT_MS);
			const root = store.runs().find((candidate) => candidate.parentRunId === undefined);
			assert.ok(root);
			assert.deepEqual(
				new Set(sent.map((details) => details.runId)),
				new Set([root.id]),
				"only the root heartbeats",
			);
			const boundaries = sent.map((details) => details.scheduledAt);
			assert.equal(new Set(boundaries).size, boundaries.length, "no boundary is delivered twice");

			writeTextSync(releasePath, "");
			assert.equal((await execution).status, "completed");
			const settled = sent.length;
			await sleep(ROOT_HEARTBEAT_MINUTES * 60_000 * 2);
			assert.equal(sent.length, settled, "a finished root stops heartbeating");
		} finally {
			scheduler.dispose();
			await pool.close();
			await backend.close();
			await sleep(0);
			removeTempDirectory(directory);
		}
	},
	POOLED_WORKFLOW_HEARTBEAT_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a root keeps one heartbeat per boundary across a worker crash and its child's replay on another worker",
	async () => {
		const directory = makeTempDirectory("pool-root-replay-heartbeat-");
		const crashedPath = join(directory, "crashed");
		const releasePath = join(directory, "release");
		const { backend, child, pool } = await pooledChild("pool-replayed-heartbeat-child.ts", directory);
		const store = createStore();
		const sent: WorkflowHeartbeatEventDetails[] = [];
		const rootName = "pool-root-replay-heartbeat";
		const scheduler = installWorkflowHeartbeatScheduler({
			store,
			sendMessage: async (message) => {
				sent.push((message as { details: WorkflowHeartbeatEventDetails }).details);
			},
			resolveIntervalMinutes: (name) => (name === rootName ? ROOT_HEARTBEAT_MINUTES : undefined),
		});
		try {
			const execution = run(
				workflow({
					name: rootName,
					description: "",
					inputs: {},
					outputs: {},
					heartbeatIntervalMinutes: ROOT_HEARTBEAT_MINUTES,
					async run(ctx) {
						await ctx.workflow(child, { inputs: { crashedPath, releasePath } });
						return {};
					},
				}),
				{},
				{ runId: testRunId("pool-root-replay-heartbeat"), cwd: directory, store, durableBackend: backend },
			);
			await untilOrRunEnds(async () => fileExists(crashedPath), execution, CONDITION_TIMEOUT_MS);
			const beforeReplay = sent.length;
			// The replacement worker replays the child while the root keeps its cadence.
			await until(() => (sent.length >= beforeReplay + 3 ? true : undefined), HEARTBEATS_TIMEOUT_MS);
			const root = store.runs().find((candidate) => candidate.parentRunId === undefined);
			assert.ok(root);
			assert.deepEqual(
				new Set(sent.map((details) => details.runId)),
				new Set([root.id]),
				"only the root heartbeats",
			);
			const boundaries = sent.map((details) => details.scheduledAt);
			assert.deepEqual(
				boundaries,
				[...new Set(boundaries)].sort((a, b) => a - b),
				"each boundary once, in order",
			);

			writeTextSync(releasePath, "");
			assert.equal((await execution).status, "completed");
		} finally {
			scheduler.dispose();
			await pool.close();
			await backend.close();
			await sleep(0);
			removeTempDirectory(directory);
		}
	},
	POOLED_WORKFLOW_HEARTBEAT_TIMEOUT_MS,
);
