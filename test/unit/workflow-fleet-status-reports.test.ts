import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test, vi } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import type { PoolWork } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { readFleetRateUsage } from "../../packages/workflows/src/durable/journal/sql-rate-buckets.js";
import { readSharedPoolStats, SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import type { FleetRateLimits } from "../../packages/workflows/src/workers/fleet-rate-limits.js";
import { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
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

function checkpointOf(
	held: PoolWork,
	boundary: ReturnType<typeof poolWorkFixture>["boundary"],
	suffix: string,
	ordinal = 0,
): DurableToolCheckpoint {
	return {
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
}

async function rootCoordinator(
	directory: string,
	options: { readonly workers?: number; readonly rateLimits?: FleetRateLimits } = {},
) {
	const workers = options.workers ?? 1;
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const host = openCoordinator();
	await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "holder");
	if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
	await host.command({
		kind: "prepare",
		root: "root",
		lease: acquired.lease,
		options: {
			durable: poolDurableJournal(journal),
			shared: {
				stateDirectory,
				host: "host-a",
				claimWindowMs: 60_000,
				...(options.rateLimits === undefined ? {} : { rateLimits: options.rateLimits }),
			},
			workers,
			leaseMs: 60_000,
			heartbeatMs: 15_000,
			startupTimeoutMs: 30_000,
			workerEntry: "fake-worker",
		},
	});
	const starting = host.command({ kind: "start", sources: [SOURCE], cwd: directory, publish: false });
	while (forked.length < workers) await sleep(5);
	for (const worker of forked.slice(0, workers)) await worker.request({ kind: "ready" });
	await starting;
	const enqueue = async (id: string) => {
		const { work, boundary } = poolWorkFixture(id);
		await host.command({
			kind: "enqueue",
			descriptor: { ...work, definition: `${SOURCE.path}#${SOURCE.exportName}`, digest: SOURCE.digest },
			boundary,
		});
		return boundary;
	};
	return {
		host,
		journal,
		lease: acquired.lease,
		enqueue,
		async close() {
			await host.command({ kind: "close" });
			await host.coordinator.shutdown();
			await journal.close();
		},
	};
}

test("session appends advance a child's progress without counting another checkpoint, and a replay starts over (#4768)", async () => {
	const directory = makeTempDirectory("fleet-progress-session-");
	const root = await rootCoordinator(directory, { workers: 2 });
	const time = vi.spyOn(performance, "now");
	try {
		const boundary = await root.enqueue("session-progress");
		const [worker, replacement] = forked as [FakeWorker, FakeWorker];
		const held = (await worker.request({ kind: "claim" })).value as PoolWork;
		assert.ok(held);
		time.mockReturnValue(10_000);
		const created = await worker.request({
			kind: "commit",
			operation: "session-create",
			mutation: {
				kind: "session-create",
				checkpoint: {
					kind: "stage",
					workflowId: "root",
					checkpointId: `${held.scope}:session`,
					name: "stage",
					replayKey: `${held.scope}:stage`,
					sessionId: "session",
					completedAt: 0,
					topology: {
						version: 1,
						stageId: "stage",
						parentIds: [],
						sourceOrder: 0,
						run: boundary.topology!.boundary!.child,
					},
				},
				header: { id: "session", version: 4, createdAt: new Date(0).toISOString(), cwd: directory },
				entries: [],
			},
		});
		assert.equal(created.error, undefined);
		assert.deepEqual(root.host.coordinator.childProgress(12_000), [{ work: held.id, agoMs: 2_000, checkpoints: 1 }]);
		time.mockReturnValue(15_000);
		const appended = await worker.request({
			kind: "commit",
			operation: "session-append",
			mutation: {
				kind: "session-append",
				sessionId: "session",
				entries: [],
				expectSeq: 0,
			},
		});
		assert.equal(appended.error, undefined);
		assert.deepEqual(root.host.coordinator.childProgress(16_000), [{ work: held.id, agoMs: 1_000, checkpoints: 1 }]);
		const queue = await openSqlPoolQueue(root.journal);
		assert.equal(await queue.releaseExited(root.lease, held), true);
		const replay = (await replacement.request({ kind: "claim" })).value as PoolWork;
		assert.equal(replay.generation, held.generation + 1);
		assert.deepEqual(
			root.host.coordinator.childProgress(16_000),
			[],
			"an earlier attempt's progress is never reported as its replay's",
		);
		assert.equal((await worker.request({ kind: "fenced" })).error, undefined);
		const committed = await replacement.request({
			kind: "commit",
			operation: "replay-checkpoint",
			mutation: { kind: "checkpoint", checkpoint: checkpointOf(replay, boundary, "replayed") },
		});
		assert.equal(committed.error, undefined);
		assert.deepEqual(root.host.coordinator.childProgress(16_000), [
			{ work: replay.id, agoMs: 1_000, checkpoints: 1 },
		]);
	} finally {
		time.mockRestore();
		await root.close();
		removeTempDirectory(directory);
	}
});

test("a coordinator ends a worker's token wait when the request is released, its attempt ends or the worker exits (#4768)", async () => {
	const directory = makeTempDirectory("fleet-rate-release-");
	let now = 10_000;
	const time = vi.spyOn(performance, "now").mockImplementation(() => now);
	const root = await rootCoordinator(directory, {
		rateLimits: { p: { requestsPerMinute: 1, burst: 1, prefetch: 1 } },
	});
	try {
		const worker = forked[0]!;
		assert.equal(
			(await worker.request({ kind: "rate-acquire", provider: "p", model: "m", request: "burst" })).value,
			0,
		);
		assert.ok(
			((await worker.request({ kind: "rate-acquire", provider: "p", model: "m", request: "released" }))
				.value as number) > 10_000,
		);
		now = 11_000;
		assert.equal((await worker.request({ kind: "rate-release", request: "released" })).value, 0);
		now = 14_000;
		await root.enqueue("attempt-end");
		const held = (await worker.request({ kind: "claim" })).value as PoolWork;
		assert.ok(held);
		assert.ok(
			((await worker.request({ kind: "rate-acquire", provider: "p", model: "m", request: "attempt" }))
				.value as number) > 10_000,
		);
		now = 15_000;
		assert.equal(
			(
				await worker.request({
					kind: "complete",
					result: { runId: held.childRunId, status: "completed", stages: [], toolNodes: [] },
				})
			).error,
			undefined,
		);
		now = 19_000;
		assert.ok(
			((await worker.request({ kind: "rate-acquire", provider: "p", model: "m", request: "exited" }))
				.value as number) > 10_000,
		);
		now = 20_000;
		worker.exit(1);
		while (forked.length < 2) await sleep(5);
		await forked[1]!.request({ kind: "ready" });
		now = 26_000;
		await root.host.command({ kind: "close" });
		await root.host.coordinator.shutdown();
		assert.equal((await readFleetRateUsage(root.journal))[0]?.waitingMs, 3_000);
	} finally {
		time.mockRestore();
		await root.close();
		removeTempDirectory(directory);
	}
});

test("a root's coordinator forgets each child's progress once its attempt ends, though nothing asks it for progress (#4768)", async () => {
	const directory = makeTempDirectory("fleet-progress-lifecycle-");
	const root = await rootCoordinator(directory);
	try {
		const worker = forked[0]!;
		const commit = async (held: PoolWork, boundary: ReturnType<typeof poolWorkFixture>["boundary"], suffix: string) =>
			assert.equal(
				(
					await worker.request({
						kind: "commit",
						operation: `commit-${held.id}-${held.generation}-${suffix}`,
						mutation: { kind: "checkpoint", checkpoint: checkpointOf(held, boundary, suffix) },
					})
				).error,
				undefined,
			);
		for (let index = 0; index < 20; index++) {
			const boundary = await root.enqueue(`completed-${index}`);
			const held = (await worker.request({ kind: "claim" })).value as PoolWork;
			assert.ok(held);
			await commit(held, boundary, "a");
			const completed = await worker.request({
				kind: "complete",
				result: { runId: held.childRunId, status: "completed", stages: [], toolNodes: [] },
			});
			assert.equal(completed.error, undefined);
		}
		const boundary = await root.enqueue("fenced");
		const fenced = (await worker.request({ kind: "claim" })).value as PoolWork;
		assert.ok(fenced);
		await commit(fenced, boundary, "a");
		assert.equal((await worker.request({ kind: "fenced" })).error, undefined);
		const replay = (await worker.request({ kind: "claim" })).value as PoolWork;
		assert.deepEqual([replay?.id, replay?.generation], [fenced.id, fenced.generation + 1]);
		await commit(replay, boundary, "b");
		worker.exit(1);
		while (root.host.coordinator.heldWork().length > 0) await sleep(5);
		const retained = (
			root.host.coordinator as unknown as {
				progress: ReadonlyMap<string, { generation: number; at: number; checkpoints: number }>;
			}
		).progress;
		assert.deepEqual([...retained.keys()], [], "a coordinator keeps the progress of attempts that ended");
	} finally {
		await root.close();
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

test.skipIf(process.platform === "win32")(
	"a host combines shipping across roots and reports a catch-up change without waiting for its report interval (#4768)",
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
		const journal = await resolveRunJournal({ journal: selection, agentDir: join(directory, "root", "agent") });
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		const coordinators: PoolCoordinator[] = [];
		const states = [
			{ lagMs: 200, pending: 2, lagging: false },
			{ lagMs: 100, pending: 3, lagging: false },
		];
		const shipping = vi.spyOn(PoolCoordinator.prototype, "shippingStatus").mockImplementation(function (
			this: PoolCoordinator,
		) {
			let index = coordinators.indexOf(this);
			if (index < 0) {
				index = coordinators.length;
				coordinators.push(this);
			}
			return states[index];
		});
		const time = vi.spyOn(performance, "now").mockReturnValue(1_000);
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			const queue = await openSqlPoolQueue(journal);
			const shared = await SqlSharedPool.open(journal, queue);
			const definition = { path: childPath, exportName: "boundChild", digest: await definitionDigest(childPath) };
			for (const root of ["root-a", "root-b"]) {
				await journal.createRun({ runId: root, name: root, cwd: directory, createdAt: 0, status: "running" });
				const acquired = await journal.acquire(root, `${root}-holder`);
				if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
				await queue.initialize(acquired.lease, 60_000);
				await shared.publishConfig(acquired.lease, {
					definitions: [definition],
					leaseMs: 30_000,
					heartbeatMs: 7_500,
					startupTimeoutMs: 30_000,
					claimWindowMs: 60_000,
					checkpointShipping: SHIPPING,
				});
			}
			host = await startWorkflowWorkerHost({
				journal: selection,
				agentDir: join(directory, "host", "agent"),
				maxWorkers: 2,
				restore: false,
				hostId: "host",
				workerEntry: stubWorker,
			});
			const reported = async () =>
				(await readSharedPoolStats(journal, "root-a"))?.hosts.find((entry) => entry.host === "host")?.shipping;
			const until = async (check: () => Promise<boolean>) => {
				const deadline = Date.now() + 10_000;
				while (!(await check())) {
					assert.ok(Date.now() < deadline, "host did not report the shipping change");
					await sleep(20);
				}
			};
			await until(async () => (await reported())?.pending === 5);
			assert.deepEqual((await host.stats()).shipping, { lagMs: 200, pending: 5 });
			assert.deepEqual(await reported(), { lagMs: 200, pending: 5 });
			states[0]!.lagging = true;
			await until(async () => (await reported())?.lagging === true);
			assert.deepEqual((await host.stats()).shipping, { lagMs: 200, pending: 5, lagging: true });
			states[0]!.lagging = false;
			await until(async () => (await reported())?.lagging === undefined);
			assert.deepEqual(await reported(), { lagMs: 200, pending: 5 });
		} finally {
			await host?.stop();
			time.mockRestore();
			shipping.mockRestore();
			await journal.close();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host reports each child it runs, when it last stepped and its checkpoints, to fleet status (#4768)",
	async () => {
		const directory = makeLibsqlDirectory();
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", join(directory, "release"));
		vi.stubEnv("SHARED_POOL_STUB_CHECKPOINTS", "2");
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
			});
			const { work, boundary } = poolWorkFixture();
			await queue.enqueue(
				lease,
				{ ...work, definition: `${definition.path}#${definition.exportName}`, digest: definition.digest },
				boundary,
			);
			host = await startWorkflowWorkerHost({
				journal: selection,
				agentDir: join(directory, "host", "agent"),
				maxWorkers: 1,
				restore: false,
				hostId: "host-b",
				workerEntry: stubWorker,
			});
			const deadline = performance.now() + 30_000;
			const leased = async () => (await readSharedPoolStats(journal, "root"))?.leases[0];
			while ((await leased())?.checkpoints !== 2 && performance.now() < deadline) await sleep(50);
			const reported = await leased();
			assert.deepEqual(
				[reported?.host, reported?.childRunId, reported?.checkpoints],
				["host-b", work.childRunId, 2],
			);
			assert.ok(
				reported?.lastProgressAgoMs !== undefined && reported.lastProgressAgoMs >= 0,
				JSON.stringify(reported),
			);
		} finally {
			await host?.stop();
			await journal.close();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
