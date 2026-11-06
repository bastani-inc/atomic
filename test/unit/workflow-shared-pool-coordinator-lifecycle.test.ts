import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { sleep } from "../helpers/runtime.js";
import {
	binding,
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	fanOut,
	fixture,
	libsql,
	PREFIX,
	satellite,
	stubWorker,
} from "../helpers/workflow-shared-pool-coordinator.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

/** A worker host's stop, drain and worker deaths, and what each puts back in the root's queue (#4310). */

test(
	"a worker host that stops while its worker holds a child puts the child back, and another host finishes it (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-stop", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		const hosts: PoolCoordinator[] = [];
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			const warmHere = { prefer: async () => warm };
			const first = await satellite(f, root, warmHere, [], "host-b");
			hosts.push(first);
			while (f.claims().length === 0) await sleep(25);
			const [[, workId]] = f.claims() as [[string, string]];
			assert.deepEqual(
				(await f.shared.stats("root")).leases.map((lease) => [lease.work, lease.host]),
				[[workId, "host-b"]],
			);
			assert.deepEqual(first.workerCounts(), { workers: 2, busy: 1 });
			await first.stopSatellite();
			const stopped = await f.shared.stats("root");
			assert.deepEqual(
				[stopped.ready, stopped.leased, stopped.leases],
				[1, 0, []],
				"the stopped host's child waits for another host",
			);
			writeFileSync(release, "");
			hosts.push(await satellite(f, root, warmHere, [], "host-c"));
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.deepEqual(
				f.claims().map(([claimer, id]) => [claimer, id]),
				[
					["host-b", workId],
					["host-c", workId],
				],
			);
		} finally {
			for (const host of hosts) {
				await host.stopSatellite();
				await host.shutdown();
			}
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a draining worker host takes no more children and finishes the one it holds before it closes (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-drain", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(2)(child as never);
		const hosts: PoolCoordinator[] = [];
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			const warmHere = { prefer: async () => warm };
			const draining = await satellite(f, root, warmHere, [], "host-b");
			hosts.push(draining);
			while (draining.workerCounts().busy < 2) await sleep(25);
			let drained = false;
			const drain = draining.drain().then(() => {
				drained = true;
			});
			await sleep(1_000);
			assert.equal(drained, false, "a drain waits for the children its workers hold");
			assert.equal((await f.shared.stats("root")).leased, 2);
			writeFileSync(release, "");
			await drain;
			assert.deepEqual(
				draining.workerCounts(),
				{ workers: 0, busy: 0 },
				"a drained host closed: its workers stopped",
			);
			const stats = await f.shared.stats("root");
			assert.deepEqual([stats.completed, stats.ready, stats.leased], [2, 0, 0], "drained children completed");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed", "completed"]);
			assert.equal(f.claims().length, 2);
		} finally {
			for (const host of hosts) {
				await host.stopSatellite();
				await host.shutdown();
			}
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host's stop and drain do not wait for a prefer hook that never settles, and abort its signal (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-prefer-hang", { workspace: binding });
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		const hosts: Awaited<ReturnType<typeof startWorkflowWorkerHost>>[] = [];
		let restores = 0;
		try {
			await f.root();
			for (const end of ["stop", "drain"] as const) {
				let asked!: (signal: AbortSignal) => void;
				const hookSignal = new Promise<AbortSignal>((resolve) => {
					asked = resolve;
				});
				const host = await startWorkflowWorkerHost({
					journal: {
						adapter: libsql,
						options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
						prefix: PREFIX,
					},
					agentDir: join(f.directory, `host-${end}`, "agent"),
					maxWorkers: 1,
					hostId: `host-${end}`,
					workerEntry: stubWorker,
					// The hook never answers: the host asks it about the root's bound child, then waits.
					placement: {
						prefer: (_binding, { signal }) => {
							asked(signal);
							return new Promise<string | undefined>(() => {});
						},
					},
					// A host that stops or drains while it asks must not fall back to restoring the child instead.
					restore: async () => {
						restores++;
						return f.directory;
					},
				});
				hosts.push(host);
				const signal = await hookSignal;
				assert.equal(signal.aborted, false);
				await host[end]();
				assert.equal(signal.aborted, true, `${end} aborted the hook's signal`);
			}
			const stats = await f.shared.stats("root");
			assert.deepEqual([stats.ready, stats.leased], [1, 0], "no host held the child");
			assert.equal(restores, 0, "no host that was stopping or draining restored the child");
		} finally {
			for (const host of hosts) await host.stop();
			await f.pool.close();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host stops at once while it attaches, its worker still starting up, and that worker is stopped (#4310)",
	async () => {
		// The root keeps running: its bound child waits for a host with its tree, which this host is not.
		const f = await fixture("shared-coordinator-stop-attaching", { workspace: binding });
		vi.stubEnv("SHARED_POOL_STUB_HANG_HOST", "host-b");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			await f.root();
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				hostId: "host-b",
				workerEntry: stubWorker,
			});
			for (
				let poll = 0;
				poll < 1_200 && !f.starts().some((start) => (start.shared as { host: string }).host === "host-b");
				poll++
			)
				await sleep(25);
			const [worker] = f.starts().filter((start) => (start.shared as { host: string }).host === "host-b");
			// Its worker never reports ready, so the attach would last until the root's worker startup timeout.
			const stopped = await Promise.race([
				host.stop().then(() => "stopped"),
				sleep(10_000).then(() => "still attaching"),
			]);
			assert.equal(stopped, "stopped");
			host = undefined;
			assert.throws(() => process.kill(worker!.pid as number, 0), "the worker still starting up was stopped");
		} finally {
			await host?.stop();
			await f.pool.close();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a stop during a worker host's drain stops at once and puts the child it held back in the queue (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-drain-then-stop", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			await f.root();
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				hostId: "host-b",
				workerEntry: stubWorker,
				placement: { prefer: async () => warm },
			});
			while (f.claims().length === 0) await sleep(25);
			let drained = false;
			const draining = host.drain().then(() => {
				drained = true;
			});
			await sleep(1_500);
			assert.equal(drained, false, "the drain waits for the child the host holds");
			// The child never finishes: its release is never written. A stop ends the drain anyway.
			await host.stop();
			await draining;
			const stats = await f.shared.stats("root");
			assert.deepEqual([stats.ready, stats.leased, stats.completed], [1, 0, 0], "the child is back, unfinished");
		} finally {
			writeFileSync(release, "");
			await host?.stop();
			await f.pool.close();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host's stop always leaves the registry and closes, and keeps its first failure with the cleanup failure attached (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-stop-failure", { workspace: binding });
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			await f.root();
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				hostId: "host-b",
				workerEntry: stubWorker,
			});
			while ((await host.stats()).roots.length === 0) await sleep(25);
			const primary = new Error("a worker's cleanup could not be confirmed");
			const cleanup = new Error("the registry is unreachable");
			const stopSatellite = PoolCoordinator.prototype.stopSatellite;
			const stopping = vi.spyOn(PoolCoordinator.prototype, "stopSatellite").mockImplementationOnce(async function (
				this: PoolCoordinator,
			) {
				await stopSatellite.call(this);
				throw primary;
			});
			const forgetting = vi.spyOn(SqlSharedPool.prototype, "forgetHost").mockRejectedValueOnce(cleanup);
			const polls = vi.spyOn(SqlSharedPool.prototype, "roots");
			const failure = await host.stop().then(
				() => undefined,
				(error: Error) => error,
			);
			assert.equal(failure, primary, "the satellite's failure is the one thrown");
			assert.equal((failure as Error & { cleanupCause?: unknown }).cleanupCause, cleanup);
			assert.equal(stopping.mock.calls.length, 1);
			assert.equal(forgetting.mock.calls.length, 1, "the host still tried to leave the registry");
			const pollsAfterStop = polls.mock.calls.length;
			await sleep(2_500);
			assert.equal(polls.mock.calls.length, pollsAfterStop, "a stopped host polls no more");
			assert.equal(await host.stop().catch((error: Error) => error), primary, "a second stop reports the same");
			vi.restoreAllMocks();
		} finally {
			vi.restoreAllMocks();
			await f.pool.close();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a child whose worker crashes on every host fails at the root with the retry limit, and only that child (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-crash", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		vi.stubEnv("SHARED_POOL_STUB_CRASH", "1");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const failures: Error[] = [];
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			host = await satellite(f, root, { prefer: async () => warm }, failures);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			const [failure] = outcomes as [Error];
			assert.ok(failure instanceof Error, String(failure));
			assert.match(
				failure.message,
				/^Local worker retry limit: child \S+ \(boundChild\) lost its worker on another host 3 times/,
			);
			assert.deepEqual(
				[failure.name, (failure as Error & { code?: string }).code],
				["WorkflowInfrastructureError", "worker_retry_limit"],
			);
			const claims = f.claims();
			assert.ok(claims.length >= 3, `claims: ${claims.length}`);
			assert.ok(claims.every(([claimer, id]) => claimer === "host-b" && id === claims[0]![1]));
			assert.equal(host.detached, false, "a crashing worker does not detach its host");
			assert.deepEqual(failures, []);
			assert.equal((await f.shared.stats("root")).failed, 1);
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host's stop throws its first failure alone, or with every later cleanup failure attached (#4310)",
	async () => {
		const directory = makeLibsqlDirectory();
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		const selection = {
			adapter: libsql,
			options: { url: pathToFileURL(join(directory, "shared.db")).href },
			prefix: PREFIX,
		};
		const journal = await resolveRunJournal({ agentDir: join(directory, "root", "agent"), journal: selection });
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		const startHost = async (hostId: string) => {
			const host = await startWorkflowWorkerHost({
				journal: selection,
				agentDir: join(directory, hostId, "agent"),
				maxWorkers: 1,
				hostId,
				workerEntry: stubWorker,
			});
			while ((await host.stats()).workers === 0) await sleep(25);
			return host;
		};
		const stopSatellite = PoolCoordinator.prototype.stopSatellite;
		const shutdown = PoolCoordinator.prototype.shutdown;
		const failing = (error: Error, original: (this: PoolCoordinator) => Promise<void>) =>
			async function (this: PoolCoordinator) {
				await original.call(this);
				throw error;
			};
		try {
			const queue = await openSqlPoolQueue(journal);
			const shared = await SqlSharedPool.open(journal, queue);
			await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
			const acquired = await journal.acquire("root", "root-holder");
			if (acquired.status !== "acquired") assert.fail("no lease");
			await queue.initialize(acquired.lease, 60_000);
			await shared.publishConfig(acquired.lease, {
				definitions: [{ path: childPath, digest: await definitionDigest(childPath), exportName: "boundChild" }],
				leaseMs: 30_000,
				heartbeatMs: 7_500,
				startupTimeoutMs: 30_000,
				claimWindowMs: 60_000,
			});
			const primary = new Error("a worker's cleanup could not be confirmed");
			const alone = await startHost("host-alone");
			vi.spyOn(PoolCoordinator.prototype, "stopSatellite").mockImplementationOnce(failing(primary, stopSatellite));
			const lone = await alone.stop().then(
				() => undefined,
				(error: Error) => error,
			);
			assert.equal(lone, primary);
			assert.equal(Object.hasOwn(lone as Error, "cleanupCause"), false, "nothing failed after it: no cleanup cause");
			vi.restoreAllMocks();

			const several = await startHost("host-several");
			const shuttingDown = new Error("a worker log could not be removed");
			const forgetting = new Error("the registry is unreachable");
			vi.spyOn(PoolCoordinator.prototype, "stopSatellite").mockImplementationOnce(failing(primary, stopSatellite));
			vi.spyOn(PoolCoordinator.prototype, "shutdown").mockImplementationOnce(failing(shuttingDown, shutdown));
			vi.spyOn(SqlSharedPool.prototype, "forgetHost").mockRejectedValueOnce(forgetting);
			const gathered = (await several.stop().then(
				() => undefined,
				(error: Error) => error,
			)) as Error & { readonly cleanupCause?: unknown };
			assert.equal(gathered, primary, "the first failure stays the one thrown");
			assert.ok(gathered.cleanupCause instanceof AggregateError);
			assert.deepEqual(
				[gathered.cleanupCause.message, gathered.cleanupCause.errors],
				["Worker host cleanup failed", [shuttingDown, forgetting]],
			);
		} finally {
			vi.restoreAllMocks();
			await journal.close();
			vi.unstubAllEnvs();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a host whose workers keep dying stops serving the root and says why (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-dying", { workspace: binding, claimWindowMs: 60_000 });
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			await f.root();
			// The root's own worker is up: from here on, every worker this test's processes fork dies at once.
			vi.stubEnv("SHARED_POOL_STUB_EXIT_IDLE", "1");
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				hostId: "host-b",
				workerEntry: stubWorker,
			});
			let detached = (await host.stats()).lastDetach;
			while (detached === undefined) {
				await sleep(25);
				detached = (await host.stats()).lastDetach;
			}
			assert.deepEqual(Object.keys(detached).sort(), ["message", "name"], "a failure that is not a placement error");
			assert.match(detached.message, /Local worker retry limit/);
			assert.deepEqual(f.claims(), []);
		} finally {
			vi.unstubAllEnvs();
			await host?.stop();
			await f.pool.close().catch(() => {});
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host that stops puts the child its worker holds back in the queue (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-host-stop", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			await f.root();
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				hostId: "host-b",
				workerEntry: stubWorker,
				placement: { prefer: async () => warm },
			});
			while (f.claims().length === 0) await sleep(25);
			assert.equal((await f.shared.stats("root")).leased, 1);
			await host.stop();
			const stats = await f.shared.stats("root");
			assert.deepEqual([stats.ready, stats.leased], [1, 0], "the stopped host's child waits for another host");
			assert.deepEqual(await f.shared.registeredHosts(), []);
		} finally {
			writeFileSync(release, "");
			await host?.stop();
			await f.pool.close().catch(() => {});
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
