import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
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
	satellite,
	stubWorker,
} from "../helpers/workflow-shared-pool-coordinator.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

/** A worker host serves a root only while the root's lease is the one it attached to (#4310). */

test.skipIf(process.platform === "win32")(
	"a worker host serves only running roots whose lease is fresh, with the definitions it has (#4310)",
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
			const roots: Record<string, { path: string; digest: string }> = {
				good: { path: childPath, digest },
				stale: { path: childPath, digest },
				done: { path: childPath, digest },
				elsewhere: { path: join(directory, "not-on-this-host.ts"), digest },
				changed: { path: childPath, digest: "0".repeat(64) },
			};
			for (const [root, definition] of Object.entries(roots)) {
				await journal.createRun({ runId: root, name: root, cwd: directory, createdAt: 0, status: "running" });
				const acquired = await journal.acquire(root, "root-holder");
				if (acquired.status !== "acquired") assert.fail(`no lease for ${root}`);
				await queue.initialize(acquired.lease, 60_000);
				await shared.publishConfig(acquired.lease, {
					definitions: [{ ...definition, exportName: "boundChild" }],
					leaseMs: 30_000,
					heartbeatMs: 7_500,
					startupTimeoutMs: 30_000,
					claimWindowMs: 60_000,
				});
			}
			const storage = sqlPoolStorage(journal)!;
			await storage.transaction(async (tx) => {
				await tx.run(`UPDATE ${PREFIX}wf_leases SET renewed_at = 0 WHERE run_id = 'stale'`);
				await tx.run(`UPDATE ${PREFIX}wf_runs SET status = 'completed' WHERE run_id = 'done'`);
			});
			host = await startWorkflowWorkerHost({
				journal: selection,
				agentDir: join(directory, "host", "agent"),
				maxWorkers: 2,
				restore: false,
				hostId: "host-b",
				workerEntry: stubWorker,
			});
			for (;;) {
				const stats = await host.stats();
				if (stats.roots.length > 0 && stats.workers === 2) break;
				await sleep(25);
			}
			await sleep(2_500);
			const stats = await host.stats();
			assert.deepEqual(
				stats.roots.map((root) => root.root),
				["good"],
				"a dead, finished, foreign or changed root is not served",
			);
			assert.equal(stats.workers, 2, "the one root it serves gets every worker");
			const hostStarts = () =>
				loggedStarts(log).filter((start) => (start.shared as { host: string }).host === "host-b");
			assert.equal(hostStarts().length, 2, "a root it keeps serving is not attached again");
			// The host reports itself when its workers change, then every few seconds: never on every poll.
			const registered = async () => (await shared.registeredHosts()).find((entry) => entry.host === "host-b")!;
			assert.equal((await registered()).workers, 2);
			let resets = 0;
			let previous = (await registered()).heartbeatAgoMs;
			for (const deadline = performance.now() + 6_000; performance.now() < deadline; ) {
				await sleep(200);
				const ago = (await registered()).heartbeatAgoMs;
				if (ago < previous) resets++;
				previous = ago;
			}
			assert.ok(resets >= 1 && resets <= 2, `${resets} reports in 6 s`);
			// Another incarnation takes the root's lease: the host lets go of the old one, and serves the new one once it
			// published its own settings.
			const state = (await journal.leaseState("good"))!;
			const resumed = await journal.takeover("good", "next-incarnation", state.holderId);
			if (resumed.status !== "acquired") assert.fail("no takeover");
			while ((await host.stats()).roots.length > 0) await sleep(25);
			await sleep(2_500);
			assert.equal(hostStarts().length, 2, "an incarnation that published nothing yet is not served");
			await shared.publishConfig(resumed.lease, {
				definitions: [{ ...roots.good!, exportName: "boundChild" }],
				leaseMs: 30_000,
				heartbeatMs: 7_500,
				startupTimeoutMs: 30_000,
				claimWindowMs: 60_000,
			});
			while (hostStarts().length < 4) await sleep(25);
			assert.deepEqual(
				(await host.stats()).roots.map((root) => root.root),
				["good"],
			);
			// A paused root keeps its host's workers, and their sessions with it, until it resumes or ends.
			const startsBeforePause = hostStarts().length;
			await storage.transaction((tx) =>
				tx.run(`UPDATE ${PREFIX}wf_runs SET status = 'paused' WHERE run_id = 'good'`),
			);
			await sleep(2_500);
			assert.deepEqual(
				(await host.stats()).roots.map((root) => root.root),
				["good"],
			);
			assert.equal(hostStarts().length, startsBeforePause, "pausing does not stop the host's workers");
			// A root that ended is let go even before its lease is released.
			await storage.transaction((tx) =>
				tx.run(`UPDATE ${PREFIX}wf_runs SET status = 'completed' WHERE run_id = 'good'`),
			);
			while ((await host.stats()).roots.length > 0) await sleep(25);
			assert.equal((await host.stats()).workers, 0);
			await host.stop();
			assert.deepEqual(await shared.registeredHosts(), [], "a stopped host leaves the registry");
		} finally {
			await host?.stop();
			await journal.close();
			vi.unstubAllEnvs();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a host stops serving a root whose lease another incarnation took, says why, and puts nothing back (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-lease-lost", { workspace: binding });
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
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			const reasons: Error[] = [];
			host = await satellite(f, root, { prefer: async () => warm }, reasons);
			while (f.claims().length === 0) await sleep(25);
			const held = (await f.shared.stats("root")).leases;
			assert.equal(held.length, 1);
			const state = (await f.hostJournal.leaseState("root"))!;
			const taken = await f.hostJournal.takeover("root", "next-incarnation", state.holderId);
			assert.equal(taken.status, "acquired");
			while (!host.detached) await sleep(25);
			assert.ok(
				reasons.some((reason) => reason.name === "StaleLeaseError"),
				reasons.map(String).join("; "),
			);
			// Stopping puts nothing back: the root's next incarnation owns the work now.
			await host.stopSatellite();
			const after = await f.shared.stats("root");
			assert.deepEqual(
				after.leases.map((lease) => [lease.work, lease.generation]),
				held.map((lease) => [lease.work, lease.generation]),
			);
		} finally {
			writeFileSync(release, "");
			await host?.stopSatellite().catch(() => {});
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
