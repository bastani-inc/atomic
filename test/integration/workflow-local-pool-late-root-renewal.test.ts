import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { defaultWorkerHeartbeatMs } from "../../packages/workflows/src/workers/worker-timing.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { makeTempDirectory, removeTempDirectory, sleep, writeFileEnsuringDir } from "../helpers/runtime.js";

const WORKERS = 2;
const CHILDREN = 2;
/** The shortest work lease a pool accepts, so the coordinator's recovery meets the late root renewal at once. */
const WORK_LEASE_MS = 2_000;
/** How late the root's last renewal looks: well past the coordinator's window of three root heartbeats. */
const RENEWAL_LATE_BY_MS = 4 * STAGE_SESSION_HEARTBEAT_INTERVAL_MS;
/**
 * How long the renewal stays late: several worker heartbeats and work leases, so every request and recovery meets it,
 * and a checkpoint commit that waits it out outlasts its attempt's work lease.
 */
const LATE_FOR_MS = 2 * WORK_LEASE_MS + 4 * defaultWorkerHeartbeatMs(WORK_LEASE_MS);
/** Children that commit a checkpoint every few milliseconds, so commits wait out the late renewal too. */
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
	"a root whose lease renewal is late but still held keeps its pooled children running",
	async () => {
		const directory = makeTempDirectory("pool-late-root-renewal-");
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
			name: "pool-late-root-renewal-root",
			description: "Root over pooled children while its lease renewal runs late",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const results = await Promise.all(
					Array.from({ length: CHILDREN }, (_, index) => ctx.workflow(child, { inputs: { directory, index } })),
				);
				for (const result of results)
					children.push({
						status: result.status,
						...(result.status === "completed"
							? { firstPid: result.outputs.firstPid, finalPid: result.outputs.finalPid }
							: { error: String((result as { error?: unknown }).error) }),
					});
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
		// Another connection stands in for a root process too busy to renew: it ages the lease row without touching its
		// holder or epoch, so the root still owns its run and keeps writing to it.
		const clock = await openNodeSqliteDatabase(path);
		const runId = randomUUID();
		const budget = AbortSignal.timeout(BUDGET.waitMs);
		try {
			const running = run(
				parent,
				{},
				{ runId, cwd: directory, store: createStore(), durableBackend: backend, signal: budget },
			);
			await waitUntil(() => startedChildren(directory) === CHILDREN, "every child to start", budget);
			const held = await journal.leaseState(runId);
			assert.ok(held?.holderId, "the root holds its lease");
			const lateUntil = Date.now() + LATE_FOR_MS;
			while (Date.now() < lateUntil) {
				await clock.run(
					"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) - ? WHERE run_id = ?",
					RENEWAL_LATE_BY_MS,
					runId,
				);
				await sleep(100);
			}
			// The late renewal lands.
			await clock.run(
				"UPDATE wf_leases SET renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE run_id = ?",
				runId,
			);
			await writeFileEnsuringDir(join(directory, "release"), "");
			const result = await running;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.equal(children.length, CHILDREN);
			for (const outcome of children) {
				assert.equal(outcome.status, "completed", JSON.stringify(children));
				// The worker that started a child finished it: the late renewal neither failed, fenced nor replayed it.
				assert.equal(outcome.finalPid, outcome.firstPid, JSON.stringify(children));
			}
			const after = await clock.get<{ epoch: number }>("SELECT epoch FROM wf_leases WHERE run_id = ?", runId);
			assert.equal(after?.epoch, held.epoch, "the root's lease was never granted again");
		} finally {
			await pool.close().catch(() => {});
			await clock.close();
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		}
	},
	BUDGET.timeoutMs,
);
