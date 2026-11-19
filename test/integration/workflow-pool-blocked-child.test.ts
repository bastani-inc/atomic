import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorktreeSnapshotSettings } from "@bastani/atomic";
import { beforeAll, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { effectiveRunStatus } from "../../packages/workflows/src/shared/returned-run-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { loadWorkerWorkflow } from "../../packages/workflows/src/workers/definitions.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { FAILING, PROVIDER_DOWN, SESSIONS_DOWN, timesDone } from "../fixtures/pool-blocked-child.js";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/** Two pools, the root's and its resume's, each starting a worker process that loads the packaged workflows runtime. */
const POOL_TIMEOUT_MS = 180_000;

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

const childPath = fileURLToPath(new URL("../fixtures/pool-blocked-child.ts", import.meta.url));

/**
 * A root whose one child, the fixture's `exportName`, runs on the root's local workers and blocks there. The root and
 * its resume run under the settings a session reads, and each starts its own pool, as a session's runs do.
 */
async function blockedPooledChild(
	exportName: "sessionBlockedChild" | "providerBlockedChild" | "failingChild",
	options: { readonly completedFirst?: boolean } = {},
) {
	const directory = makeTempDirectory("pool-blocked-child-");
	/** With `completedFirst`, the root runs the child once in a directory of its own first, where nothing blocks it. */
	const earlier = join(directory, "earlier");
	mkdirSync(earlier);
	const path = join(directory, "journal.sqlite");
	let journal = await resolveRunJournal({ journal: { path } });
	let backend = await JournalDurableBackend.open(journal);
	const child = await loadWorkerWorkflow(childPath, exportName);
	const root = workflow({
		name: "pool-blocked-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			if (options.completedFirst === true) await ctx.workflow(child, { inputs: { directory: earlier } });
			await ctx.workflow(child, { inputs: { directory } });
			return {};
		},
	});
	let store = createStore();
	const runId = randomUUID();
	const views = () => {
		const rootRun = store.run(runId);
		const childRun = store
			.runs()
			.find((candidate) => candidate.parentRunId === runId && candidate.inputs.directory === directory);
		assert.ok(
			rootRun && childRun,
			`the root and its child are in the root's store: ${JSON.stringify(store.runs().map((candidate) => [candidate.id, candidate.name, candidate.parentRunId]))}`,
		);
		const earlierRun = store
			.runs()
			.find((candidate) => candidate.parentRunId === runId && candidate.inputs.directory === earlier);
		return { root: rootRun, child: childRun, earlier: earlierRun };
	};
	const runtimeFor = (jobs: ReturnType<typeof createJobTracker>) =>
		createExtensionRuntime({ registry: createRegistry([root, child]), jobs, store, cwd: directory });
	return {
		directory,
		earlier,
		runId,
		views,
		async first(): Promise<RunResult> {
			return run(
				root,
				{},
				{
					runId,
					cwd: directory,
					store,
					durableBackend: backend,
					snapshots: resolveWorktreeSnapshotSettings(undefined, "settings", "snapshots"),
					localWorkers: { count: 1, definitions: [{ path: childPath, exportName }] },
				},
			);
		},
		/** What the worker sent the root as the child's result, as the pool's queue keeps it. */
		async workerResult(): Promise<RunResult | undefined> {
			const queue = await openSqlPoolQueue(journal);
			const [work] = await queue.inspect(runId);
			return work === undefined ? undefined : ((await queue.result(runId, work.id)) as RunResult | undefined);
		},
		/** Resumes the root in the same session, as the graph's `r` does. */
		async resumeInSession() {
			const jobs = createJobTracker();
			const resumed = await runtimeFor(jobs).resumeFailedRun(runId);
			assert.ok(resumed.ok, resumed.ok ? undefined : resumed.message);
			await jobs.get(runId)?.promise;
			return (await journal.getRun(runId))?.status;
		},
		/** Resumes the root in a new session, from its journal, as `/resume` does after a restart. */
		async resumeAfterRestart() {
			await backend.close();
			journal = await resolveRunJournal({ journal: { path } });
			backend = await JournalDurableBackend.open(journal);
			store = createStore();
			configureTestStoreBackend(store, backend);
			try {
				const jobs = createJobTracker();
				const runtime = runtimeFor(jobs);
				await runtime.prepareDurableResumable(runId);
				const resumed = await runtime.resumeDurableWorkflow(runId, { actor: "user" });
				assert.ok(resumed.ok, resumed.ok ? undefined : resumed.message);
				await jobs.get(runId)?.promise;
				return (await journal.getRun(runId))?.status;
			} finally {
				configureTestStoreBackend(store, undefined);
			}
		},
		async close() {
			await backend.close();
			removeTempDirectory(directory);
		},
	};
}

describe("a pooled child blocked on a recoverable failure (#5534)", () => {
	test(
		"whose woken stage cannot reopen its session store reads as blocked in the root's store, as the root does, and the graph's resume once the store is back continues the stage",
		async () => {
			const pooled = await blockedPooledChild("sessionBlockedChild");
			try {
				const first = await pooled.first();
				assert.equal(first.status, "running", first.error);
				assert.equal(first.failure?.code, "session_unavailable", first.error);
				assert.equal(first.failure?.disposition, "active_blocked");
				const stored = await pooled.workerResult();
				assert.equal(stored?.failure?.code, "session_unavailable", "the worker blocked the child");

				const { root, child } = pooled.views();
				assert.equal(effectiveRunStatus(root), "blocked", "the root");
				assert.equal(effectiveRunStatus(child), "blocked", "the child, as the root's store shows it");
				assert.equal(child.failureCode, "session_unavailable");
				assert.equal(child.failureDisposition, "active_blocked");
				assert.equal(child.resumable, true);
				assert.ok(child.blockedAt !== undefined, "the child records when it blocked");
				assert.equal(child.endedAt, undefined, "a block is not an end");
				const build = child.stages.find((stage) => stage.name === "build");
				assert.ok(build);
				assert.equal(child.failedStageId, build.id, "the stage it blocked on");
				assert.deepEqual(
					[timesDone(pooled.directory, "entries"), timesDone(pooled.directory, "effects")],
					[1, 1],
					"nothing was retried while blocked",
				);

				rmSync(join(pooled.directory, SESSIONS_DOWN));
				assert.equal(await pooled.resumeInSession(), "completed", pooled.views().root.error);
				const after = pooled.views();
				assert.equal(effectiveRunStatus(after.root), "completed");
				assert.equal(effectiveRunStatus(after.child), "completed");
				assert.equal(timesDone(pooled.directory, "effects"), 1, "the stage continued from the command's result");
				assert.equal(timesDone(pooled.directory, "entries"), 2, "the resume ran the child again");
			} finally {
				await pooled.close();
			}
		},
		POOL_TIMEOUT_MS,
	);

	test(
		"on its stage's provider outage reads as blocked in the root's store, and a resume after a restart once the provider is back runs it again, and only it",
		async () => {
			const pooled = await blockedPooledChild("providerBlockedChild", { completedFirst: true });
			try {
				writeFileSync(join(pooled.directory, PROVIDER_DOWN), "");
				const first = await pooled.first();
				assert.equal(first.status, "running", first.error);
				assert.equal(first.failure?.code, "provider_unavailable", first.error);

				const { root, child, earlier } = pooled.views();
				assert.equal(effectiveRunStatus(earlier!), "completed", "the child that ran first completed");
				assert.equal(effectiveRunStatus(root), "blocked", "the root");
				assert.equal(effectiveRunStatus(child), "blocked", "the child, as the root's store shows it");
				assert.equal(child.failureCode, "provider_unavailable");
				assert.ok(child.blockedAt !== undefined);
				assert.equal(child.endedAt, undefined);
				assert.equal(child.failedStageId, child.stages.find((stage) => stage.name === "review")?.id);
				const requests = timesDone(pooled.directory, "requests");
				assert.ok(requests >= 1);

				rmSync(join(pooled.directory, PROVIDER_DOWN));
				await new Promise((resolve) => setTimeout(resolve, 500));
				assert.equal(timesDone(pooled.directory, "requests"), requests, "nothing was retried while blocked");
				assert.equal(await pooled.resumeAfterRestart(), "completed", pooled.views().root.error);
				assert.equal(effectiveRunStatus(pooled.views().child), "completed");
				assert.equal(timesDone(pooled.directory, "requests"), requests + 1, "the resumed stage asked once more");
				assert.equal(timesDone(pooled.earlier, "entries"), 1, "the child that had completed keeps its result");
			} finally {
				await pooled.close();
			}
		},
		POOL_TIMEOUT_MS,
	);
});

describe("a pooled child that failed on its own logic", () => {
	test(
		"keeps its failure when the root resumes: only a block or a fault of the pool runs a child again",
		async () => {
			const pooled = await blockedPooledChild("failingChild");
			try {
				writeFileSync(join(pooled.directory, FAILING), "");
				const first = await pooled.first();
				assert.equal(first.status, "failed", first.error);
				assert.match(first.error ?? "", /the check failed/);
				rmSync(join(pooled.directory, FAILING));
				assert.equal(await pooled.resumeInSession(), "failed", "the child's failure stands");
				assert.equal(timesDone(pooled.directory, "entries"), 1, "the child did not run again");
			} finally {
				await pooled.close();
			}
		},
		POOL_TIMEOUT_MS,
	);
});
