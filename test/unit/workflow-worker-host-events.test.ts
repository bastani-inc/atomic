import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { readSharedPoolFleet } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import {
	isSharedPoolSetupError,
	isWorkerPlacementConfigError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import {
	readWorkflowWorkerFleet,
	startWorkflowWorkerHost,
	type WorkflowWorkerHostEvent,
} from "../../packages/workflows/src/workers/worker-host.js";
import { startFakeLibsqlServer } from "../helpers/fake-libsql-server.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { startOutageProxy } from "../helpers/outage-proxy.js";
import { sleep } from "../helpers/runtime.js";

/** The scaling signal of a fleet with no work and no host, under the default policy. */
const EMPTY_SCALING = {
	desiredHosts: 0,
	desiredWorkers: 0,
	demand: 0,
	queueDepth: 0,
	running: 0,
	hosts: 0,
	busySlots: 0,
	idleSlots: 0,
	minHosts: 0,
	maxHosts: 10,
	workersPerHost: 4,
};

const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
/** A failed poll waits out the storage facade's transient retries (about 4 s) before it fails. */
const OUTAGE_TEST_TIMEOUT_MS = 60_000;

let directory: string;
beforeEach(() => {
	directory = makeLibsqlDirectory();
});
afterEach(async () => {
	await removeLibsqlDirectory(directory);
});

function journal(url = pathToFileURL(join(directory, "shared.db")).href) {
	return { adapter: libsql, options: { url }, prefix: "acme_" };
}

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await sleep(25);
	}
}

test.skipIf(process.platform === "win32")(
	"a worker host registers in the fleet, drains itself after idleExitMs, and closed settles once it left (#4768)",
	async () => {
		const events: WorkflowWorkerHostEvent[] = [];
		const host = await startWorkflowWorkerHost({
			journal: journal(),
			agentDir: join(directory, "agent"),
			maxWorkers: 3,
			hostId: "host-idle",
			labels: { zone: "east" },
			restore: false,
			idleExitMs: 2_500,
			onEvent: (event) => events.push(event),
		});
		let closed = false;
		void host.closed.then(() => {
			closed = true;
		});
		const fleet = async () => readWorkflowWorkerFleet({ journal: journal(), agentDir: join(directory, "reader") });
		await until("the host to register", async () => (await fleet()).hosts.length === 1);
		const [registered] = (await fleet()).hosts;
		assert.equal(registered?.host, "host-idle");
		assert.deepEqual(registered?.labels, { zone: "east" });
		assert.equal(registered?.maxWorkers, 3);
		assert.equal(closed, false, "an idle host stays up until idleExitMs passed");
		await host.closed;
		assert.equal(events.length, 1, JSON.stringify(events));
		assert.equal(events[0]?.kind, "idle-exit");
		assert.ok(events[0]?.kind === "idle-exit" && events[0].idleMs >= 2_500);
		assert.deepEqual(
			await fleet(),
			{
				hosts: [],
				roots: [],
				fleet: { store: { state: "ok" }, queue: { roots: 0, ready: 0, leased: 0 } },
				scaling: EMPTY_SCALING,
			},
			"a drained host leaves the registry",
		);
		await host.drain();
		await host.stop();
	},
	OUTAGE_TEST_TIMEOUT_MS,
);

test("a worker host refuses an idleExitMs that is not a positive integer (#4768)", async () => {
	for (const idleExitMs of [0, -1, 1.5])
		await assert.rejects(
			startWorkflowWorkerHost({ journal: journal(), maxWorkers: 1, idleExitMs }),
			(error: unknown) =>
				isWorkerPlacementConfigError(error) &&
				error.field === "idleExitMs" &&
				error.code === "invalid-option" &&
				error.detail === "must be a positive integer",
		);
});

test.skipIf(process.platform === "win32")(
	"a worker host with the smallest idleExitMs exits at its first tick, reporting its idle time once (#4768)",
	async () => {
		const events: WorkflowWorkerHostEvent[] = [];
		const host = await startWorkflowWorkerHost({
			journal: journal(),
			agentDir: join(directory, "agent"),
			maxWorkers: 1,
			restore: false,
			idleExitMs: 1,
			onEvent: (event) => events.push(event),
		});
		await host.closed;
		assert.equal(events.length, 1, JSON.stringify(events));
		assert.ok(events[0]?.kind === "idle-exit" && events[0].idleMs >= 1);
		assert.equal("degraded" in (await host.stats()), false);
	},
	OUTAGE_TEST_TIMEOUT_MS,
);

test("reading the fleet lists every setup problem first, and a journal that is not SQL holds no fleet (#4768)", async () => {
	await assert.rejects(
		readWorkflowWorkerFleet({
			journal: { adapter: join(directory, "no-such-adapter.js"), options: { url: "file:///none" } },
			agentDir: join(directory, "agent"),
		}),
		(error: unknown) =>
			isSharedPoolSetupError(error) &&
			error.operation === "worker-host" &&
			error.problems.map((problem) => problem.code).join() === "storage-adapter-unavailable",
	);
	assert.equal(
		await readSharedPoolFleet(new MemoryRunJournal({ adapter: "memory", location: ":memory:" })),
		undefined,
	);
});

test("reading the fleet of a journal that never ran a shared pool finds nothing and creates nothing (#4768)", async () => {
	assert.deepEqual(await readWorkflowWorkerFleet({ journal: journal(), agentDir: join(directory, "agent") }), {
		hosts: [],
		roots: [],
		fleet: { store: { state: "ok" }, queue: { roots: 0, ready: 0, leased: 0 } },
		scaling: EMPTY_SCALING,
	});
});

test.skipIf(process.platform === "win32")(
	"a worker host that loses the journal reports degraded with a backoff, keeps going, and recovers (#4768)",
	async () => {
		const database = await startFakeLibsqlServer({ streamTtlMs: 60_000 });
		const proxy = await startOutageProxy(new URL(database.url));
		const events: WorkflowWorkerHostEvent[] = [];
		const host = await startWorkflowWorkerHost({
			journal: journal(proxy.url),
			agentDir: join(directory, "agent"),
			maxWorkers: 1,
			hostId: "host-outage",
			restore: false,
			onEvent: (event) => events.push(event),
		});
		try {
			await until("the host to register", () => {
				const row = database.database.prepare("SELECT COUNT(*) AS count FROM acme_wf_runs_pool_hosts").get() as
					| { count: number }
					| undefined;
				return Number(row?.count ?? 0) === 1;
			});
			proxy.cut();
			await until("a degraded poll", () => events.some((event) => event.kind === "degraded"));
			const degraded = events.find((event) => event.kind === "degraded");
			assert.ok(degraded?.kind === "degraded");
			assert.equal(degraded.failures, 1);
			assert.ok(degraded.retryInMs >= 500 && degraded.retryInMs <= 1_000, String(degraded.retryInMs));
			const stats = await host.stats();
			assert.equal(stats.degraded?.failures, 1);
			assert.equal(stats.degraded?.error.name, degraded.error.name);
			assert.ok(stats.degraded !== undefined && stats.degraded.since <= Date.now());
			proxy.restore();
			await until("the host to recover", () => events.some((event) => event.kind === "recovered"));
			const recovered = events.find((event) => event.kind === "recovered");
			assert.ok(recovered?.kind === "recovered" && recovered.failures >= 1);
			assert.equal("degraded" in (await host.stats()), false, "a recovered host is no longer degraded");
		} finally {
			proxy.restore();
			await host.stop();
			await proxy.close();
			await database.close();
		}
	},
	OUTAGE_TEST_TIMEOUT_MS,
);
