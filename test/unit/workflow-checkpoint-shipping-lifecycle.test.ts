import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import {
	type PoolControl,
	type PoolWork,
	SqlPoolQueue,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { StaleWorkLeaseError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
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
const LEASE = { id: "work-1", generation: 1, worker: "host/1", epoch: 1 } as const;

function filesUnder(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => !entry.isDirectory())
		.map((entry) => join(entry.parentPath, entry.name));
}

/** Files of roots' local journals under `directory`: everything but each journal's lock, which is never removed. */
function shardFilesUnder(directory: string): string[] {
	return filesUnder(directory).filter((file) => !file.endsWith(".lock"));
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
		assert.deepEqual(
			filesUnder(join(directory, "ship")).map((file) => basename(file)),
			[`${basename(dirname(shipShardPath(directory, "journal", "root-0")))}.lock`],
			"only the journal's lock is left",
		);
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

async function prepareRoot(
	directory: string,
	stateDirectory: string,
	settings: { readonly control?: PoolControl["state"]; readonly leaseMs?: number } = {},
) {
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const host = openCoordinator();
	await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "holder");
	if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
	const leaseMs = settings.leaseMs ?? 30_000;
	await host.command({
		kind: "prepare",
		root: "root",
		lease: acquired.lease,
		options: {
			durable: poolDurableJournal(journal),
			shared: { stateDirectory, host: "host-a", claimWindowMs: 60_000, checkpointShipping: SHIPPING },
			workers: 1,
			leaseMs,
			heartbeatMs: Math.min(10_000, leaseMs / 4),
			startupTimeoutMs: 30_000,
			workerEntry: "fake-worker",
		},
		...(settings.control === undefined ? {} : { control: settings.control }),
	});
	return { journal, host, lease: acquired.lease };
}

test("a root pool that closes after its run ends removes its local checkpoint journal (#4768)", async () => {
	const directory = makeTempDirectory("shipping-root-retire-");
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	const { journal, host } = await prepareRoot(directory, stateDirectory);
	try {
		assert.equal(shardFilesUnder(join(stateDirectory, "ship")).length > 0, true);
		await host.command({ kind: "close" });
		assert.deepEqual(shardFilesUnder(join(stateDirectory, "ship")), []);
	} finally {
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
});

test("a root pool that closes paused or quitting keeps its local checkpoint journal for the run's resume (#4768)", async () => {
	for (const control of ["paused", "quit"] as const) {
		const directory = makeTempDirectory("shipping-root-keep-");
		const stateDirectory = join(directory, "state");
		mkdirSync(stateDirectory);
		const { journal, host } = await prepareRoot(directory, stateDirectory, { control });
		try {
			const journals = () =>
				shardFilesUnder(join(stateDirectory, "ship")).filter((file) => file.endsWith(".sqlite"));
			assert.equal(journals().length, 1);
			await host.command({ kind: "close" });
			assert.equal(journals().length, 1, `a ${control} root keeps it`);
		} finally {
			await host.coordinator.shutdown();
			await journal.close();
			removeTempDirectory(directory);
		}
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
			assert.equal(shardFilesUnder(join(stateDirectory, "ship")).length > 0, true);
			await host.coordinator.stopSatellite({ rootEnded });
			await host.coordinator.shutdown();
			assert.equal(shardFilesUnder(join(stateDirectory, "ship")).length === 0, rootEnded);
		}
	} finally {
		await journal.close();
		removeTempDirectory(directory);
	}
});

/** What a worker has waiting on the journal when it exits: the request whose late hold must not count. */
type InFlight = "nothing" | "heartbeat" | "claim" | "overdue renewal" | "refused renewal";

/** A work lease short enough that a request soon finds its attempt overdue and renews it on the way. */
const OVERDUE_LEASE_MS = 2_000;

/**
 * How many times a root pool reports its local journal failing for work, when every local write fails and its worker
 * exits while `inFlight` waits on the journal.
 */
async function reportsAfterExit(inFlight: InFlight): Promise<number> {
	const directory = makeTempDirectory("shipping-exit-in-flight-");
	const stateDirectory = join(directory, "state");
	mkdirSync(stateDirectory);
	const { journal, host } = await prepareRoot(directory, stateDirectory, {
		leaseMs: inFlight === "overdue renewal" ? OVERDUE_LEASE_MS : 30_000,
	});
	let releaseRequest!: () => void;
	const requestGate = new Promise<void>((resolve) => {
		releaseRequest = resolve;
	});
	let requestWritten!: () => void;
	const written = new Promise<void>((resolve) => {
		requestWritten = resolve;
	});
	/** Lets `method`'s next call write to the journal, then holds its answer until the worker exited. */
	const holdAnswer = (method: "claim" | "heartbeat" | "extend") => {
		const original = SqlPoolQueue.prototype[method] as (...args: unknown[]) => Promise<unknown>;
		let held = false;
		vi.spyOn(SqlPoolQueue.prototype, method).mockImplementation(async function (
			this: SqlPoolQueue,
			...args: unknown[]
		) {
			const result = await original.apply(this, args);
			if (held) return result;
			held = true;
			requestWritten();
			await requestGate;
			return result;
		} as never);
	};
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
		if (inFlight === "claim") {
			holdAnswer("claim");
			worker.ask({ kind: "claim" });
		} else {
			const claim = await worker.request({ kind: "claim" });
			assert.equal(claim.error, undefined);
			assert.ok(claim.value as PoolWork);
			if (inFlight === "heartbeat") {
				holdAnswer("heartbeat");
				worker.ask({ kind: "heartbeat", reports: [] });
			} else if (inFlight === "overdue renewal") {
				await sleep(OVERDUE_LEASE_MS / 2 + 200);
				holdAnswer("extend");
				worker.ask({ kind: "activity", runs: [] });
			} else if (inFlight === "refused renewal") {
				const claimed = claim.value as PoolWork;
				vi.spyOn(SqlPoolQueue.prototype, "heartbeat").mockRejectedValueOnce(
					new StaleWorkLeaseError({
						root: "root",
						workId: claimed.id,
						generation: claimed.generation,
						reason: "expired",
					}),
				);
				holdAnswer("extend");
				worker.ask({ kind: "heartbeat", reports: [] });
			} else requestWritten();
		}
		await written;
		worker.exit(1);
		await sleep(500);
		releaseRequest();
		await sleep(500);
		return host.events.filter(
			(event) => event.kind === "health" && /local journal failed for work/.test(event.message),
		).length;
	} finally {
		releaseRequest();
		vi.restoreAllMocks();
		await host.command({ kind: "close" }).catch(() => {});
		await host.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
}

test("a worker that exits with its heartbeat in flight reports its attempt's local journal failure once (#4768)", async () => {
	assert.equal(await reportsAfterExit("nothing"), 1);
	assert.equal(await reportsAfterExit("heartbeat"), 1);
}, 60_000);

test("a worker that exits with its claim in flight never holds the claimed attempt locally (#4768)", async () => {
	assert.equal(
		await reportsAfterExit("claim"),
		0,
		"no local journal is reported failing for an attempt that never ran",
	);
}, 60_000);

test("a worker that exits while a request renews its overdue attempt reports its local journal failure once (#4768)", async () => {
	assert.equal(await reportsAfterExit("overdue renewal"), 1);
}, 60_000);

test("a worker that exits while it renews an attempt the journal refused reports its local journal failure once (#4768)", async () => {
	assert.equal(await reportsAfterExit("refused renewal"), 1);
}, 60_000);
