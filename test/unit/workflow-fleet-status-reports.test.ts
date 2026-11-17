import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test, vi } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import type { PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { readSharedPoolStats, SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import { poolDurableJournal } from "../../packages/workflows/src/workers/pool-journal.js";
import type { FakeWorker } from "../helpers/fake-pool-worker.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { openCoordinator, SOURCE } from "../helpers/pool-coordinator.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import {
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	libsql,
	PREFIX,
	stubWorker,
} from "../helpers/workflow-shared-pool-coordinator.js";

const forked = vi.hoisted((): FakeWorker[] => []);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { FakeWorker } = await import("../helpers/fake-pool-worker.js");
	return {
		...actual,
		fork(modulePath: string, args: readonly string[], options: ForkOptions) {
			if (modulePath !== "fake-worker") return actual.fork(modulePath, args, options);
			const worker = new FakeWorker(6_100_000 + forked.length, args, options);
			forked.push(worker);
			return worker;
		},
	};
});

afterEach(() => {
	forked.length = 0;
	vi.unstubAllEnvs();
});

const SHIPPING = { intervalMs: 60_000, maxBatch: 64, maxLagMs: 600_000 } as const;

test("a host coordinator reports how far its checkpoint shipping lags and each held child's last step and checkpoints (#4768)", async () => {
	const directory = makeTempDirectory("fleet-status-reports-");
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const host = openCoordinator();
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "holder");
		if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
		await host.command({
			kind: "prepare",
			root: "root",
			lease: acquired.lease,
			options: {
				durable: poolDurableJournal(journal),
				shared: { stateDirectory, host: "host-a", claimWindowMs: 60_000, checkpointShipping: SHIPPING },
				workers: 1,
				leaseMs: 60_000,
				heartbeatMs: 15_000,
				startupTimeoutMs: 30_000,
				workerEntry: "fake-worker",
			},
		});
		const starting = host.command({ kind: "start", sources: [SOURCE], cwd: directory, publish: false });
		while (forked.length === 0) await sleep(5);
		const worker = forked[0]!;
		await worker.request({ kind: "ready" });
		await starting;
		assert.deepEqual(host.coordinator.shippingStatus(), { pending: 0, lagMs: 0, lagging: false });
		assert.deepEqual(host.coordinator.childProgress(), []);
		const { work, boundary } = poolWorkFixture();
		await host.command({
			kind: "enqueue",
			descriptor: { ...work, definition: `${SOURCE.path}#${SOURCE.exportName}`, digest: SOURCE.digest },
			boundary,
		});
		const held = (await worker.request({ kind: "claim" })).value as PoolWork;
		assert.ok(held);
		const before = performance.now();
		for (const [ordinal, suffix] of ["a", "b"].entries()) {
			const checkpoint: DurableToolCheckpoint = {
				kind: "tool",
				name: `tool-${suffix}`,
				output: {},
				workflowId: "root",
				checkpointId: `${held.scope}:${suffix}`,
				argsHash: `${held.scope}:args-${suffix}`,
				completedAt: ordinal + 1,
				topology: {
					version: 1,
					nodeId: `tool-${suffix}`,
					ordinal,
					order: ordinal,
					parentIds: [],
					run: boundary.topology!.boundary!.child,
				},
			};
			const committed = await worker.request({
				kind: "commit",
				operation: `commit-${suffix}`,
				mutation: { kind: "checkpoint", checkpoint },
			});
			assert.equal(committed.error, undefined);
		}
		await sleep(30);
		const now = performance.now();
		const [progress, ...others] = host.coordinator.childProgress(now);
		assert.deepEqual(others, []);
		assert.equal(progress?.work, held.id);
		assert.equal(progress?.checkpoints, 2);
		assert.ok(
			progress !== undefined && progress.agoMs >= 25 && progress.agoMs <= now - before,
			String(progress?.agoMs),
		);
		const shipping = host.coordinator.shippingStatus();
		assert.deepEqual({ pending: shipping?.pending, lagging: shipping?.lagging }, { pending: 2, lagging: false });
		assert.ok(shipping !== undefined && shipping.lagMs >= 25, String(shipping?.lagMs));
	} finally {
		await host.command({ kind: "close" });
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
});

test.skipIf(process.platform === "win32")(
	"a worker host reports its checkpoint shipping to the registry and in its stats while a root it serves ships checkpoints (#4768)",
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
			const definition = { path: childPath, exportName: "boundChild", digest: await definitionDigest(childPath) };
			await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
			const acquired = await journal.acquire("root", "root-holder");
			if (acquired.status !== "acquired") assert.fail("no lease for the root");
			const lease: Lease = acquired.lease;
			await queue.initialize(lease, 60_000);
			await shared.publishConfig(lease, {
				definitions: [definition],
				leaseMs: 30_000,
				heartbeatMs: 7_500,
				startupTimeoutMs: 30_000,
				claimWindowMs: 60_000,
				checkpointShipping: SHIPPING,
			});
			host = await startWorkflowWorkerHost({
				journal: selection,
				agentDir: join(directory, "host", "agent"),
				maxWorkers: 1,
				restore: false,
				hostId: "host-b",
				workerEntry: stubWorker,
			});
			const deadline = performance.now() + 30_000;
			const reported = async () =>
				(await readSharedPoolStats(journal, "root"))?.hosts.find((entry) => entry.host === "host-b")?.shipping;
			while ((await reported()) === undefined && performance.now() < deadline) await sleep(50);
			assert.deepEqual(await reported(), { lagMs: 0, pending: 0 });
			assert.deepEqual((await host.stats()).shipping, { lagMs: 0, pending: 0 });
		} finally {
			await host?.stop();
			await journal.close();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
