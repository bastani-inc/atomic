import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { INTERNAL_WORKFLOW_WORKER_ARG } from "../../packages/coding-agent/src/bun/internal-workflow-worker.js";
import { setDebugSetting } from "../../packages/coding-agent/src/core/debug-setting.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import { POOL_COORDINATOR_ROLE } from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { areaRecords, withDebugLog } from "../helpers/debug-mode.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

interface Launch {
	readonly modulePath: string;
	readonly args: readonly string[];
	readonly options: ForkOptions;
	readonly sent: Record<string, unknown>[];
	child?: unknown;
}

const FAKE_COORDINATOR_PID = 424_242;
const launches = vi.hoisted((): Launch[] => []);

// A stand-in coordinator process: records how it was launched and answers prepare and close.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { EventEmitter } = await import("node:events");
	return {
		...actual,
		fork(modulePath: string, args: readonly string[], options: ForkOptions) {
			const launch: Launch = { modulePath, args, options, sent: [] };
			launches.push(launch);
			const child = Object.assign(new EventEmitter(), {
				pid: FAKE_COORDINATOR_PID,
				connected: true,
				exitCode: null as number | null,
				signalCode: null as string | null,
				stderr: new EventEmitter(),
				send(message: Record<string, unknown>, callback?: (error: Error | null) => void) {
					launch.sent.push(message);
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
			launch.child = child;
			return child;
		},
	};
});
vi.mock("@bastani/atomic", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bastani/atomic")>()),
	isBunBinary: true,
}));

afterEach(() => {
	launches.length = 0;
});

test("in the compiled binary a pool launches its coordinator, and has it launch workers, through the internal worker argument (#3903)", async () => {
	const directory = makeTempDirectory("pool-coordinator-launch-");
	const path = join(directory, "journal.sqlite");
	const journal = await resolveRunJournal({ journal: { path } });
	const backend = await JournalDurableBackend.open(journal);
	const pool = new LocalWorkerPool(backend, { journalPath: path, workers: 2, definitions: [] });
	try {
		await backend.commitWorkflowRegistration({
			workflowId: "root",
			name: "root",
			inputs: {},
			createdAt: 0,
			status: "running",
		});
		// A root whose pool already ran, as a resumed root's did, starts its coordinator as it is prepared, to recover
		// that pool; any other root starts it with its first pooled child.
		const lease = await journal.leaseState("root");
		assert.ok(lease);
		await (await openSqlPoolQueue(journal)).initialize(
			{ runId: "root", holderId: lease.holderId, epoch: lease.epoch },
			3 * STAGE_SESSION_HEARTBEAT_INTERVAL_MS,
		);
		await pool.prepare("root");
		assert.equal(launches.length, 1, "one coordinator process per pool");
		const [launch] = launches;
		assert.equal(
			launch!.modulePath,
			INTERNAL_WORKFLOW_WORKER_ARG,
			"the launcher's own worker entry runs the coordinator",
		);
		assert.deepEqual(
			launch!.args.map((arg) => JSON.parse(arg)),
			[{ role: POOL_COORDINATOR_ROLE }],
			"exactly the one JSON argument the launcher's worker entry accepts",
		);
		assert.deepEqual(launch!.options.stdio, ["ignore", "ignore", "pipe", "ipc"]);
		const prepare = launch!.sent.find((message) => message.kind === "prepare") as
			| { readonly root: string; readonly options: { readonly workerEntry?: string; readonly journalPath: string } }
			| undefined;
		assert.equal(prepare?.root, "root");
		assert.equal(prepare?.options.journalPath, path);
		assert.equal(prepare?.options.workerEntry, INTERNAL_WORKFLOW_WORKER_ARG, "workers start from the launcher too");
		assert.equal(pool.coordinatorPid, FAKE_COORDINATOR_PID);
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("a pool's coordinator starts with the debug setting, hears later changes, and its counts reach the debug log (#4360)", async () => {
	await withDebugLog("off", async (log) => {
		const directory = makeTempDirectory("pool-coordinator-debug-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const pool = new LocalWorkerPool(backend, { journalPath: path, workers: 1, definitions: [] });
		try {
			await backend.commitWorkflowRegistration({
				workflowId: "root",
				name: "root",
				inputs: {},
				createdAt: 0,
				status: "running",
			});
			const lease = await journal.leaseState("root");
			assert.ok(lease);
			await (await openSqlPoolQueue(journal)).initialize(
				{ runId: "root", holderId: lease.holderId, epoch: lease.epoch },
				3 * STAGE_SESSION_HEARTBEAT_INTERVAL_MS,
			);
			setDebugSetting(true);
			await pool.prepare("root");
			const [launch] = launches;
			assert.equal(launch!.options.env?.ATOMIC_DEBUG_SETTING, "1", "the coordinator starts with the setting");
			assert.equal(launch!.options.env?.AI_AGENT, "atomic");
			const debugNotices = () => launch!.sent.filter((message) => message.kind === "debug");
			assert.deepEqual(debugNotices(), [], "nothing to tell a coordinator that started with the current setting");
			setDebugSetting(false);
			setDebugSetting(true);
			assert.deepEqual(debugNotices(), [
				{ kind: "debug", enabled: false },
				{ kind: "debug", enabled: true },
			]);
			const stats = { since: 0, requests: { claim: { count: 2, perSecond: 1 } }, writes: {} };
			(launch!.child as EventEmitter).emit("message", { kind: "coordination", stats });
			await vi.waitFor(() => assert.equal(log.records().length, 1));
			assert.deepEqual(areaRecords(log, "pool"), [
				{
					event: "coordination",
					data: { root: "root", summary: "pool: requests 1.0/s (claim 1.0) · writes 0.00/s" },
				},
			]);
			assert.deepEqual(pool.coordinationStats(), stats);
		} finally {
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
		const sentBefore = launches[0]!.sent.length;
		setDebugSetting(false);
		assert.equal(launches[0]!.sent.length, sentBefore, "a closed pool stops following the setting");
	});
});

test("a pool that never started its coordinator closes without one (#4360)", async () => {
	const directory = makeTempDirectory("pool-coordinator-unstarted-");
	const path = join(directory, "journal.sqlite");
	const journal = await resolveRunJournal({ journal: { path } });
	const backend = await JournalDurableBackend.open(journal);
	try {
		const pool = new LocalWorkerPool(backend, { journalPath: path, workers: 1, definitions: [] });
		await pool.close();
		setDebugSetting(true);
		assert.equal(launches.length, 0, "neither closing nor a setting change starts a coordinator");
	} finally {
		setDebugSetting(false);
		await backend.close();
		removeTempDirectory(directory);
	}
});
