/** The fixture shared by the workflow-local-pool-lifecycle*.test.ts files: one root run over one local worker pool. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, SessionManager } from "@bastani/atomic";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { TaskSupervisor } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { executeSupervisedCommand } from "../../packages/coding-agent/src/core/tools/bash-pty-native.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowRunContext } from "../../packages/workflows/src/shared/types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import {
	type AdmissionConfiguration,
	SqlResourceAdmission,
} from "../../packages/workflows/src/workers/resource-admission.js";
import { poolStageOptions } from "../fixtures/pool-stage-options.js";
import { POOL_CLEANUP_HEADROOM_MS, poolTestBudgetMs } from "./pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "./runtime.js";

/**
 * A test over one pool: its cold start, plus the child's own work and the root's teardown. Every wait of a test shares
 * its root run's budget (the run's own signal), so a slow cold start leaves more for the waits after it instead of
 * failing one wait at a fixed bound.
 */
export const SINGLE_POOL = poolTestBudgetMs(3);
/** A restart test runs two roots, each over its own pool and each with a single pool's budget. */
export const TWO_POOLS = {
	waitMs: 2 * SINGLE_POOL.waitMs,
	timeoutMs: 2 * SINGLE_POOL.waitMs + POOL_CLEANUP_HEADROOM_MS,
} as const;
/** A test that kills its worker twice cold-starts three workers in one pool, plus the child's work. */
export const THREE_WORKERS = poolTestBudgetMs(5);

/** Polls until the condition holds, or fails once the test's budget (`signal`) is spent. */
export async function waitUntil(predicate: () => Promise<boolean>, signal: AbortSignal): Promise<void> {
	while (!(await predicate())) {
		if (signal.aborted) throw new Error("Worker lifecycle condition timed out: the test's budget is spent");
		await sleep(20);
	}
}

export async function fixture(
	root = "root",
	afterChild?: (ctx: WorkflowRunContext) => Promise<void>,
	options: {
		beforeChild?: () => Promise<void>;
		admission?: AdmissionConfiguration;
		coordinator?: "in-process";
		/** The root run's signal: its share of the test's budget, one cold start per pool or worker it starts. */
		runBudgetMs?: number;
	} = {},
) {
	const directory = makeTempDirectory("local-pool-lifecycle-");
	const path = join(directory, "journal.sqlite");
	const releasePath = join(directory, "release");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	const childPath = fileURLToPath(new URL("../fixtures/pool-lifecycle-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
		admission: options.admission,
		coordinator: options.coordinator,
	});
	const parent = workflow({
		name: "pool-lifecycle-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await options.beforeChild?.();
			const result = await ctx.workflow(child, { inputs: { releasePath } });
			assert.equal(result.status, "completed");
			await afterChild?.(ctx);
			return {};
		},
	});
	const store = createStore();
	const budget = AbortSignal.timeout(options.runBudgetMs ?? SINGLE_POOL.waitMs);
	const running = run(
		parent,
		{},
		{
			runId: root,
			cwd: directory,
			store,
			durableBackend: backend,
			signal: budget,
		},
	);
	return {
		root,
		directory,
		path,
		childPath,
		child,
		parent,
		database,
		journal,
		backend,
		pool,
		running,
		store,
		budget,
		async finishing() {
			await waitUntil(
				async () =>
					store
						.runs()
						.some(
							(entry) =>
								entry.parentRunId === root &&
								entry.toolNodes.some((node) => node.name === "finish" && node.status === "running"),
						),
				budget,
			);
		},
		async ready() {
			await waitUntil(async () => {
				await backend.hydrateWorkflow(root);
				return backend.listCheckpoints(root).some((entry) => entry.kind === "tool" && entry.name === "checkpoint");
			}, budget);
			return openSqlPoolQueue(journal);
		},
		release: () => writeFileEnsuringDir(releasePath, "ready"),
		async shutdown() {
			await pool.close();
			await running;
			await backend.close();
			await journal.close();
			await database.close();
		},
		async close() {
			await this.shutdown();
			removeTempDirectory(directory);
		},
	};
}

/** One case of "explicit restart … admits local resources before child dispatch": the root quits (or quits and is
 * marked paused), restarts on the same journal, and must admit its own resources before the worker gets the child. */
export async function explicitRestartAdmitsLocalResources({
	state,
	cached,
}: {
	readonly state: "quit" | "paused";
	readonly cached: boolean;
}): Promise<void> {
	// Every wait shares what is left of the test's budget: the restarted pool cold-starts its coordinator and
	// worker again, which takes tens of seconds under parallel-suite load, and a fixed 30 s run timeout killed
	// the restarted root before its child finished.
	const budget = AbortSignal.timeout(TWO_POOLS.waitMs);
	const completed = Promise.withResolvers<void>();
	const releaseRoot = Promise.withResolvers<void>();
	let resuming = false;
	let localWorkCompleted = false;
	const admission = { limits: { session: 2, process: 1 } };
	const f = await fixture(
		randomUUID(),
		async () => {
			if (!resuming) {
				completed.resolve();
				await releaseRoot.promise;
			}
		},
		{
			admission,
			async beforeChild() {
				if (!resuming) return;
				assert.equal(restartedPool!.workerPids.length, 0, "root resources precede worker dispatch");
				const options = await poolStageOptions(f.directory, false, 0);
				const { session } = await createAgentSession({
					...options,
					sessionManager: SessionManager.inMemory(f.directory),
					resourceAdmissionSignal: budget,
				});
				try {
					const { session: delegated } = await createAgentSession({
						...options,
						...session.extensionRunner.createContext().getChildSessionOptions!({ cwd: f.directory }),
						sessionManager: SessionManager.inMemory(f.directory),
						resourceAdmissionSignal: budget,
					});
					await delegated.dispose();
					const supervisor = new TaskSupervisor();
					const scope = { kind: "session" as const, sessionId: session.sessionId };
					const host = supervisor.bindHostSession({
						scope,
						tasks: { wait: { kind: "until-settled" } },
						authorizeLaunch() {},
						createRunner() {
							throw new Error("not an agent");
						},
					});
					const opened = supervisor.openTaskOwner(host, scope);
					assert.ok(opened.ok);
					try {
						const result = await executeSupervisedCommand(
							"echo resumed",
							f.directory,
							{
								taskOwner: { supervisor, owner: opened.value },
								onData() {},
								signal: budget,
							},
							false,
						);
						assert.equal(result.exitCode, 0);
					} finally {
						assert.ok((await supervisor.closeTaskOwner(opened.value, "session-close")).ok);
					}
					localWorkCompleted = true;
				} finally {
					await session.dispose();
				}
			},
		},
	);
	let restartedPool: LocalWorkerPool | undefined;
	let restarted: { close(): Promise<void> } | undefined;
	let originalClosed = false;
	try {
		if (cached) {
			await f.release();
			await completed.promise;
		} else {
			await f.ready();
			await f.finishing();
		}
		const queue = await openSqlPoolQueue(f.journal);
		const before = await queue.inspect(f.root);
		await toolControlRegistry.runControl(f.root)!.quit();
		assert.equal((await f.running).status, "paused");
		if (state === "paused") {
			await f.backend.commitWorkflowStatus(f.root, "paused");
			const owned = (await f.journal.leaseState(f.root))!;
			await queue.setControl({ runId: f.root, holderId: owned.holderId!, epoch: owned.epoch }, "paused");
		}
		await f.shutdown();
		originalClosed = true;
		resuming = true;
		await f.release();
		const database = await openNodeSqliteDatabase(f.path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const pool = new LocalWorkerPool(backend, {
			journalPath: f.path,
			workers: 1,
			admission,
			definitions: [{ definition: f.child, path: f.childPath, exportName: "child" }],
		});
		restartedPool = pool;
		restarted = {
			async close() {
				await pool.close();
				await backend.close();
				await journal.close();
				await database.close();
			},
		};
		const result = await run(
			f.parent,
			{},
			{
				runId: f.root,
				cwd: f.directory,
				store: createStore(),
				durableBackend: backend,
				signal: budget,
			},
		);
		assert.equal(result.status, "completed", JSON.stringify(result));
		assert.equal(localWorkCompleted, true);
		const observer = await SqlResourceAdmission.open(journal, { ...admission, root: f.root, holder: "observer" });
		const permits = await observer.inspect();
		assert.equal(permits.filter((permit) => permit.kind === "session").length, 2);
		assert.equal(permits.filter((permit) => permit.kind === "process").length, 1);
		assert.ok(permits.every((permit) => permit.state === "released"));
		const [after] = await (await openSqlPoolQueue(journal)).inspect(f.root);
		assert.equal(after!.id, before[0]!.id);
		assert.equal(after!.state, "completed");
		if (cached) {
			assert.equal(pool.workerPids.length, 0, "cached child replay must not launch workers");
			assert.deepEqual(after, before[0]);
		} else {
			assert.ok(after!.generation > before[0]!.generation);
		}
	} finally {
		releaseRoot.resolve();
		if (!originalClosed) await f.shutdown();
		await restarted?.close();
		removeTempDirectory(f.directory);
	}
}
