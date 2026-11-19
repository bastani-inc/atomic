import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StorageNotificationEvent, StorageNotifications } from "@bastani/atomic/storage";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { CheckpointShipping } from "../../packages/workflows/src/workers/checkpoint-shipping.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { poolDurableJournal } from "../../packages/workflows/src/workers/pool-journal.js";
import { IdleClaimBackoff, IdleReadyProbe } from "../../packages/workflows/src/workers/pool-wake-ups.js";
import { RESTORE_BACKOFF, RestoreBackoff } from "../../packages/workflows/src/workers/restore-backoff.js";
import { workspaceAffinityKey } from "../../packages/workflows/src/workers/workspace-binding.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { binding, COORDINATOR_TEST_TIMEOUT_MS, quietPort } from "../helpers/workflow-shared-pool-coordinator.js";

const transportHolder: { notifications?: StorageNotifications } = vi.hoisted(() => ({}));

vi.mock("../../packages/workflows/src/durable/journal/internal.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/workflows/src/durable/journal/internal.js")>();
	return {
		...actual,
		registerSqlPoolStorage: (
			journal: Parameters<typeof actual.registerSqlPoolStorage>[0],
			storage: Parameters<typeof actual.registerSqlPoolStorage>[1],
		) =>
			actual.registerSqlPoolStorage(
				journal,
				transportHolder.notifications === undefined
					? storage
					: { ...storage, notifications: transportHolder.notifications },
			),
	};
});

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

useTemporaryAgentDir();

afterEach(() => {
	// Restoring alone keeps each spy and its implementation for the rest of the file, and these implementations hold the
	// test's pool and claims: about 10 MB a test. Resetting first drops them.
	vi.resetAllMocks();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	transportHolder.notifications = undefined;
});

const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const childPath = fileURLToPath(new URL("../fixtures/shared-pool-child.ts", import.meta.url));
const stubWorker = fileURLToPath(new URL("../fixtures/shared-pool-stub-worker.mjs", import.meta.url));
const IDLE_SETTLE_MS = 7_500;
const CLEAR_AFTER_MS = 50;
/**
 * The idle pause these tests stub while they wait for one wake-up: far longer than any wake-up takes, so only the
 * wake-up, not the pause running out, ends the wait in time.
 */
const STUBBED_IDLE_PAUSE_MS = 10_000;
/**
 * How long a claim may follow the event that should wake its idle worker. The wake-up itself comes at once or on the
 * coordinator's next 500 ms recovery tick or retry timer, but the worker's reply, its next claim and the store's claim
 * follow it, and on a loaded runner those take far longer than on an idle one. Half the stubbed pause, so a claim
 * within it still proves that a wake-up, not the pause running out, ended the wait.
 */
const GATE_CLEAR_BOUND_MS = STUBBED_IDLE_PAUSE_MS / 2;

function listeningNotifications() {
	const listeners: { channel: string; listener: (event: StorageNotificationEvent) => void; open: boolean }[] = [];
	const notifications: StorageNotifications = {
		notify: (channel, payload) => ({
			sql: "INSERT INTO gate_notices(channel, payload) VALUES (?, ?)",
			params: [channel, payload],
		}),
		listen(channel, listener) {
			const entry = { channel, listener, open: true };
			listeners.push(entry);
			return {
				close() {
					entry.open = false;
				},
			};
		},
		state: async () => ({ status: "listening" }),
	};
	return {
		notifications,
		deliver(channel: string, payload: string) {
			for (const entry of listeners)
				if (entry.open && entry.channel === channel) entry.listener({ kind: "notification", payload });
		},
	};
}

async function openNoticeRelay(directory: string) {
	const selection = {
		adapter: libsql,
		options: { url: pathToFileURL(join(directory, "shared.db")).href },
		prefix: "acme_",
	};
	transportHolder.notifications = undefined;
	const pollJournal = await resolveRunJournal({ agentDir: join(directory, "poll", "agent"), journal: selection });
	const poll = sqlPoolStorage(pollJournal)!;
	await poll.transaction((tx) =>
		tx.exec(
			"CREATE TABLE IF NOT EXISTS gate_notices(id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, payload TEXT NOT NULL)",
		),
	);
	const transport = listeningNotifications();
	transportHolder.notifications = transport.notifications;
	const journal = await resolveRunJournal({ agentDir: join(directory, "root", "agent"), journal: selection });
	const hostJournal = await resolveRunJournal({ agentDir: join(directory, "host", "agent"), journal: selection });
	let seen = 0;
	let held = false;
	const poller = setInterval(() => {
		if (held) return;
		void poll
			.read((executor) =>
				executor.all<{ id: number; channel: string; payload: string }>(
					"SELECT id, channel, payload FROM gate_notices WHERE id > ? ORDER BY id",
					seen,
				),
			)
			.then((rows) => {
				if (held) return;
				for (const row of rows) {
					seen = Math.max(seen, Number(row.id));
					transport.deliver(String(row.channel), String(row.payload));
				}
			})
			.catch(() => {});
	}, 5);
	return {
		poll,
		journal,
		hostJournal,
		hold(next: boolean) {
			held = next;
		},
		async close() {
			clearInterval(poller);
			await hostJournal.close();
			await journal.close();
			await pollJournal.close();
		},
	};
}

test(
	"an idle satellite claims a ready bound child on a wake-up, not at the end of its idle pause, after a fleet drain clears (#5230)",
	async () => {
		const directory = makeLibsqlDirectory("idle-gate-drain-");
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		const relay = await openNoticeRelay(directory);
		const backend = await JournalDurableBackend.open(relay.journal);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			rootId: "root",
			durable: poolDurableJournal(relay.journal),
			shared: {
				stateDirectory: join(directory, "root", "state"),
				host: "root-host",
				claimWindowMs: 60_000,
			},
			workspace: binding,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const shared = await SqlSharedPool.open(relay.hostJournal, await openSqlPoolQueue(relay.hostJournal));
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		let firstDone = false;
		const parent = workflow({
			name: "idle-gate-drain-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child as never, { inputs: {} });
				firstDone = true;
				await gate;
				await ctx.workflow(child as never, { inputs: {} });
				return {};
			},
		});
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: directory, store: createStore(), durableBackend: backend },
		);
		let host: PoolCoordinator | undefined;
		const restored = join(directory, "restored");
		mkdirSync(restored);
		const restores: number[] = [];
		try {
			let root: Awaited<ReturnType<SqlSharedPool["roots"]>>[number] | undefined;
			for (;;) {
				[root] = await shared.roots();
				if (root !== undefined && root.status === "running") break;
				await sleep(25);
			}
			host = new PoolCoordinator(quietPort([]));
			await host.attachSatellite({
				root: root.root,
				lease: root.lease,
				journal: relay.hostJournal,
				config: root.config,
				sources: root.config.definitions,
				workers: 1,
				durable: poolDurableJournal(relay.hostJournal),
				stateDirectory: join(directory, "host", "state"),
				workerEntry: stubWorker,
				placement: {
					host: "host-b",
					restore: async () => {
						restores.push(performance.now());
						await sleep(10);
						return restored;
					},
					detached: () => {},
					placementFailed: () => {},
				},
			});
			while (!firstDone) await sleep(25);
			await sleep(IDLE_SETTLE_MS);
			vi.spyOn(IdleClaimBackoff.prototype, "next").mockReturnValue(STUBBED_IDLE_PAUSE_MS);
			const runs = relay.poll.tables.runs;
			const refused: number[] = [];
			const claim = SqlPoolQueue.prototype.claim;
			vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (this: SqlPoolQueue, ...args) {
				const result = await claim.call(this, ...args);
				if (args[4]?.kind === "work" && result === undefined) refused.push(performance.now());
				return result;
			});
			await relay.poll.transaction((tx) =>
				tx.exec(
					`CREATE TABLE IF NOT EXISTS ${runs}_fleet_drains(host TEXT PRIMARY KEY, provider_id TEXT, requested_at INTEGER NOT NULL)`,
				),
			);
			await relay.poll.transaction((tx) =>
				tx.run(`INSERT INTO ${runs}_fleet_drains(host, provider_id, requested_at) VALUES (?, NULL, 0)`, "host-b"),
			);
			openGate();
			while (refused.length === 0) await sleep(2);
			await sleep(CLEAR_AFTER_MS);
			await relay.poll.transaction((tx) => tx.run(`DELETE FROM ${runs}_fleet_drains WHERE host = ?`, "host-b"));
			const clearAt = performance.now();
			const result = await execution;
			assert.equal(result.status, "completed");
			assert.equal(restores.length, 2);
			assert.ok(
				restores[1]! - clearAt < GATE_CLEAR_BOUND_MS,
				`the ready child waited ${Math.round(restores[1]! - clearAt)} ms after its fleet drain cleared`,
			);
		} finally {
			openGate();
			await host?.stopSatellite().catch(() => {});
			await host?.shutdown().catch(() => {});
			await pool.close().catch(() => {});
			await execution.catch(() => {});
			await backend.close();
			await relay.close();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a drain retry and a workspace restore backoff share one retry timer without losing either deadline (#5230)",
	async () => {
		const directory = makeLibsqlDirectory("idle-gate-drain-backoff-");
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		const relay = await openNoticeRelay(directory);
		const backend = await JournalDurableBackend.open(relay.journal);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			rootId: "root",
			durable: poolDurableJournal(relay.journal),
			shared: {
				stateDirectory: join(directory, "root", "state"),
				host: "root-host",
				claimWindowMs: 60_000,
			},
			workspace: binding,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const shared = await SqlSharedPool.open(relay.hostJournal, await openSqlPoolQueue(relay.hostJournal));
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		let firstDone = false;
		const parent = workflow({
			name: "idle-gate-drain-backoff-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child as never, { inputs: {} });
				firstDone = true;
				await gate;
				await ctx.workflow(child as never, { inputs: {} });
				return {};
			},
		});
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: directory, store: createStore(), durableBackend: backend },
		);
		let host: PoolCoordinator | undefined;
		const restored = join(directory, "restored");
		mkdirSync(restored);
		const restores: number[] = [];
		const backoff = new RestoreBackoff();
		const key = workspaceAffinityKey(binding);
		try {
			let root: Awaited<ReturnType<SqlSharedPool["roots"]>>[number] | undefined;
			for (;;) {
				[root] = await shared.roots();
				if (root !== undefined && root.status === "running") break;
				await sleep(25);
			}
			host = new PoolCoordinator(quietPort([]));
			await host.attachSatellite({
				root: root.root,
				lease: root.lease,
				journal: relay.hostJournal,
				config: root.config,
				sources: root.config.definitions,
				workers: 1,
				durable: poolDurableJournal(relay.hostJournal),
				stateDirectory: join(directory, "host", "state"),
				workerEntry: stubWorker,
				placement: {
					host: "host-b",
					restoreBackoff: backoff,
					restore: async () => {
						restores.push(performance.now());
						await sleep(10);
						return restored;
					},
					detached: () => {},
					placementFailed: () => {},
				},
			});
			while (!firstDone) await sleep(25);
			vi.spyOn(IdleClaimBackoff.prototype, "next").mockReturnValue(STUBBED_IDLE_PAUSE_MS);
			vi.spyOn(IdleReadyProbe.prototype, "tick").mockResolvedValue();
			await sleep(100);
			const runs = relay.poll.tables.runs;
			await relay.poll.transaction((tx) =>
				tx.exec(
					`CREATE TABLE IF NOT EXISTS ${runs}_fleet_drains(host TEXT PRIMARY KEY, provider_id TEXT, requested_at INTEGER NOT NULL)`,
				),
			);
			await relay.poll.transaction((tx) =>
				tx.run(`INSERT INTO ${runs}_fleet_drains(host, provider_id, requested_at) VALUES (?, NULL, 0)`, "host-b"),
			);
			const refused: number[] = [];
			const claim = SqlPoolQueue.prototype.claim;
			vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (this: SqlPoolQueue, ...args) {
				const result = await claim.call(this, ...args);
				if (args[4]?.kind === "work" && result === undefined && refused.length === 0) {
					backoff.failed(key);
					refused.push(performance.now());
				}
				return result;
			});
			openGate();
			while (refused.length === 0) await sleep(2);
			const failedAt = refused[0]!;
			await sleep(CLEAR_AFTER_MS);
			await relay.poll.transaction((tx) => tx.run(`DELETE FROM ${runs}_fleet_drains WHERE host = ?`, "host-b"));
			const result = await execution;
			assert.equal(result.status, "completed");
			assert.equal(restores.length, 2);
			assert.ok(restores[1]! - failedAt >= 950);
			assert.ok(
				restores[1]! - failedAt < RESTORE_BACKOFF.firstMs + GATE_CLEAR_BOUND_MS,
				`the shared retry timer claimed ${Math.round(restores[1]! - failedAt)} ms after the overlapped drain and restore backoff`,
			);
		} finally {
			openGate();
			await host?.stopSatellite().catch(() => {});
			await host?.shutdown().catch(() => {});
			await pool.close().catch(() => {});
			await execution.catch(() => {});
			await backend.close();
			await relay.close();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"an idle root pool claims a ready child on a wake-up, not at the end of its idle pause, after background checkpoint shipping clears its lag (#5230)",
	async () => {
		const directory = makeLibsqlDirectory("idle-gate-lag-root-");
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		const relay = await openNoticeRelay(directory);
		const backend = await JournalDurableBackend.open(relay.journal);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			rootId: "root",
			durable: poolDurableJournal(relay.journal),
			shared: {
				stateDirectory: join(directory, "root", "state"),
				host: "root-host",
				claimWindowMs: 60_000,
				checkpointShipping: { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 },
			},
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		let firstDone = false;
		const parent = workflow({
			name: "idle-gate-lag-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child as never, { inputs: {} });
				firstDone = true;
				await gate;
				await ctx.workflow(child as never, { inputs: {} });
				return {};
			},
		});
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: directory, store: createStore(), durableBackend: backend },
		);
		try {
			while (!firstDone) await sleep(25);
			await sleep(IDLE_SETTLE_MS);
			vi.spyOn(IdleClaimBackoff.prototype, "next").mockReturnValue(STUBBED_IDLE_PAUSE_MS);
			const taken: number[] = [];
			const claim = SqlPoolQueue.prototype.claim;
			vi.spyOn(SqlPoolQueue.prototype, "claim").mockImplementation(async function (this: SqlPoolQueue, ...args) {
				const result = await claim.call(this, ...args);
				if (result !== undefined) taken.push(performance.now());
				return result;
			});
			let lagged = true;
			let outage = true;
			const gated: number[] = [];
			vi.spyOn(CheckpointShipping.prototype, "lagging").mockImplementation(() => {
				if (lagged) gated.push(performance.now());
				return lagged;
			});
			vi.spyOn(CheckpointShipping.prototype, "flushAll").mockImplementation(async () => {
				if (outage) throw new Error("shared journal unavailable");
			});
			openGate();
			while (gated.length === 0) await sleep(2);
			await sleep(CLEAR_AFTER_MS);
			outage = false;
			lagged = false;
			const clearAt = performance.now();
			const result = await execution;
			assert.equal(result.status, "completed");
			const claimedAt = taken.find((at) => at >= clearAt);
			assert.notEqual(claimedAt, undefined);
			// The pause the cleared gate should end began after the first gated check: a claim at its end, however late
			// the lag cleared, comes a whole stubbed pause after that check.
			assert.ok(
				claimedAt! - gated[0]! < STUBBED_IDLE_PAUSE_MS,
				`the ready child waited out its idle pause: claimed ${Math.round(claimedAt! - gated[0]!)} ms after the gate closed`,
			);
			assert.ok(
				claimedAt! - clearAt < GATE_CLEAR_BOUND_MS,
				`the ready child waited ${Math.round(claimedAt! - clearAt)} ms after checkpoint shipping lag cleared`,
			);
		} finally {
			openGate();
			await pool.close().catch(() => {});
			await execution.catch(() => {});
			await backend.close();
			await relay.close();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"an idle satellite claims a waiting bound child on a wake-up, not at the end of its idle pause, after a sibling worker's restore clears its binding backoff (#5230, #5340)",
	async () => {
		const directory = makeLibsqlDirectory("idle-gate-restore-cleared-");
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		const releaseFile = join(directory, "release");
		writeFileSync(releaseFile, "");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", releaseFile);
		const relay = await openNoticeRelay(directory);
		const backend = await JournalDurableBackend.open(relay.journal);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			rootId: "root",
			durable: poolDurableJournal(relay.journal),
			shared: {
				stateDirectory: join(directory, "root", "state"),
				host: "root-host",
				claimWindowMs: 60_000,
			},
			workspace: binding,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const shared = await SqlSharedPool.open(relay.hostJournal, await openSqlPoolQueue(relay.hostJournal));
		let openGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		let firstDone = false;
		const parent = workflow({
			name: "idle-gate-restore-cleared-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child as never, { inputs: {} });
				firstDone = true;
				await gate;
				await Promise.all([
					ctx.workflow(child as never, { inputs: {} }),
					ctx.workflow(child as never, { inputs: {} }),
				]);
				return {};
			},
		});
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: directory, store: createStore(), durableBackend: backend },
		);
		let host: PoolCoordinator | undefined;
		const restored = join(directory, "restored");
		mkdirSync(restored);
		const restores: number[] = [];
		const succeededAt: number[] = [];
		const restoreRetryMs = STUBBED_IDLE_PAUSE_MS * 4;
		const backoff = new RestoreBackoff(undefined, { firstMs: restoreRetryMs, maxMs: restoreRetryMs });
		const key = workspaceAffinityKey(binding);
		const siblingRestoring = Promise.withResolvers<void>();
		const waitingAfterFailure = Promise.withResolvers<void>();
		const finishSiblingRestore = Promise.withResolvers<void>();
		let retryAt = Number.POSITIVE_INFINITY;
		let idleRetryAt = Number.POSITIVE_INFINITY;
		try {
			let root: Awaited<ReturnType<SqlSharedPool["roots"]>>[number] | undefined;
			for (;;) {
				[root] = await shared.roots();
				if (root !== undefined && root.status === "running") break;
				await sleep(25);
			}
			host = new PoolCoordinator(quietPort([]));
			await host.attachSatellite({
				root: root.root,
				lease: root.lease,
				journal: relay.hostJournal,
				config: root.config,
				sources: root.config.definitions,
				workers: 2,
				durable: poolDurableJournal(relay.hostJournal),
				stateDirectory: join(directory, "host", "state"),
				workerEntry: stubWorker,
				placement: {
					host: "host-b",
					restoreBackoff: backoff,
					restore: async () => {
						restores.push(performance.now());
						const call = restores.length;
						if (call === 2) {
							await siblingRestoring.promise;
							throw new Error("the remote is unreachable");
						}
						if (call === 3) {
							relay.hold(true);
							siblingRestoring.resolve();
							await finishSiblingRestore.promise;
							succeededAt.push(performance.now());
							return restored;
						}
						await sleep(10);
						return restored;
					},
					detached: () => {},
					placementFailed: () => {},
				},
			});
			while (!firstDone) await sleep(25);
			rmSync(releaseFile, { force: true });
			await sleep(IDLE_SETTLE_MS);
			vi.spyOn(IdleReadyProbe.prototype, "tick").mockResolvedValue();
			vi.spyOn(IdleClaimBackoff.prototype, "next").mockImplementation(() => {
				const remaining = backoff.remaining(key);
				if (remaining > 0) {
					const now = performance.now();
					retryAt = Math.min(retryAt, now + remaining);
					idleRetryAt = Math.min(idleRetryAt, now + STUBBED_IDLE_PAUSE_MS);
					waitingAfterFailure.resolve();
				}
				return STUBBED_IDLE_PAUSE_MS;
			});
			openGate();
			await waitingAfterFailure.promise;
			while ((await shared.restoreFailure(key)) === undefined) await sleep(2);
			await sleep(CLEAR_AFTER_MS);
			assert.equal(restores.length, 3);
			assert.ok(backoff.remaining(key) > GATE_CLEAR_BOUND_MS);
			finishSiblingRestore.resolve();
			for (let waited = 0; restores.length < 4; waited++) {
				if (waited > 2_000) {
					writeFileSync(releaseFile, "");
					throw new Error(`the waiting child never retried its restore: restores=${restores.length}`);
				}
				await sleep(10);
			}
			relay.hold(false);
			writeFileSync(releaseFile, "");
			const result = await execution;
			assert.equal(result.status, "completed");
			assert.equal(restores.length, 4);
			assert.equal(succeededAt.length, 1);
			assert.equal(existsSync(releaseFile), true);
			assert.ok(restores[3]! >= succeededAt[0]!, "the waiting child retried before its sibling cleared the backoff");
			assert.ok(restores[3]! < retryAt, "the waiting child waited for its own restore retry deadline");
			assert.ok(restores[3]! < idleRetryAt, "the waiting child waited out its idle pause");
			assert.ok(
				restores[3]! - succeededAt[0]! < GATE_CLEAR_BOUND_MS,
				`a ready child whose binding backoff was cleared by another worker's restore waited ${Math.round(restores[3]! - succeededAt[0]!)} ms`,
			);
		} finally {
			relay.hold(false);
			siblingRestoring.resolve();
			finishSiblingRestore.resolve();
			writeFileSync(releaseFile, "");
			openGate();
			await host?.stopSatellite().catch(() => {});
			await host?.shutdown().catch(() => {});
			await pool.close().catch(() => {});
			await execution.catch(() => {});
			await backend.close();
			await relay.close();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"an idle satellite claims a ready bound child whose restore backoff expires while a later candidate's preference check runs (#5230)",
	async () => {
		const directory = makeLibsqlDirectory("idle-gate-prefer-expiry-");
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		const relay = await openNoticeRelay(directory);
		const backend = await JournalDurableBackend.open(relay.journal);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const bindingA = { ...binding, tree: "t1" };
		const bindingB = { ...binding, tree: "t2" };
		const activeBinding = { ...bindingA };
		const pool = new LocalWorkerPool(backend, {
			rootId: "root",
			durable: poolDurableJournal(relay.journal),
			shared: {
				stateDirectory: join(directory, "root", "state"),
				host: "root-host",
				claimWindowMs: 60_000,
			},
			workspace: activeBinding,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const queue = await openSqlPoolQueue(relay.hostJournal);
		const shared = await SqlSharedPool.open(relay.hostJournal, queue);
		let openGateA!: () => void;
		const gateA = new Promise<void>((resolve) => {
			openGateA = resolve;
		});
		let openGateB!: () => void;
		const gateB = new Promise<void>((resolve) => {
			openGateB = resolve;
		});
		let firstDone = false;
		const parent = workflow({
			name: "idle-gate-prefer-expiry-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				await ctx.workflow(child as never, { inputs: {} });
				firstDone = true;
				await gateA;
				const first = ctx.workflow(child as never, { inputs: {} });
				await gateB;
				const second = ctx.workflow(child as never, { inputs: {} });
				await Promise.all([first, second]);
				return {};
			},
		});
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: directory, store: createStore(), durableBackend: backend },
		);
		let host: PoolCoordinator | undefined;
		const restored = join(directory, "restored");
		mkdirSync(restored);
		const restores: { tree: string; at: number }[] = [];
		const backoff = new RestoreBackoff();
		const keyA = workspaceAffinityKey(bindingA);
		const keyB = workspaceAffinityKey(bindingB);
		let preferBReleasedAt: number | undefined;
		try {
			let root: Awaited<ReturnType<SqlSharedPool["roots"]>>[number] | undefined;
			for (;;) {
				[root] = await shared.roots();
				if (root !== undefined && root.status === "running") break;
				await sleep(25);
			}
			host = new PoolCoordinator(quietPort([]));
			await host.attachSatellite({
				root: root.root,
				lease: root.lease,
				journal: relay.hostJournal,
				config: root.config,
				sources: root.config.definitions,
				workers: 1,
				durable: poolDurableJournal(relay.hostJournal),
				stateDirectory: join(directory, "host", "state"),
				workerEntry: stubWorker,
				placement: {
					host: "host-b",
					restoreBackoff: backoff,
					prefer: async (requested) => {
						if (requested.tree === "t2" && preferBReleasedAt === undefined) {
							while (backoff.remaining(keyA) > 0) await sleep(10);
							await sleep(50);
							preferBReleasedAt = performance.now();
						}
						return undefined;
					},
					restore: async (requested) => {
						restores.push({ tree: requested.tree, at: performance.now() });
						if (requested.tree === "t1" && restores.length >= 2) backoff.succeeded(keyB);
						await sleep(10);
						return restored;
					},
					detached: () => {},
					placementFailed: () => {},
				},
			});
			while (!firstDone) await sleep(25);
			vi.spyOn(IdleClaimBackoff.prototype, "next").mockReturnValue(STUBBED_IDLE_PAUSE_MS);
			vi.spyOn(IdleReadyProbe.prototype, "tick").mockResolvedValue();
			await sleep(100);
			relay.hold(true);
			activeBinding.tree = "t1";
			openGateA();
			while ((await queue.inspect("root")).filter((work) => work.state === "ready").length < 1) await sleep(5);
			activeBinding.tree = "t2";
			openGateB();
			while ((await queue.inspect("root")).filter((work) => work.state === "ready").length < 2) await sleep(5);
			for (let failure = 0; failure < 6; failure++) backoff.failed(keyB);
			backoff.failed(keyA);
			relay.hold(false);
			const result = await execution;
			assert.equal(result.status, "completed");
			assert.notEqual(preferBReleasedAt, undefined);
			const retriedA = restores.slice(1).find((entry) => entry.tree === "t1");
			assert.notEqual(retriedA, undefined);
			assert.ok(
				retriedA!.at - preferBReleasedAt! < GATE_CLEAR_BOUND_MS,
				`the ready child whose restore backoff expired during prefer(B) waited ${Math.round(retriedA!.at - preferBReleasedAt!)} ms`,
			);
		} finally {
			relay.hold(false);
			openGateA();
			openGateB();
			await host?.stopSatellite().catch(() => {});
			await host?.shutdown().catch(() => {});
			await pool.close().catch(() => {});
			await execution.catch(() => {});
			await backend.close();
			await relay.close();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
