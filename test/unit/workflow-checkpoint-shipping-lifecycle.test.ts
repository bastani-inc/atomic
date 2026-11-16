import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { type PoolWork, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { CheckpointShipping } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { poolDurableJournal } from "../../packages/workflows/src/workers/pool-journal.js";
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
			const worker = new FakeWorker(5_000_000 + forked.length, args, options);
			forked.push(worker);
			return worker;
		},
	};
});

afterEach(() => {
	forked.length = 0;
	vi.restoreAllMocks();
});

const SHIPPING = { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 } as const;
const HEARTBEAT = SqlPoolQueue.prototype.heartbeat;
const LEASE = { id: "work-1", generation: 1, worker: "host/1", epoch: 1 } as const;

function filesUnder(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => !entry.isDirectory())
		.map((entry) => join(entry.parentPath, entry.name));
}

async function shipOnce(shard: ShipShard, key: string): Promise<void> {
	await shard.hold(LEASE, 60_000);
	const { localSeq } = await shard.accept(shard.root, LEASE, key, "{}", 1);
	await shard.shipped(LEASE, localSeq);
}

test("a retired local checkpoint journal whose checkpoints all shipped leaves no files behind (#4768)", async () => {
	const directory = makeTempDirectory("ship-shard-retire-");
	try {
		for (let index = 0; index < 20; index++) {
			const root = `root-${index}`;
			const shard = await ShipShard.open(shipShardPath(directory, "journal", root), root);
			for (let checkpoint = 0; checkpoint < 50; checkpoint++) await shipOnce(shard, `key-${checkpoint}`);
			await shard.close({ retire: true });
		}
		assert.deepEqual(filesUnder(join(directory, "ship")), []);
	} finally {
		removeTempDirectory(directory);
	}
});

test("a local checkpoint journal is kept when it still holds a checkpoint, another connection uses it, or it is not retired (#4768)", async () => {
	const directory = makeTempDirectory("ship-shard-keep-");
	try {
		const unshippedPath = shipShardPath(directory, "journal", "unshipped");
		const unshipped = await ShipShard.open(unshippedPath, "unshipped");
		await unshipped.hold(LEASE, 60_000);
		await unshipped.accept("unshipped", LEASE, "pending", "{}", 1);
		await unshipped.close({ retire: true });
		assert.ok(existsSync(unshippedPath));

		const sharedPath = shipShardPath(directory, "journal", "shared");
		const first = await ShipShard.open(sharedPath, "shared");
		const second = await ShipShard.open(sharedPath, "shared");
		await first.close({ retire: true });
		assert.ok(existsSync(sharedPath), "a connection still open keeps the file");
		await second.close({ retire: true });
		assert.ok(!existsSync(sharedPath), "the last connection removes it");

		const keptPath = shipShardPath(directory, "journal", "kept");
		const kept = await ShipShard.open(keptPath, "kept");
		await shipOnce(kept, "key");
		await kept.close();
		assert.ok(existsSync(keptPath));
	} finally {
		removeTempDirectory(directory);
	}
});

async function prepareRoot(directory: string, stateDirectory: string) {
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
			shared: { stateDirectory, host: "host-a", claimWindowMs: 60_000, checkpointShipping: SHIPPING },
			workers: 1,
			leaseMs: 30_000,
			heartbeatMs: 10_000,
			startupTimeoutMs: 30_000,
			workerEntry: "fake-worker",
		},
	});
	return { journal, host, lease: acquired.lease };
}

test("a root pool that closes after its run ends removes its local checkpoint journal (#4768)", async () => {
	const directory = makeTempDirectory("shipping-root-retire-");
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	const { journal, host } = await prepareRoot(directory, stateDirectory);
	try {
		assert.equal(filesUnder(join(stateDirectory, "ship")).length > 0, true);
		await host.command({ kind: "close" });
		assert.deepEqual(filesUnder(join(stateDirectory, "ship")), []);
	} finally {
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
});

test("a worker host removes its local checkpoint journal only when its root's run ended (#4768)", async () => {
	const directory = makeTempDirectory("shipping-satellite-retire-");
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "holder");
		if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
		for (const rootEnded of [false, true]) {
			const stateDirectory = join(directory, `state-${rootEnded}`);
			mkdirSync(stateDirectory);
			const host = openCoordinator();
			const before = forked.length;
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
					checkpointShipping: SHIPPING,
				},
				sources: [SOURCE],
				workers: 1,
				durable: poolDurableJournal(journal),
				stateDirectory,
				workerEntry: "fake-worker",
				placement: { host: "host-b", detached: () => {}, placementFailed: () => {} },
			});
			while (forked.length === before) await sleep(5);
			await forked[before]!.request({ kind: "ready" });
			await attaching;
			assert.equal(filesUnder(join(stateDirectory, "ship")).length > 0, true);
			await host.coordinator.stopSatellite({ rootEnded });
			await host.coordinator.shutdown();
			assert.equal(filesUnder(join(stateDirectory, "ship")).length === 0, rootEnded);
		}
	} finally {
		await journal.close();
		removeTempDirectory(directory);
	}
});

async function exitWithHeartbeatInFlight(heartbeatInFlight: boolean): Promise<number> {
	const directory = makeTempDirectory("shipping-exit-heartbeat-");
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	const { journal, host } = await prepareRoot(directory, stateDirectory);
	let releaseHeartbeat!: () => void;
	const heartbeatGate = new Promise<void>((resolve) => {
		releaseHeartbeat = resolve;
	});
	let heartbeatWritten!: () => void;
	const written = new Promise<void>((resolve) => {
		heartbeatWritten = resolve;
	});
	try {
		const shipping = (host.coordinator as unknown as { shipping: CheckpointShipping }).shipping;
		const database = (shipping as unknown as { shard: { database: SqliteDatabase } }).shard.database;
		const transaction = database.transaction.bind(database);
		let diskFull = false;
		database.transaction = ((
			callback: Parameters<typeof transaction>[0],
			options?: Parameters<typeof transaction>[1],
		) =>
			diskFull
				? Promise.reject(new Error("database or disk is full"))
				: transaction(callback, options)) as typeof database.transaction;
		const before = forked.length;
		const starting = host.command({ kind: "start", sources: [SOURCE], cwd: directory, publish: false });
		while (forked.length === before) await sleep(5);
		const worker = forked[before]!;
		await worker.request({ kind: "ready" });
		await starting;
		const { work, boundary } = poolWorkFixture();
		await host.command({
			kind: "enqueue",
			descriptor: { ...work, definition: `${SOURCE.path}#${SOURCE.exportName}`, digest: SOURCE.digest },
			boundary,
		});
		diskFull = true;
		const claim = await worker.request({ kind: "claim" });
		assert.equal(claim.error, undefined);
		assert.ok(claim.value as PoolWork);
		vi.spyOn(SqlPoolQueue.prototype, "heartbeat").mockImplementation(async function (
			this: SqlPoolQueue,
			...args: Parameters<SqlPoolQueue["heartbeat"]>
		) {
			const result = await HEARTBEAT.apply(this, args);
			heartbeatWritten();
			await heartbeatGate;
			return result;
		});
		if (heartbeatInFlight) {
			worker.ask({ kind: "heartbeat", reports: [] });
			await written;
		}
		worker.exit(1);
		await sleep(500);
		releaseHeartbeat();
		await sleep(500);
		return host.events.filter(
			(event) => event.kind === "health" && /local journal failed for work/.test(event.message),
		).length;
	} finally {
		releaseHeartbeat();
		await host.command({ kind: "close" }).catch(() => {});
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
}

test("a worker that exits with its heartbeat in flight reports its attempt's local journal failure once (#4768)", async () => {
	assert.equal(await exitWithHeartbeatInFlight(false), 1);
	assert.equal(await exitWithHeartbeatInFlight(true), 1);
}, 60_000);
