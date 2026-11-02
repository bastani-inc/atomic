/**
 * A local worker sends one renewal, one control poll and one usage report at a time, and waits for each answer before
 * it sends the next. When the pool's journal answers more slowly than the work lease, as when other writers keep its
 * write lock busy, every worker of the pool waits on the coordinator at once and sends nothing more. Lease recovery
 * used to read that wait as every worker having gone silent: it killed every worker of the pool at the same moment
 * and replayed, or failed, every child. A worker waiting for the pool's own answer is not silent.
 */
import assert from "node:assert/strict";
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
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { WORKER_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/workers/protocol.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

const WORKERS = 3;
const CHILDREN = 3;
/** The shortest work lease a pool accepts, so recovery meets the slow journal at once. */
const WORK_LEASE_MS = 2_000;
/** How long each lease renewal takes while the journal is slow: well past the work lease. */
const SLOW_RENEWAL_MS = 3 * WORK_LEASE_MS;
/** How long the journal stays slow: several leases and worker heartbeats, so every recovery pass meets it. */
const SLOW_FOR_MS = 2 * WORK_LEASE_MS + 4 * WORKER_HEARTBEAT_INTERVAL_MS;
/** Children that commit a checkpoint every few milliseconds until the test releases them. */
const childPath = fileURLToPath(new URL("../fixtures/pool-committing-child.ts", import.meta.url));
const BUDGET = poolTestBudgetMs(2);

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
	"workers waiting on a pool journal slower than their lease keep their children",
	async () => {
		const directory = makeTempDirectory("pool-slow-journal-");
		const path = join(directory, "journal.sqlite");
		const exportName = "committingChild";
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName,
			digest: await definitionDigest(childPath),
		});
		const children: {
			status: string;
			error?: string;
			firstPid?: WorkflowSerializableValue;
			finalPid?: WorkflowSerializableValue;
		}[] = [];
		const parent = workflow({
			name: "pool-slow-journal-root",
			description: "Root over pooled children while the pool's journal answers slowly",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const results = await Promise.allSettled(
					Array.from({ length: CHILDREN }, (_, index) => ctx.workflow(child, { inputs: { directory, index } })),
				);
				for (const result of results)
					children.push(
						result.status === "rejected"
							? { status: "rejected", error: String(result.reason) }
							: {
									status: result.value.status,
									...(result.value.status === "completed"
										? { firstPid: result.value.outputs.firstPid, finalPid: result.value.outputs.finalPid }
										: { error: String((result.value as { error?: unknown }).error) }),
								},
					);
				return {};
			},
		});
		const database = await openNodeSqliteDatabase(path);
		const journal = await SqlRunJournal.open(database);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: WORKERS,
			leaseMs: WORK_LEASE_MS,
			definitions: [{ definition: child, path: childPath, exportName }],
			coordinator: "in-process",
		});
		// The pool's journal answers lease renewals slowly, as one whose write lock other writers keep busy does. Only the
		// time changes: every renewal still lands, and the coordinator's own event loop stays free.
		let slowUntil = 0;
		const extend = SqlPoolQueue.prototype.extend;
		vi.spyOn(SqlPoolQueue.prototype, "extend").mockImplementation(async function (this: SqlPoolQueue, ...args) {
			if (Date.now() < slowUntil) await sleep(SLOW_RENEWAL_MS);
			return extend.apply(this, args);
		});
		const runId = randomUUID();
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		try {
			const running = run(
				parent,
				{},
				{ runId, cwd: directory, store: createStore(), durableBackend: backend, signal: budget },
			);
			await waitUntil(() => startedChildren(directory) === CHILDREN, "every child to start", budget);
			const workers = [...pool.workerPids].sort();
			slowUntil = Date.now() + SLOW_FOR_MS;
			await sleep(SLOW_FOR_MS + SLOW_RENEWAL_MS);
			await writeFileEnsuringDir(join(directory, "release"), "");
			const result = await running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.equal(children.length, CHILDREN);
			for (const outcome of children) {
				assert.equal(outcome.status, "completed", JSON.stringify(children));
				// The worker that started a child finished it: the slow journal neither killed, fenced nor replayed it.
				assert.equal(outcome.finalPid, outcome.firstPid, JSON.stringify(children));
			}
			assert.deepEqual([...pool.workerPids].sort(), workers, "no worker was stopped or replaced");
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
