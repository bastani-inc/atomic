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
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

const WORKERS = 2;
const childPath = fileURLToPath(new URL("../fixtures/pool-resume-child.ts", import.meta.url));
/** One pool cold start, the child's work, and the wait for its workers to meet the released lease. */
const BUDGET = poolTestBudgetMs(3);

function startedChildren(directory: string): number {
	return readdirSync(directory).filter((name) => name.startsWith("started-")).length;
}

async function waitUntil(predicate: () => boolean, what: string, budget: AbortSignal): Promise<void> {
	while (!predicate()) {
		if (budget.aborted) throw new Error(`Timed out waiting for ${what}`);
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
		// Workers whose request the coordinator refused because the root's lease is gone: its claim or its control
		// request, whichever the worker sent first after the release (both check the root's lease).
		const leaseLostReplies = new Set<number>();
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
			if (event === "spawn") {
				spawns += 1;
				// Each forked worker has its own IPC `send`; record the replies that tell it the root's lease is gone.
				const send = this.send.bind(this) as (message: object, ...rest: unknown[]) => boolean;
				const pid = this.pid;
				this.send = ((message: object, ...rest: unknown[]) => {
					if ((message as { readonly rootLeaseLost?: boolean }).rootLeaseLost === true && pid !== undefined)
						leaseLostReplies.add(pid);
					return send(message, ...rest);
				}) as typeof this.send;
			}
			if (event === "exit") exits.push({ pid: this.pid, code: args[0] as number | null });
			return emit.call(this, event, ...args);
		});
		// Every wait shares the test's budget.
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		try {
			const running = run(
				parent,
				{},
				{
					runId: randomUUID(),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: budget,
				},
			);
			await waitUntil(() => startedChildren(directory) === 1, "the child to start", budget);
			await writeFileEnsuringDir(join(directory, "release"), "");
			const result = await running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			// The root released its lease, but the pool is still open: its idle workers keep asking for work.
			const workers = [...pool.workerPids];
			assert.equal(workers.length, WORKERS);
			const spawnedBefore = spawns;
			await waitUntil(
				() => workers.every((pid) => exits.some((exit) => exit.pid === pid)),
				"every worker to end after the root lease is gone",
				budget,
			);
			assert.ok(
				[...leaseLostReplies].some((pid) => workers.includes(pid)),
				"the coordinator told a worker the root's lease is gone",
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
	BUDGET.timeoutMs,
);
