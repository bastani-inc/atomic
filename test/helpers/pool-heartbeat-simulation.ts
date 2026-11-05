/**
 * Hundreds of simulated pool workers heartbeating against one real SQLite pool journal, on a virtual clock: the
 * journal's `unixepoch()` and the workers' timers both follow vitest's fake `Date`, so a two-minute window runs in
 * seconds. Each worker holds a distinct claimed attempt. Every transaction the pool submits while a window is measured
 * is counted; the root's lease renewals and the test's own inspections are not. Pool reads run as read transactions on
 * a read-only connection the journal opens itself (#4314), which this module does not clock: a test whose reads check
 * leases against the journal's clock fakes `node:sqlite` so that every connection reads its clock from `Date`.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import type { SqliteDatabase, SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { wrapNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	openSqlPoolQueue,
	type PoolWork,
	type SqlPoolQueue,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import {
	openSqlPoolUsage,
	type PoolUsageReport,
	type SqlPoolUsage,
} from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { startWorkerHeartbeat } from "../../packages/workflows/src/workers/worker-heartbeat.js";
import { poolWorkFixture } from "./pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "./runtime.js";

/** The coordinator's window for the root's own lease (three root heartbeats). */
const COORDINATOR_LEASE_MS = 90_000;
/** How often the simulated root renews its lease, well inside {@link COORDINATOR_LEASE_MS}. */
const ROOT_RENEWAL_MS = 30_000;
/** Virtual epoch the simulations start at. */
const START_MS = Date.UTC(2026, 0, 1);

/** One accepted renewal of a worker's attempt, on the journal's clock. */
export interface AcceptedRenewal {
	/** When the worker sent the request that renewed it. */
	readonly sentAt: number;
	readonly renewedAt: number;
	readonly expiresAt: number;
	/** The attempt's expiry before this renewal: renewing after it would have been a lapse. */
	readonly previousExpiresAt: number;
}

export interface SimulatedWorker {
	readonly index: number;
	/** Periodic requests the worker sent. */
	requests: number;
	/** Most requests of this worker in flight at once. */
	maxInFlight: number;
	readonly renewals: AcceptedRenewal[];
	held: PoolWork;
	stop(): Promise<void>;
}

/** Cumulative usage of a worker's one stage after `elapsedMs` of work, as its heartbeat reports it. */
export function usageAt(index: number, elapsedMs: number): PoolUsageReport[] {
	const seconds = Math.floor(elapsedMs / 1_000);
	return [
		{
			key: `stage:child-boundary-${index}:agent`,
			usage: { input: 100 * seconds, output: 20 * seconds, cacheRead: 0, cacheWrite: 0, cost: seconds },
		},
	];
}

export interface SimulatedPool {
	readonly connection: DatabaseSync;
	readonly journal: SqlRunJournal;
	readonly lease: Lease;
	readonly queue: SqlPoolQueue;
	readonly usage: SqlPoolUsage;
	readonly attempts: readonly PoolWork[];
	readonly leaseMs: number;
	/** Milliseconds since the simulation started, on the workers' clock. */
	elapsed(): number;
	/** The journal clock, which runs `skewMs` ahead of the workers' clock. */
	journalNow(): number;
	skewMs: number;
	/** Transactions submitted while `measuring` was set. */
	transactions: number;
	measuring: boolean;
	/** Registers a journal operation the driver waits for before the clock moves on. */
	track<T>(operation: Promise<T>): Promise<T>;
	/**
	 * Moves the clock forward `windowMs` in `stepMs` steps. After each step it waits for the journal operations the step
	 * started, renews the root's lease when due, and calls `afterStep`; none of that is measured.
	 */
	advance(windowMs: number, stepMs: number, afterStep?: () => Promise<void>): Promise<void>;
	/** The root's work, read without being measured. */
	inspect(): Promise<readonly PoolWork[]>;
	close(): Promise<void>;
}

function countingDatabase(
	database: SqliteDatabase,
	pool: { measuring: boolean; transactions: number },
): SqliteDatabase {
	return {
		descriptor: database.descriptor,
		exec: (sql) => database.exec(sql),
		run: (sql, ...params) => database.run(sql, ...params),
		get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.get<T>(sql, ...params),
		all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => database.all<T>(sql, ...params),
		transaction: (callback, options) => {
			if (pool.measuring) pool.transactions += 1;
			return database.transaction(callback, options);
		},
		close: () => database.close(),
	};
}

/** Lets the continuations of settled journal operations run, outside the fake clock. */
function drain(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A root with `workers` claimed attempts of `leaseMs` each, on a fake clock. Call {@link SimulatedPool.close} to
 * restore real timers.
 */
export async function simulatedPool(workers: number, leaseMs: number): Promise<SimulatedPool> {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"], now: START_MS });
	const directory = makeTempDirectory("pool-heartbeat-simulation-");
	const connection = new DatabaseSync(join(directory, "journal.sqlite"));
	const state = { measuring: false, transactions: 0, skewMs: 0 };
	connection.function("unixepoch", { varargs: true }, () => (Date.now() + state.skewMs) / 1_000);
	const database = wrapNodeSqliteDatabase(connection);
	// Durability is not under test: counts are of submitted transactions, whatever each costs to sync.
	connection.exec("PRAGMA synchronous=OFF");
	const journal = await SqlRunJournal.open(countingDatabase(database, state));
	await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "coordinator");
	assert.equal(acquired.status, "acquired");
	const lease = (acquired as { lease: Lease }).lease;
	const queue = await openSqlPoolQueue(journal);
	await queue.initialize(lease, COORDINATOR_LEASE_MS);
	const attempts: PoolWork[] = [];
	for (let index = 0; index < workers; index++) {
		const { work, boundary } = poolWorkFixture(`boundary-${index}`);
		await queue.enqueue(lease, work, boundary);
		const attempt = await queue.claim(lease, `worker-${index}`, [work], leaseMs);
		assert.ok(attempt, `worker ${index} claimed no work`);
		attempts.push(attempt);
	}
	const usage = await openSqlPoolUsage(journal);
	const inflight = new Set<Promise<unknown>>();
	let lastRootRenewal = Date.now();
	const pool: SimulatedPool = {
		connection,
		journal,
		lease,
		queue,
		usage,
		attempts,
		leaseMs,
		elapsed: () => Date.now() - START_MS,
		journalNow: () => Date.now() + state.skewMs,
		get skewMs() {
			return state.skewMs;
		},
		set skewMs(value: number) {
			state.skewMs = value;
		},
		get transactions() {
			return state.transactions;
		},
		set transactions(value: number) {
			state.transactions = value;
		},
		get measuring() {
			return state.measuring;
		},
		set measuring(value: boolean) {
			state.measuring = value;
		},
		track<T>(operation: Promise<T>): Promise<T> {
			inflight.add(operation);
			const settled = () => inflight.delete(operation);
			void operation.then(settled, settled);
			return operation;
		},
		async advance(windowMs, stepMs, afterStep) {
			for (let advanced = 0; advanced < windowMs; advanced += stepMs) {
				vi.advanceTimersByTime(stepMs);
				while (inflight.size > 0) {
					await Promise.allSettled([...inflight]);
					await drain();
				}
				await drain();
				const measuring = state.measuring;
				state.measuring = false;
				try {
					if (Date.now() - lastRootRenewal >= ROOT_RENEWAL_MS) {
						await journal.renew(lease);
						lastRootRenewal = Date.now();
					}
					await afterStep?.();
				} finally {
					state.measuring = measuring;
				}
			}
		},
		async inspect() {
			const measuring = state.measuring;
			state.measuring = false;
			try {
				return await queue.inspect("root");
			} finally {
				state.measuring = measuring;
			}
		},
		async close() {
			vi.useRealTimers();
			await journal.close();
			await database.close();
			connection.close();
			removeTempDirectory(directory);
		},
	};
	return pool;
}

/**
 * A worker as it heartbeats since #4313: one request every `intervalMs`, through the production heartbeat timer,
 * answered by the operation the coordinator runs for it (`SqlPoolQueue.heartbeat` recording the attempt's usage). Its
 * answer reaches the worker `replyDelayMs` after the journal committed it, as from a slow or busy coordinator.
 */
export function coalescedWorker(
	pool: SimulatedPool,
	index: number,
	intervalMs: number,
	replyDelayMs = 0,
): SimulatedWorker {
	let inFlight = 0;
	const worker: SimulatedWorker = {
		index,
		requests: 0,
		maxInFlight: 0,
		renewals: [],
		held: pool.attempts[index]!,
		stop: async () => {},
	};
	const heartbeat = startWorkerHeartbeat(intervalMs, async () => {
		inFlight += 1;
		worker.maxInFlight = Math.max(worker.maxInFlight, inFlight);
		worker.requests += 1;
		const sentAt = pool.journalNow();
		const previous = worker.held;
		const record = pool.usage.recording(pool.lease, previous, usageAt(index, pool.elapsed()));
		const beat = await pool.track(pool.queue.heartbeat(pool.lease, previous, pool.leaseMs, record));
		worker.held = beat.work;
		worker.renewals.push({
			sentAt,
			renewedAt: beat.work.renewedAt,
			expiresAt: beat.work.expiresAt,
			previousExpiresAt: previous.expiresAt,
		});
		if (replyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, replyDelayMs));
		inFlight -= 1;
	});
	worker.stop = () => heartbeat.stop();
	return worker;
}

/** The fixed heartbeat interval before #4313. */
export const LEGACY_HEARTBEAT_INTERVAL_MS = 1_000;

/**
 * A worker as it heartbeat before #4313, reproduced for comparison: every second, a lease renewal, a control read and a
 * usage report, each its own request with its own in-flight guard, each answered by the operation the coordinator ran
 * for that request kind (`extend`, `control`, `report`).
 */
export function legacyWorker(pool: SimulatedPool, index: number): SimulatedWorker {
	const worker: SimulatedWorker = {
		index,
		requests: 0,
		maxInFlight: 0,
		renewals: [],
		held: pool.attempts[index]!,
		stop: async () => {},
	};
	let renewal: Promise<void> | undefined;
	let control: Promise<void> | undefined;
	let report: Promise<void> | undefined;
	const timer = setInterval(() => {
		renewal ??= (async () => {
			worker.requests += 1;
			const previous = worker.held;
			worker.held = await pool.track(pool.queue.extend(pool.lease, previous, pool.leaseMs));
		})().finally(() => {
			renewal = undefined;
		});
		control ??= (async () => {
			worker.requests += 1;
			await pool.track(pool.queue.control(pool.lease));
		})().finally(() => {
			control = undefined;
		});
		report ??= (async () => {
			worker.requests += 1;
			await pool.track(pool.usage.report(pool.lease, worker.held, usageAt(index, pool.elapsed())));
		})().finally(() => {
			report = undefined;
		});
	}, LEGACY_HEARTBEAT_INTERVAL_MS);
	worker.stop = async () => {
		clearInterval(timer);
		await Promise.all([renewal, control, report]);
	};
	return worker;
}

/** Each worker's work is still leased to it, by the same attempt, and has not expired on the journal clock. */
export async function assertNoLapse(pool: SimulatedPool, workers: readonly SimulatedWorker[]): Promise<number> {
	const now = pool.journalNow();
	const rows = new Map((await pool.inspect()).map((work) => [work.id, work]));
	let headroom = Number.POSITIVE_INFINITY;
	for (const worker of workers) {
		const claimed = pool.attempts[worker.index]!;
		const row = rows.get(claimed.id);
		assert.equal(row?.state, "leased", `worker ${worker.index}'s work is no longer leased`);
		assert.equal(row.worker, claimed.worker, `worker ${worker.index}'s work changed hands`);
		assert.equal(row.generation, claimed.generation, `worker ${worker.index}'s attempt was replaced`);
		assert.ok(
			row.expiresAt > now,
			`worker ${worker.index}'s lease lapsed at ${row.expiresAt}, ${now - row.expiresAt} ms ago`,
		);
		headroom = Math.min(headroom, row.expiresAt - now);
	}
	return headroom;
}

/**
 * Every accepted renewal of each worker landed before the expiry it extended, its claim's included. Returns the longest
 * gap between two accepted renewals of one attempt, its claim counted as the first.
 */
export function assertRenewedBeforeExpiry(pool: SimulatedPool, workers: readonly SimulatedWorker[]): number {
	let longestGap = 0;
	for (const worker of workers) {
		let renewedAt = pool.attempts[worker.index]!.renewedAt;
		for (const renewal of worker.renewals) {
			assert.ok(
				renewal.renewedAt < renewal.previousExpiresAt,
				`worker ${worker.index} renewed at ${renewal.renewedAt}, after its lease expired at ${renewal.previousExpiresAt}`,
			);
			longestGap = Math.max(longestGap, renewal.renewedAt - renewedAt);
			renewedAt = renewal.renewedAt;
		}
	}
	return longestGap;
}
