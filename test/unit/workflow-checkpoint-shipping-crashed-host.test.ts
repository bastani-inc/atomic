import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { openNodeSqliteDatabase } from "@bastani/atomic";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { tryAdvisoryLock } from "@bastani/atomic-natives";
import { afterEach, test, vi } from "vitest";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue, SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import {
	durableJournalIdentity,
	poolDurableJournal,
	poolStateDirectory,
} from "../../packages/workflows/src/workers/pool-journal.js";
import { ShipShard, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import {
	crashHostThenRestart,
	holdShards,
	LATE_OPEN_GRACE_MS,
	restartAsRoot,
	restartAsWorkerHost,
	setRunStatus,
	shardFiles,
	shardRemovals,
	unshippedCheckpoints,
} from "../helpers/crashed-ship-shards.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { libsql, PREFIX, stubWorker } from "../helpers/workflow-shared-pool-coordinator.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		async rm(path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) {
			const hook = shardRemovals.before;
			if (hook !== undefined && String(path).startsWith(hook.prefix)) {
				shardRemovals.before = undefined;
				await hook.run();
			}
			return actual.rm(path, options);
		},
	};
});

const CRASHED_HOST_PROCESSES_TIMEOUT_MS = 120_000;

test("retiring through a symlink never unlinks a concurrent connection's lifetime lock twice (#5317)", async () => {
	const directory = makeTempDirectory("ship-retire-alias-");
	let late: SqliteDatabase | undefined;
	try {
		const target = join(directory, "real-agent");
		const agentDir = join(directory, "linked-agent");
		mkdirSync(target);
		symlinkSync(target, agentDir, process.platform === "win32" ? "junction" : "dir");
		const path = shipShardPath(agentDir, "journal", "root");
		const shard = await ShipShard.open(path, "root");
		const location = realpathSync(path);
		shardRemovals.before = {
			prefix: `${path}-open.lock`,
			run: async () => {
				late = await openNodeSqliteDatabase(location);
			},
		};
		await shard.close({ retire: true });
		late ??= await openNodeSqliteDatabase(location);
		const exclusive = tryAdvisoryLock(`${location}-open.lock`, 0);
		exclusive?.release();
		assert.equal(exclusive, null, "the late connection keeps its shared lifetime fence");
	} finally {
		shardRemovals.before = undefined;
		await late?.close();
		removeTempDirectory(directory);
	}
});

test(
	"a host reached through a symlink keeps concurrent connections fenced during crashed journal cleanup (#5317)",
	async () => {
		const directory = makeTempDirectory("ship-crashed-symlink-");
		try {
			const target = join(directory, "real-agent");
			const agentDir = join(directory, "linked-agent");
			mkdirSync(target);
			symlinkSync(target, agentDir, process.platform === "win32" ? "junction" : "dir");
			await crashHostThenRestart({
				selection: { path: join(directory, "shared.sqlite") },
				agentDir,
				restart: restartAsRoot(agentDir),
			});
		} finally {
			removeTempDirectory(directory);
		}
	},
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);

afterEach(() => {
	vi.restoreAllMocks();
});

test(
	"a root host restarted after a crash removes its local checkpoint journals of runs that ended while it was down, on a SQLite journal (#5317)",
	async () => {
		const directory = makeTempDirectory("ship-crashed-root-sqlite-");
		try {
			const agentDir = join(directory, "host", "agent");
			await crashHostThenRestart({
				selection: { path: join(directory, "shared.sqlite") },
				agentDir,
				restart: restartAsRoot(agentDir),
			});
		} finally {
			removeTempDirectory(directory);
		}
	},
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);

test(
	"a root host restarted after a crash removes its local checkpoint journals of runs that ended while it was down, on a libSQL journal (#5317)",
	async () => {
		const directory = makeLibsqlDirectory("ship-crashed-root-libsql-");
		try {
			const agentDir = join(directory, "host", "agent");
			await crashHostThenRestart({
				selection: {
					adapter: libsql,
					options: { url: pathToFileURL(join(directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir,
				restart: restartAsRoot(agentDir),
			});
		} finally {
			await removeLibsqlDirectory(directory);
		}
	},
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host restarted after a crash removes its local checkpoint journals of runs that ended while it was down, on a libSQL journal (#5317)",
	async () => {
		const directory = makeLibsqlDirectory("ship-crashed-host-libsql-");
		try {
			const agentDir = join(directory, "host", "agent");
			const selection = {
				adapter: libsql,
				options: { url: pathToFileURL(join(directory, "shared.db")).href },
				prefix: PREFIX,
			};
			await crashHostThenRestart({
				selection,
				agentDir,
				restart: restartAsWorkerHost(selection, agentDir, stubWorker),
			});
		} finally {
			await removeLibsqlDirectory(directory);
		}
	},
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);

function poolWorkOf(root: string) {
	return JSON.parse(JSON.stringify(poolWorkFixture()).replaceAll('"root"', JSON.stringify(root))) as ReturnType<
		typeof poolWorkFixture
	>;
}

async function claimedAttempt(journal: RunJournal, queue: SqlPoolQueue, root: string): Promise<string> {
	await journal.createRun({ runId: root, name: root, cwd: "/", createdAt: 0, status: "running" });
	const acquired = await journal.acquire(root, "earlier-host");
	if (acquired.status !== "acquired") assert.fail(`no lease for ${root}`);
	await queue.initialize(acquired.lease, 60_000);
	const { work, boundary } = poolWorkOf(root);
	await queue.enqueue(acquired.lease, work, boundary);
	const claimed = await queue.claim(acquired.lease, "earlier-host/1", [work], 60_000);
	assert.ok(claimed, `the attempt of ${root} was claimed`);
	return claimed.id;
}

test(
	"a restarted host removes a crashed host's local checkpoint journals an earlier release left without their root, once the run ended (#5317)",
	async () => {
		const directory = makeTempDirectory("ship-crashed-earlier-release-");
		const agentDir = join(directory, "host", "agent");
		const journal = await resolveRunJournal({ agentDir, journal: { path: join(directory, "shared.sqlite") } });
		try {
			const queue = await openSqlPoolQueue(journal);
			const identity = durableJournalIdentity(poolDurableJournal(journal));
			const shard = (root: string, work?: string) => ({
				path: shipShardPath(poolStateDirectory(agentDir), identity, root),
				root,
				...(work === undefined ? {} : { work }),
			});
			const ended = shard("ended", await claimedAttempt(journal, queue, "ended"));
			const deleted = shard("deleted", await claimedAttempt(journal, queue, "deleted"));
			const running = shard("running", await claimedAttempt(journal, queue, "running"));
			await journal.createRun({ runId: "idle", name: "idle", cwd: "/", createdAt: 0, status: "running" });
			const idle = shard("idle");
			await journal.createRun({
				runId: "running-idle",
				name: "running-idle",
				cwd: "/",
				createdAt: 0,
				status: "running",
			});
			const runningIdle = shard("running-idle");
			const crashed = await holdShards([ended, deleted, running, idle, runningIdle]);
			await crashed.kill();
			for (const { path } of [ended, deleted, running, idle, runningIdle]) {
				const database = await openNodeSqliteDatabase(path);
				try {
					await database.exec(`DROP TABLE IF EXISTS ship_root`);
				} finally {
					await database.close();
				}
			}
			await setRunStatus(journal, "ended", "completed");
			await journal.deleteRun("deleted");
			await setRunStatus(journal, "idle", "completed");

			const stop = await restartAsRoot(agentDir)(journal);
			try {
				for (const { root, path } of [ended, deleted, idle])
					assert.deepEqual(shardFiles(path), [], `the ${root} root's local journal is removed`);
				assert.ok(existsSync(running.path), "a running root's local journal is kept");
				assert.equal(await unshippedCheckpoints(running.path), 1);
				assert.ok(existsSync(runningIdle.path), "a running root's empty legacy journal is kept");
			} finally {
				await stop();
			}
		} finally {
			await journal.close();
			removeTempDirectory(directory);
		}
	},
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);

async function crashedShardOfEndedRoot(directory: string) {
	const agentDir = join(directory, "host", "agent");
	const journal = await resolveRunJournal({ agentDir, journal: { path: join(directory, "shared.sqlite") } });
	const root = "ended";
	await journal.createRun({ runId: root, name: root, cwd: directory, createdAt: 0, status: "running" });
	const path = shipShardPath(poolStateDirectory(agentDir), durableJournalIdentity(poolDurableJournal(journal)), root);
	const crashed = await holdShards([{ path, root, work: "work-1" }]);
	await crashed.kill();
	await setRunStatus(journal, root, "completed");
	return { agentDir, journal, root, path };
}

test(
	"a host restarted with synchronous checkpoints removes an ended run's crashed local checkpoint journal (#5317)",
	async () => {
		const directory = makeTempDirectory("ship-crashed-sync-");
		const { agentDir, journal, path } = await crashedShardOfEndedRoot(directory);
		try {
			const stop = await restartAsRoot(agentDir, { sync: true })(journal);
			try {
				assert.deepEqual(shardFiles(path), [], "synchronous checkpoints do not leave old journals behind");
			} finally {
				await stop();
			}
		} finally {
			await journal.close();
			removeTempDirectory(directory);
		}
	},
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);

test(
	"a read-only opener waits for crashed journal removal through a symlink, then finds no file (#5317)",
	async () => {
		const directory = makeTempDirectory("ship-crashed-late-reader-");
		mkdirSync(join(directory, "real-host"));
		symlinkSync(
			join(directory, "real-host"),
			join(directory, "host"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const { agentDir, journal, path } = await crashedShardOfEndedRoot(directory);
		let reading: Promise<SqliteDatabase> | undefined;
		let settledDuringRemoval = false;
		try {
			shardRemovals.before = {
				prefix: realpathSync(path),
				run: async () => {
					let settled = false;
					reading = openNodeSqliteDatabase(pathToFileURL(path).href, { readOnly: true });
					const settling = reading.then(
						() => {
							settled = true;
						},
						() => {
							settled = true;
						},
					);
					await Promise.race([settling, sleep(LATE_OPEN_GRACE_MS)]);
					settledDuringRemoval = settled;
				},
			};
			const stop = await restartAsRoot(agentDir)(journal);
			try {
				assert.ok(reading !== undefined, "the restarted host removed the ended run's journal");
				assert.equal(
					settledDuringRemoval,
					false,
					"a late read-only connection waits while the journal is being removed",
				);
				await assert.rejects(reading, /unable to open database file/i);
				assert.deepEqual(shardFiles(path), [], "the late read-only connection leaves no journal behind");
			} finally {
				await stop();
			}
		} finally {
			shardRemovals.before = undefined;
			await reading?.then(
				(database) => database.close(),
				() => {},
			);
			await journal.close();
			removeTempDirectory(directory);
		}
	},
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);

test(
	"a root resumed on the host while a restart reads that its run ended keeps the local checkpoint journal it opened (#5317)",
	async () => {
		const directory = makeTempDirectory("ship-crashed-resumed-");
		const { agentDir, journal, root, path } = await crashedShardOfEndedRoot(directory);
		try {
			const read = SqlPoolQueue.prototype.endedShipRoots;
			vi.spyOn(SqlPoolQueue.prototype, "endedShipRoots").mockImplementation(async function (
				this: SqlPoolQueue,
				...args: Parameters<SqlPoolQueue["endedShipRoots"]>
			) {
				const ended = await read.apply(this, args);
				await setRunStatus(journal, root, "running");
				const resumed = await ShipShard.open(path, root);
				const lease = { id: "work-2", generation: 1, worker: "resumed-host/1", epoch: 2 };
				await resumed.hold(lease, 60_000);
				await resumed.accept(root, lease, "scope:resumed", "{}", 2);
				await resumed.close();
				return ended;
			});
			const stop = await restartAsRoot(agentDir)(journal);
			try {
				assert.ok(existsSync(path), "the journal the resumed root opened is kept");
				assert.equal(await unshippedCheckpoints(path), 2, "with the checkpoints of both incarnations");
			} finally {
				await stop();
			}
		} finally {
			await journal.close();
			removeTempDirectory(directory);
		}
	},
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);

test(
	"a restarted host that cannot read the shared journal keeps every crashed local checkpoint journal and still opens its own, until a later restart reads it (#5317)",
	async () => {
		const directory = makeTempDirectory("ship-crashed-unreadable-");
		const { agentDir, journal, path } = await crashedShardOfEndedRoot(directory);
		try {
			vi.spyOn(SqlPoolQueue.prototype, "endedShipRoots").mockRejectedValueOnce(new Error("store unavailable"));
			let stop = await restartAsRoot(agentDir)(journal);
			try {
				assert.ok(existsSync(path), "an unreadable shared journal removes nothing");
				assert.equal(await unshippedCheckpoints(path), 1);
				assert.equal(
					readdirSync(dirname(path)).filter((name) => name.endsWith(".sqlite")).length,
					2,
					"the restarted root opened its own local journal",
				);
			} finally {
				await stop();
			}
			stop = await restartAsRoot(agentDir)(journal);
			try {
				assert.deepEqual(shardFiles(path), [], "the next restart that reads it removes the ended root's journal");
			} finally {
				await stop();
			}
		} finally {
			await journal.close();
			removeTempDirectory(directory);
		}
	},
	CRASHED_HOST_PROCESSES_TIMEOUT_MS,
);
