import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlPoolQueue, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
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

async function fixture() {
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
			return {};
		},
	});
	const running = run(
		parent,
		{},
		{
			runId: "root",
			cwd: directory,
			store: createStore(),
			durableBackend: backend,
			signal: AbortSignal.timeout(90_000),
		},
	);
	return {
		database,
		journal,
		backend,
		pool,
		running,
		async ready() {
			await waitUntil(async () => {
				await backend.hydrateWorkflow("root");
				return backend
					.listCheckpoints("root")
					.some((entry) => entry.kind === "tool" && entry.name === "checkpoint");
			});
			return openSqlPoolQueue(journal);
		},
		release: () => writeFileEnsuringDir(releasePath, "ready"),
		async close() {
			await pool.close();
			await running;
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

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
