import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { type PoolWork, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { CheckpointShipping } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { poolDurableJournal } from "../../packages/workflows/src/workers/pool-journal.js";
import type { FakeWorker } from "../helpers/fake-pool-worker.js";
import { openCoordinator, SOURCE } from "../helpers/pool-coordinator.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	binding,
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	fanOut,
	fixture,
	satellite,
} from "../helpers/workflow-shared-pool-coordinator.js";

const forked = vi.hoisted((): FakeWorker[] => []);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { FakeWorker } = await import("../helpers/fake-pool-worker.js");
	return {
		...actual,
		fork(modulePath: string, args: readonly string[], options: ForkOptions) {
			if (modulePath !== "fake-worker") return actual.fork(modulePath, args, options);
			const worker = new FakeWorker(5_100_000 + forked.length, args, options);
			forked.push(worker);
			return worker;
		},
	};
});

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

useTemporaryAgentDir();

afterEach(() => {
	forked.length = 0;
	vi.restoreAllMocks();
});

const SHIPPING = { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 } as const;
const HOLD = CheckpointShipping.prototype.hold;
const RELEASE = CheckpointShipping.prototype.release;
const RELEASE_UNPLACED = SqlPoolQueue.prototype.releaseUnplaced;

test(
	"a worker host releases the local checkpoint state of a claim it puts back unplaced (#4768)",
	async () => {
		const f = await fixture("shipping-unplaced-claim", { workspace: binding, leaseMs: 2_000 });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const calls: string[] = [];
		const hold = CheckpointShipping.prototype.hold;
		vi.spyOn(CheckpointShipping.prototype, "hold").mockImplementation(async function (
			this: CheckpointShipping,
			...args: Parameters<CheckpointShipping["hold"]>
		) {
			calls.push(`hold ${args[0].generation}`);
			return hold.apply(this, args);
		});
		const release = CheckpointShipping.prototype.release;
		vi.spyOn(CheckpointShipping.prototype, "release").mockImplementation(function (
			this: CheckpointShipping,
			...args: Parameters<CheckpointShipping["release"]>
		) {
			const work = args[0];
			calls.push(`release ${typeof work === "string" ? "any" : work.generation}`);
			return release.apply(this, args);
		});
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			let restores = 0;
			host = await satellite(
				f,
				{
					...root,
					config: { ...root.config, checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 } },
				},
				{
					restore: async () => {
						restores++;
						if (restores === 1) throw new Error("the remote is unreachable");
						return restored;
					},
				},
			);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.equal(restores, 2);
			assert.equal(calls[0], "release 1", `the unplaced claim is released before the next attempt holds: ${calls}`);
			assert.equal(calls[1], "hold 1", `${calls}`);
		} finally {
			vi.restoreAllMocks();
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a worker host holds nothing locally for a claim whose workspace still restores, even when its watchdog renews it (#4768)",
	async () => {
		const f = await fixture("shipping-restoring-claim", { workspace: binding, leaseMs: 2_000 });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		let failing = false;
		let restoring = false;
		let inspectedWhileRestoring = 0;
		const health: string[] = [];
		// The host's watchdog finds the claim's lease lapsed while its workspace restores, and renews it.
		const inspect = SqlPoolQueue.prototype.inspect;
		vi.spyOn(SqlPoolQueue.prototype, "inspect").mockImplementation(async function (
			this: SqlPoolQueue,
			...args: Parameters<SqlPoolQueue["inspect"]>
		) {
			const rows = await inspect.apply(this, args);
			if (!restoring || this !== (host as unknown as { queue?: SqlPoolQueue } | undefined)?.queue) return rows;
			inspectedWhileRestoring++;
			return rows.map((row) => (row.state === "leased" ? { ...row, expiresAt: 0 } : row));
		});
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			let restores = 0;
			host = await satellite(
				f,
				{
					...root,
					config: { ...root.config, checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 } },
				},
				{
					restore: async () => {
						restores++;
						if (restores > 1) return restored;
						while (!failing) await sleep(10);
						restoring = true;
						while (inspectedWhileRestoring < 3) await sleep(25);
						restoring = false;
						throw new Error("the remote is unreachable");
					},
				},
				[],
				"host-b",
				1,
				health,
			);
			// Every write to the host's local journal fails, so each attempt it holds there reports it.
			const shipping = (host as unknown as { shipping: { shard: { database: SqliteDatabase } } }).shipping;
			shipping.shard.database.transaction = (() =>
				Promise.reject(new Error("database or disk is full"))) as SqliteDatabase["transaction"];
			failing = true;
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.equal(restores, 2);
			assert.deepEqual(
				health.filter((message) => /local journal failed for work/.test(message)).length,
				1,
				`only the attempt that ran held the local journal: ${health.join("\n")}`,
			);
		} finally {
			vi.restoreAllMocks();
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

async function lateUnplacedReleaseAfterReplacement(diskFull: boolean): Promise<void> {
	const directory = makeTempDirectory("shipping-unplaced-late-release-");
	const rootState = join(directory, "root-state");
	const hostState = join(directory, "host-state");
	const restoredPath = join(directory, "restored");
	mkdirSync(rootState);
	mkdirSync(hostState);
	mkdirSync(restoredPath);
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const root = openCoordinator();
	const host = openCoordinator();
	let openGate!: () => void;
	const gate = new Promise<void>((resolve) => {
		openGate = resolve;
	});
	let unplacedCommitted!: () => void;
	const committed = new Promise<void>((resolve) => {
		unplacedCommitted = resolve;
	});
	let releaseFinished!: (done: Promise<void>) => void;
	const firstRelease = new Promise<void>((resolve) => {
		releaseFinished = (done) => void done.then(resolve, resolve);
	});
	try {
		await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
		const acquired = await journal.acquire("root", "holder");
		if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
		await root.command({
			kind: "prepare",
			root: "root",
			lease: acquired.lease,
			options: {
				durable: poolDurableJournal(journal),
				shared: { stateDirectory: rootState, host: "host-a", claimWindowMs: 60_000, checkpointShipping: SHIPPING },
				workers: 1,
				leaseMs: 30_000,
				heartbeatMs: 10_000,
				startupTimeoutMs: 30_000,
				workerEntry: "fake-worker",
			},
		});
		const beforeRoot = forked.length;
		const rootStarting = root.command({ kind: "start", sources: [SOURCE], cwd: directory, publish: false });
		while (forked.length === beforeRoot) await sleep(5);
		await forked[beforeRoot]!.request({ kind: "ready" });
		await rootStarting;
		const { work, boundary } = poolWorkFixture();
		await root.command({
			kind: "enqueue",
			descriptor: {
				...work,
				definition: `${SOURCE.path}#${SOURCE.exportName}`,
				digest: SOURCE.digest,
				execution: { workspaceBinding: { ...binding } },
			},
			boundary,
		});
		let restores = 0;
		const beforeHost = forked.length;
		const attaching = host.coordinator.attachSatellite({
			root: "root",
			lease: acquired.lease,
			journal,
			config: {
				definitions: [SOURCE],
				leaseMs: 30_000,
				heartbeatMs: 10_000,
				startupTimeoutMs: 30_000,
				claimWindowMs: 60_000,
				checkpointShipping: SHIPPING,
			},
			sources: [SOURCE],
			workers: 2,
			durable: poolDurableJournal(journal),
			stateDirectory: hostState,
			workerEntry: "fake-worker",
			placement: {
				host: "host-b",
				restore: async () => {
					restores++;
					if (restores === 1) throw new Error("the remote is unreachable");
					return restoredPath;
				},
				detached: () => {},
				placementFailed: () => {},
			},
		});
		while (forked.length < beforeHost + 2) await sleep(5);
		const workerA = forked[beforeHost]!;
		const workerB = forked[beforeHost + 1]!;
		await workerA.request({ kind: "ready" });
		await workerB.request({ kind: "ready" });
		await attaching;
		const shipping = (host.coordinator as unknown as { shipping: CheckpointShipping }).shipping;
		const database = (shipping as unknown as { shard: { database: SqliteDatabase } }).shard.database;
		const transaction = database.transaction.bind(database);
		let failLocal = false;
		database.transaction = ((
			callback: Parameters<typeof transaction>[0],
			options?: Parameters<typeof transaction>[1],
		) =>
			failLocal
				? Promise.reject(new Error("database or disk is full"))
				: transaction(callback, options)) as typeof database.transaction;
		const holds: string[] = [];
		vi.spyOn(CheckpointShipping.prototype, "hold").mockImplementation(async function (
			this: CheckpointShipping,
			...args: Parameters<CheckpointShipping["hold"]>
		) {
			if (this === shipping) holds.push(`${args[0].generation}:${args[0].worker}`);
			return HOLD.apply(this, args);
		});
		let sawRelease = false;
		vi.spyOn(CheckpointShipping.prototype, "release").mockImplementation(function (
			this: CheckpointShipping,
			...args: Parameters<CheckpointShipping["release"]>
		) {
			const done = RELEASE.apply(this, args);
			if (this === shipping && !sawRelease) {
				sawRelease = true;
				releaseFinished(done);
			}
			return done;
		});
		let gated = false;
		vi.spyOn(SqlPoolQueue.prototype, "releaseUnplaced").mockImplementation(async function (
			this: SqlPoolQueue,
			...args: Parameters<SqlPoolQueue["releaseUnplaced"]>
		) {
			const result = await RELEASE_UNPLACED.apply(this, args);
			if (!gated) {
				gated = true;
				unplacedCommitted();
				await gate;
			}
			return result;
		});
		workerA.ask({ kind: "claim" });
		await committed;
		failLocal = diskFull;
		const bClaim = await workerB.request({ kind: "claim" });
		assert.equal(bClaim.error, undefined);
		const claimedB = bClaim.value as PoolWork;
		assert.ok(claimedB);
		assert.equal(claimedB.generation, 1);
		assert.deepEqual(holds, [`1:${claimedB.worker}`]);
		openGate();
		await firstRelease;
		const child = boundary.topology!.boundary!.child;
		const commit = await workerB.request({
			kind: "commit",
			operation: "commit-c0",
			mutation: {
				kind: "checkpoint",
				checkpoint: {
					kind: "tool",
					name: "tool-c0",
					output: {},
					workflowId: "root",
					checkpointId: `${claimedB.scope}:c0`,
					argsHash: `${claimedB.scope}:args-c0`,
					completedAt: 1,
					topology: { version: 1, nodeId: "tool-c0", ordinal: 0, order: 0, parentIds: [], run: child },
				},
			} as never,
		});
		assert.equal(commit.error, undefined);
		const receipt = commit.value as { local?: boolean; seq?: number };
		assert.equal(receipt.local === true, !diskFull);
		const fallbackReports = host.events.filter(
			(event) => event.kind === "health" && /local journal failed for work/.test(event.message),
		).length;
		assert.equal(fallbackReports, diskFull ? 1 : 0);
		assert.deepEqual(holds, [`1:${claimedB.worker}`]);
	} finally {
		openGate();
		vi.restoreAllMocks();
		await host.coordinator.stopSatellite({ rootEnded: true }).catch(() => {});
		await host.coordinator.shutdown().catch(() => {});
		await root.command({ kind: "close" }).catch(() => {});
		await root.coordinator.shutdown();
		await journal.close();
		removeTempDirectory(directory);
	}
}

test(
	"a late answer to an unplaced claim's release leaves the next worker's same-generation local shipping lease intact (#4768)",
	async () => {
		await lateUnplacedReleaseAfterReplacement(false);
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a late answer to an unplaced claim's release reports the next worker's same-generation local journal failure once (#4768)",
	async () => {
		await lateUnplacedReleaseAfterReplacement(true);
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
