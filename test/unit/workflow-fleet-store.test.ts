import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { SqlFleetStore } from "../../packages/workflows/src/durable/journal/sql-fleet.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { recordedPlacement } from "../../packages/workflows/src/workers/public-pool.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";

const PREFIX = "acme_";
const header = { runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" };
const definition = { definition: "fixture/child", digest: "sha256:child" };
const config = {
	definitions: [],
	admission: { limits: { session: 2 } },
	leaseMs: 60_000,
	heartbeatMs: 15_000,
	startupTimeoutMs: 60_000,
	claimWindowMs: 60_000,
};

/** A prefixed libSQL journal with a root that holds its lease and has a shared pool; `before` runs before the pool opens. */
async function fixture(before?: (database: Awaited<ReturnType<typeof openLibsqlDatabase>>) => Promise<void>) {
	const directory = makeLibsqlDirectory();
	const database = await openLibsqlDatabase({ url: pathToFileURL(join(directory, "journal.db")).href });
	const journal = await SqlRunJournal.open(database, { prefix: PREFIX });
	await journal.createRun(header);
	const lease = ((await journal.acquire(header.runId, "coordinator")) as { lease: Lease }).lease;
	const queue = await openSqlPoolQueue(journal);
	await queue.initialize(lease, 60_000);
	await before?.(database);
	const shared = await SqlSharedPool.open(journal, queue);
	await shared.publishConfig(lease, config);
	const store = await SqlFleetStore.open(journal);
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
	return {
		journal,
		lease,
		queue,
		shared,
		store,
		report,
		async close() {
			await journal.close();
			await database.close();
			await removeLibsqlDirectory(directory);
		},
	};
}

test.skipIf(process.platform === "win32")(
	"the fleet snapshot counts each shared root's queue under its session limit, and each host's leases by provider id (#4768)",
	async () => {
		const f = await fixture();
		try {
			for (const name of ["a", "b", "c"]) {
				const { work, boundary } = poolWorkFixture(name);
				await f.queue.enqueue(f.lease, work, boundary);
			}
			assert.ok(await f.queue.claim(f.lease, "h1/worker-1", [definition], 60_000));
			await f.report("h1", "vm-1");
			await f.report("h2");
			const snapshot = await f.store.snapshot();
			assert.deepEqual(snapshot.roots, [{ root: "root", ready: 2, leased: 1, sessionLimit: 2, blocked: false }]);
			assert.deepEqual(snapshot.hosts, [
				{ host: "h1", providerId: "vm-1", live: true, leased: 1 },
				{ host: "h2", live: true, leased: 0 },
			]);
			assert.deepEqual([...snapshot.leased], [["h1", 1]]);
			assert.deepEqual(
				(await f.shared.registeredHosts()).map((host) => host.providerId),
				["vm-1", undefined],
			);
			// A root whose budget blocks it starts no child: it counts as blocked.
			await f.shared.publishBudget(f.lease, true);
			assert.equal((await f.store.snapshot()).roots[0]?.blocked, true);
		} finally {
			await f.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a drain request reaches only an idle host, once, under the current lease, and its provider id is kept until cleared (#4768)",
	async () => {
		const f = await fixture();
		try {
			const { work, boundary } = poolWorkFixture("busy");
			await f.queue.enqueue(f.lease, work, boundary);
			assert.ok(await f.queue.claim(f.lease, "h1/worker-1", [definition], 60_000));
			const fence = { holder: "C", epoch: (await f.store.acquire("C", undefined, 60_000)).epoch };
			assert.equal(await f.store.requestDrain(fence, "h1", "vm-1"), false, "a host that holds a child is not asked");
			// `h` is not `h1`: another host's leases do not hold it.
			assert.equal(await f.store.requestDrain(fence, "h", "vm-0"), true);
			assert.equal(await f.store.requestDrain(fence, "h2", "vm-2"), true);
			assert.equal(await f.store.requestDrain(fence, "h2", "vm-2"), false, "asked once");
			assert.equal(await f.shared.drainRequested("h2"), true);
			assert.equal(await f.shared.drainRequested("h1"), false);
			assert.deepEqual((await f.store.snapshot()).drains, [
				{ host: "h", providerId: "vm-0" },
				{ host: "h2", providerId: "vm-2" },
			]);
			await f.store.clearDrain({ holder: "C", epoch: fence.epoch + 1 }, "h2");
			assert.equal(await f.shared.drainRequested("h2"), true, "a stale controller clears nothing");
			await f.store.clearDrain(fence, "h2");
			assert.equal(await f.shared.drainRequested("h2"), false);
		} finally {
			await f.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a host registry from before fleet autoscaling gains the provider id column (#4768)",
	async () => {
		const f = await fixture(async (database) => {
			await database.exec(`CREATE TABLE ${PREFIX}wf_runs_pool_hosts(
				host TEXT PRIMARY KEY, labels TEXT NOT NULL, git TEXT NOT NULL, restore INTEGER NOT NULL,
				workers INTEGER NOT NULL, max_workers INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
				roots TEXT NOT NULL DEFAULT '[]'
			)`);
		});
		try {
			await f.report("h1", "vm-1");
			assert.deepEqual(
				(await f.shared.registeredHosts()).map((host) => [host.host, host.providerId]),
				[["h1", "vm-1"]],
			);
		} finally {
			await f.close();
		}
	},
);

test.skipIf(process.platform === "win32")(
	"the shared pool's tables open again, a holder renews only at its own epoch, and events keep missing figures as null (#4768)",
	async () => {
		const f = await fixture();
		try {
			// Every host and root opens the shared pool: opening it again finds the provider id column there.
			await f.report("h1", "vm-1");
			const again = await SqlSharedPool.open(f.journal, f.queue);
			assert.deepEqual(
				(await again.registeredHosts()).map((host) => host.providerId),
				["vm-1"],
			);
			assert.deepEqual(await f.store.acquire("A", undefined, 60_000), { held: true, epoch: 1 });
			assert.deepEqual(await f.store.acquire("A", 7, 60_000), { held: false, holder: "A", epoch: 1 });
			assert.equal(await f.store.record({ holder: "A", epoch: 1 }, { kind: "active", reason: "r" }), true);
			assert.deepEqual(
				(await f.store.recent(1)).map(({ kind, target, live, reason, error }) => ({
					kind,
					target,
					live,
					reason,
					error,
				})),
				[{ kind: "active", target: null, live: null, reason: "r", error: null }],
			);
		} finally {
			await f.close();
		}
	},
);

test.skipIf(process.platform === "win32")("recordedPlacement never keeps a root's provisioner (#4768)", async () => {
	const provisioner = {
		provisioner: { kind: "k", list: async () => [], scaleTo: async () => {}, drain: async () => {} },
	};
	assert.deepEqual(await recordedPlacement({ placement: "shared", claimWindowMs: 5, provisioner }), {
		placement: { placement: "shared", claimWindowMs: 5, workspace: undefined },
	});
	const binding = {
		remotes: ["https://example.invalid/r.git"],
		head: "a".repeat(40),
		tree: "b".repeat(40),
		envHash: "e",
	};
	const placed = await recordedPlacement({ placement: "shared", workspace: binding, provisioner });
	assert.equal("provisioner" in placed.placement, false);
	assert.deepEqual(placed.placement.workspace, binding);
});
