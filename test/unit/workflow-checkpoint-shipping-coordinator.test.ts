import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import {
	checkpointKey,
	openSqlPoolQueue,
	type PoolWork,
	SqlPoolQueue,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { DurableStageCheckpoint, DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import { durableJournalIdentity, poolDurableJournal } from "../../packages/workflows/src/workers/pool-journal.js";
import { ShipShard, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import type { FakeWorker } from "../helpers/fake-pool-worker.js";
import { openCoordinator, SOURCE } from "../helpers/pool-coordinator.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const forked = vi.hoisted((): FakeWorker[] => []);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { FakeWorker } = await import("../helpers/fake-pool-worker.js");
	return {
		...actual,
		fork(_modulePath: string, args: readonly string[], options: ForkOptions) {
			const worker = new FakeWorker(4_000_000 + forked.length, args, options);
			forked.push(worker);
			return worker;
		},
	};
});

afterEach(() => {
	forked.length = 0;
});

test.each(["not a directory", "already open"] as const)(
	"a host whose local journal cannot open (%s) starts its pool and commits checkpoints directly (#4768)",
	async (failure) => {
		const directory = makeTempDirectory("shipping-startup-");
		const stateDirectory = join(directory, "state");
		mkdirSync(stateDirectory);
		if (failure === "not a directory") writeFileSync(join(stateDirectory, "ship"), "not a directory");
		const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
		const host = openCoordinator();
		let owner: ShipShard | undefined;
		try {
			if (failure === "already open")
				owner = await ShipShard.open(
					shipShardPath(stateDirectory, durableJournalIdentity(poolDurableJournal(journal)!), "root"),
					"root",
				);
			await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
			const acquired = await journal.acquire("root", "holder");
			assert.equal(acquired.status, "acquired");
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
						checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 },
					},
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
			const { work, boundary } = poolWorkFixture();
			await host.command({
				kind: "enqueue",
				descriptor: { ...work, definition: `${SOURCE.path}#${SOURCE.exportName}`, digest: SOURCE.digest },
				boundary,
			});
			const claim = await worker.request({ kind: "claim" });
			assert.equal(claim.error, undefined);
			const held = claim.value as PoolWork;
			assert.ok(held);
			for (const suffix of ["a", "b"]) {
				const checkpoint: DurableToolCheckpoint = {
					kind: "tool",
					name: `tool-${suffix}`,
					output: {},
					workflowId: "root",
					checkpointId: `${held.scope}:${suffix}`,
					argsHash: `${held.scope}:args-${suffix}`,
					completedAt: 1,
					topology: {
						version: 1,
						nodeId: `tool-${suffix}`,
						ordinal: suffix === "a" ? 0 : 1,
						order: suffix === "a" ? 0 : 1,
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
				assert.ok(committed.value);
				assert.ok(await journal.readKey("root", checkpointKey(checkpoint)));
			}
			const health = host.events.filter((event) => event.kind === "health");
			assert.equal(health.length, 1);
			assert.match(health[0]!.message, /checkpoint shipping.*local journal.*shared journal/);
		} finally {
			await host.command({ kind: "close" });
			await host.coordinator.shutdown();
			await journal.close();
			await owner?.close();
			removeTempDirectory(directory);
		}
	},
);

test("closing while the checkpoint shard opens releases its ownership before the pool finishes preparing (#4768)", async () => {
	const directory = makeTempDirectory("shipping-open-close-");
	const stateDirectory = join(directory, "state");
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const host = openCoordinator();
	const opened = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const open = ShipShard.open.bind(ShipShard);
	let owner: ShipShard | undefined;
	let shardPath: string | undefined;
	const opening = vi.spyOn(ShipShard, "open").mockImplementation(async (...args) => {
		owner = await open(...args);
		shardPath = args[0];
		opened.resolve();
		await release.promise;
		return owner;
	});
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "holder");
		assert.equal(acquired.status, "acquired");
		if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
		const preparing = host.command({
			kind: "prepare",
			root: "root",
			lease: acquired.lease,
			options: {
				durable: poolDurableJournal(journal),
				shared: {
					stateDirectory,
					host: "host-a",
					claimWindowMs: 60_000,
					checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 },
				},
				workers: 1,
				leaseMs: 60_000,
				heartbeatMs: 15_000,
				startupTimeoutMs: 30_000,
				workerEntry: "fake-worker",
			},
		});
		const settled = Promise.allSettled([preparing]);
		await opened.promise;
		await host.command({ kind: "close" });
		release.resolve();
		await settled;
		assert.ok(shardPath !== undefined);
		const replacement = await open(shardPath, "root");
		await replacement.close();
	} finally {
		release.resolve();
		opening.mockRestore();
		await owner?.close();
		await host.command({ kind: "close" });
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
});

function toolCheckpoint(
	held: PoolWork,
	child: NonNullable<NonNullable<ReturnType<typeof poolWorkFixture>["boundary"]["topology"]>["boundary"]>["child"],
	suffix: string,
	ordinal: number,
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
			run: child,
		},
	};
}

function billedStageCheckpoint(
	held: PoolWork,
	child: NonNullable<NonNullable<ReturnType<typeof poolWorkFixture>["boundary"]["topology"]>["boundary"]>["child"],
	suffix: string,
	ordinal: number,
): DurableStageCheckpoint {
	return {
		kind: "stage",
		name: `stage-${suffix}`,
		output: "done",
		workflowId: "root",
		checkpointId: `${held.scope}:stage-${suffix}`,
		replayKey: `${held.scope}:stage-${suffix}`,
		startedAt: ordinal,
		completedAt: ordinal + 1,
		modelAttempts: [
			{
				model: "m",
				success: true,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: 0,
				},
			},
		],
		topology: {
			version: 1,
			stageId: `${held.scope}:stage-${suffix}`,
			parentIds: [],
			sourceOrder: ordinal,
			status: "completed",
			run: child,
		},
	};
}

test("renewing an attempt after a late root lease renewal refreshes its local checkpoint lease (#4768)", async () => {
	const directory = makeTempDirectory("shipping-late-root-");
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const host = openCoordinator();
	const leaseMs = 2_000;
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "holder");
		assert.equal(acquired.status, "acquired");
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
					checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 },
				},
				workers: 1,
				leaseMs,
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
		const { work, boundary } = poolWorkFixture();
		const child = boundary.topology!.boundary!.child;
		await host.command({
			kind: "enqueue",
			descriptor: { ...work, definition: `${SOURCE.path}#${SOURCE.exportName}`, digest: SOURCE.digest },
			boundary,
		});
		const claim = await worker.request({ kind: "claim" });
		assert.equal(claim.error, undefined);
		const held = claim.value as PoolWork;
		const c0 = await worker.request({
			kind: "commit",
			operation: "commit-c0",
			mutation: { kind: "checkpoint", checkpoint: toolCheckpoint(held, child, "c0", 0) },
		});
		assert.equal(c0.error, undefined);
		assert.equal((c0.value as { local?: boolean }).local, true);
		await sqlPoolStorage(journal)!.transaction((tx) =>
			tx.run("UPDATE wf_leases SET renewed_at = renewed_at - 200000 WHERE run_id = ?", "root"),
		);
		const pendingC1 = worker.request({
			kind: "commit",
			operation: "commit-c1",
			mutation: { kind: "checkpoint", checkpoint: billedStageCheckpoint(held, child, "c1", 1) },
		});
		await sleep(leaseMs + 600);
		await journal.renew(acquired.lease);
		const c1 = await pendingC1;
		assert.equal(c1.error, undefined);
		const c2 = await worker.request({
			kind: "commit",
			operation: "commit-c2",
			mutation: { kind: "checkpoint", checkpoint: toolCheckpoint(held, child, "c2", 2) },
		});
		assert.equal(c2.error, undefined);
		assert.equal((c2.value as { local?: boolean }).local, true);
		assert.equal(await journal.readKey("root", checkpointKey(toolCheckpoint(held, child, "c2", 2))), undefined);
		const flushed = await worker.request({ kind: "controlled", revision: 0 });
		assert.equal(flushed.error, undefined);
		assert.ok(await journal.readKey("root", checkpointKey(toolCheckpoint(held, child, "c0", 0))));
		assert.ok(await journal.readKey("root", checkpointKey(billedStageCheckpoint(held, child, "c1", 1))));
		assert.ok(await journal.readKey("root", checkpointKey(toolCheckpoint(held, child, "c2", 2))));
	} finally {
		await host.command({ kind: "close" });
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
});

test("a shippable checkpoint whose local lease expired while the attempt still owns its work renews and commits (#4768)", async () => {
	const directory = makeTempDirectory("shipping-local-expired-");
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const host = openCoordinator();
	const leaseMs = 2_000;
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "holder");
		assert.equal(acquired.status, "acquired");
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
					checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 },
				},
				workers: 1,
				leaseMs,
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
		const { work, boundary } = poolWorkFixture();
		const child = boundary.topology!.boundary!.child;
		await host.command({
			kind: "enqueue",
			descriptor: { ...work, definition: `${SOURCE.path}#${SOURCE.exportName}`, digest: SOURCE.digest },
			boundary,
		});
		const claim = await worker.request({ kind: "claim" });
		assert.equal(claim.error, undefined);
		const held = claim.value as PoolWork;
		const pinnedWallClock = Date.now();
		await sleep(leaseMs + 200);
		const dateSpy = vi.spyOn(Date, "now").mockReturnValue(pinnedWallClock);
		try {
			const c0 = await worker.request({
				kind: "commit",
				operation: "commit-c0",
				mutation: { kind: "checkpoint", checkpoint: toolCheckpoint(held, child, "c0", 0) },
			});
			assert.equal(c0.error, undefined);
			assert.equal((c0.value as { local?: boolean }).local, true);
		} finally {
			dateSpy.mockRestore();
		}
		assert.equal(await journal.readKey("root", checkpointKey(toolCheckpoint(held, child, "c0", 0))), undefined);
		const flushed = await worker.request({ kind: "controlled", revision: 0 });
		assert.equal(flushed.error, undefined);
		assert.ok(await journal.readKey("root", checkpointKey(toolCheckpoint(held, child, "c0", 0))));
	} finally {
		await host.command({ kind: "close" });
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
});

test("fencing or handing off an attempt releases its sync-only fallback so the next attempt ships locally again (#4768)", async () => {
	const directory = makeTempDirectory("shipping-fence-release-");
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const host = openCoordinator();
	const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
	const acceptSpy = vi.spyOn(ShipShard.prototype, "accept");
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "holder");
		assert.equal(acquired.status, "acquired");
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
					checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 },
				},
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
		const { work, boundary } = poolWorkFixture();
		const child = boundary.topology!.boundary!.child;
		await host.command({
			kind: "enqueue",
			descriptor: { ...work, definition: `${SOURCE.path}#${SOURCE.exportName}`, digest: SOURCE.digest },
			boundary,
		});
		const claim1 = await worker.request({ kind: "claim" });
		assert.equal(claim1.error, undefined);
		const gen1 = claim1.value as PoolWork;
		assert.equal(gen1.generation, 1);
		acceptSpy.mockRejectedValueOnce(new Error("ENOSPC gen 1"));
		const c0 = await worker.request({
			kind: "commit",
			operation: "commit-c0",
			mutation: { kind: "checkpoint", checkpoint: toolCheckpoint(gen1, child, "c0", 0) },
		});
		assert.equal(c0.error, undefined);
		const healthAfterGen1 = host.events.filter((event) => event.kind === "health");
		assert.equal(healthAfterGen1.length, 1);
		assert.match(healthAfterGen1[0]!.message, /ENOSPC gen 1/);
		const local = acceptSpy.mock.contexts[0] as ShipShard;
		const handoff = await worker.request({ kind: "fenced", handoff: true });
		assert.equal(handoff.error, undefined);
		await assert.rejects(
			local.accept("root", { ...gen1, worker: gen1.worker! }, "after-handoff", "{}", 1),
			(error: Error) => error instanceof StaleWorkLeaseError && error.reason === "missing",
		);
		const claim2 = await worker.request({ kind: "claim" });
		assert.equal(claim2.error, undefined);
		const gen2 = claim2.value as PoolWork;
		assert.equal(gen2.generation, 2);
		const acceptsBeforeGen2 = acceptSpy.mock.calls.length;
		const c1 = await worker.request({
			kind: "commit",
			operation: "commit-c1",
			mutation: { kind: "checkpoint", checkpoint: toolCheckpoint(gen2, child, "c1", 1) },
		});
		assert.equal(c1.error, undefined);
		assert.equal(acceptSpy.mock.calls.length, acceptsBeforeGen2 + 1);
		acceptSpy.mockRejectedValueOnce(new Error("ENOSPC gen 2"));
		const c2 = await worker.request({
			kind: "commit",
			operation: "commit-c2",
			mutation: { kind: "checkpoint", checkpoint: toolCheckpoint(gen2, child, "c2", 2) },
		});
		assert.equal(c2.error, undefined);
		const healthAfterGen2 = host.events.filter((event) => event.kind === "health");
		assert.equal(healthAfterGen2.length, 2);
		assert.match(healthAfterGen2[1]!.message, /ENOSPC gen 2/);
		const fenced = await worker.request({ kind: "fenced" });
		assert.equal(fenced.error, undefined);
		await assert.rejects(
			local.accept("root", { ...gen2, worker: gen2.worker! }, "after-fence", "{}", 1),
			(error: Error) => error instanceof StaleWorkLeaseError && error.reason === "missing",
		);
		const claim3 = await worker.request({ kind: "claim" });
		assert.equal(claim3.error, undefined);
		const gen3 = claim3.value as PoolWork;
		assert.equal(gen3.generation, 3);
		const acceptsBeforeGen3 = acceptSpy.mock.calls.length;
		const c3 = await worker.request({
			kind: "commit",
			operation: "commit-c3",
			mutation: { kind: "checkpoint", checkpoint: toolCheckpoint(gen3, child, "c3", 3) },
		});
		assert.equal(c3.error, undefined);
		assert.equal(acceptSpy.mock.calls.length, acceptsBeforeGen3 + 1);
	} finally {
		acceptSpy.mockRestore();
		randomSpy.mockRestore();
		await host.command({ kind: "close" });
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
});

test("stopping a satellite while its local checkpoint journal opens closes the shard (#4768)", async () => {
	const directory = makeTempDirectory("shipping-satellite-close-");
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const host = openCoordinator();
	let opened = 0;
	let closed = 0;
	let notifyOpening!: () => void;
	const openingStarted = new Promise<void>((resolve) => {
		notifyOpening = resolve;
	});
	let releaseOpen!: () => void;
	const openGate = new Promise<void>((resolve) => {
		releaseOpen = resolve;
	});
	const originalOpen = ShipShard.open.bind(ShipShard);
	const openSpy = vi.spyOn(ShipShard, "open").mockImplementation(async (path, root, now) => {
		const shard = await originalOpen(path, root, now);
		opened += 1;
		const originalClose = shard.close.bind(shard);
		let shardClosed = false;
		vi.spyOn(shard, "close").mockImplementation(async () => {
			if (!shardClosed) {
				shardClosed = true;
				closed += 1;
			}
			return originalClose();
		});
		notifyOpening();
		await openGate;
		return shard;
	});
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "holder");
		assert.equal(acquired.status, "acquired");
		if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
		const attaching = host.coordinator.attachSatellite({
			root: "root",
			lease: acquired.lease,
			journal,
			config: {
				definitions: [SOURCE],
				leaseMs: 60_000,
				heartbeatMs: 15_000,
				startupTimeoutMs: 30_000,
				claimWindowMs: 60_000,
				checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 },
			},
			sources: [SOURCE],
			workers: 1,
			durable: poolDurableJournal(journal),
			stateDirectory,
			workerEntry: "fake-worker",
			placement: {
				host: "host-b",
				detached: () => {},
				placementFailed: () => {},
			},
		});
		await openingStarted;
		const stopping = host.coordinator.stopSatellite();
		await Promise.race([stopping, sleep(0)]);
		releaseOpen();
		await Promise.all([attaching, stopping]);
		assert.equal(opened, 1);
		assert.equal(closed, 1);
	} finally {
		releaseOpen();
		openSpy.mockRestore();
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
});

test("closing a root pool while prepare opens its local checkpoint journal closes the shard (#4768)", async () => {
	const directory = makeTempDirectory("shipping-prepare-close-");
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const host = openCoordinator();
	let opened = 0;
	let closed = 0;
	let notifyOpening!: () => void;
	const openingStarted = new Promise<void>((resolve) => {
		notifyOpening = resolve;
	});
	let releaseOpen!: () => void;
	const openGate = new Promise<void>((resolve) => {
		releaseOpen = resolve;
	});
	const originalOpen = ShipShard.open.bind(ShipShard);
	const openSpy = vi.spyOn(ShipShard, "open").mockImplementation(async (path, root, now) => {
		const shard = await originalOpen(path, root, now);
		opened += 1;
		const originalClose = shard.close.bind(shard);
		let shardClosed = false;
		vi.spyOn(shard, "close").mockImplementation(async () => {
			if (!shardClosed) {
				shardClosed = true;
				closed += 1;
			}
			return originalClose();
		});
		notifyOpening();
		await openGate;
		return shard;
	});
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "holder");
		assert.equal(acquired.status, "acquired");
		if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
		const preparing = host.command({
			kind: "prepare",
			root: "root",
			lease: acquired.lease,
			options: {
				durable: poolDurableJournal(journal),
				shared: {
					stateDirectory,
					host: "host-a",
					claimWindowMs: 60_000,
					checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 },
				},
				workers: 1,
				leaseMs: 60_000,
				heartbeatMs: 15_000,
				startupTimeoutMs: 30_000,
				workerEntry: "fake-worker",
			},
		});
		await openingStarted;
		const closing = host.command({ kind: "close" });
		releaseOpen();
		await assert.rejects(preparing, /Local worker pool is closed/);
		await closing;
		assert.equal(opened, 1);
		assert.equal(closed, 1);
	} finally {
		releaseOpen();
		openSpy.mockRestore();
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
});

test("a displaced worker's fenced handoff during a delivery outage leaves its replacement's checkpoint to ship before completion (#4768)", async () => {
	const directory = makeTempDirectory("shipping-stale-release-");
	const stateDirectory = join(directory, "state");
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const host = openCoordinator();
	let failing: ReturnType<typeof vi.spyOn> | undefined;
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "holder");
		assert.equal(acquired.status, "acquired");
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
					checkpointShipping: { intervalMs: 60_000, maxBatch: 64, maxLagMs: 30_000 },
				},
				workers: 2,
				leaseMs: 60_000,
				heartbeatMs: 15_000,
				startupTimeoutMs: 30_000,
				workerEntry: "fake-worker",
			},
		});
		const starting = host.command({ kind: "start", sources: [SOURCE], cwd: directory, publish: false });
		while (forked.length < 2) await sleep(5);
		const [firstWorker, secondWorker] = [forked[0]!, forked[1]!];
		await firstWorker.request({ kind: "ready" });
		await secondWorker.request({ kind: "ready" });
		await starting;
		const { work, boundary } = poolWorkFixture();
		const child = boundary.topology!.boundary!.child;
		await host.command({
			kind: "enqueue",
			descriptor: { ...work, definition: `${SOURCE.path}#${SOURCE.exportName}`, digest: SOURCE.digest },
			boundary,
		});
		const firstClaim = await firstWorker.request({ kind: "claim" });
		assert.equal(firstClaim.error, undefined);
		const first = firstClaim.value as PoolWork;
		assert.equal(first.generation, 1);
		const firstCommit = await firstWorker.request({
			kind: "commit",
			operation: "commit-a",
			mutation: { kind: "checkpoint", checkpoint: toolCheckpoint(first, child, "a", 0) },
		});
		assert.equal(firstCommit.error, undefined);
		const queue = await openSqlPoolQueue(journal);
		await sqlPoolStorage(journal)!.transaction((tx) =>
			tx.run("UPDATE wf_runs_work SET expires_at = 1 WHERE id = ?", first.id),
		);
		assert.equal(await queue.expire(acquired.lease, first), true);
		const secondClaim = await secondWorker.request({ kind: "claim" });
		assert.equal(secondClaim.error, undefined);
		const second = secondClaim.value as PoolWork;
		assert.equal(second.id, first.id);
		assert.equal(second.generation, 2);
		const secondCheckpoint = toolCheckpoint(second, child, "b", 1);
		const secondCommit = await secondWorker.request({
			kind: "commit",
			operation: "commit-b",
			mutation: { kind: "checkpoint", checkpoint: secondCheckpoint },
		});
		assert.equal(secondCommit.error, undefined);
		assert.equal((secondCommit.value as { readonly local?: boolean } | undefined)?.local, true);
		failing = vi.spyOn(SqlPoolQueue.prototype, "shipBatch").mockRejectedValue(new Error("shared store unavailable"));
		const handoff = await firstWorker.request({ kind: "fenced", handoff: true });
		assert.equal(handoff.error, undefined);
		failing.mockRestore();
		const completed = await secondWorker.request({
			kind: "complete",
			result: { runId: second.childRunId, status: "completed", stages: [], toolNodes: [] },
		});
		assert.equal(completed.error, undefined);
		assert.equal((await queue.inspect("root")).find((row) => row.id === second.id)?.state, "completed");
		assert.ok(await journal.readKey("root", checkpointKey(secondCheckpoint)));
	} finally {
		failing?.mockRestore();
		await host.command({ kind: "close" });
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
});
