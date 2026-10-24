import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { POOL_SUMMARY_INTERVAL_MS } from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { WORKER_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/workers/protocol.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { testRunId } from "../helpers/run-id.js";
import {
	fileExistsSync,
	makeTempDirectory,
	readDirectorySync,
	readTextSync,
	removeTempDirectory,
	sleep,
	writeTextSync,
} from "../helpers/runtime.js";

/** Enough workers that per-worker activity would far outrun the summary rate. */
const WORKERS = 20;
/** Steady traffic over which root store invalidations are counted. */
const OBSERVED_TRAFFIC_MS = 5_000;
/** Timer phase and the last summary of the window may add one invalidation each. */
const SUMMARY_SLACK = 2;
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
const ACTIVATION_TIMEOUT_MS = 90_000;
const PROCESS_EXIT_TIMEOUT_MS = 30_000;
const COORDINATOR_ISOLATION_TIMEOUT_MS = 240_000;

/** Pool journal writes; reads such as `result` and the delivery-receipt guard may still run on the root. */
const POOL_WRITES = [
	"initialize",
	"setControl",
	"enqueue",
	"claim",
	"renew",
	"extend",
	"commit",
	"complete",
	"expire",
	"releaseExited",
	"releasePreviousIncarnations",
] as const;

function parentPid(pid: number): number {
	return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * A root whose children run on protocol stub workers (test/fixtures/pool-load-stub-worker.mjs),
 * with an isolated Intercom broker for the routes of their agent stages.
 */
async function startPooledRoot(root: string, workers: number) {
	const directory = makeTempDirectory("pool-coordinator-isolation-");
	const broker = new IntercomBrokerFixture(join(directory, "agent"));
	broker.overrideAgentDir();
	const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
	const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
	const intercomPath = fileURLToPath(new URL("../../packages/intercom", import.meta.url));
	broker.trackBroker(
		spawn(process.execPath, [getJitiCliPath(intercomPath), join(intercomPath, "broker/broker.ts")], {
			env: process.env,
			stdio: "ignore",
		}),
	);
	const brokerDeadline = performance.now() + BROKER_STARTUP_TIMEOUT_MS;
	while (!fileExistsSync(getBrokerSocketPath())) {
		broker.assertRunning();
		if (performance.now() > brokerDeadline) throw new Error("Intercom broker did not start");
		await sleep(25);
	}
	const path = join(directory, "journal.sqlite");
	const phaseFile = join(directory, "load-phase");
	const activeDirectory = join(directory, "active");
	const failureLog = join(directory, "stub-failures.log");
	writeTextSync(phaseFile, "traffic");
	writeTextSync(
		join(directory, "load-config.json"),
		JSON.stringify({
			phaseFile,
			activeDirectory,
			statsDirectory: join(directory, "stats"),
			failureLog,
			heartbeatMs: WORKER_HEARTBEAT_INTERVAL_MS,
			appendIntervalMs: 500,
			toolIntervalMs: 1_000,
			largeEvery: 4,
			largeEntryBytes: 8 * 1024,
		}),
	);
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const childPath = fileURLToPath(new URL("../fixtures/pool-load-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
		workerEntry: fileURLToPath(new URL("../fixtures/pool-load-stub-worker.mjs", import.meta.url)),
	});
	const store = createStore();
	const execution = run(
		workflow({
			name: "pool-coordinator-isolation-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await Promise.all(
					Array.from({ length: workers }, (_, index) => ctx.workflow(child, { inputs: { index } })),
				);
				return {};
			},
		}),
		{},
		{ runId: root, cwd: directory, store, durableBackend: backend },
	);
	const failures = () => (fileExistsSync(failureLog) ? readTextSync(failureLog, "utf8") : "");
	return {
		pool,
		store,
		execution,
		failures,
		finish: () => writeTextSync(phaseFile, "finish"),
		async active(): Promise<void> {
			const deadline = performance.now() + ACTIVATION_TIMEOUT_MS;
			const count = () => (fileExistsSync(activeDirectory) ? readDirectorySync(activeDirectory).length : 0);
			while (count() < workers) {
				assert.equal(failures(), "", "a stub worker failed");
				if (performance.now() > deadline) assert.fail(`only ${count()} of ${workers} workers became active`);
				await sleep(100);
			}
		},
		async close(): Promise<void> {
			writeTextSync(phaseFile, "finish");
			await execution.catch(() => {});
			await pool.close().catch(() => {});
			await backend.close();
			await broker.cleanup();
			removeTempDirectory(directory);
		},
	};
}

test.skipIf(process.platform === "win32")(
	"pool coordination runs in the coordinator process and reaches the root store only as rate-bounded summaries (#3903)",
	async () => {
		const root = testRunId("pool-coordinator-isolation-root");
		const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
		const writes = POOL_WRITES.map((method) => [method, vi.spyOn(SqlPoolQueue.prototype, method)] as const);
		const usageReports = vi.spyOn(SqlPoolUsage.prototype, "report");
		const routeRegistrations = vi.spyOn(IntercomClient.prototype, "registerPendingStageRouteAcknowledged");
		const pooled = await startPooledRoot(root, WORKERS);
		try {
			await pooled.active();

			let invalidations = 0;
			const unsubscribe = pooled.store.subscribeInvalidation(() => {
				invalidations++;
			});
			await sleep(OBSERVED_TRAFFIC_MS);
			unsubscribe();
			const summaryBound = Math.ceil(OBSERVED_TRAFFIC_MS / POOL_SUMMARY_INTERVAL_MS) + SUMMARY_SLACK;
			assert.ok(
				invalidations <= summaryBound,
				`${WORKERS} busy workers caused ${invalidations} root store invalidations in ${OBSERVED_TRAFFIC_MS} ms; the summary rate allows ${summaryBound}`,
			);

			const coordinatorPid = pooled.pool.coordinatorPid;
			assert.ok(
				coordinatorPid !== undefined && coordinatorPid !== process.pid,
				"the coordinator is its own process",
			);
			assert.equal(pooled.pool.workerPids.length, WORKERS);
			for (const pid of pooled.pool.workerPids)
				assert.equal(parentPid(pid), coordinatorPid, "workers are children of the coordinator, not of the root");

			const pooledRuns = new Set(
				pooled.store.runs().flatMap((entry) => (entry.parentRunId === root ? [entry.id] : [])),
			);
			assert.equal(pooledRuns.size, WORKERS, "the root store shows every pooled run");
			assert.ok(
				routeRegistrations.mock.calls.some(([runId]) => runId === root),
				"the root's own route is registered from the root process",
			);
			assert.deepEqual(
				routeRegistrations.mock.calls.filter(([runId]) => pooledRuns.has(runId)),
				[],
				"the root process registered no route for a pooled run; the coordinator owns them",
			);

			pooled.finish();
			const result = await pooled.execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.equal(pooled.failures(), "");
			for (const [method, write] of writes)
				assert.equal(write.mock.calls.length, 0, `the root process called SqlPoolQueue.${method}`);
			assert.equal(usageReports.mock.calls.length, 0, "the root process wrote pool usage");
		} finally {
			vi.restoreAllMocks();
			await pooled.close();
		}
	},
	COORDINATOR_ISOLATION_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a coordinator that dies fails the waiting children instead of leaving them waiting, and its workers exit with it (#3903)",
	async () => {
		const root = testRunId("pool-coordinator-death-root");
		const pooled = await startPooledRoot(root, 3);
		try {
			await pooled.active();
			const coordinatorPid = pooled.pool.coordinatorPid!;
			const workers = pooled.pool.workerPids;
			assert.equal(workers.length, 3);
			process.kill(coordinatorPid, "SIGKILL");
			const result = await pooled.execution;
			assert.equal(result.status, "failed");
			assert.match(String(result.error), /Local worker pool coordinator exited \(SIGKILL\)/);
			const deadline = performance.now() + PROCESS_EXIT_TIMEOUT_MS;
			while (workers.some(alive)) {
				if (performance.now() > deadline) assert.fail("workers outlived their coordinator");
				await sleep(50);
			}
			assert.deepEqual(pooled.pool.workerPids, []);
		} finally {
			await pooled.close();
		}
	},
	COORDINATOR_ISOLATION_TIMEOUT_MS,
);
