import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { StaleLeaseError } from "../../packages/workflows/src/durable/journal/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { POOL_COLD_START_BUDGET_MS, poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

const WORKERS = 2;
const childPath = fileURLToPath(new URL("../fixtures/pool-resume-child.ts", import.meta.url));
/** One pool cold start, plus the wait for its workers to meet the released lease. */
const ROOT_LEASE_LOST_TIMEOUT_MS = poolTestBudgetMs(2).timeoutMs;

function startedChildren(directory: string): number {
	return readdirSync(directory).filter((name) => name.startsWith("started-")).length;
}

async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + POOL_COLD_START_BUDGET_MS;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
		await sleep(20);
	}
}

test.skipIf(process.platform === "win32")(
	"idle workers that meet the root's released lease end cleanly instead of crashing (#3979)",
	async () => {
		const directory = makeTempDirectory("pool-root-lease-lost-");
		const path = join(directory, "journal.sqlite");
		const exportName = "resumedChild";
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName,
			digest: await definitionDigest(childPath),
		});
		const parent = workflow({
			name: "pool-root-lease-lost-root",
			description: "Root over one pooled child",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const result = await ctx.workflow(child, { inputs: { directory, index: 0 } });
				assert.equal(result.status, "completed");
				return {};
			},
		});
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: WORKERS,
			definitions: [{ definition: child, path: childPath, exportName }],
			coordinator: "in-process",
		});
		// The in-process coordinator forks the workers from this process, so their spawns and exit codes are observable.
		const exits: { readonly pid: number | undefined; readonly code: number | null }[] = [];
		let spawns = 0;
		const emit = ChildProcess.prototype.emit as (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) => boolean;
		vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function (
			this: ChildProcess,
			event: string | symbol,
			...args: unknown[]
		) {
			if (event === "spawn") spawns += 1;
			if (event === "exit") exits.push({ pid: this.pid, code: args[0] as number | null });
			return emit.call(this, event, ...args);
		});
		let staleClaims = 0;
		const claim = SqlPoolQueue.prototype.claim;
		vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (this: SqlPoolQueue, ...args) {
			try {
				return await claim.apply(this, args);
			} catch (error) {
				if (error instanceof StaleLeaseError) staleClaims += 1;
				throw error;
			}
		});
		try {
			const running = run(
				parent,
				{},
				{
					runId: randomUUID(),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: AbortSignal.timeout(ROOT_LEASE_LOST_TIMEOUT_MS),
				},
			);
			await waitUntil(() => startedChildren(directory) === 1, "the child to start");
			await writeFileEnsuringDir(join(directory, "release"), "");
			const result = await running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			// The root released its lease, but the pool is still open: its idle workers keep asking for work.
			const workers = [...pool.workerPids];
			assert.equal(workers.length, WORKERS);
			const spawnedBefore = spawns;
			await waitUntil(() => staleClaims > 0, "a claim to meet the released root lease");
			await waitUntil(
				() => workers.every((pid) => exits.some((exit) => exit.pid === pid)),
				"every worker to end after the root lease is gone",
			);
			for (const pid of workers)
				assert.equal(
					exits.find((exit) => exit.pid === pid)?.code,
					0,
					`worker ${pid} crashed on the released lease`,
				);
			assert.equal(spawns, spawnedBefore, "no replacement was spawned for a worker that ended on a released lease");
			await pool.close();
		} finally {
			vi.restoreAllMocks();
			await pool.close().catch(() => {});
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	ROOT_LEASE_LOST_TIMEOUT_MS,
);
