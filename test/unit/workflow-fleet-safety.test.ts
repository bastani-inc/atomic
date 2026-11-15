import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
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
const definition = { definition: "fixture/child", digest: "sha256:child" };
const config = {
	definitions: [],
	leaseMs: 60_000,
	heartbeatMs: 15_000,
	startupTimeoutMs: 60_000,
	claimWindowMs: 60_000,
};

async function fixture() {
	const directory = makeLibsqlDirectory();
	const database = await openLibsqlDatabase({ url: pathToFileURL(join(directory, "journal.db")).href });
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
	const report = (host: string, providerId?: string) =>
		shared.reportHost({
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
			await database.close();
			await removeLibsqlDirectory(directory);
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
		// The host on vm-1 keeps reporting itself, idle (its worker lost the child when the root died).
		for (let i = 0; i < 20; i++) {
			await f.report("h1", "vm-1");
			await sleep(TICK_MS);
		}
		assert.ok(
			events.some((e) => e.kind === "drain-requested"),
			"an idle host whose only lease belongs to a dead root, with an expired work lease, should be drained to the floor",
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
						`UPDATE ${PREFIX}wf_runs_fleet_controller SET holder = 'other', epoch = epoch + 1, renewed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), lease_ms = 600000`,
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
		await sleep(5 * TICK_MS);
		assert.ok(removed.includes("vm-1"));
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
		await sleep(5 * TICK_MS);
		assert.ok(removed.includes("vm-1"));
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
		await sleep(5 * TICK_MS);
		assert.deepEqual(removed, ["vm-3"], "only the instance whose host never registered is removed");
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
