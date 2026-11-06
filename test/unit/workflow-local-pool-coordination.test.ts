import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test, vi } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { PoolCoordinationStats } from "../../packages/workflows/src/shared/store-types.js";
import { isLocalWorkerOptionsError } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import type { PoolCoordinatorOptions } from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

interface FakeCoordinator {
	readonly sent: Record<string, unknown>[];
	emit(event: string, message: unknown): boolean;
}

const coordinators = vi.hoisted((): FakeCoordinator[] => []);

// A stand-in coordinator process: answers prepare and close, and lets the test send the pool its events.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	return {
		...actual,
		fork(_modulePath: string, _args: readonly string[], _options: ForkOptions) {
			const sent: Record<string, unknown>[] = [];
			const child = Object.assign(new EventEmitter(), {
				pid: 525_252,
				connected: true,
				exitCode: null as number | null,
				signalCode: null as string | null,
				stderr: new PassThrough(),
				sent,
				send(message: Record<string, unknown>, callback?: (error: Error | null) => void) {
					sent.push(message);
					callback?.(null);
					if (message.kind === "prepare" || message.kind === "close") {
						const value =
							message.kind === "prepare"
								? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
								: undefined;
						setImmediate(() => child.emit("message", { kind: "reply", id: message.id, value }));
					}
					return true;
				},
				disconnect() {
					child.connected = false;
					child.exitCode = 0;
					setImmediate(() => child.emit("exit", 0, null));
				},
				kill() {
					return true;
				},
			});
			coordinators.push(child);
			return child;
		},
	};
});

afterEach(() => {
	coordinators.length = 0;
});

const stats: PoolCoordinationStats = {
	since: 1_000,
	requests: { heartbeat: { count: 8, perSecond: 0.5 } },
	writes: { heartbeat: { count: 8, perSecond: 0.5 } },
};

function rootStore(): Store {
	const store = createStore();
	store.recordRunStart({
		id: "root",
		name: "root",
		inputs: {},
		status: "running",
		stages: [],
		toolNodes: [],
		startedAt: 0,
	});
	return store;
}

/** A pool prepared for a root whose pool already ran, so preparing it starts the coordinator. */
async function preparedPool(
	options: { readonly leaseMs?: number; readonly heartbeatMs?: number },
	/** `null`: an SDK pool prepared without a store. */
	store: Store | null = rootStore(),
) {
	const directory = makeTempDirectory("local-pool-coordination-");
	const path = join(directory, "journal.sqlite");
	const journal = await resolveRunJournal({ journal: { path } });
	const backend = await JournalDurableBackend.open(journal);
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const lease = (await journal.leaseState("root"))!;
	await (await openSqlPoolQueue(journal)).initialize(
		{ runId: "root", holderId: lease.holderId, epoch: lease.epoch },
		3 * STAGE_SESSION_HEARTBEAT_INTERVAL_MS,
	);
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [],
		...options,
	});
	await pool.prepare("root", store ?? undefined);
	const prepare = coordinators.at(-1)!.sent.find((message) => message.kind === "prepare") as
		| { readonly options: PoolCoordinatorOptions }
		| undefined;
	return {
		pool,
		store,
		prepared: prepare?.options,
		async close() {
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		},
	};
}

test("a pool hands its coordinator the lease and the heartbeat interval derived from it (#4313)", async () => {
	const derived = await preparedPool({ leaseMs: 60_000 });
	try {
		assert.equal(derived.prepared?.leaseMs, 60_000);
		assert.equal(derived.prepared?.heartbeatMs, 15_000, "a quarter of the lease");
	} finally {
		await derived.close();
	}
	const chosen = await preparedPool({ leaseMs: 8_000, heartbeatMs: 1_000 });
	try {
		assert.equal(chosen.prepared?.leaseMs, 8_000);
		assert.equal(chosen.prepared?.heartbeatMs, 1_000);
	} finally {
		await chosen.close();
	}
	const defaults = await preparedPool({});
	try {
		assert.equal(defaults.prepared?.leaseMs, 30_000);
		assert.equal(defaults.prepared?.heartbeatMs, 7_500);
	} finally {
		await defaults.close();
	}
});

test("the coordinator's counts reach the pool and the root run's snapshot (#4313)", async () => {
	const f = await preparedPool({});
	try {
		assert.equal(f.pool.coordinationStats(), undefined, "nothing reported yet");
		assert.equal(f.store?.run("root")?.pool, undefined);
		coordinators.at(-1)!.emit("message", { kind: "coordination", stats });
		while (f.pool.coordinationStats() === undefined) await delay(5);
		assert.deepEqual(f.pool.coordinationStats(), stats);
		assert.deepEqual(f.store?.run("root")?.pool, { coordination: stats });
	} finally {
		await f.close();
	}
});

test("a pool without a store, or with one that keeps no pool snapshot, still keeps the counts (#4313)", async () => {
	const withoutStore = await preparedPool({}, null);
	try {
		coordinators.at(-1)!.emit("message", { kind: "coordination", stats });
		while (withoutStore.pool.coordinationStats() === undefined) await delay(5);
		assert.deepEqual(withoutStore.pool.coordinationStats(), stats);
	} finally {
		await withoutStore.close();
	}
	const store: Store = rootStore();
	delete (store as { recordRunPool?: Store["recordRunPool"] }).recordRunPool;
	const withOlderStore = await preparedPool({}, store);
	try {
		coordinators.at(-1)!.emit("message", { kind: "coordination", stats });
		while (withOlderStore.pool.coordinationStats() === undefined) await delay(5);
		assert.equal(store.run("root")?.pool, undefined);
	} finally {
		await withOlderStore.close();
	}
});

test("a pool refuses an out-of-range lease or heartbeat before it starts anything (#4313)", async () => {
	const directory = makeTempDirectory("local-pool-options-");
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	try {
		for (const options of [{ leaseMs: 1_999 }, { leaseMs: 4_000, heartbeatMs: 2_001 }, { heartbeatMs: 50 }])
			assert.throws(
				() => new LocalWorkerPool(backend, { journalPath: path, workers: 1, definitions: [], ...options }),
				(error: unknown) => isLocalWorkerOptionsError(error) && error.source === "sdk",
			);
		assert.equal(coordinators.length, 0, "no coordinator was started");
	} finally {
		await backend.close();
		removeTempDirectory(directory);
	}
});
