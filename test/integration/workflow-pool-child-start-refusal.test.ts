/**
 * A pooled child whose waiting stage's session is gone when it starts again refuses at once, typed, without running
 * its body or being retried by the pool; a later resume of its root, with the session back, runs the child again
 * instead of replaying the refusal. A child that failed on its own keeps that failure across a resume (#4440).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue, type PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import {
	createStageReplayKeyGenerator,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createCheckpointIdGenerator } from "../../packages/workflows/src/durable/tool-primitive.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { findStageWaitError, StageRehydrationError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowInputValues } from "../../packages/workflows/src/shared/types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { openWorkerJournals } from "../../packages/workflows/src/workers/local-worker.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import {
	makeTempDirectory,
	readDirectorySync,
	readTextSync,
	removeTempDirectory,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const faultedChildPath = fileURLToPath(new URL("../fixtures/pool-infrastructure-fault-child.ts", import.meta.url));
const failingChildPath = fileURLToPath(new URL("../fixtures/pool-named-failure-child.ts", import.meta.url));
/** The pools of the root's three incarnations. */
const BUDGET = poolTestBudgetMs(3);
const MISSING_SESSION = "pooled-waiting-session";

/** A root over one pooled child, run and resumed in incarnations that each open their own pool over its journal. */
interface PooledRoot {
	readonly runId: string;
	readonly caught: unknown[];
	readonly childName: string;
	start(): Promise<string>;
	resume(): Promise<RunSnapshot | undefined>;
	/** The child's work in the pool's queue. */
	pooledChild(): Promise<PoolWork>;
	/** The child's recorded result in the pool's queue. */
	recordedResult(work: PoolWork): Promise<StoredResult | undefined>;
	/** As if the earlier process were gone: its lease is old enough for another process to take the root over. */
	releaseRoot(): Promise<void>;
	readonly journal: SqlRunJournal;
	close(): Promise<void>;
}

interface StoredResult {
	readonly status?: string;
	readonly failureDetail?: {
		readonly name?: string;
		readonly code?: string;
		readonly fields?: { readonly [key: string]: unknown };
	};
}

async function pooledRoot(
	directory: string,
	childPath: string,
	exportName: string,
	inputs: WorkflowInputValues,
): Promise<PooledRoot> {
	const path = join(directory, "journal.sqlite");
	const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
	const caught: unknown[] = [];
	const parent = workflow({
		name: "pool-child-start-refusal-root",
		description: "Root over one pooled child",
		inputs: {},
		outputs: {},
		async run(ctx) {
			try {
				await ctx.workflow(child, { inputs });
			} catch (error) {
				caught.push(error);
				throw error;
			}
			return {};
		},
	});
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const runId = randomUUID();
	const budget = AbortSignal.timeout(BUDGET.waitMs);
	const pool = (backend: JournalDurableBackend) =>
		new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName }],
			coordinator: "in-process",
		});
	return {
		runId,
		caught,
		childName: child.name,
		journal,
		async start() {
			const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
			const started = pool(backend);
			try {
				const result = await run(
					parent,
					{},
					{ runId, cwd: directory, store: createStore(), durableBackend: backend, signal: budget },
				);
				return result.status;
			} finally {
				await started.close().catch(() => {});
				await backend.close();
			}
		},
		async resume() {
			const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
			const resumed = pool(backend);
			try {
				const jobs = createJobTracker();
				const store = createStore();
				let completion: Promise<unknown> | undefined;
				const accepted = await resumeDurableWorkflow(runId, {
					registry: createRegistry().register(parent),
					baseRunOpts: { store, cwd: directory, signal: budget },
					durableBackend: backend,
					jobs,
					onRunAccepted: (id: string) => {
						completion = jobs.get(id)?.promise;
					},
				});
				assert.equal(accepted.ok, true, accepted.message);
				await completion;
				return store.runs().find((candidate) => candidate.id === runId);
			} finally {
				await resumed.close().catch(() => {});
				await backend.close();
			}
		},
		async pooledChild() {
			const [work] = await (await openSqlPoolQueue(journal)).inspect(runId);
			assert.ok(work, "the child was not dispatched to the pool");
			return work;
		},
		async recordedResult(work) {
			return (await (await openSqlPoolQueue(journal)).result(runId, work.id)) as StoredResult | undefined;
		},
		async releaseRoot() {
			await database.run("UPDATE wf_leases SET renewed_at = 0 WHERE run_id = ?", runId);
		},
		async close() {
			await journal.close();
			await database.close();
		},
	};
}

/** How many times the faulted child's body ran its one tool call: each run leaves a `run-<n>` file. */
function childRuns(directory: string): number {
	return readDirectorySync(directory).filter((name) => name.startsWith("run-")).length;
}

test.skipIf(process.platform === "win32")(
	"a pooled child refuses a missing waiting session at start, typed and once, and a later root resume runs it again (#4440)",
	async () => {
		const directory = makeTempDirectory("pool-child-start-refusal-");
		const root = await pooledRoot(directory, faultedChildPath, "faultedChild", { directory, persistent: true });
		try {
			// First incarnation: the child fails on a fault of the pool, which a resumed root runs again.
			assert.equal(await root.start(), "failed");
			const runsBefore = childRuns(directory);
			assert.ok(runsBefore > 0, "the child ran in the first incarnation");

			// The child's previous process also left a stage waiting, whose session the pool's store does not hold.
			await root.releaseRoot();
			const dispatched = await root.pooledChild();
			const seeding = await JournalDurableBackend.open(root.journal, { ownsJournal: false });
			try {
				await recordStageSessionCheckpoint(
					{
						workflowId: dispatched.childRunId,
						backend: new ScopedDurableBackend(seeding, {
							rootWorkflowId: root.runId,
							scopePrefix: dispatched.scope,
						}),
						nextCheckpointId: createCheckpointIdGenerator(),
						nextReplayKey: createStageReplayKeyGenerator(dispatched.childRunId),
						sourceOrderForStage: () => 1,
						runTopology: {
							runId: dispatched.childRunId,
							runName: root.childName,
							parentRunId: root.runId,
							parentStageId: dispatched.boundaryId,
							rootRunId: root.runId,
						},
					},
					{
						id: "waiting-stage",
						name: "review",
						replayKey: "stage:review:1",
						status: "waiting",
						parentIds: [],
						toolEvents: [],
						startedAt: 1_000,
						sessionId: MISSING_SESSION,
						wait: { kind: "tool", since: 2_000, promptsCompleted: 0 },
					},
					{ force: true },
				);
			} finally {
				await seeding.close();
			}

			// Second incarnation: the child runs again and refuses before its body, in one attempt.
			await root.releaseRoot();
			const refused = await root.resume();
			assert.equal(refused?.status, "failed", JSON.stringify({ status: refused?.status, error: refused?.error }));
			assert.equal(childRuns(directory), runsBefore, "the refused child ran nothing");
			const refusedWork = await root.pooledChild();
			assert.equal(refusedWork.state, "completed");
			// One attempt: the pool completed it with the refusal instead of counting a lost worker and retrying.
			assert.equal(refusedWork.generation, dispatched.generation + 1);
			const stored = await root.recordedResult(refusedWork);
			assert.equal(stored?.status, "failed");
			assert.equal(stored?.failureDetail?.name, "StageRehydrationError");
			assert.equal(stored?.failureDetail?.code, "session-not-found");
			assert.equal(stored?.failureDetail?.fields?.runId, dispatched.childRunId);
			assert.equal(stored?.failureDetail?.fields?.rootRunId, root.runId);
			assert.deepEqual(stored?.failureDetail?.fields?.sessionIds, [MISSING_SESSION]);
			assert.match(String(stored?.failureDetail?.fields?.storage), /^child workflow session store: /);
			const found = findStageWaitError(root.caught.at(-1));
			assert.ok(found instanceof StageRehydrationError, `no StageRehydrationError in ${String(root.caught.at(-1))}`);
			assert.equal(found.code, "session-not-found");
			assert.equal(found.fields.rootRunId, root.runId);
			assert.deepEqual(found.fields.sessionIds, [MISSING_SESSION]);

			// The session is back: a later incarnation runs the child again rather than replaying its refusal.
			const local = await openWorkerJournals({ journalPath: join(directory, "journal.sqlite") }, undefined);
			try {
				await local.sessions.create(
					{
						id: MISSING_SESSION,
						version: SESSION_FORMAT_VERSION,
						createdAt: new Date(0).toISOString(),
						cwd: directory,
					},
					[],
				);
			} finally {
				await local.sessions.close();
				await local.journal.close();
			}
			await writeFileEnsuringDir(join(directory, "recovered"), "");
			await root.releaseRoot();
			const recovered = await root.resume();
			assert.equal(
				recovered?.status,
				"completed",
				JSON.stringify({ status: recovered?.status, error: recovered?.error }),
			);
			assert.equal(childRuns(directory), runsBefore + 1, "the child ran its body once more");
		} finally {
			await root.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);

test.skipIf(process.platform === "win32")(
	"a pooled child that failed on its own keeps that failure when its root resumes, without running again (#4440)",
	async () => {
		const directory = makeTempDirectory("pool-child-own-failure-resume-");
		const executions = join(directory, "executions");
		const message = "ENOENT: no such file or directory, open '/tmp/missing-input.json'";
		const root = await pooledRoot(directory, failingChildPath, "plainChild", { message, executions });
		try {
			assert.equal(await root.start(), "failed");
			assert.equal(readTextSync(executions, "utf8").trim().split("\n").length, 1);
			const failedWork = await root.pooledChild();
			assert.equal(failedWork.state, "completed");
			assert.equal((await root.recordedResult(failedWork))?.status, "failed");

			await root.releaseRoot();
			const resumed = await root.resume();
			assert.equal(resumed?.status, "failed", JSON.stringify({ status: resumed?.status, error: resumed?.error }));
			assert.equal(
				readTextSync(executions, "utf8").trim().split("\n").length,
				1,
				"the resumed root got the child's recorded failure, not a new run",
			);
			assert.equal((await root.pooledChild()).generation, failedWork.generation);
		} finally {
			await root.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
