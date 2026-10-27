import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { WorkflowInfrastructureError } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowOutputValues } from "../../packages/workflows/src/shared/types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import {
	fileExistsSync,
	makeTempDirectory,
	readTextSync,
	removeTempDirectory,
	sleep,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** A local pool whose workers keep crashing: later children get the pool's fault (#3979). */

const WORKER_FAILURE_ROOT_TIMEOUT_MS = 150_000;
const CONDITION_TIMEOUT_MS = 90_000;

/**
 * Fails the whole pool the way only a pool-wide fault does: every worker but the one whose pid `busyPidFile` names
 * is SIGKILLed as soon as it appears, so workers keep crashing without work, until `done`. Only replacement workers
 * may be idle when it starts: an initial worker killed before readiness is not replaced.
 */
async function crashIdleWorkers(pool: LocalWorkerPool, busyPidFile: string, done: () => boolean): Promise<void> {
	const killed = new Set<number>();
	const deadline = performance.now() + CONDITION_TIMEOUT_MS;
	while (!done()) {
		if (performance.now() > deadline) assert.fail("the pool never failed");
		const busy = fileExistsSync(busyPidFile) ? Number(readTextSync(busyPidFile, "utf8")) : 0;
		if (busy > 0)
			for (const pid of pool.workerPids)
				if (pid !== busy && !killed.has(pid)) {
					killed.add(pid);
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
		await sleep(25);
	}
}

const heldChildPath = fileURLToPath(new URL("../fixtures/pool-worker-failure-child.ts", import.meta.url));

test.skipIf(process.platform === "win32")(
	"a child started after the pool failed gets the pool's fault instead of running in the host (#3979)",
	async () => {
		const directory = makeTempDirectory("pool-fault-no-host-fallback-");
		const held = join(directory, "held");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const holding = await loadWorkerDefinition({
			path: heldChildPath,
			exportName: "releasedChild",
			digest: await definitionDigest(heldChildPath),
		});
		const laterPath = fileURLToPath(new URL("../fixtures/pool-resume-child.ts", import.meta.url));
		const later = await loadWorkerDefinition({
			path: laterPath,
			exportName: "resumedChild",
			digest: await definitionDigest(laterPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [
				{ definition: holding, path: heldChildPath, exportName: "releasedChild" },
				{ definition: later, path: laterPath, exportName: "resumedChild" },
			],
		});
		await writeFileEnsuringDir(join(held, "placeholder"), "");
		await writeFileEnsuringDir(join(directory, "release"), "");
		let first: unknown;
		let afterFault: unknown;
		let laterOutputs: WorkflowOutputValues | undefined;
		const parent = workflow({
			name: "pool-fault-no-host-fallback-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				// Its release file never appears: it holds its worker until the coordinator dies.
				await ctx.workflow(holding, { inputs: { directory: held, index: 0 } }).catch((error: Error) => {
					first = error;
				});
				try {
					laterOutputs = (await ctx.workflow(later, { inputs: { directory, index: 0 } })).outputs;
				} catch (error) {
					afterFault = error;
				}
				return {};
			},
		});
		try {
			const execution = run(
				parent,
				{},
				{
					runId: "pool-fault-no-host-fallback-root",
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
				},
			);
			// A coordinator that dies is a pool-wide fault.
			await untilOrRunEnds(async () => fileExistsSync(join(held, "started-0")), execution, CONDITION_TIMEOUT_MS);
			process.kill(pool.coordinatorPid!, "SIGKILL");
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.ok(first instanceof WorkflowInfrastructureError, String(first));
			assert.equal(laterOutputs, undefined, "the later child ran in the host process");
			assert.ok(afterFault instanceof WorkflowInfrastructureError, String(afterFault));
			assert.equal(afterFault.code, first.code);
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a pool that fails settles the work of its root, so none stays ready or leased after the root completes (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-fault-releases-leases-");
		const held = join(directory, "held");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const crashingPath = fileURLToPath(new URL("../fixtures/pool-crashing-child.ts", import.meta.url));
		const crashing = await loadWorkerDefinition({
			path: crashingPath,
			exportName: "crashingChild",
			digest: await definitionDigest(crashingPath),
		});
		const holding = await loadWorkerDefinition({
			path: heldChildPath,
			exportName: "releasedChild",
			digest: await definitionDigest(heldChildPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 2,
			definitions: [
				{ definition: crashing, path: crashingPath, exportName: "crashingChild" },
				{ definition: holding, path: heldChildPath, exportName: "releasedChild" },
			],
		});
		await writeFileEnsuringDir(join(held, "placeholder"), "");
		const root = "pool-fault-releases-leases-root";
		let settled: PromiseSettledResult<unknown>[] | undefined;
		let crashFailure: unknown;
		const parent = workflow({
			name: "pool-fault-releases-leases-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				// The holding child keeps its worker's lease until the pool fails: its release file never appears.
				settled = await Promise.allSettled([
					ctx.workflow(holding, { inputs: { directory: held, index: 0 } }),
					ctx.workflow(crashing).catch((error: unknown) => {
						crashFailure = error;
						throw error;
					}),
				]);
				return {};
			},
		});
		try {
			const execution = run(
				parent,
				{},
				{ runId: root, cwd: directory, store: createStore(), durableBackend: backend },
			);
			// The crashing child fails alone first; every worker not holding the other child is then a replacement.
			await untilOrRunEnds(async () => crashFailure !== undefined, execution, CONDITION_TIMEOUT_MS);
			assert.ok(crashFailure instanceof WorkflowInfrastructureError, String(crashFailure));
			assert.equal(crashFailure.code, "worker_retry_limit");
			await crashIdleWorkers(pool, join(held, "started-0"), () => settled !== undefined);
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.deepEqual(
				settled?.map((result) => result.status),
				["rejected", "rejected"],
			);
			await pool.close().catch(() => {});
			const work = await (await openSqlPoolQueue(journal)).inspect(root);
			assert.equal(work.length, 2);
			assert.deepEqual(
				work.filter((item) => item.state === "leased" || item.state === "ready").map((item) => item.childRunId),
				[],
				"no work of the finished root stays ready or leased",
			);
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);
