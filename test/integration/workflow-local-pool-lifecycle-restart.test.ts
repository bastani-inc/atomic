import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";
import { fixture, SINGLE_POOL, THREE_WORKERS, TWO_POOLS, waitUntil } from "../helpers/workflow-local-pool-lifecycle.js";

/** A pooled root restarted on its journal, a delayed heartbeat, a final-attempt death, and an idle worker's quit. */

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
					signal: AbortSignal.timeout(SINGLE_POOL.waitMs),
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
	TWO_POOLS.timeoutMs,
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
	SINGLE_POOL.timeoutMs,
);

test(
	"a final-attempt worker death cannot hide its pending durable completion (#3869)",
	async () => {
		// The completion this test holds is written by the coordinator; keep it in this process to intercept it.
		const f = await fixture("root", undefined, { coordinator: "in-process", runBudgetMs: THREE_WORKERS.waitMs });
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
				await waitUntil(async () => (await queue.inspect("root"))[0]?.generation === generation, f.budget);
				process.kill(f.pool.workerPids[0]!, "SIGKILL");
				await waitUntil(async () => (await queue.inspect("root"))[0]?.generation === generation + 1, f.budget);
			}
			await f.release();
			await received;
			await waitUntil(async () => f.pool.workerPids.length === 0, f.budget);
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
	THREE_WORKERS.timeoutMs,
);

test(
	"an idle worker acknowledges root quit after completing a child (#3869)",
	async () => {
		const childCompleted = Promise.withResolvers<void>();
		const releaseRoot = Promise.withResolvers<void>();
		// In process, the coordinator's quit revision and its workers' acknowledgements are observable here.
		const f = await fixture(
			randomUUID(),
			async () => {
				childCompleted.resolve();
				await releaseRoot.promise;
			},
			{ coordinator: "in-process" },
		);
		let quitRevision: number | undefined;
		const setControl = SqlPoolQueue.prototype.setControl;
		const controlSpy = vi.spyOn(SqlPoolQueue.prototype, "setControl").mockImplementation(async function (
			this: SqlPoolQueue,
			...args
		) {
			const control = await setControl.apply(this, args);
			if (args[1] === "quit") quitRevision = control.revision;
			return control;
		});
		const acknowledged: number[] = [];
		const emit = ChildProcess.prototype.emit as (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) => boolean;
		const messageSpy = vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) {
			const message = args[0] as { readonly kind?: string; readonly revision?: number } | undefined;
			if (event === "message" && message?.kind === "controlled" && typeof message.revision === "number")
				acknowledged.push(message.revision);
			return emit.call(this, event, ...args);
		});
		try {
			await f.release();
			await childCompleted.promise;
			await toolControlRegistry.runControl(f.root)!.quit();
			// The idle worker itself acknowledged the quit; quit did not just give up after the coordinator's grace.
			assert.ok(quitRevision !== undefined, "quit reached the pool");
			assert.ok(
				acknowledged.some((revision) => revision >= quitRevision!),
				`no worker acknowledged quit revision ${quitRevision} (acknowledged ${JSON.stringify(acknowledged)})`,
			);
			assert.equal((await f.running).status, "paused");
			assert.equal(f.pool.workerPids.length, 0);
			const queue = await openSqlPoolQueue(f.journal);
			assert.equal((await queue.inspect(f.root))[0]?.state, "completed");
		} finally {
			releaseRoot.resolve();
			controlSpy.mockRestore();
			messageSpy.mockRestore();
			await f.close();
		}
	},
	SINGLE_POOL.timeoutMs,
);
