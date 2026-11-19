import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StorageNotificationEvent, StorageNotifications } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { openSqlPoolQueue, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { IdleClaimBackoff, IdleReadyProbe } from "../../packages/workflows/src/workers/pool-wake-ups.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	binding,
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	fixture,
	satellite,
} from "../helpers/workflow-shared-pool-coordinator.js";

const listeners = vi.hoisted(() => new Set<(event: StorageNotificationEvent) => void>());
vi.mock("../../packages/workflows/src/durable/journal/internal.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/workflows/src/durable/journal/internal.js")>();
	const notifications: StorageNotifications = {
		notify: (_channel, payload) => ({ sql: "INSERT INTO idle_notices(payload) VALUES (?)", params: [payload] }),
		listen: (_channel, listener) => {
			listeners.add(listener);
			return {
				close: () => {
					listeners.delete(listener);
				},
			};
		},
		state: async () => ({ status: "listening" }),
	};
	return {
		...actual,
		registerSqlPoolStorage: (
			journal: Parameters<typeof actual.registerSqlPoolStorage>[0],
			storage: Parameters<typeof actual.registerSqlPoolStorage>[1],
		) => actual.registerSqlPoolStorage(journal, { ...storage, notifications }),
	};
});
vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));
useTemporaryAgentDir();
afterEach(() => {
	// Restoring alone keeps each spy and its implementation for the rest of the file, and these implementations hold the
	// test's paused workers and pool: about 20 MB a test. Resetting first drops them.
	vi.resetAllMocks();
	vi.restoreAllMocks();
	listeners.clear();
});

const ISOLATED_IDLE_PAUSE_MS = 10_000;
const CLAIM_WAKE_BOUND_MS = ISOLATED_IDLE_PAUSE_MS / 2;
const RESTORE_RETRY_BOUND_MS = ISOLATED_IDLE_PAUSE_MS / 2;

async function idleSatellite(workers: number, children: number, restore: (path: string) => Promise<string>) {
	const pausedWorkers = new Set<IdleClaimBackoff>();
	vi.spyOn(IdleClaimBackoff.prototype, "next").mockImplementation(function (this: IdleClaimBackoff) {
		pausedWorkers.add(this);
		return ISOLATED_IDLE_PAUSE_MS;
	});
	vi.spyOn(IdleReadyProbe.prototype, "tick").mockResolvedValue();
	const f = await fixture("shared-coordinator-idle-wake", { workspace: binding });
	await sqlPoolStorage(f.hostJournal)!.transaction((tx) =>
		tx.exec("CREATE TABLE idle_notices(payload TEXT NOT NULL)"),
	);
	const queue = await openSqlPoolQueue(f.hostJournal);
	const restored = join(f.directory, "restored");
	mkdirSync(restored);
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "boundChild",
		digest: await definitionDigest(childPath),
	});
	let enqueue!: () => void;
	const enqueued = new Promise<void>((resolve) => {
		enqueue = resolve;
	});
	let warmed = false;
	const parent = workflow({
		name: "idle-satellite-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.workflow(child as never, { inputs: {} });
			warmed = true;
			await enqueued;
			await Promise.all(Array.from({ length: children }, () => ctx.workflow(child as never, { inputs: {} })));
			return {};
		},
	});
	const execution = run(
		parent,
		{},
		{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
	);
	let host: PoolCoordinator | undefined;
	try {
		const root = await f.root();
		host = await satellite(
			f,
			root,
			{ restore: () => (warmed ? restore(restored) : Promise.resolve(restored)) },
			[],
			"host-b",
			workers,
		);
		while (!warmed || pausedWorkers.size < workers + 1) await sleep(5);
		return {
			f,
			root,
			queue,
			execution,
			async ready() {
				enqueue();
				while ((await queue.inspect("root")).filter((work) => work.state === "ready").length < children)
					await sleep(5);
			},
			wake() {
				for (const listener of listeners) listener({ kind: "notification", payload: "root" });
			},
			async close() {
				enqueue();
				await host?.stopSatellite();
				await host?.shutdown();
				await f.pool.close();
				await execution.catch(() => {});
				await f.close();
			},
		};
	} catch (error) {
		enqueue();
		await host?.stopSatellite();
		await host?.shutdown();
		await f.pool.close();
		await execution.catch(() => {});
		await f.close();
		throw error;
	}
}

test.each([
	{ name: "one notice", race: false, busy: false },
	{ name: "a placement race", race: true, busy: false },
	{ name: "a temporarily locked candidate", race: false, busy: true },
])(
	"a listening satellite claims both ready children before either restore ends with $name (#5230)",
	async ({ race, busy }) => {
		let release!: () => void;
		const restoring = new Promise<void>((resolve) => {
			release = resolve;
		});
		const restores: number[] = [];
		const f = await idleSatellite(2, 2, async (path) => {
			restores.push(performance.now());
			await restoring;
			return path;
		});
		let openSnapshots!: () => void;
		const snapshots = new Promise<void>((resolve) => {
			openSnapshots = resolve;
		});
		try {
			await f.ready();
			if (busy) {
				const claim = SqlPoolQueue.prototype.claim;
				let refused = false;
				vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (this: SqlPoolQueue, ...args) {
					if (args[4]?.kind === "work" && !refused) {
						refused = true;
						return undefined;
					}
					return claim.call(this, ...args);
				});
			}
			if (race) {
				const readyCandidates = SqlPoolQueue.prototype.readyCandidates;
				let reads = 0;
				vi.spyOn(SqlPoolQueue.prototype, "readyCandidates").mockImplementation(async function (
					this: SqlPoolQueue,
					...args
				) {
					const candidates = await readyCandidates.call(this, ...args);
					if (candidates.length > 0 && reads++ < 2) {
						if (reads === 2) openSnapshots();
						await snapshots;
					}
					return candidates;
				});
			}
			const notifiedAt = performance.now();
			f.wake();
			if (race) f.wake();
			while (restores.length < 2 && performance.now() - notifiedAt < CLAIM_WAKE_BOUND_MS) await sleep(5);
			assert.equal(restores.length, 2, "both idle slots claim before the first restore can finish");
			assert.ok(restores.every((at) => at - notifiedAt < CLAIM_WAKE_BOUND_MS));
			release();
			assert.equal((await f.execution).status, "completed");
		} finally {
			openSnapshots();
			release();
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a paused satellite does not retry the same ready candidate as a placement race (#5230)",
	async () => {
		const f = await idleSatellite(1, 1, async (path) => path);
		try {
			await f.ready();
			const claim = SqlPoolQueue.prototype.claim;
			let paused = false;
			const claims = vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (
				this: SqlPoolQueue,
				...args
			) {
				if (args[4]?.kind === "work" && !paused) {
					paused = true;
					await f.queue.setControl(f.root.lease, "paused");
				}
				return claim.call(this, ...args);
			});
			f.wake();
			const placementClaims = () => claims.mock.calls.filter((args) => args[4]?.kind === "work").length;
			while (placementClaims() === 0) await sleep(5);
			await sleep(200);
			assert.equal(placementClaims(), 1, "a control refusal does not repeat the same fenced write");
			await f.queue.setControl(f.root.lease, "running");
			f.wake();
			assert.equal((await f.execution).status, "completed");
		} finally {
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a listening satellite retries a failed workspace restore when its one-second backoff expires (#5230)",
	async () => {
		const restores: number[] = [];
		const f = await idleSatellite(1, 1, async (path) => {
			restores.push(performance.now());
			if (restores.length === 1) throw new Error("workspace remote unavailable");
			return path;
		});
		try {
			await f.ready();
			f.wake();
			while (restores.length === 0) await sleep(5);
			while (restores.length < 2 && performance.now() - restores[0]! < RESTORE_RETRY_BOUND_MS) await sleep(5);
			assert.equal(
				restores.length,
				2,
				"restore backoff expiry wakes the idle slot without another readiness notice",
			);
			assert.ok(restores[1]! - restores[0]! >= 1_000);
			assert.ok(restores[1]! - restores[0]! < RESTORE_RETRY_BOUND_MS);
			assert.equal((await f.execution).status, "completed");
		} finally {
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
