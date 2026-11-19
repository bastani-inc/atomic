import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { RateBucketUsage } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { readSharedPoolStats, SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { Lease, RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import type { ProvisionedHost, WorkerHostProvisioner } from "../../packages/workflows/src/workers/autoscaler.js";
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import {
	startWorkflowFleetController,
	type WorkflowFleetController,
} from "../../packages/workflows/src/workers/fleet-controller.js";
import { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { readWorkflowWorkerFleet, startWorkflowWorkerHost } from "../../packages/workflows/src/workers/worker-host.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { sleep } from "../helpers/runtime.js";
import { childPath } from "../helpers/workflow-shared-pool-coordinator.js";

const usage = vi.hoisted(() => ({ next: (): RateBucketUsage[] => [] }));

vi.mock("../../packages/workflows/src/durable/journal/sql-rate-buckets.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/workflows/src/durable/journal/sql-rate-buckets.js")>()),
	readFleetRateUsage: async () => usage.next(),
}));

const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const TICK_MS = 100;
const STEP_MS = 30_000;
const LIMIT_PER_MINUTE = 600;

let directory: string;
const journals: RunJournal[] = [];
const controllers: WorkflowFleetController[] = [];
beforeEach(() => {
	directory = makeLibsqlDirectory();
});
afterEach(async () => {
	await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
	await Promise.all(journals.splice(0).map((journal) => journal.close()));
	await removeLibsqlDirectory(directory);
	usage.next = () => [];
});

function selection() {
	return { adapter: libsql, options: { url: pathToFileURL(join(directory, "shared.db")).href }, prefix: "acme_" };
}

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

function bucketReadings(perStep: () => number) {
	let step = 0;
	let acquired = 0;
	return () => {
		acquired += step === 0 ? 0 : perStep();
		const reading = {
			scope: "anthropic",
			acquired,
			waitingMs: 0,
			intervalMs: 60_000 / LIMIT_PER_MINUTE,
			now: 1_800_000_000_000 + step * STEP_MS,
		};
		step++;
		return [reading];
	};
}

test.skipIf(process.platform === "win32")(
	"fleet reads retain rate history only when requested, hold startup growth and cap subsequent scaling (#4768)",
	async () => {
		const journal = await resolveRunJournal({ journal: selection(), agentDir: join(directory, "agent") });
		journals.push(journal);
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "owner");
		if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
		const queue = await openSqlPoolQueue(journal);
		await queue.initialize(acquired.lease, 60_000);
		const shared = await SqlSharedPool.open(journal, queue);
		await shared.publishConfig(acquired.lease, {
			definitions: [],
			leaseMs: 60_000,
			heartbeatMs: 15_000,
			startupTimeoutMs: 60_000,
			claimWindowMs: 60_000,
			rateLimits: { anthropic: { requestsPerMinute: LIMIT_PER_MINUTE } },
		});
		for (let index = 0; index < 40; index++) {
			const { work, boundary } = poolWorkFixture(`child-${index}`);
			await queue.enqueue(acquired.lease, work, boundary);
		}
		for (let slot = 0; slot < 4; slot++) {
			const work = await queue.claim(acquired.lease, `h/w${slot}`, [poolWorkFixture().work], 60_000);
			assert.ok(work);
			await queue.heartbeat(acquired.lease, work, 60_000, async () => {});
		}
		await shared.reportHost({
			host: "h",
			labels: {},
			git: "unavailable",
			restore: false,
			workers: 4,
			maxWorkers: 4,
			roots: ["root"],
			busy: 4,
		});
		await shared.reportHost({
			host: "h-draining",
			labels: {},
			git: "unavailable",
			restore: false,
			workers: 4,
			maxWorkers: 4,
			roots: ["root"],
			busy: 0,
			draining: true,
		});
		await shared.reportHost({
			host: "h-stale",
			labels: {},
			git: "unavailable",
			restore: false,
			workers: 4,
			maxWorkers: 4,
			roots: ["root"],
			busy: 0,
		});
		await sqlPoolStorage(journal)!.transaction((tx) =>
			tx.run("UPDATE acme_wf_runs_pool_hosts SET heartbeat_at = heartbeat_at - 60000 WHERE host = 'h-stale'"),
		);
		usage.next = bucketReadings(() => LIMIT_PER_MINUTE / 4);
		const options = {
			journal: selection(),
			agentDir: join(directory, "reader"),
			probeWrites: false,
			policy: { workersPerHost: 4, maxHosts: 20 },
		};
		const first = await readWorkflowWorkerFleet({ ...options, rateHistory: true });
		assert.deepEqual(
			[first.scaling?.desiredHosts, first.scaling?.rateCapHosts],
			[1, 1],
			"a cold metrics reader holds growth at the live non-draining host count until its history matures",
		);
		await readWorkflowWorkerFleet({ ...options, rateHistory: true });
		const warm = await readWorkflowWorkerFleet({ ...options, rateHistory: true });
		assert.deepEqual([warm.scaling?.desiredHosts, warm.scaling?.rateCapHosts], [2, 2]);
		const plain = await readWorkflowWorkerFleet(options);
		assert.equal(plain.scaling?.desiredHosts, 10, "a one-shot status read does not apply the process's history");
		assert.equal(plain.scaling?.rateCapHosts, undefined);
	},
);

test.skipIf(process.platform === "win32")(
	"a fleet controller adds no host the fleet-wide rate limits cannot feed, records why, and grows once they can (#4768, #5673)",
	async ({ onTestFinished }) => {
		const journal = await resolveRunJournal({ journal: selection(), agentDir: join(directory, "agent") });
		journals.push(journal);
		await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
		const lease = ((await journal.acquire("root", "coordinator")) as { lease: Lease }).lease;
		const queue = await openSqlPoolQueue(journal);
		await queue.initialize(lease, 60_000);
		const shared = await SqlSharedPool.open(journal, queue);
		await shared.publishConfig(lease, {
			definitions: [],
			leaseMs: 60_000,
			heartbeatMs: 15_000,
			startupTimeoutMs: 60_000,
			claimWindowMs: 60_000,
			rateLimits: { anthropic: { requestsPerMinute: LIMIT_PER_MINUTE } },
		});
		for (let index = 0; index < 24; index++) {
			const { work, boundary } = poolWorkFixture(`child-${index}`);
			await queue.enqueue(lease, work, boundary);
		}
		const definition = { definition: poolWorkFixture().work.definition, digest: poolWorkFixture().work.digest };
		for (let worker = 1; worker <= 4; worker++) {
			const work = await queue.claim(lease, `h1/worker-${worker}`, [definition], 60_000);
			assert.ok(work);
			await queue.heartbeat(lease, work, 60_000, async () => {});
		}
		await shared.reportHost({
			host: "h1",
			labels: {},
			git: "unavailable",
			restore: false,
			workers: 4,
			maxWorkers: 4,
			roots: ["root"],
			busy: 4,
			providerId: "vm-1",
		});
		const store = await SqlFleetStore.open(journal);
		const seeded = await store.acquire("seed", undefined, 60_000);
		if (!seeded.held) assert.fail("seed controller lease was not acquired");
		await store.carryDrain({ holder: "seed", epoch: seeded.epoch }, "h-draining", "vm-draining");
		await store.release({ holder: "seed", epoch: seeded.epoch });
		usage.next = bucketReadings(() => LIMIT_PER_MINUTE / 2);
		const hosts: ProvisionedHost[] = [
			{ id: "vm-1", state: "running", since: 0 },
			{ id: "vm-draining", state: "running", since: 0 },
			{ id: "vm-provider-draining", state: "draining", since: 0 },
			{ id: "vm-failed", state: "failed", since: 0 },
			{ id: "vm-stopped", state: "stopped", since: 0 },
		];
		const targets: number[] = [];
		const scaled = Promise.withResolvers<void>();
		const provisioner: WorkerHostProvisioner = {
			kind: "fake",
			async list() {
				return [...hosts];
			},
			async scaleTo(target) {
				targets.push(target);
				scaled.resolve();
				while (hosts.length < target)
					hosts.push({ id: `vm-${hosts.length + 1}`, state: "pending", since: Date.now() });
			},
			async drain(id) {
				const index = hosts.findIndex((host) => host.id === id);
				if (index >= 0) hosts.splice(index, 1);
			},
		};
		// Run the next scheduled pass without charging time spent waiting for real journal I/O to its lease.
		vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
		vi.setTimerTickMode("nextTimerAsync");
		onTestFinished(() => {
			vi.useRealTimers();
		});
		const running = await startWorkflowFleetController({
			journal: selection(),
			agentDir: join(directory, "controller"),
			provisioner,
			tickMs: TICK_MS,
			workersPerHost: 4,
			scaleUpQueueDepth: 0,
			scaleUpDelayMs: TICK_MS,
		});
		controllers.push(running);
		// The warm-up and measured cap are recorded on different passes, beyond the one-tick growth delay.
		await until(
			"the measured rate cap",
			async () => (await store.recent(20)).filter((e) => e.kind === "rate-cap").length >= 2,
		);
		assert.deepEqual(targets, [], "a saturated limit holds the fleet at the hosts it feeds");
		assert.deepEqual([running.status().target, running.status().rateCapHosts], [1, 1]);
		const capped = (await store.recent(20)).filter((event) => event.kind === "rate-cap");
		assert.deepEqual(
			capped.map((event) => [event.target, event.live]),
			[
				[1, 1],
				[1, 1],
			],
		);
		assert.match(
			capped[1]!.reason,
			/^rate limit anthropic \(600\/min\) granted 600\/min with 4 nonwaiting workers out of 4 busy over the last 60 seconds: the fleet can use at most 1 hosts including other scopes, while the queue wants 6$/,
		);
		assert.deepEqual(
			(await readSharedPoolStats(journal, "root"))?.fleet.scaleEvents?.find((event) => event.kind === "rate-cap")
				?.reason,
			capped[1]!.reason,
		);

		usage.next = bucketReadings(() => LIMIT_PER_MINUTE / 20);
		await scaled.promise;
		assert.deepEqual(targets, [6]);
		await until("the cap's release to be recorded", async () =>
			(await store.recent(20)).some(
				(event) =>
					event.kind === "rate-cap" &&
					event.reason === "the rate limits no longer hold the fleet below what its queue wants",
			),
		);
	},
);

test.skipIf(process.platform === "win32")(
	"a worker host strips URL credentials from its shipping error before reporting to the registry or stats (#4768)",
	async () => {
		const journal = await resolveRunJournal({ journal: selection(), agentDir: join(directory, "agent") });
		journals.push(journal);
		const queue = await openSqlPoolQueue(journal);
		const shared = await SqlSharedPool.open(journal, queue);
		const definition = { path: childPath, exportName: "boundChild", digest: await definitionDigest(childPath) };
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "owner");
		if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
		await queue.initialize(acquired.lease, 60_000);
		await shared.publishConfig(acquired.lease, {
			definitions: [definition],
			leaseMs: 30_000,
			heartbeatMs: 7_500,
			startupTimeoutMs: 30_000,
			claimWindowMs: 60_000,
			checkpointShipping: { intervalMs: 60_000, maxBatch: 64, maxLagMs: 600_000 },
		});
		const attach = vi.spyOn(PoolCoordinator.prototype, "attachSatellite").mockResolvedValue(undefined);
		const shipping = vi.spyOn(PoolCoordinator.prototype, "shippingStatus").mockReturnValue({
			lagMs: 120,
			pending: 2,
			lagging: true,
			error: Object.assign(new Error("fetch libsql://me:pw@db.example/x?authToken=s3cret failed"), {
				name: "StorageError",
			}),
		});
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			host = await startWorkflowWorkerHost({
				journal: selection(),
				agentDir: join(directory, "host"),
				maxWorkers: 1,
				restore: false,
				hostId: "h-ship",
			});
			const expected = {
				lagMs: 120,
				pending: 2,
				lagging: true,
				error: { name: "StorageError", message: "fetch libsql://db.example/x failed" },
			};
			const rawShipping = async () => {
				const row = await sqlPoolStorage(journal)!.read((executor) =>
					executor.get<{ shipping: string | null }>(
						"SELECT shipping FROM acme_wf_runs_pool_hosts WHERE host = 'h-ship'",
					),
				);
				return row?.shipping ? (JSON.parse(row.shipping) as typeof expected) : undefined;
			};
			await until("the host to report its redacted shipping error", async () => (await rawShipping()) !== undefined);
			assert.deepEqual(await rawShipping(), expected);
			assert.deepEqual((await host.stats()).shipping, expected);
		} finally {
			await host?.stop();
			shipping.mockRestore();
			attach.mockRestore();
		}
	},
);
