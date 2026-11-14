import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { runWorkerCommand } from "../../packages/coding-agent/src/cli/worker-command.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import type {
	SharedPoolFleet,
	SharedPoolHost,
	SharedPoolStats,
} from "../../packages/workflows/src/durable/journal/shared-pool-types.js";
import {
	classifySharedStoreHealth,
	SHARED_STORE_HINT,
	SharedStoreStatusTimeoutError,
	SharedStoreWrites,
	STATUS_READ_TIMEOUT_MS,
	STORE_PROBE_TIMEOUT_MS,
	STORE_WRITE_FAILURES,
	STORE_WRITE_STALL_MS,
	withoutUrlCredentials,
} from "../../packages/workflows/src/durable/journal/shared-store-health.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import {
	readSharedPoolFleet,
	readSharedPoolStats,
	SqlSharedPool,
} from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { type Lease, RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
import { sharedPoolStatus } from "../../packages/workflows/src/workers/shared-pool-status.js";
import {
	sharedPoolStatusLines,
	workflowWorkerFleetLines,
} from "../../packages/workflows/src/workers/shared-pool-status-lines.js";
import { readWorkflowWorkerFleet, startWorkflowWorkerHost } from "../../packages/workflows/src/workers/worker-host.js";
import { startFakeLibsqlServer } from "../helpers/fake-libsql-server.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { sleep } from "../helpers/runtime.js";

const PREFIX = "acme_";
const HOSTS = `${PREFIX}wf_runs_pool_hosts`;
const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const libsqlPackage = fileURLToPath(new URL("../../packages/storage-libsql", import.meta.url));
const definition = { definition: "fixture/child", digest: "sha256:child" };
/** A status read of a store that never answers ends at the status budget; this is the slack around it. */
const STALLED_READ_SLACK_MS = 3_000;
/** A test that waits out the status budget once or twice, and a real worker host's start, poll and stop. */
const STALLED_STORE_TIMEOUT_MS = 2 * STATUS_READ_TIMEOUT_MS + 20_000;
const REAL_HOST_TIMEOUT_MS = 60_000;

let directory: string;
beforeEach(() => {
	directory = makeLibsqlDirectory();
});
afterEach(async () => {
	await removeLibsqlDirectory(directory);
});

/** A prefixed journal at `url` with a running root that published its shared pool, and `ready` children queued. */
async function sharedRoot(url = pathToFileURL(join(directory, "shared.db")).href, ready = 0) {
	const database = await openLibsqlDatabase({ url });
	const journal = await SqlRunJournal.open(database, { prefix: PREFIX });
	await journal.createRun({ runId: "root", name: "root", cwd: "", createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "owner");
	if (acquired.status !== "acquired") assert.fail("the root holds no lease");
	const lease: Lease = acquired.lease;
	const queue = await openSqlPoolQueue(journal);
	await queue.initialize(lease, 60_000);
	const shared = await SqlSharedPool.open(journal, queue);
	await shared.publishConfig(lease, {
		definitions: [],
		leaseMs: 60_000,
		heartbeatMs: 1_000,
		startupTimeoutMs: 60_000,
		claimWindowMs: 0,
	});
	for (let index = 0; index < ready; index += 1) {
		const { work, boundary } = poolWorkFixture(`child-${index}`);
		await queue.enqueue(lease, work, boundary);
	}
	return {
		database,
		journal,
		lease,
		queue,
		shared,
		async close() {
			await journal.close().catch(() => {});
			await database.close().catch(() => {});
		},
	};
}

const host = (name: string, extra: Partial<Parameters<SqlSharedPool["reportHost"]>[0]> = {}) => ({
	host: name,
	labels: {},
	git: "system" as const,
	restore: true,
	workers: 2,
	maxWorkers: 4,
	roots: ["root"],
	...extra,
});

/** A TCP endpoint that takes connections and never answers: a store that stopped answering. */
async function silentStore(): Promise<{ readonly url: string; close(): Promise<void> }> {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** A proxy to `target` that, once stalled, forwards nothing more either way and holds every connection open. */
async function stallableProxy(target: URL): Promise<{ readonly url: string; stall(): void; close(): Promise<void> }> {
	const sockets = new Set<Socket>();
	const pairs: [Socket, Socket][] = [];
	let stalled = false;
	const server = createServer((client) => {
		sockets.add(client);
		client.on("error", () => {});
		if (stalled) return;
		const upstream = new Socket();
		sockets.add(upstream);
		upstream.on("error", () => client.destroy());
		upstream.connect(Number(target.port), target.hostname);
		client.pipe(upstream).pipe(client);
		pairs.push([client, upstream]);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		stall() {
			stalled = true;
			for (const [client, upstream] of pairs) {
				client.unpipe(upstream);
				upstream.unpipe(client);
				client.pause();
				upstream.pause();
			}
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** What the libSQL adapter emits on `process` as a server stops answering writes and answers them again. */
function emitWriteHealth(health: { readonly stalled: boolean; readonly message: string }): void {
	(process as NodeJS.EventEmitter).emit("atomic-libsql-write-health", health);
}

/** Each host as `[host, state, busy, draining, slots, leased]`. */
function hostStates(hosts: readonly (SharedPoolHost & { readonly leased?: number })[]) {
	return hosts.map((entry) => [entry.host, entry.state, entry.busy, entry.draining, entry.maxWorkers, entry.leased]);
}

test("fleet status reads each host's slots, busy workers, draining, heartbeat and state, and the fleet's queue, from a libSQL journal (#4768)", async () => {
	const f = await sharedRoot(undefined, 3);
	try {
		await f.queue.claim(f.lease, "h-busy/worker-1", [definition], 60_000);
		await f.shared.reportHost(host("h-busy", { busy: 1 }));
		await f.shared.reportHost(host("h-idle", { busy: 0, labels: { zone: "east" } }));
		await f.shared.reportHost(host("h-draining", { busy: 1, draining: true }));
		await f.shared.reportHost(host("h-stale", { busy: 2, draining: true }));
		await f.database.run(`UPDATE ${HOSTS} SET heartbeat_at = heartbeat_at - 60000 WHERE host = 'h-stale'`);
		await f.shared.reportHost(
			host("h-degraded", {
				busy: 0,
				degraded: {
					failures: 3,
					error: { name: "StorageError", message: "fetch libsql://me:pw@db.example/x?authToken=s3cret failed" },
				},
			}),
		);
		// A host of an older version writes only the columns it knows.
		await f.database.run(
			`INSERT INTO ${HOSTS}(host, labels, git, restore, workers, max_workers, heartbeat_at, roots)
			VALUES ('h-older', '{}', 'unavailable', 0, 1, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER), '[]')`,
		);
		const stats = (await readSharedPoolStats(f.journal, "root")) as SharedPoolStats;
		assert.deepEqual(hostStates(stats.hosts), [
			["h-busy", "busy", 1, undefined, 4, 1],
			["h-degraded", "degraded", 0, undefined, 4, 0],
			["h-draining", "draining", 1, true, 4, 0],
			["h-idle", "idle", 0, undefined, 4, 0],
			["h-older", "live", undefined, undefined, 1, 0],
			["h-stale", "stale", 2, true, 4, 0],
		]);
		const stale = stats.hosts.find((entry) => entry.host === "h-stale")!;
		assert.ok(stale.heartbeatAgoMs >= 60_000, `${stale.heartbeatAgoMs}`);
		const degraded = stats.hosts.find((entry) => entry.host === "h-degraded")!;
		assert.deepEqual(degraded.degraded, {
			failures: 3,
			error: { name: "StorageError", message: "fetch libsql://db.example/x failed" },
		});
		assert.deepEqual(stats.fleet, { store: { state: "ok" }, queue: { roots: 1, ready: 2, leased: 1 } });

		const fleet = (await readSharedPoolFleet(f.journal)) as SharedPoolFleet;
		assert.deepEqual(hostStates(fleet.hosts), hostStates(stats.hosts.map(({ leased: _, ...rest }) => rest)));
		assert.deepEqual(fleet.fleet, stats.fleet);
		assert.deepEqual(
			fleet.roots.map((root) => root.fleet),
			[stats.fleet],
		);

		await f.database.run(`UPDATE ${PREFIX}wf_runs SET status = 'completed' WHERE run_id = 'root'`);
		assert.deepEqual(
			(await readSharedPoolStats(f.journal, "root"))?.fleet.queue,
			{ roots: 0, ready: 0, leased: 0 },
			"a root that ended holds no fleet queue",
		);
	} finally {
		await f.close();
	}
});

test("fleet status reads a host registry an older version created, and the first host of this version adds its columns (#4768)", async () => {
	const f = await sharedRoot();
	try {
		for (const column of ["slots_busy", "draining", "degraded"])
			await f.database.run(`ALTER TABLE ${HOSTS} DROP COLUMN ${column}`);
		await f.database.run(
			`INSERT INTO ${HOSTS}(host, labels, git, restore, workers, max_workers, heartbeat_at, roots)
			VALUES ('h-older', '{}', 'system', 1, 2, 2, CAST(unixepoch('subsec') * 1000 AS INTEGER), '["root"]')`,
		);
		const before = (await readSharedPoolStats(f.journal, "root")) as SharedPoolStats;
		assert.deepEqual(hostStates(before.hosts), [["h-older", "live", undefined, undefined, 2, 0]]);
		const reopened = await SqlSharedPool.open(f.journal, f.queue);
		await SqlSharedPool.open(f.journal, f.queue);
		await reopened.reportHost(host("h-new", { busy: 2, draining: true }));
		const after = (await readSharedPoolStats(f.journal, "root")) as SharedPoolStats;
		assert.deepEqual(hostStates(after.hosts), [
			["h-new", "draining", 2, true, 4, 0],
			["h-older", "live", undefined, undefined, 2, 0],
		]);
	} finally {
		await f.close();
	}
});

const STATS: SharedPoolStats = {
	root: "root",
	ready: 2,
	leased: 1,
	completed: 3,
	failed: 0,
	pendingStageInputs: 1,
	hosts: [
		{
			host: "h-busy",
			labels: { zone: "east" },
			git: "system",
			restore: true,
			workers: 2,
			maxWorkers: 4,
			roots: ["root"],
			busy: 1,
			heartbeatAgoMs: 300,
			state: "busy",
			leased: 1,
			shipping: { lagMs: 1_500, pending: 4, error: { name: "StorageError", message: "busy" } },
		},
		{
			host: "h-degraded",
			labels: {},
			git: "unavailable",
			restore: false,
			workers: 1,
			maxWorkers: 1,
			roots: [],
			busy: 0,
			degraded: { failures: 1, error: { name: "StorageError", message: "gone" } },
			heartbeatAgoMs: 1_250,
			state: "degraded",
			leased: 0,
			shipping: { lagMs: 0, pending: 0 },
		},
		{
			host: "h-older",
			labels: {},
			git: "system",
			restore: false,
			workers: 1,
			maxWorkers: 2,
			roots: ["root"],
			heartbeatAgoMs: 20_000,
			state: "stale",
			leased: 0,
		},
	],
	leases: [
		{
			work: "w1",
			childRunId: "child-1",
			worker: "h-busy/1",
			host: "h-busy",
			generation: 1,
			renewedAgoMs: 400,
			expiresInMs: 29_600,
		},
	],
	fleet: {
		store: { state: "ok" },
		queue: { roots: 1, ready: 2, leased: 1 },
		controller: { holder: "root-process", epoch: 3, renewedAgoMs: 900 },
		scaleEvents: [
			{ seq: 2, agoMs: 2_000, kind: "scale-up", target: 3, live: 2, reason: "4 ready" },
			{
				seq: 1,
				agoMs: 9_000,
				kind: "provider-error",
				target: 2,
				live: 2,
				reason: "scaleTo failed",
				error: { name: "Error", message: "quota" },
			},
		],
		rateLimits: [
			{ scope: "anthropic", cooldownInMs: 4_000 },
			{ scope: "openai/gpt", cooldownInMs: 0 },
		],
	},
};

test("fleet status lines show each host's state, the fleet's queue, and every later field only when present (#4768)", () => {
	assert.deepEqual(sharedPoolStatusLines({ sharedPool: STATS }), [
		"2 ready · 1 leased · 3 completed · 0 failed · 1 stage input waiting",
		"fleet: 1 root · 2 ready · 1 leased",
		"controller root-process (epoch 3), renewed 0.9s ago",
		"scale scale-up: target 3, live 2, 4 ready, 2.0s ago",
		"scale provider-error: target 2, live 2, scaleTo failed, quota, 9.0s ago",
		"rate limit anthropic: cooling down for 4.0s",
		"rate limit openai/gpt: open",
		"host h-busy: busy, 2 of 4 workers, 1 busy, 1 lease, git system, restores, labels zone=east, shipping 1.5s behind, 4 pending, busy, seen 0.3s ago",
		"host h-degraded: degraded, 1 of 1 workers, 0 busy, 0 leases, git unavailable, 1 poll failed: gone, shipping 0.0s behind, 0 pending, seen 1.3s ago",
		"host h-older: stale, 1 of 2 workers, 0 leases, git system, seen 20.0s ago",
		"child child-1 on host h-busy: renewed 0.4s ago, expires in 29.6s",
	]);
	const bare: SharedPoolStats = {
		...STATS,
		hosts: [],
		leases: [],
		fleet: { store: { state: "degraded", message: "stalled" }, queue: { roots: 2, ready: 0, leased: 0 } },
	};
	assert.deepEqual(sharedPoolStatusLines({ sharedPool: bare }), [
		"2 ready · 1 leased · 3 completed · 0 failed · 1 stage input waiting",
		"shared store degraded: stalled",
		"fleet: 2 roots · 0 ready · 0 leased",
	]);
	assert.deepEqual(
		sharedPoolStatusLines({ sharedPoolUnavailable: { name: "StorageError", message: "gone", hint: "restart it" } }),
		["Shared pool stats unavailable: gone", "restart it"],
	);
	const { leased: _, ...older } = STATS.hosts[2]!;
	assert.deepEqual(
		workflowWorkerFleetLines({
			hosts: [{ ...older, labels: { zone: "east", rack: "2" } }],
			roots: [STATS, { ...STATS, root: "idle-root", hosts: [] }],
			fleet: { store: { state: "ok" } },
		}),
		[
			"Hosts: 1",
			"  host h-older: stale, 1 of 2 workers, git system, labels zone=east,rack=2, seen 20.0s ago",
			"Roots: 2",
			"  root root: 2 ready · 1 leased · 3 completed · 0 failed · 1 stage input waiting, on h-busy(1)",
			"  root idle-root: 2 ready · 1 leased · 3 completed · 0 failed · 1 stage input waiting",
		],
	);
	assert.deepEqual(
		workflowWorkerFleetLines({ hosts: [], roots: [], fleet: { store: { state: "degraded" } } }),
		["shared store degraded"],
		"a store that did not answer lists no hosts or roots",
	);
	assert.deepEqual(
		workflowWorkerFleetLines({
			hosts: [],
			roots: [],
			fleet: { store: { state: "degraded" }, queue: { roots: 0, ready: 0, leased: 0 } },
		}),
		["shared store degraded", "fleet: 0 roots · 0 ready · 0 leased", "Hosts: 0", "Roots: 0"],
	);
	assert.deepEqual(
		workflowWorkerFleetLines({
			hosts: [],
			roots: [],
			fleet: { store: { state: "unknown", message: "refused", hint: SHARED_STORE_HINT } },
		}),
		["shared store unknown: refused", SHARED_STORE_HINT],
	);
});

test("fleet status strips the query, fragment and user info of every URL in a message it shows (#4768)", () => {
	assert.equal(
		withoutUrlCredentials(
			"at libsql://me:pw@db.example/x?authToken=s3cret and https://h.example/p#token=t, then wss://q.example.",
		),
		"at libsql://db.example/x and https://h.example/p then wss://q.example.",
	);
	assert.equal(withoutUrlCredentials("no url: a?b#c @d"), "no url: a?b#c @d");
});

test("fleet status hears the libSQL adapter's write-health event, which the CLI's silenced warnings do not stop (#4768)", async () => {
	const f = await sharedRoot();
	const emitWarning = process.emitWarning;
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	try {
		emitWriteHealth({
			stalled: true,
			message: "The libSQL server at libsql://me:pw@db.example/x?authToken=s3cret left 3 write requests…",
		});
		assert.deepEqual((await readSharedPoolStats(f.journal, "root"))?.fleet.store, {
			state: "degraded",
			message: "The libSQL server at libsql://db.example/x left 3 write requests…",
		});
		emitWriteHealth({ stalled: false, message: "taking writes again" });
		assert.deepEqual((await readSharedPoolStats(f.journal, "root"))?.fleet.store, { state: "ok" });
	} finally {
		process.emitWarning = emitWarning;
		await f.close();
	}
});

test("atomic worker status of an adapter journal that is not SQL reads as an unknown store that holds no pools (#4768)", async () => {
	const memory = fileURLToPath(new URL("../fixtures/storage-domain-adapter.ts", import.meta.url));
	assert.deepEqual(
		await readWorkflowWorkerFleet({
			journal: { adapter: memory, options: {} },
			agentDir: join(directory, "agent"),
		}),
		{
			hosts: [],
			roots: [],
			fleet: {
				store: {
					state: "unknown",
					message: "The journal's storage adapter is not SQL, so it holds no shared pools.",
				},
			},
		},
	);
});

test("fleet status follows the libSQL adapter's write-stall warnings: degraded with its redacted message, ok once writes recover (#4768)", async () => {
	const f = await sharedRoot();
	try {
		process.emitWarning("The libSQL server at libsql://me:pw@db.example/x?authToken=s3cret left 3 write requests…", {
			code: "ATOMIC_LIBSQL_WRITES_STALLED",
		});
		await sleep(0);
		const stalled = (await readSharedPoolStats(f.journal, "root")) as SharedPoolStats;
		assert.deepEqual(stalled.fleet.store, {
			state: "degraded",
			message: "The libSQL server at libsql://db.example/x left 3 write requests…",
		});
		assert.equal(
			sharedPoolStatusLines({ sharedPool: stalled })[1],
			"shared store degraded: The libSQL server at libsql://db.example/x left 3 write requests…",
		);
		process.emitWarning("something else", { code: "SOME_OTHER_WARNING" });
		await sleep(0);
		assert.equal((await readSharedPoolStats(f.journal, "root"))?.fleet.store.state, "degraded");
		process.emitWarning("taking writes again", { code: "ATOMIC_LIBSQL_WRITES_RECOVERED" });
		await sleep(0);
		assert.deepEqual((await readSharedPoolStats(f.journal, "root"))?.fleet.store, { state: "ok" });
	} finally {
		await f.close();
	}
});

test(
	"a status read of a shared store that stopped answering ends at the status budget as unknown, with the sqld hint (#4768)",
	async () => {
		assert.match(SHARED_STORE_HINT, /tursodatabase\/libsql\/issues\/2286/);
		assert.match(SHARED_STORE_HINT, /--checkpoint-interval-s 60/);
		const server = await startFakeLibsqlServer({ streamTtlMs: 60_000 });
		const proxy = await stallableProxy(new URL(server.url));
		const f = await sharedRoot(proxy.url);
		try {
			await f.journal.append(f.lease, {
				type: RUN_EVENT_TYPES.runStarted,
				payload: {
					workflowId: "root",
					name: "root",
					inputs: {},
					createdAt: 0,
					status: "running",
					resources: { workers: { placement: "shared" } },
				},
			});
			const backend = await JournalDurableBackend.open(f.journal);
			await backend.hydrateWorkflow("root");
			const answered = await sharedPoolStatus(backend, "root");
			assert.ok(answered !== undefined && "sharedPool" in answered, JSON.stringify(answered));
			assert.deepEqual(JSON.parse(JSON.stringify(answered)), answered, "status JSON holds the fleet as read");
			assert.deepEqual(answered.sharedPool.fleet.queue, { roots: 1, ready: 0, leased: 0 });

			proxy.stall();
			const started = performance.now();
			const status = await sharedPoolStatus(backend, "root");
			const tookMs = performance.now() - started;
			assert.ok(tookMs < STATUS_READ_TIMEOUT_MS + STALLED_READ_SLACK_MS, `took ${tookMs} ms`);
			assert.deepEqual(status, {
				sharedPoolUnavailable: {
					name: "SharedStoreStatusTimeoutError",
					state: "degraded",
					message: `The shared store did not answer within ${STATUS_READ_TIMEOUT_MS / 1000} s.`,
					hint: SHARED_STORE_HINT,
				},
			});
			assert.deepEqual(sharedPoolStatusLines(status), [
				`Shared pool stats unavailable, shared store degraded: The shared store did not answer within ${STATUS_READ_TIMEOUT_MS / 1000} s.`,
				SHARED_STORE_HINT,
			]);
		} finally {
			await proxy.close();
			await f.close();
			await server.close();
		}
	},
	STALLED_STORE_TIMEOUT_MS,
);

test(
	"atomic worker status reports a shared store that does not answer as degraded, with the sqld hint, and exits 1 (#4768)",
	async () => {
		const store = await silentStore();
		const agentDir = join(directory, "agent");
		try {
			const started = performance.now();
			const fleet = await readWorkflowWorkerFleet({
				journal: { adapter: libsql, options: { url: store.url }, prefix: PREFIX },
				agentDir,
			});
			assert.ok(performance.now() - started < STATUS_READ_TIMEOUT_MS + STALLED_READ_SLACK_MS);
			assert.deepEqual(fleet, {
				hosts: [],
				roots: [],
				fleet: {
					store: {
						state: "degraded",
						message: `The shared store did not answer within ${STATUS_READ_TIMEOUT_MS / 1000} s.`,
						hint: SHARED_STORE_HINT,
					},
				},
			});
			const out: string[] = [];
			const code = await runWorkerCommand(["status"], {
				cwd: directory,
				agentDir,
				log: (line) => out.push(line),
				error: (line) => out.push(line),
				loadModule: async () => ({
					startWorkflowWorkerHost: () => assert.fail("status starts no host"),
					startWorkflowFleetController: () => assert.fail("status runs no controller"),
					createWorkerHostProvisioner: () => assert.fail("status builds no provisioner"),
					readWorkflowWorkerFleet: async () => fleet,
					workflowWorkerFleetLines,
				}),
			});
			assert.equal(code, 1);
			assert.deepEqual(out, [
				`shared store degraded: The shared store did not answer within ${STATUS_READ_TIMEOUT_MS / 1000} s.`,
				SHARED_STORE_HINT,
			]);
		} finally {
			await store.close();
		}
	},
	STALLED_STORE_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"atomic worker status --json reports a worker host as its host.stats() does (#4768)",
	async () => {
		const url = pathToFileURL(join(directory, "shared.db")).href;
		const f = await sharedRoot(url, 2);
		const agentDir = join(directory, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [libsqlPackage] }));
		const workerHost = await startWorkflowWorkerHost({
			journal: { adapter: libsql, options: { url }, prefix: PREFIX },
			agentDir: join(directory, "host"),
			maxWorkers: 3,
			hostId: "h-parity",
			labels: { zone: "east" },
			restore: false,
		});
		try {
			const status = async (): Promise<SharedPoolFleet> => {
				const out: string[] = [];
				const err: string[] = [];
				const code = await runWorkerCommand(
					["status", "--json", "--db", url, "--prefix", PREFIX, "--workers-per-host", "3", "--max-hosts", "5"],
					{
						cwd: directory,
						agentDir,
						log: (line) => out.push(line),
						error: (line) => err.push(line),
						loadModule: async () => ({
							startWorkflowWorkerHost,
							readWorkflowWorkerFleet,
							workflowWorkerFleetLines,
							startWorkflowFleetController: () => assert.fail("status runs no controller"),
							createWorkerHostProvisioner: () => assert.fail("status builds no provisioner"),
						}),
					},
				);
				assert.equal(code, 0, err.join("\n"));
				return JSON.parse(out.join("\n")) as SharedPoolFleet;
			};
			const deadline = Date.now() + 30_000;
			let reported = await status();
			while (reported.hosts.length === 0 && Date.now() < deadline) {
				await sleep(50);
				reported = await status();
			}
			const stats = await workerHost.stats();
			const [entry] = reported.hosts;
			assert.ok(entry !== undefined, "the host registered");
			assert.deepEqual(
				{
					host: entry.host,
					labels: entry.labels,
					git: entry.git,
					restore: entry.restore,
					workers: entry.workers,
					maxWorkers: entry.maxWorkers,
					busy: entry.busy,
					draining: entry.draining === true,
					state: entry.state,
				},
				{
					host: stats.hostId,
					labels: stats.labels,
					git: stats.git,
					restore: stats.restore,
					workers: stats.workers,
					maxWorkers: stats.maxWorkers,
					busy: stats.busy,
					draining: stats.draining,
					state: "idle",
				},
			);
			assert.deepEqual(reported.fleet, { store: { state: "ok" }, queue: { roots: 1, ready: 2, leased: 0 } });
			assert.deepEqual(reported.scaling, {
				desiredHosts: 1,
				desiredWorkers: 3,
				demand: 2,
				queueDepth: 2,
				running: 0,
				hosts: 1,
				busySlots: 0,
				idleSlots: 3,
				minHosts: 0,
				maxHosts: 5,
				workersPerHost: 3,
			});
			assert.deepEqual(
				reported.roots.map((root) => [root.root, root.ready, root.fleet]),
				[["root", 2, reported.fleet]],
			);
		} finally {
			await workerHost.stop();
			await f.close();
		}
	},
	REAL_HOST_TIMEOUT_MS,
);

test("a draining host that still reports itself does not count as able to restore a binding (#4768)", async () => {
	const f = await sharedRoot();
	try {
		await f.shared.reportHost(host("h-restorer", { busy: 1, draining: true }));
		assert.equal(await f.shared.capableHostLive("root", 60_000, "binding"), false, "it takes no more work");
		await f.shared.reportHost(host("h-restorer", { busy: 1 }));
		assert.equal(await f.shared.capableHostLive("root", 60_000, "binding"), true);
	} finally {
		await f.close();
	}
});

test(
	"the shared store reads degraded when a write waits too long, a status read times out, or writes keep failing while hosts are registered (#4768)",
	async () => {
		const hint = SHARED_STORE_HINT;
		const waiting = new SharedStoreWrites();
		let commit: () => void = () => {};
		const write = waiting.watch(() => new Promise<void>((resolve) => (commit = resolve)));
		assert.deepEqual(classifySharedStoreHealth({ writes: waiting, hostsRegistered: true }), { state: "ok" });
		await sleep(STORE_WRITE_STALL_MS + 50);
		assert.deepEqual(classifySharedStoreHealth({ writes: waiting, hostsRegistered: false }), {
			state: "degraded",
			message: `A write has waited more than ${STORE_WRITE_STALL_MS / 1000} s for the shared store to commit it.`,
			hint,
		});
		commit();
		await write;
		assert.equal(waiting.oldestWaitingMs(), undefined);
		assert.deepEqual(classifySharedStoreHealth({ writes: waiting, hostsRegistered: true }), { state: "ok" });

		const timeout = new SharedStoreStatusTimeoutError(STATUS_READ_TIMEOUT_MS);
		assert.deepEqual(classifySharedStoreHealth({ hostsRegistered: false, readFailure: timeout }), {
			state: "degraded",
			message: timeout.message,
			hint,
		});
		assert.deepEqual(
			classifySharedStoreHealth({
				hostsRegistered: false,
				readFailure: new Error("refused libsql://u:p@db.example/x?t=1"),
			}),
			{ state: "unknown", message: "refused libsql://db.example/x", hint },
		);

		const failing = new SharedStoreWrites();
		const refuse = (name: string) =>
			failing
				.watch(async () => {
					throw Object.assign(new Error(`${name} at libsql://db.example/x?authToken=s3cret`), { name });
				})
				.catch(() => {});
		for (let index = 1; index < STORE_WRITE_FAILURES; index += 1) await refuse("StorageUnavailableError");
		await refuse("StaleLeaseError");
		assert.equal(
			failing.failuresInRow,
			STORE_WRITE_FAILURES - 1,
			"a write the journal itself refused is no store failure",
		);
		assert.deepEqual(classifySharedStoreHealth({ writes: failing, hostsRegistered: true }), { state: "ok" });
		await refuse("StorageTransientError");
		const refused = `The shared store failed ${STORE_WRITE_FAILURES} writes in a row: StorageTransientError at libsql://db.example/x`;
		assert.deepEqual(classifySharedStoreHealth({ writes: failing, hostsRegistered: true }), {
			state: "degraded",
			message: refused,
			hint,
		});
		assert.deepEqual(classifySharedStoreHealth({ writes: failing, hostsRegistered: false }), {
			state: "unknown",
			message: refused,
			hint,
		});
		await failing.watch(async () => {});
		assert.equal(failing.failuresInRow, 0, "a committed write ends the run of failures");
	},
	STALLED_STORE_TIMEOUT_MS,
);

test(
	"workflow status reads a store that left one of the root's writes waiting as degraded, without writing to it (#4768)",
	async () => {
		const server = await startFakeLibsqlServer({ streamTtlMs: 60_000 });
		const f = await sharedRoot(server.url);
		let release: () => void = () => {};
		try {
			await f.journal.append(f.lease, {
				type: RUN_EVENT_TYPES.runStarted,
				payload: {
					workflowId: "root",
					name: "root",
					inputs: {},
					createdAt: 0,
					status: "running",
					resources: { workers: { placement: "shared" } },
				},
			});
			const backend = await JournalDurableBackend.open(f.journal);
			await backend.hydrateWorkflow("root");
			// The root's next write waits unanswered, as a wedged sqld leaves writes, and every call after it waits too.
			server.onOpenTransaction(() => new Promise<void>((resolve) => (release = resolve)));
			const stuck = f.shared.reportHost(host("h-busy", { busy: 1 })).catch(() => {});
			await sleep(STORE_WRITE_STALL_MS);
			const sent = server.pipelines.length;
			const started = performance.now();
			const status = await sharedPoolStatus(backend, "root");
			assert.ok(performance.now() - started < STATUS_READ_TIMEOUT_MS + STALLED_READ_SLACK_MS);
			assert.deepEqual(status, {
				sharedPoolUnavailable: {
					name: "SharedStoreStatusTimeoutError",
					state: "degraded",
					message: `A write has waited more than ${STORE_WRITE_STALL_MS / 1000} s for the shared store to commit it.`,
					hint: SHARED_STORE_HINT,
				},
			});
			assert.deepEqual(sharedPoolStatusLines(status), [
				`Shared pool stats unavailable, shared store degraded: A write has waited more than ${STORE_WRITE_STALL_MS / 1000} s for the shared store to commit it.`,
				SHARED_STORE_HINT,
			]);
			assert.equal(server.pipelines.length, sent, "status sent the store nothing of its own");
			server.onOpenTransaction(undefined);
			release();
			await stuck;
		} finally {
			release();
			await f.close();
			await server.close();
		}
	},
	STALLED_STORE_TIMEOUT_MS + STORE_WRITE_STALL_MS,
);

test(
	"atomic worker status, in a process of its own, probes the store with a write and reads one that commits none as degraded (#4768)",
	async () => {
		const server = await startFakeLibsqlServer({ streamTtlMs: 60_000 });
		const f = await sharedRoot(server.url, 1);
		let release: () => void = () => {};
		try {
			await f.shared.reportHost(host("h-busy", { busy: 1 }));
			const selection = { adapter: libsql, options: { url: server.url }, prefix: PREFIX };
			const agentDir = join(directory, "reader");
			assert.deepEqual((await readWorkflowWorkerFleet({ journal: selection, agentDir })).fleet.store, {
				state: "ok",
			});
			// Every write transaction waits unanswered from now on, as a wedged sqld leaves them; reads still answer.
			server.onOpenTransaction(() => new Promise<void>((resolve) => (release = resolve)));
			const started = performance.now();
			const fleet = await readWorkflowWorkerFleet({ journal: selection, agentDir });
			assert.ok(performance.now() - started < STATUS_READ_TIMEOUT_MS, "the probe ends before the status budget");
			assert.deepEqual(fleet.fleet, {
				store: {
					state: "degraded",
					message: `The shared store did not commit a write within ${STORE_PROBE_TIMEOUT_MS / 1000} s.`,
					hint: SHARED_STORE_HINT,
				},
				queue: { roots: 1, ready: 1, leased: 0 },
			});
			assert.deepEqual(hostStates(fleet.hosts), [["h-busy", "busy", 1, undefined, 4, undefined]]);
			assert.deepEqual(
				fleet.roots.map((root) => [root.root, root.ready, root.fleet.store.state]),
				[["root", 1, "degraded"]],
			);
			server.onOpenTransaction(undefined);
			release();
		} finally {
			release();
			await f.close();
			await server.close();
		}
	},
	STALLED_STORE_TIMEOUT_MS,
);
