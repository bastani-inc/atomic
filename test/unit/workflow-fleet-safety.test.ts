import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { observeSqlPoolTransactions, sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { FLEET_DRAIN_TIMEOUT_MS, SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import type { ProvisionedHost, WorkerHostProvisioner } from "../../packages/workflows/src/workers/autoscaler.js";
import {
	FleetController,
	joinHosts,
	type WorkflowFleetEvent,
} from "../../packages/workflows/src/workers/fleet-controller.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { sleep } from "../helpers/runtime.js";

const PREFIX = "acme_";
const TICK_MS = 100;
/** How long a test waits for the controller's ticks to reach a state, however slowly they come under load. */
const FLEET_TICKS_WAIT_MS = 10_000;
const TICKS_WAIT = { timeout: FLEET_TICKS_WAIT_MS, interval: 10 };
const definition = { definition: "fixture/child", digest: "sha256:child" };
const config = {
	definitions: [],
	leaseMs: 60_000,
	heartbeatMs: 15_000,
	startupTimeoutMs: 60_000,
	claimWindowMs: 60_000,
};

/**
 * The journal's database: a libSQL file, or, while `FLEET_SAFETY_BACKEND` is `postgres` (as
 * test/integration/workflow-fleet-safety-postgres.test.ts sets it), a PostgreSQL database of its own (#4793).
 */
async function openFleetDatabase(): Promise<{ readonly database: SqliteDatabase; close(): Promise<void> }> {
	if (process.env.FLEET_SAFETY_BACKEND === "postgres") {
		const { storageBackends } = await import("../helpers/storage-backends.js");
		const scope = await storageBackends.find((backend) => backend.name === "Postgres")!.openScope();
		return { database: await scope.connect(), close: () => scope.close() };
	}
	const directory = makeLibsqlDirectory();
	const database = await openLibsqlDatabase({ url: pathToFileURL(join(directory, "journal.db")).href });
	return {
		database,
		async close() {
			await database.close();
			await removeLibsqlDirectory(directory);
		},
	};
}

async function fixture() {
	const { database, close } = await openFleetDatabase();
	const journal = await SqlRunJournal.open(database, { prefix: PREFIX });
	await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
	const lease = ((await journal.acquire("root", "coordinator")) as { lease: Lease }).lease;
	const queue = await openSqlPoolQueue(journal);
	await queue.initialize(lease, 60_000);
	const shared = await SqlSharedPool.open(journal, queue);
	await shared.publishConfig(lease, config);
	const store = await SqlFleetStore.open(journal);
	const storage = sqlPoolStorage(journal)!;
	const sql = (text: string) => storage.transaction((tx) => tx.run(text));
	/** The database clock, in integer milliseconds, as SQL. */
	const now = storage.dialect.nowMs;
	const report = (host: string, providerId?: string, draining?: boolean) =>
		shared.reportHost({
			...(draining === undefined ? {} : { draining }),
			host,
			labels: {},
			git: "unavailable",
			restore: false,
			workers: 1,
			maxWorkers: 1,
			roots: ["root"],
			...(providerId === undefined ? {} : { providerId }),
		});
	const controllers: FleetController[] = [];
	return {
		leasesTable: storage.tables.leases,
		journal,
		lease,
		queue,
		shared,
		store,
		sql,
		now,
		report,
		controller(provisioner: WorkerHostProvisioner, events: WorkflowFleetEvent[] = [], policy = {}) {
			const started = new FleetController(journal, {
				provisioner,
				tickMs: TICK_MS,
				...policy,
				onEvent: (e) => events.push(e),
			});
			controllers.push(started);
			return started;
		},
		async close() {
			for (const c of controllers) await c.stop();
			await journal.close();
			await close();
		},
	};
}

/** Puts a drain row as a previous controller would have, then frees the lease. */
async function seedDrain(store: SqlFleetStore, host: string, providerId: string) {
	const { epoch } = await store.acquire("previous", undefined, 60_000);
	assert.equal(await store.requestDrain({ holder: "previous", epoch }, host, providerId), true);
	await store.release({ holder: "previous", epoch });
}

test("a drained instance is kept while an unmatched restarted host on it holds a live lease, however old its last report (#5072)", async () => {
	const f = await fixture();
	try {
		await seedDrain(f.store, "h1", "vm-1");
		// h1 ran without a provider id and restarted on vm-1 as h2; the provider still names h1 for vm-1.
		const { work, boundary } = poolWorkFixture("busy");
		await f.queue.enqueue(f.lease, work, boundary);
		assert.ok(await f.queue.claim(f.lease, "h2/worker-1", [definition], 60_000));
		await f.report("h2");
		// Its last report is 35 s old (a 35 s journal hiccup on that host): FLEET_HOST_LIVE_MS is 30 s.
		await f.sql(`UPDATE ${PREFIX}wf_runs_pool_hosts SET heartbeat_at = heartbeat_at - 35000 WHERE host = 'h2'`);
		const removed: string[] = [];
		const provisioner: WorkerHostProvisioner = {
			kind: "fake",
			async list(): Promise<readonly ProvisionedHost[]> {
				return [{ id: "vm-1", hostId: "h1", state: "running", since: 0 }];
			},
			async scaleTo() {},
			async drain(id) {
				removed.push(id);
			},
		};
		f.controller(provisioner);
		await sleep(10 * TICK_MS);
		assert.deepEqual(removed, [], "the instance an unmatched busy host runs on must not be removed");
	} finally {
		await f.close();
	}
});

test("a drained instance is kept while an unmatched restarted host with a fresh report holds a lease (#5072)", async () => {
	const f = await fixture();
	try {
		await seedDrain(f.store, "h1", "vm-1");
		const { work, boundary } = poolWorkFixture("busy");
		await f.queue.enqueue(f.lease, work, boundary);
		assert.ok(await f.queue.claim(f.lease, "h2/worker-1", [definition], 60_000));
		await f.report("h2");
		const removed: string[] = [];
		f.controller({
			kind: "fake",
			async list() {
				return [{ id: "vm-1", hostId: "h1", state: "running", since: 0 }];
			},
			async scaleTo() {},
			async drain(id) {
				removed.push(id);
			},
		});
		await sleep(10 * TICK_MS);
		assert.deepEqual(removed, []);
	} finally {
		await f.close();
	}
});

test("an idle host is drained when the only leased work on it belongs to a dead root and its work lease expired (#5072)", async () => {
	const f = await fixture();
	try {
		const { work, boundary } = poolWorkFixture("orphan");
		await f.queue.enqueue(f.lease, work, boundary);
		assert.ok(await f.queue.claim(f.lease, "h1/worker-1", [definition], 1_000));
		// The root process is killed: it stops renewing its lease, and its status stays 'running'. The child's work
		// lease expires too, and its worker is gone; nothing will ever settle the row until someone resumes the root.
		await f.sql(`UPDATE ${f.leasesTable} SET renewed_at = 0 WHERE run_id = 'root'`);
		await sleep(1_200);
		const events: WorkflowFleetEvent[] = [];
		f.controller(
			{
				kind: "fake",
				async list() {
					return [{ id: "vm-1", state: "running", since: 0 }];
				},
				async scaleTo() {},
				async drain() {},
			},
			events,
			{ idleDrainMs: 0, minHosts: 0 },
		);
		// The host on vm-1 keeps reporting itself, idle (its worker lost the child when the root died), until the drain
		// comes: however few ticks a loaded machine runs meanwhile.
		await vi.waitFor(
			async () => {
				await f.report("h1", "vm-1");
				assert.ok(
					events.some((e) => e.kind === "drain-requested"),
					"an idle host whose only lease belongs to a dead root, with an expired work lease, should be drained to the floor",
				);
			},
			{ ...TICKS_WAIT, interval: TICK_MS },
		);
	} finally {
		await f.close();
	}
});

test("a controller stalled past its lease makes no provider call (#5072)", async () => {
	const f = await fixture();
	try {
		// vm-1 drained and its host left: the plan removes it.
		await seedDrain(f.store, "h1", "vm-1");
		const removed: { id: string; holderAtCall: string }[] = [];
		let lists = 0;
		const provisioner: WorkerHostProvisioner = {
			kind: "slow-sync",
			async list() {
				lists++;
				if (lists === 1) {
					// Another controller takes over while this one is stalled (a VM pause, a long GC, a sync CLI call).
					await f.sql(
						`UPDATE ${PREFIX}wf_runs_fleet_controller SET holder = 'other', epoch = epoch + 1, renewed_at = ${f.now}, lease_ms = 600000`,
					);
					const until = Date.now() + 5 * TICK_MS;
					while (Date.now() < until) {
						// the event loop is blocked: no timer runs
					}
				}
				return [{ id: "vm-1", state: "running", since: 0 }];
			},
			async scaleTo() {},
			async drain(id) {
				const row = (await f.store.acquire("probe", undefined, 1)) as { holder?: string };
				removed.push({ id, holderAtCall: row.holder ?? "?" });
			},
		};
		f.controller(provisioner);
		await sleep(10 * TICK_MS);
		assert.deepEqual(removed, [], "a controller that no longer holds the lease makes no provider call");
	} finally {
		await f.close();
	}
});

test("a drained host that only stopped reporting is not removed while it is still in the registry (#5072)", async () => {
	const f = await fixture();
	try {
		await f.report("h1", "vm-1");
		await seedDrain(f.store, "h1", "vm-1");
		// h1 has not polled since (it reads drains with its next report): its row says draining = 0 and it never left.
		await f.sql(`UPDATE ${PREFIX}wf_runs_pool_hosts SET heartbeat_at = heartbeat_at - 35000 WHERE host = 'h1'`);
		const removed: string[] = [];
		f.controller({
			kind: "fake",
			async list() {
				return [{ id: "vm-1", state: "running", since: 0 }];
			},
			async scaleTo() {},
			async drain(id) {
				removed.push(id);
			},
		});
		await sleep(5 * TICK_MS);
		assert.deepEqual(removed, [], "a host still in the registry that never reported draining has not drained");
	} finally {
		await f.close();
	}
});

test("a drained host that confirmed its drain and left the registry is removed (#5072)", async () => {
	const f = await fixture();
	try {
		await f.report("h1", "vm-1");
		await seedDrain(f.store, "h1", "vm-1");
		await f.shared.forgetHost("h1");
		const removed: string[] = [];
		f.controller({
			kind: "fake",
			async list() {
				return [{ id: "vm-1", state: "running", since: 0 }];
			},
			async scaleTo() {},
			async drain(id) {
				removed.push(id);
			},
		});
		await vi.waitFor(() => assert.ok(removed.includes("vm-1")), TICKS_WAIT);
	} finally {
		await f.close();
	}
});

test("a drained host still in the registry is removed once its drain timed out with no lease held (#5072)", async () => {
	const f = await fixture();
	try {
		await f.report("h1", "vm-1");
		await seedDrain(f.store, "h1", "vm-1");
		await f.sql(`UPDATE ${PREFIX}wf_runs_pool_hosts SET heartbeat_at = heartbeat_at - 35000 WHERE host = 'h1'`);
		await f.sql(
			`UPDATE ${PREFIX}wf_runs_fleet_drains SET requested_at = requested_at - ${FLEET_DRAIN_TIMEOUT_MS} WHERE host = 'h1'`,
		);
		const removed: string[] = [];
		f.controller({
			kind: "fake",
			async list() {
				return [{ id: "vm-1", state: "running", since: 0 }];
			},
			async scaleTo() {},
			async drain(id) {
				removed.push(id);
			},
		});
		await vi.waitFor(() => assert.ok(removed.includes("vm-1")), TICKS_WAIT);
	} finally {
		await f.close();
	}
});

test("a drained host whose drain timed out is kept while it holds a live lease (#5072)", async () => {
	const f = await fixture();
	try {
		await f.report("h1", "vm-1");
		await seedDrain(f.store, "h1", "vm-1");
		const { work, boundary } = poolWorkFixture("busy");
		await f.queue.enqueue(f.lease, work, boundary);
		assert.ok(await f.queue.claim(f.lease, "h1/worker-1", [definition], 60_000));
		await f.sql(
			`UPDATE ${PREFIX}wf_runs_fleet_drains SET requested_at = requested_at - ${FLEET_DRAIN_TIMEOUT_MS} WHERE host = 'h1'`,
		);
		const removed: string[] = [];
		f.controller({
			kind: "fake",
			async list() {
				return [{ id: "vm-1", state: "running", since: 0 }];
			},
			async scaleTo() {},
			async drain(id) {
				removed.push(id);
			},
		});
		await sleep(5 * TICK_MS);
		assert.deepEqual(removed, []);
	} finally {
		await f.close();
	}
});

test("a worker host's claim takes nothing once its host or its instance was asked to drain, before it reads the drain (#5072)", async () => {
	const f = await fixture();
	try {
		const { work, boundary } = poolWorkFixture("next");
		await f.queue.enqueue(f.lease, work, boundary);
		const [candidate] = await f.queue.readyCandidates(f.lease, [definition], 10);
		assert.ok(candidate);
		const placement = (host: { id: string; providerId?: string }) => ({
			kind: "work" as const,
			id: candidate.id,
			generation: candidate.generation,
			host,
		});
		await seedDrain(f.store, "h0", "vm-1");
		await seedDrain(f.store, "h2", "vm-2");
		// h1 restarted on the drained vm-1; h2 itself was asked to drain.
		assert.equal(
			await f.queue.claim(f.lease, "h1/worker-1", [definition], 60_000, placement({ id: "h1", providerId: "vm-1" })),
			undefined,
		);
		assert.equal(
			await f.queue.claim(f.lease, "h2/worker-1", [definition], 60_000, placement({ id: "h2" })),
			undefined,
		);
		assert.ok(
			await f.queue.claim(f.lease, "h3/worker-1", [definition], 60_000, placement({ id: "h3", providerId: "vm-3" })),
			"a host nobody asked to drain claims",
		);
	} finally {
		await f.close();
	}
});

test("a host that registers after the snapshot is not removed for a boot timeout (#5072)", async () => {
	const f = await fixture();
	const snapshot = SqlFleetStore.prototype.snapshot;
	let snapshots = 0;
	const spy = vi.spyOn(SqlFleetStore.prototype, "snapshot").mockImplementation(async function (this: SqlFleetStore) {
		const taken = await snapshot.call(this);
		// The host boots and registers right after the second tick read the registry, which times its boot out.
		if (++snapshots === 2) {
			await f.report("h1", "vm-1");
			// A host the provider names by host id registers without a provider id.
			await f.report("h2");
		}
		return taken;
	});
	try {
		const removed: string[] = [];
		f.controller(
			{
				kind: "fake",
				async list(): Promise<readonly ProvisionedHost[]> {
					const listed: ProvisionedHost[] = [
						{ id: "vm-1", state: "running", since: 0 },
						{ id: "vm-2", hostId: "h2", state: "running", since: 0 },
						{ id: "vm-3", state: "running", since: 0 },
					];
					return listed.filter((provided) => !removed.includes(provided.id));
				},
				async scaleTo() {},
				async drain(id) {
					removed.push(id);
				},
			},
			[],
			{ bootTimeoutMs: 1, minHosts: 3 },
		);
		// Ticks, not time: under load five ticks' worth of time held fewer than the removal and the ticks after it.
		await vi.waitFor(() => assert.ok(removed.length > 0, "the instance whose host never registered is removed"), {
			timeout: FLEET_TICKS_WAIT_MS,
			interval: 10,
		});
		const ticksAtRemoval = snapshots;
		await vi.waitFor(() => assert.ok(snapshots >= ticksAtRemoval + 3, "three more ticks read the registry"), {
			timeout: FLEET_TICKS_WAIT_MS,
			interval: 10,
		});
		assert.deepEqual(removed, ["vm-3"], "only the instance whose host never registered is removed");
		assert.deepEqual(
			(await f.store.snapshot()).drains.filter((drain) => drain.providerId !== "vm-3"),
			[],
			"the drain written for a removal that did not happen is cleared, so the hosts kept serve",
		);
	} finally {
		spy.mockRestore();
		await f.close();
	}
});

test("joinHosts says a drain is over only once no host on the instance is registered, or its latest drain timed out (#5072)", () => {
	const listed = [
		{ id: "vm-a", state: "draining" as const, since: 0 },
		{ id: "vm-b", state: "draining" as const, since: 0 },
		{ id: "vm-c", state: "running" as const, since: 0 },
		{ id: "vm-d", state: "running" as const, since: 0 },
		{ id: "vm-e", state: "running" as const, since: 0 },
	];
	const joined = joinHosts(listed, {
		roots: [],
		hosts: [
			{ host: "ha", providerId: "vm-a", live: true, leased: 0 },
			{ host: "hc", providerId: "vm-c", live: false, leased: 0 },
			{ host: "hd", providerId: "vm-d", live: false, leased: 0 },
			{ host: "he", providerId: "vm-e", live: true, leased: 0 },
		],
		drains: [
			{ host: "hc", providerId: "vm-c", agoMs: FLEET_DRAIN_TIMEOUT_MS },
			{ host: "hc2", providerId: "vm-c", agoMs: 0 },
			{ host: "hd", providerId: "vm-d", agoMs: FLEET_DRAIN_TIMEOUT_MS },
			{ host: "he", providerId: "vm-e", agoMs: 0 },
		],
		leased: new Map(),
	});
	assert.deepEqual(
		joined.map((entry) => [entry.view.id, entry.view.drained]),
		[
			// The provider drains vm-a itself, and its host is still registered.
			["vm-a", false],
			// The provider drains vm-b, and no host on it is registered.
			["vm-b", true],
			// A drain carried to vm-c's restarted host just now restarts the wait.
			["vm-c", false],
			["vm-d", true],
			["vm-e", false],
		],
	);
});

test("an instance whose worker died after registering is removed for its boot timeout and replaced (#5072)", async () => {
	const f = await fixture();
	try {
		// h1 registered on vm-1 once, then its process was killed: its row stays, and it never reports again.
		await f.report("h1", "vm-1");
		await f.sql(`UPDATE ${PREFIX}wf_runs_pool_hosts SET heartbeat_at = heartbeat_at - 3600000 WHERE host = 'h1'`);
		const removed: string[] = [];
		let lists = 0;
		f.controller(
			{
				kind: "fake",
				async list() {
					lists++;
					return removed.includes("vm-1") ? [] : [{ id: "vm-1", state: "running", since: 0 }];
				},
				async scaleTo() {},
				async drain(id) {
					removed.push(id);
				},
			},
			[],
			{ bootTimeoutMs: 200, minHosts: 1 },
		);
		// Ticks, not time: under load thirty ticks' worth of time held too few ticks to time the boot out.
		await vi.waitFor(() => assert.ok(removed.length > 0, "the instance is removed for its boot timeout"), {
			timeout: FLEET_TICKS_WAIT_MS,
			interval: 10,
		});
		const listsAtRemoval = lists;
		await vi.waitFor(() => assert.ok(lists >= listsAtRemoval + 3, "three more ticks list the instances"), {
			timeout: FLEET_TICKS_WAIT_MS,
			interval: 10,
		});
		assert.deepEqual(removed, ["vm-1"]);
	} finally {
		await f.close();
	}
});

test("a controller whose machine slept past its lease makes no provider call, though the monotonic clock stopped (#5072)", async () => {
	const f = await fixture();
	const realNow = performance.now.bind(performance);
	let suspended = 0;
	const spy = vi.spyOn(performance, "now").mockImplementation(() => realNow() - suspended);
	try {
		await seedDrain(f.store, "h1", "vm-1");
		const removed: string[] = [];
		let lists = 0;
		f.controller({
			kind: "fake",
			async list() {
				lists++;
				if (lists === 1) {
					await f.sql(
						`UPDATE ${PREFIX}wf_runs_fleet_controller SET holder = 'other', epoch = epoch + 1, renewed_at = ${f.now}, lease_ms = 600000`,
					);
					// A system suspend: nothing runs, and the wall and database clocks move on while CLOCK_MONOTONIC does not.
					const start = realNow();
					while (realNow() - start < 5 * TICK_MS) {
						// suspended
					}
					suspended += realNow() - start;
				}
				return [{ id: "vm-1", state: "running", since: 0 }];
			},
			async scaleTo() {},
			async drain(id) {
				removed.push(id);
			},
		});
		await sleep(10 * TICK_MS);
		assert.deepEqual(removed, [], "a controller whose lease lapsed during a suspend makes no provider call");
	} finally {
		spy.mockRestore();
		await f.close();
	}
});

test("an instance removed for its boot timeout is drained first, so a host that registers on it meanwhile claims nothing (#5072)", async () => {
	const f = await fixture();
	try {
		const { work, boundary } = poolWorkFixture("late");
		await f.queue.enqueue(f.lease, work, boundary);
		const [candidate] = await f.queue.readyCandidates(f.lease, [definition], 10);
		assert.ok(candidate);
		const claims: unknown[] = [];
		f.controller(
			{
				kind: "fake",
				async list() {
					return claims.length > 0 ? [] : [{ id: "vm-1", hostId: "h1", state: "running", since: 0 }];
				},
				async scaleTo() {},
				async drain() {
					// The host on vm-1 registers and claims just as the provider is asked to delete it.
					await f.report("h1", "vm-1");
					claims.push(
						await f.queue.claim(f.lease, "h1/worker-1", [definition], 60_000, {
							kind: "work",
							id: candidate.id,
							generation: candidate.generation,
							host: { id: "h1", providerId: "vm-1" },
						}),
					);
				},
			},
			[],
			{ bootTimeoutMs: 1 },
		);
		await vi.waitFor(
			() => assert.ok(claims.length > 0, "the host on the instance being removed tried to claim"),
			TICKS_WAIT,
		);
		assert.deepEqual(claims, [undefined], "the host on the instance being removed claims nothing");
	} finally {
		await f.close();
	}
});

test("an instance removed for its boot timeout is kept while a host that registered on it during the tick holds a child, though it went quiet (#5072)", async () => {
	const f = await fixture();
	try {
		const { work, boundary } = poolWorkFixture("late");
		await f.queue.enqueue(f.lease, work, boundary);
		const removed: string[] = [];
		f.controller(
			{
				kind: "fake",
				async list() {
					return ["vm-0", "vm-1"]
						.filter((id) => !removed.includes(id))
						.map((id) => ({ id, state: "pending" as const, since: 0 }));
				},
				async scaleTo() {},
				async drain(id) {
					if (id === "vm-0" && !removed.includes("vm-0")) {
						// While vm-0's removal runs, the worker on vm-1 boots, registers and takes a child...
						await f.report("h1", "vm-1");
						const [candidate] = await f.queue.readyCandidates(f.lease, [definition], 10);
						assert.ok(
							await f.queue.claim(f.lease, "h1/worker-1", [definition], 60_000, {
								kind: "work",
								id: candidate!.id,
								generation: candidate!.generation,
								host: { id: "h1", providerId: "vm-1" },
							}),
						);
						// ...and then goes 35 s without reporting, its child still running.
						await f.sql(
							`UPDATE ${PREFIX}wf_runs_pool_hosts SET heartbeat_at = heartbeat_at - 35000 WHERE host = 'h1'`,
						);
					}
					removed.push(id);
				},
			},
			[],
			{ bootTimeoutMs: 200, minHosts: 0 },
		);
		await vi.waitFor(() => assert.ok(removed.includes("vm-0")), TICKS_WAIT);
		// What must not happen is given the ticks it would take to happen.
		await sleep(20 * TICK_MS);
		assert.ok(!removed.includes("vm-1"), "an instance whose host holds a live lease is not removed");
	} finally {
		await f.close();
	}
});

test("an instance whose late host read its boot-timeout drain and is draining is removed once that host leaves, not after another boot timeout (#5072)", async () => {
	const f = await fixture();
	const carryDrain = SqlFleetStore.prototype.carryDrain;
	const spy = vi.spyOn(SqlFleetStore.prototype, "carryDrain").mockImplementation(async function (
		this: SqlFleetStore,
		...args: Parameters<typeof carryDrain>
	) {
		await carryDrain.apply(this, args);
		// The host on vm-1 registers right after the drain was written, reads it at its poll, and starts draining.
		await f.report("h1", "vm-1", true);
	});
	try {
		const events: WorkflowFleetEvent[] = [];
		const removed: string[] = [];
		f.controller(
			{
				kind: "fake",
				async list() {
					return removed.includes("vm-1") ? [] : [{ id: "vm-1", state: "running", since: 0 }];
				},
				async scaleTo() {},
				async drain(id) {
					removed.push(id);
				},
			},
			events,
			{ bootTimeoutMs: 1, minHosts: 0 },
		);
		await sleep(3 * TICK_MS);
		assert.deepEqual(removed, [], "the instance waits for its draining host");
		spy.mockRestore();
		// The host finished draining and left the registry.
		await f.shared.forgetHost("h1");
		await vi.waitFor(
			() =>
				assert.ok(
					events.some((event) => event.kind === "removed"),
					"the instance is removed once its host left",
				),
			TICKS_WAIT,
		);
		assert.deepEqual(
			events.flatMap((event) => (event.kind === "removed" ? [[event.id, event.reason]] : [])),
			[["vm-1", "drained"]],
		);
	} finally {
		spy.mockRestore();
		await f.close();
	}
});

test("bootHold keeps an instance for a host that reports, registered after the snapshot, holds a live child, or drains (#5072)", async () => {
	const f = await fixture();
	try {
		const none = new Set<string>();
		assert.equal(await f.store.bootHold("vm-0", undefined, none), "free", "nobody on it");
		await f.report("fresh", "vm-1");
		assert.equal(await f.store.bootHold("vm-1", undefined, new Set(["fresh"])), "occupied", "a host that reports");
		await f.report("named");
		assert.equal(
			await f.store.bootHold("vm-2", "named", new Set(["named"])),
			"occupied",
			"a reporting host the provider names by host id",
		);
		await f.report("stale", "vm-3");
		await f.sql(`UPDATE ${PREFIX}wf_runs_pool_hosts SET heartbeat_at = heartbeat_at - 35000 WHERE host = 'stale'`);
		assert.equal(
			await f.store.bootHold("vm-3", undefined, new Set(["stale"])),
			"free",
			"a dead host holding nothing",
		);
		assert.equal(await f.store.bootHold("vm-3", undefined, none), "occupied", "a host registered after the snapshot");
		await f.report("leaving", "vm-4", true);
		assert.equal(await f.store.bootHold("vm-4", undefined, new Set(["leaving"])), "draining");
		// A host that is not in the registry, which the provider names, holds a live child.
		const { work, boundary } = poolWorkFixture("held");
		await f.queue.enqueue(f.lease, work, boundary);
		assert.ok(await f.queue.claim(f.lease, "gone/worker-1", [definition], 60_000));
		assert.equal(await f.store.bootHold("vm-5", "gone", none), "occupied", "a host holding a live child");
		assert.equal(await f.store.bootHold("vm-5", undefined, none), "free");
	} finally {
		await f.close();
	}
});

test("bootHold finds an instance free in a journal that never ran a shared pool (#5072)", async () => {
	const { database, close } = await openFleetDatabase();
	const journal = await SqlRunJournal.open(database, { prefix: PREFIX });
	try {
		const store = await SqlFleetStore.open(journal);
		assert.equal(await store.bootHold("vm-1", "h1", new Set()), "free");
	} finally {
		await journal.close();
		await close();
	}
});

test("a host that reads a drain naming it is draining for the controller at once, before its next report (#5072)", async () => {
	const f = await fixture();
	try {
		await f.report("h1", "vm-1");
		await f.report("h2", "vm-2");
		// The controller drained vm-1 for its boot timeout; h1 registered on it just before.
		await seedDrain(f.store, "boot-timeout:vm-1", "vm-1");
		assert.equal(await f.shared.drainRequested("h1", "vm-1"), true);
		// Before h1 acts on the drain or reports again, the controller checks the instance once more.
		assert.equal(await f.store.bootHold("vm-1", undefined, new Set(["h1"])), "draining");
		assert.equal(await f.shared.drainRequested("h2", "vm-2"), false);
		assert.equal(await f.store.bootHold("vm-2", undefined, new Set(["h2"])), "occupied", "a host not asked serves");
	} finally {
		await f.close();
	}
});

test("a host that reads drains takes the write lock only when a drain names it (#5072)", async () => {
	const f = await fixture();
	try {
		await f.report("h1", "vm-1");
		let writes = 0;
		observeSqlPoolTransactions(f.journal, () => writes++);
		const shared = await SqlSharedPool.open(f.journal, f.queue);
		writes = 0;
		assert.equal(await shared.drainRequested("h1", "vm-1"), false);
		assert.equal(writes, 0, "a poll that finds no drain writes nothing");
		await seedDrain(f.store, "other", "vm-1");
		assert.equal(await shared.drainRequested("h1", "vm-1"), true);
		assert.equal(writes, 1, "a poll that finds a drain marks the host draining in one write");
	} finally {
		await f.close();
	}
});
