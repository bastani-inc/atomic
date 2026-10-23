import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowRunContext } from "../../packages/workflows/src/shared/types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

const LOCAL_WORKER_LIFECYCLE_TIMEOUT_MS = 120_000;

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Worker lifecycle condition timed out");
		await sleep(20);
	}
}

async function fixture(root = "root", afterChild?: (ctx: WorkflowRunContext) => Promise<void>) {
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
	});
	const parent = workflow({
		name: "pool-lifecycle-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const result = await ctx.workflow(child, { inputs: { releasePath } });
			assert.equal(result.status, "completed");
			await afterChild?.(ctx);
			return {};
		},
	});
	const store = createStore();
	const running = run(
		parent,
		{},
		{
			runId: root,
			cwd: directory,
			store,
			durableBackend: backend,
			signal: AbortSignal.timeout(90_000),
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
		async finishing() {
			await waitUntil(async () =>
				store
					.runs()
					.some(
						(entry) =>
							entry.parentRunId === root &&
							entry.toolNodes.some((node) => node.name === "finish" && node.status === "running"),
					),
			);
		},
		async ready() {
			await waitUntil(async () => {
				await backend.hydrateWorkflow(root);
				return backend.listCheckpoints(root).some((entry) => entry.kind === "tool" && entry.name === "checkpoint");
			});
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

test(
	"root pause and resume reach workers without losing committed results (#3869)",
	async () => {
		const f = await fixture();
		try {
			const queue = await f.ready();
			await toolControlRegistry.runControl("root")!.pause();
			const leaseState = (await f.journal.leaseState("root"))!;
			const lease = { runId: "root", holderId: leaseState.holderId!, epoch: leaseState.epoch };
			assert.equal((await queue.control(lease)).state, "paused");
			const [before] = await queue.inspect("root");
			await toolControlRegistry.runControl("root")!.resume();
			assert.equal((await queue.control(lease)).state, "running");
			await f.release();
			assert.equal((await f.running).status, "completed");
			const [after] = await queue.inspect("root");
			assert.equal(after!.id, before!.id);
			assert.equal(after!.generation, before!.generation);
			assert.equal(after!.state, "completed");
		} finally {
			if (toolControlRegistry.runControl("root")?.paused) await toolControlRegistry.runControl("root")!.resume();
			await f.release();
			await f.close();
		}
	},
	LOCAL_WORKER_LIFECYCLE_TIMEOUT_MS,
);
test(
	"a worker tool finishing while the root is paused commits its checkpoint without a new attempt (#3869)",
	async () => {
		const f = await fixture();
		try {
			const queue = await f.ready();
			await f.finishing();
			const [before] = await queue.inspect("root");
			await toolControlRegistry.runControl("root")!.pause();
			assert.equal((await f.journal.getRun("root"))?.status, "paused");
			await f.release();
			await waitUntil(async () => {
				await f.backend.hydrateWorkflow("root");
				return f.backend.listCheckpoints("root").some((entry) => entry.kind === "tool" && entry.name === "finish");
			});
			const [paused] = await queue.inspect("root");
			assert.equal(paused!.id, before!.id);
			assert.equal(paused!.generation, before!.generation);
			assert.equal(f.pool.workerPids.length, 1);
			await toolControlRegistry.runControl("root")!.resume();
			const result = await f.running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			const [after] = await queue.inspect("root");
			assert.equal(after!.id, before!.id);
			assert.equal(after!.generation, before!.generation);
			assert.equal(after!.state, "completed");
		} finally {
			if (toolControlRegistry.runControl("root")?.paused) await toolControlRegistry.runControl("root")!.resume();
			await f.release();
			await f.close();
		}
	},
	LOCAL_WORKER_LIFECYCLE_TIMEOUT_MS,
);
test(
	"root quit waits for worker teardown and retains resumable work (#3869)",
	async () => {
		const f = await fixture();
		try {
			const queue = await f.ready();
			await f.finishing();
			const [before] = await queue.inspect("root");
			await toolControlRegistry.runControl("root")!.quit();
			assert.equal((await f.running).status, "paused");
			assert.equal(f.pool.workerPids.length, 0);
			assert.equal(
				f.store
					.runs()
					.find((entry) => entry.parentRunId === f.root)
					?.toolNodes.find((node) => node.name === "finish")?.status,
				"cancelled",
				"the worker publishes graceful tool cancellation before teardown",
			);
			const [after] = await queue.inspect("root");
			assert.equal(after!.id, before!.id);
			assert.equal(after!.state, "leased");
		} finally {
			await f.close();
		}
	},
	LOCAL_WORKER_LIFECYCLE_TIMEOUT_MS,
);

test(
	"pooled quit blocks the next local tool before worker cleanup finishes (#3869)",
	async () => {
		const childCompleted = Promise.withResolvers<void>();
		const releaseRoot = Promise.withResolvers<void>();
		const cleanup = Promise.withResolvers<void>();
		const toolAttempted = Promise.withResolvers<void>();
		let toolCalls = 0;
		const f = await fixture(randomUUID(), async (ctx) => {
			childCompleted.resolve();
			await releaseRoot.promise;
			try {
				await ctx.tool("local-after-child", {}, async () => ++toolCalls);
			} finally {
				toolAttempted.resolve();
			}
		});
		const control = f.pool.control.bind(f.pool);
		const intercepted = vi.spyOn(f.pool, "control").mockImplementation(async (state) => {
			if (state === "quit") await cleanup.promise;
			await control(state);
		});
		let quitSettled = false;
		try {
			await f.release();
			await childCompleted.promise;
			const quitting = toolControlRegistry
				.runControl(f.root)!
				.quit()
				.finally(() => {
					quitSettled = true;
				});
			releaseRoot.resolve();
			await toolAttempted.promise;
			assert.equal(toolCalls, 0, "quit closes local tool admission before worker cleanup");
			assert.notEqual(f.store.runs().find((entry) => entry.id === f.root)?.status, "completed");
			assert.equal(quitSettled, false, "quit still waits for worker cleanup acknowledgement");
			cleanup.resolve();
			await quitting;
			assert.equal((await f.running).status, "paused", "quit cannot become normal completion");
			assert.equal(f.pool.workerPids.length, 0);
		} finally {
			releaseRoot.resolve();
			cleanup.resolve();
			intercepted.mockRestore();
			await f.close();
		}
	},
	LOCAL_WORKER_LIFECYCLE_TIMEOUT_MS,
);

test(
	"a root quit and restarted on the same journal finishes the retained work with its checkpoint intact (#3869)",
	async () => {
		const f = await fixture(randomUUID());
		let restarted: { close(): Promise<void> } | undefined;
		let originalClosed = false;
		try {
			const queue = await f.ready();
			await f.finishing();
			const firstPid = f.pool.workerPids[0]!;
			const [before] = await queue.inspect(f.root);
			await toolControlRegistry.runControl(f.root)!.quit();
			assert.equal((await f.running).status, "paused");
			await f.shutdown();
			originalClosed = true;
			const database = await openNodeSqliteDatabase(f.path);
			const journal = await SqlRunJournal.open(database);
			const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
			const pool = new LocalWorkerPool(backend, {
				journalPath: f.path,
				workers: 1,
				definitions: [{ definition: f.child, path: f.childPath, exportName: "child" }],
			});
			restarted = {
				async close() {
					await pool.close();
					await backend.close();
					await journal.close();
					await database.close();
				},
			};
			await writeFileEnsuringDir(join(f.directory, "release"), "ready");
			const result = await run(
				f.parent,
				{},
				{
					runId: f.root,
					cwd: f.directory,
					store: createStore(),
					durableBackend: backend,
					signal: AbortSignal.timeout(90_000),
				},
			);
			assert.equal(result.status, "completed", JSON.stringify(result));
			const recovered = await openSqlPoolQueue(journal);
			const [after] = await recovered.inspect(f.root);
			assert.equal(after!.id, before!.id);
			assert.equal(after!.state, "completed");
			const outputs = ((await recovered.result(f.root, after!.id)) as { result: Record<string, number> }).result;
			assert.equal(outputs.firstPid, firstPid);
			assert.notEqual(outputs.finalPid, firstPid);
		} finally {
			if (!originalClosed) {
				if (toolControlRegistry.runControl(f.root)?.paused) await toolControlRegistry.runControl(f.root)!.resume();
				await f.release();
				await f.shutdown();
			}
			await restarted?.close();
			removeTempDirectory(f.directory);
		}
	},
	LOCAL_WORKER_LIFECYCLE_TIMEOUT_MS,
);

test(
	"worker commits survive a root heartbeat delayed beyond its interval (#3869)",
	async () => {
		const f = await fixture();
		try {
			await f.ready();
			await f.database.run(
				"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - 30500 WHERE run_id = 'root'",
			);
			await f.release();
			const result = await f.running;
			assert.equal(result.status, "completed", JSON.stringify(result));
		} finally {
			await f.close();
		}
	},
	LOCAL_WORKER_LIFECYCLE_TIMEOUT_MS,
);

test(
	"a final-attempt worker death cannot hide its pending durable completion (#3869)",
	async () => {
		const f = await fixture();
		let releaseCompletion = () => {};
		const completionGate = new Promise<void>((resolve) => {
			releaseCompletion = resolve;
		});
		let completionReceived = () => {};
		const received = new Promise<void>((resolve) => {
			completionReceived = resolve;
		});
		const complete = SqlPoolQueue.prototype.complete;
		const intercepted = vi.spyOn(SqlPoolQueue.prototype, "complete").mockImplementation(async function (
			this: SqlPoolQueue,
			...args
		) {
			assert.equal(args[1].generation, 3);
			process.kill(f.pool.workerPids[0]!, "SIGKILL");
			completionReceived();
			await completionGate;
			return complete.apply(this, args);
		});
		try {
			const queue = await f.ready();
			for (const generation of [1, 2]) {
				await waitUntil(async () => (await queue.inspect("root"))[0]?.generation === generation);
				process.kill(f.pool.workerPids[0]!, "SIGKILL");
				await waitUntil(async () => (await queue.inspect("root"))[0]?.generation === generation + 1);
			}
			await f.release();
			await received;
			await waitUntil(async () => f.pool.workerPids.length === 0);
			await sleep(100);
			releaseCompletion();
			const result = await f.running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			const [work] = await queue.inspect("root");
			assert.equal(work?.state, "completed");
			assert.equal(work.generation, 3);
			assert.equal((await queue.result("root", work.id))?.status, "completed");
		} finally {
			releaseCompletion();
			intercepted.mockRestore();
			await f.close();
		}
	},
	LOCAL_WORKER_LIFECYCLE_TIMEOUT_MS,
);

test(
	"an idle worker acknowledges root quit after completing a child (#3869)",
	async () => {
		const IDLE_WORKER_QUIT_ACK_BUDGET_MS = 3_000;
		const childCompleted = Promise.withResolvers<void>();
		const releaseRoot = Promise.withResolvers<void>();
		const f = await fixture(randomUUID(), async () => {
			childCompleted.resolve();
			await releaseRoot.promise;
		});
		try {
			await f.release();
			await childCompleted.promise;
			const started = performance.now();
			await toolControlRegistry.runControl(f.root)!.quit();
			const elapsed = performance.now() - started;
			assert.ok(
				elapsed < IDLE_WORKER_QUIT_ACK_BUDGET_MS,
				`idle-worker quit took ${elapsed}ms instead of acknowledging before the grace period`,
			);
			assert.equal((await f.running).status, "paused");
			assert.equal(f.pool.workerPids.length, 0);
			const queue = await openSqlPoolQueue(f.journal);
			assert.equal((await queue.inspect(f.root))[0]?.state, "completed");
		} finally {
			releaseRoot.resolve();
			await f.close();
		}
	},
	LOCAL_WORKER_LIFECYCLE_TIMEOUT_MS,
);
