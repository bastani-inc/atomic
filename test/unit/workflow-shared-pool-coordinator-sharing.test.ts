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
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { isWorkspaceRestoreUnavailableError } from "../../packages/workflows/src/workers/placement-errors.js";
import { poolDurableJournal } from "../../packages/workflows/src/workers/pool-journal.js";
import type { WorkspaceBinding } from "../../packages/workflows/src/workers/workspace-binding.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { sleep } from "../helpers/runtime.js";
import {
	binding,
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	fanOut,
	fixture,
	libsql,
	loggedStarts,
	PREFIX,
	stubWorker,
} from "../helpers/workflow-shared-pool-coordinator.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

/** How a worker host divides its workers between the shared roots it serves (#4310). */

test.skipIf(process.platform === "win32")(
	"a worker host serves every running shared root with a share of its workers, reports them, and drains (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-host", {});
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		vi.stubEnv("SHARED_POOL_STUB_RECYCLE", "1");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const second = new LocalWorkerPool(f.backend, {
			rootId: "root-2",
			durable: poolDurableJournal(f.backend.journal),
			shared: { stateDirectory: join(f.directory, "root", "state-2"), host: "root-host", claimWindowMs: 60_000 },
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const first = await fanOut(3)(child as never);
		const other = await fanOut(3)(child as never);
		const executions = [
			run(first.parent, {}, { runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
			run(other.parent, {}, { runId: "root-2", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
		];
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			while ((await f.shared.roots()).filter((root) => root.status === "running").length < 2) await sleep(25);
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 2,
				restore: false,
				hostId: "host-b",
				labels: { zone: "test" },
				workerEntry: stubWorker,
			});
			// Each root's children wait on the release; the host runs one of each root's at a time.
			for (;;) {
				const stats = await host.stats();
				if (stats.roots.length === 2 && stats.busy === 2) break;
				await sleep(25);
			}
			const stats = await host.stats();
			assert.deepEqual(
				[stats.hostId, stats.workers, stats.busy, stats.maxWorkers, stats.restore],
				["host-b", 2, 2, 2, false],
			);
			assert.deepEqual(stats.roots.map((root) => root.root).sort(), ["root", "root-2"]);
			for (const root of stats.roots) assert.equal(root.leases.filter((lease) => lease.host === "host-b").length, 1);
			// The host's next report lists the roots it serves.
			let registered = await f.shared.registeredHosts();
			for (let poll = 0; poll < 200 && registered[0]?.roots.length !== 2; poll++) {
				await sleep(25);
				registered = await f.shared.registeredHosts();
			}
			assert.deepEqual(
				registered.map((row) => [row.host, row.labels, row.roots]),
				[["host-b", { zone: "test" }, ["root", "root-2"]]],
			);
			writeFileSync(release, "");
			const results = await Promise.all(executions);
			assert.deepEqual(
				results.map((result) => result.status),
				["completed", "completed"],
			);
			assert.deepEqual(first.outcomes, ["completed", "completed", "completed"]);
			assert.deepEqual(other.outcomes, ["completed", "completed", "completed"]);
			assert.ok(
				f.claims().some(([claimer]) => claimer === "host-b"),
				"the host ran some of the children",
			);
			const claimed = f.claims().map(([, workId]) => workId);
			assert.equal(new Set(claimed).size, claimed.length, "a host serving steadily never gives a child back");
			// Workers past their memory limit after one child are replaced, and the host says why.
			assert.match((await host.stats()).lastHealth ?? "", /maxWorkerRssBytes/);
			// A root that ended is let go: its satellite stops and its workers with it.
			while ((await host.stats()).roots.length > 0) await sleep(25);
			assert.deepEqual([(await host.stats()).workers, (await host.stats()).busy], [0, 0]);
			await host.drain();
			assert.deepEqual(await f.shared.registeredHosts(), [], "a drained host leaves the registry");
			assert.deepEqual((await host.stats()).roots, []);
		} finally {
			await host?.stop();
			writeFileSync(release, "");
			await Promise.allSettled(executions);
			await second.close();
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host keeps its idle worker on its root while a later root has no ready work (#4310)",
	async () => {
		// The first root keeps running: its child waits for a host with its tree far longer than this test.
		const f = await fixture("shared-coordinator-no-yield", { workspace: binding, claimWindowMs: 600_000 });
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		// The later root's own worker holds its only child, so it has nothing ready for this host.
		const second = new LocalWorkerPool(f.backend, {
			rootId: "root-2",
			durable: poolDurableJournal(f.backend.journal),
			shared: { stateDirectory: join(f.directory, "root", "state-2"), host: "root-host", claimWindowMs: 60_000 },
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const first = await fanOut(1)(child as never);
		const other = await fanOut(1)(child as never);
		const executions = [
			run(first.parent, {}, { runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
		];
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			await f.root();
			executions.push(
				run(
					other.parent,
					{},
					{ runId: "root-2", cwd: f.directory, store: createStore(), durableBackend: f.backend },
				),
			);
			for (;;) {
				const stats = await f.shared.stats("root-2");
				if (stats.leased === 1) break;
				await sleep(25);
			}
			// The host serves the root published first, and the later root waits for a worker of it.
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				restore: false,
				hostId: "host-b",
				workerEntry: stubWorker,
			});
			for (;;) {
				const stats = await host.stats();
				if (stats.workers === 1 && stats.roots.length === 1) break;
				await sleep(25);
			}
			// Past the idle yield interval, with the later root's pool running and nothing of it ready.
			await sleep(7_000);
			assert.equal((await f.shared.stats("root-2")).ready, 0);
			assert.deepEqual(
				(await host.stats()).roots.map((root) => root.root),
				["root"],
				"the host gives no worker to a root with no ready work",
			);
		} finally {
			writeFileSync(release, "");
			await host?.stop();
			await f.pool.close();
			await Promise.allSettled(executions);
			await second.close();
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host whose workers serve one root gives a root that starts later its share (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-yield", { workspace: binding, claimWindowMs: 20_000 });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const later: WorkspaceBinding = { ...binding, tree: "t2" };
		const second = new LocalWorkerPool(f.backend, {
			rootId: "root-2",
			durable: poolDurableJournal(f.backend.journal),
			shared: { stateDirectory: join(f.directory, "root", "state-2"), host: "root-host", claimWindowMs: 60_000 },
			workspace: later,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const first = await fanOut(1)(child as never);
		const other = await fanOut(2)(child as never);
		const executions = [
			run(first.parent, {}, { runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
		];
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
				maxWorkers: 2,
				restore: false,
				hostId: "host-b",
				workerEntry: stubWorker,
				// This host has only the later root's tree: the first root's child is never its to run.
				placement: { prefer: async (requested) => (requested.tree === "t2" ? warm : undefined) },
			});
			for (;;) {
				const stats = await host.stats();
				if (stats.workers === 2 && stats.roots.length === 1) break;
				await sleep(25);
			}
			executions.push(
				run(
					other.parent,
					{},
					{ runId: "root-2", cwd: f.directory, store: createStore(), durableBackend: f.backend },
				),
			);
			while (f.claims().length < 1) await sleep(25);
			const stats = await host.stats();
			assert.deepEqual(stats.roots.map((root) => root.root).sort(), ["root", "root-2"]);
			assert.equal(stats.workers, 2, "the host still runs its two workers, one for each root");
			assert.ok(f.claims().every(([claimer, , cwd]) => claimer === "host-b" && cwd === warm));
			writeFileSync(release, "");
			assert.equal((await executions[1]!).status, "completed");
			assert.deepEqual(other.outcomes, ["completed", "completed"]);
			assert.equal(f.claims().length, 2, "the later root's children ran on the host");
			const firstResult = await executions[0]!;
			assert.equal(firstResult.status, "completed");
			assert.ok(isWorkspaceRestoreUnavailableError(first.outcomes[0]), String(first.outcomes[0]));
		} finally {
			await host?.stop();
			writeFileSync(release, "");
			await Promise.allSettled(executions);
			await second.close();
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host with one worker gives it, once idle, to a later root whose ready work it can run (#4310)",
	async () => {
		// The first root keeps running: its child waits for a host with its tree far longer than this test.
		const f = await fixture("shared-coordinator-idle-yield", { workspace: binding, claimWindowMs: 600_000 });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const later: WorkspaceBinding = { ...binding, tree: "t2" };
		const second = new LocalWorkerPool(f.backend, {
			rootId: "root-2",
			durable: poolDurableJournal(f.backend.journal),
			shared: { stateDirectory: join(f.directory, "root", "state-2"), host: "root-host", claimWindowMs: 60_000 },
			workspace: later,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const first = await fanOut(1)(child as never);
		const other = await fanOut(2)(child as never);
		const executions = [
			run(first.parent, {}, { runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
		];
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
				restore: false,
				hostId: "host-b",
				workerEntry: stubWorker,
				// This host has only the later root's tree: its one worker has nothing of the first root's to run.
				placement: { prefer: async (requested) => (requested.tree === "t2" ? warm : undefined) },
			});
			for (;;) {
				const stats = await host.stats();
				if (stats.workers === 1 && stats.roots.length === 1) break;
				await sleep(25);
			}
			executions.push(
				run(
					other.parent,
					{},
					{ runId: "root-2", cwd: f.directory, store: createStore(), durableBackend: f.backend },
				),
			);
			assert.equal((await executions[1]!).status, "completed");
			assert.deepEqual(other.outcomes, ["completed", "completed"]);
			assert.deepEqual(
				f.claims().map(([claimer, , cwd]) => [claimer, cwd]),
				[
					["host-b", warm],
					["host-b", warm],
				],
				"the later root's children ran on the host's one worker",
			);
			assert.equal((await f.shared.stats("root")).ready, 1, "while the first root still waits for its tree");
		} finally {
			await host?.stop();
			await f.pool.close();
			await Promise.allSettled(executions);
			await second.close();
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host never runs more workers than maxWorkers, however many roots it could serve (#4310)",
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
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			const queue = await openSqlPoolQueue(journal);
			const shared = await SqlSharedPool.open(journal, queue);
			const digest = await definitionDigest(childPath);
			for (const root of ["first", "second", "third"]) {
				await journal.createRun({ runId: root, name: root, cwd: directory, createdAt: 0, status: "running" });
				const acquired = await journal.acquire(root, "root-holder");
				if (acquired.status !== "acquired") assert.fail(`no lease for ${root}`);
				await queue.initialize(acquired.lease, 60_000);
				await shared.publishConfig(acquired.lease, {
					definitions: [{ path: childPath, digest, exportName: "boundChild" }],
					leaseMs: 30_000,
					heartbeatMs: 7_500,
					startupTimeoutMs: 30_000,
					claimWindowMs: 60_000,
				});
			}
			host = await startWorkflowWorkerHost({
				journal: selection,
				agentDir: join(directory, "host", "agent"),
				maxWorkers: 2,
				restore: false,
				hostId: "host-b",
				workerEntry: stubWorker,
			});
			while ((await host.stats()).workers < 2) await sleep(25);
			// Several polls later, the third root still waits: two roots hold the host's two workers.
			await sleep(2_500);
			const stats = await host.stats();
			assert.deepEqual([stats.workers, stats.roots.length], [2, 2]);
			assert.equal(loggedStarts(log).length, 2, "no worker beyond maxWorkers was ever started");
		} finally {
			await host?.stop();
			await journal.close();
			vi.unstubAllEnvs();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a host giving workers to a root that starts later lets the child it holds finish first (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-yield-held", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const second = new LocalWorkerPool(f.backend, {
			rootId: "root-2",
			durable: poolDurableJournal(f.backend.journal),
			shared: { stateDirectory: join(f.directory, "root", "state-2"), host: "root-host", claimWindowMs: 60_000 },
			workspace: { ...binding, tree: "t2" },
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const first = await fanOut(1)(child as never);
		const other = await fanOut(2)(child as never);
		const executions = [
			run(first.parent, {}, { runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
		];
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
				maxWorkers: 2,
				restore: false,
				hostId: "host-b",
				workerEntry: stubWorker,
				placement: { prefer: async () => warm },
			});
			while (f.claims().length < 1) await sleep(25);
			const [[, held]] = f.claims() as [[string, string]];
			executions.push(
				run(
					other.parent,
					{},
					{ runId: "root-2", cwd: f.directory, store: createStore(), durableBackend: f.backend },
				),
			);
			// The first root's satellite drains: it takes no more work, and keeps the child its worker holds.
			await sleep(3_000);
			assert.deepEqual(
				f.claims().map(([, workId]) => workId),
				[held],
				"nothing is claimed while the host drains, and the held child is not given back",
			);
			writeFileSync(release, "");
			const results = await Promise.all(executions);
			assert.deepEqual(
				results.map((result) => result.status),
				["completed", "completed"],
			);
			assert.deepEqual(first.outcomes, ["completed"]);
			assert.deepEqual(other.outcomes, ["completed", "completed"]);
			const claimed = f.claims().map(([, workId]) => workId);
			assert.equal(claimed.length, 3);
			assert.equal(new Set(claimed).size, 3, "each child ran once");
		} finally {
			await host?.stop();
			writeFileSync(release, "");
			await Promise.allSettled(executions);
			await second.close();
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
