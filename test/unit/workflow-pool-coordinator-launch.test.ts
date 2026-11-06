import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PassThrough } from "node:stream";
import { afterEach, test, vi } from "vitest";
import { INTERNAL_WORKFLOW_WORKER_ARG } from "../../packages/coding-agent/src/bun/internal-workflow-worker.js";
import { setDebugSetting } from "../../packages/coding-agent/src/core/debug-setting.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import {
	rehydrateError,
	type SerializedError,
	serializeError,
} from "../../packages/workflows/src/shared/error-codec.js";
import { registerWorkflowPendingStageRouteReadiness } from "../../packages/workflows/src/shared/pending-stage-route-readiness.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import {
	isPublicationRejectedError,
	isStaleWorkLeaseError,
} from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	isWorkerLostError,
	isWorkerRetryLimitError,
	WorkerRetryLimitError,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { POOL_COORDINATOR_ROLE } from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import type { WatchId } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { areaRecords, withDebugLog } from "../helpers/debug-mode.js";
import { poolNotInitialized } from "../helpers/pool-errors.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

interface Launch {
	readonly modulePath: string;
	readonly args: readonly string[];
	readonly options: ForkOptions;
	readonly sent: Record<string, unknown>[];
	child?: unknown;
	/** The stand-in coordinator's stderr, which the pool writes to the coordinator's log. */
	stderr?: PassThrough;
	/**
	 * Ends the stand-in coordinator as a crash would, after it wrote `stderr`. `onExit` runs as the exit is announced,
	 * right after the pool heard of it and before anything it queued for later.
	 */
	crash?: (stderr: string, code: number | null, signal?: string, onExit?: () => void) => void;
	/** When set, the stand-in coordinator refuses the root's close with this error. */
	closeError?: SerializedError;
	/** Delivers an event from the stand-in coordinator to the root. */
	emit?: (event: Record<string, unknown>) => void;
}

const FAKE_COORDINATOR_PID = 424_242;
/** How long a loaded runner may take to write a stand-in coordinator's stderr to its log. */
const LOG_DRAIN_TIMEOUT_MS = 10_000;
const launches = vi.hoisted((): Launch[] => []);

// A stand-in coordinator process: records how it was launched and answers prepare and close.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
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
				stderr: new PassThrough(),
				send(message: Record<string, unknown>, callback?: (error: Error | null) => void) {
					launch.sent.push(message);
					callback?.(null);
					if (message.kind === "prepare" || message.kind === "close" || message.kind === "start") {
						const value =
							message.kind === "prepare"
								? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
								: undefined;
						const error = message.kind === "close" ? launch.closeError : undefined;
						setImmediate(() =>
							child.emit("message", { kind: "reply", id: message.id, ...(error ? { error } : { value }) }),
						);
					}
					return true;
				},
				disconnect() {
					child.stderr.end();
					child.connected = false;
					child.exitCode = 0;
					setImmediate(() => child.emit("exit", 0, null));
				},
				kill() {
					return true;
				},
			});
			launch.emit = (event) => child.emit("message", event);
			launch.stderr = child.stderr;
			launch.crash = (stderr, code, signal, onExit) => {
				child.stderr.end(stderr);
				child.connected = false;
				child.exitCode = code;
				child.signalCode = signal ?? null;
				if (onExit !== undefined) child.once("exit", onExit);
				setImmediate(() => child.emit("exit", code, signal ?? null));
			};
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

async function preparedPool(directory: string, store?: Store) {
	const path = join(directory, "journal.sqlite");
	const journal = await resolveRunJournal({ journal: { path } });
	const backend = await JournalDurableBackend.open(journal);
	const pool = new LocalWorkerPool(backend, { journalPath: path, workers: 1, definitions: [] });
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
	await pool.prepare("root", store);
	return { pool, backend, logPath: join(directory, "worker-logs", "root", "coordinator.log") };
}

test("a lost coordinator's error names its stderr log, which keeps what the coordinator wrote (#4327)", async () => {
	const directory = makeTempDirectory("pool-coordinator-log-");
	const { pool, backend, logPath } = await preparedPool(directory);
	try {
		launches[0]!.crash!("coordinator failed: database is locked\n", 3);
		const lost = await pool.control("paused").then(
			() => assert.fail("a lost coordinator answered"),
			(error: unknown) => error,
		);
		assert.ok(isWorkerLostError(lost), String(lost));
		assert.equal(lost.phase, "coordinator");
		assert.equal(lost.exitCode, 3);
		assert.equal(lost.logPath, logPath);
		assert.equal(lost.logFailure, undefined);
		// The log is written as the coordinator's stderr drains, which may finish after its exit is reported.
		await vi.waitFor(() => assert.equal(readFileSync(logPath, "utf8"), "coordinator failed: database is locked\n"), {
			timeout: LOG_DRAIN_TIMEOUT_MS,
		});
		await pool.close();
		assert.equal(existsSync(logPath), true, "a lost coordinator's log is kept for diagnosis");
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("a coordinator log that cannot be written is drained, and the loss error says why (#4327)", async () => {
	const directory = makeTempDirectory("pool-coordinator-log-");
	writeFileSync(join(directory, "worker-logs"), "a file where the log directory belongs");
	const { pool, backend, logPath } = await preparedPool(directory);
	try {
		launches[0]!.crash!("written nowhere\n", 1);
		const lost = await pool.control("paused").then(
			() => assert.fail("a lost coordinator answered"),
			(error: unknown) => error,
		);
		assert.ok(isWorkerLostError(lost), String(lost));
		assert.equal(lost.logPath, logPath);
		assert.ok(lost.logFailure === "ENOTDIR" || lost.logFailure === "EEXIST", String(lost.logFailure));
		assert.match(lost.message, /could not be written: E[A-Z]+ \(worker_lost\)/);
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("a pool that closes cleanly removes its coordinator's log and the root's log directory (#4327)", async () => {
	const directory = makeTempDirectory("pool-coordinator-log-");
	const { pool, backend, logPath } = await preparedPool(directory);
	try {
		await pool.close();
		assert.equal(existsSync(logPath), false);
		assert.equal(existsSync(join(directory, "worker-logs", "root")), false);
	} finally {
		await backend.close();
		removeTempDirectory(directory);
	}
});

async function sentMessage(launch: Launch, kind: string): Promise<Record<string, unknown>> {
	for (let waited = 0; waited < 200; waited++) {
		const found = launch.sent.find((message) => message.kind === kind);
		if (found !== undefined) return found;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return assert.fail(`the root never sent ${kind}`);
}

test("the root refuses requests and publications of work it does not track, typed, across the IPC (#4327)", async () => {
	const directory = makeTempDirectory("pool-coordinator-untracked-");
	const store = createStore();
	// A route owner on the store keeps the pool from starting the root's own Intercom routes.
	const unregister = registerWorkflowPendingStageRouteReadiness(store, () => undefined);
	const { pool, backend } = await preparedPool(directory, store);
	try {
		// The root starts its pool's stage handoff with its first pooled child; this test has no child to run.
		await (pool as unknown as { start(root: string, promptNodes: boolean): Promise<void> }).start("root", false);
		const launch = launches[0]!;
		const token = { id: "untracked-work", generation: 2, worker: "worker", epoch: 1, renewedAt: 0, expiresAt: 0 };
		launch.emit!({
			kind: "request",
			id: 7,
			request: { kind: "ready", work: token, runId: "run", stageId: "s", stageName: "s" },
		});
		const reply = (await sentMessage(launch, "request-reply")) as { id: number; error?: SerializedError };
		assert.equal(reply.id, 7);
		const refused = rehydrateError(reply.error);
		assert.ok(isStaleWorkLeaseError(refused), String(refused));
		assert.equal(refused.root, "root");
		assert.equal(refused.workId, "untracked-work");
		assert.equal(refused.generation, 2);
		assert.equal(refused.reason, "missing");

		launch.emit!({ kind: "activity", batch: 3, entries: [{ work: token, runs: [] }] });
		const published = (await sentMessage(launch, "published")) as {
			batch: number;
			rejected: { workId: string; generation: number; error: SerializedError }[];
		};
		assert.equal(published.batch, 3);
		assert.equal(published.rejected.length, 1);
		assert.equal(published.rejected[0]!.workId, "untracked-work");
		assert.equal(published.rejected[0]!.generation, 2);
		const rejection = rehydrateError(published.rejected[0]!.error);
		assert.ok(isPublicationRejectedError(rejection), String(rejection));
		assert.deepEqual(
			[rejection.root, rejection.workId, rejection.generation, rejection.reason],
			["root", "untracked-work", 2, "stale-lease"],
		);
		const cause = rejection.cause;
		assert.ok(isStaleWorkLeaseError(cause), String(cause));
		assert.deepEqual(
			[cause.root, cause.workId, cause.generation, cause.reason],
			["root", "untracked-work", 2, "missing"],
		);
	} finally {
		await pool.close();
		await backend.close();
		unregister();
		removeTempDirectory(directory);
	}
});

test("a pool whose coordinator log could not be written still closes cleanly (#4327)", async () => {
	const directory = makeTempDirectory("pool-coordinator-log-");
	writeFileSync(join(directory, "worker-logs"), "a file where the log directory belongs");
	const { pool, backend } = await preparedPool(directory);
	try {
		await pool.close();
		assert.equal(existsSync(join(directory, "worker-logs")), true, "what was there is left alone");
	} finally {
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("a coordinator killed by a signal is lost with that signal (#4327)", async () => {
	const directory = makeTempDirectory("pool-coordinator-log-");
	const { pool, backend } = await preparedPool(directory);
	try {
		launches[0]!.crash!("", null, "SIGKILL");
		const lost = await pool.control("paused").then(
			() => assert.fail("a lost coordinator answered"),
			(error: unknown) => error,
		);
		assert.ok(isWorkerLostError(lost), String(lost));
		assert.equal(lost.signal, "SIGKILL");
		assert.equal(lost.exitCode, undefined);
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("a pool keeps its coordinator's log when the pool failed or its close was refused (#4327)", async () => {
	for (const ending of ["pool failure", "refused close"] as const) {
		const directory = makeTempDirectory("pool-coordinator-log-");
		const { pool, backend, logPath } = await preparedPool(directory);
		try {
			const launch = launches.at(-1)!;
			const refusal = serializeError(new WorkerRetryLimitError({ reason: "worker-crashes", attempts: 4, limit: 3 }));
			if (ending === "pool failure") launch.emit!({ kind: "failure", error: refusal });
			else launch.closeError = refusal;
			await new Promise((resolve) => setTimeout(resolve, 20));
			const closed = await pool.close().then(
				() => undefined,
				(error: unknown) => error,
			);
			if (ending === "refused close") assert.ok(isWorkerRetryLimitError(closed), String(closed));
			assert.equal(existsSync(logPath), true, `${ending}: the coordinator's log is kept for diagnosis`);
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	}
});

test("a pool closed as its coordinator is lost keeps the coordinator's log, whether or not the loss reached the pool's failure yet (#4327)", async () => {
	const directory = makeTempDirectory("pool-coordinator-log-");
	const { pool, backend, logPath } = await preparedPool(directory);
	try {
		const launch = launches[0]!;
		const written = "coordinator failed: out of memory\n";
		launch.stderr!.write(written);
		await vi.waitFor(() => assert.equal(readFileSync(logPath, "utf8"), written), { timeout: LOG_DRAIN_TIMEOUT_MS });
		// The pool learns of the loss and is closed in the same turn: the loss has not become the pool's failure yet,
		// and the close sends the coordinator nothing, so only the loss itself says the log is worth keeping.
		const closed = new Promise<void>((resolve) => launch.crash!("", 1, undefined, () => resolve(pool.close())));
		await closed;
		assert.equal(readFileSync(logPath, "utf8"), written, "a lost coordinator's log is kept for diagnosis");
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("a pool nobody prepared refuses a stage command before it launches a coordinator (#4327)", async () => {
	const directory = makeTempDirectory("pool-coordinator-unprepared-");
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const pool = new LocalWorkerPool(backend, { journalPath: path, workers: 1, definitions: [] });
	try {
		const refused = pool.pausePooledStage("watch" as WatchId);
		// The command reaches for the coordinator in the call itself, so a coordinator launched for it exists by now.
		assert.deepEqual(launches, [], "no coordinator is launched for a root nobody prepared");
		await assert.rejects(refused, poolNotInitialized(undefined));
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});

const CHILD = workflow({
	name: "child",
	description: "",
	inputs: {},
	outputs: {},
	async run() {
		assert.fail("a pool not prepared for the child's root ran it");
	},
});

/** How a pool came to be unprepared for the child's root `child`, and the root its refusal names. */
const UNPREPARED: readonly {
	readonly name: string;
	readonly child: string;
	readonly root: string | undefined;
	readonly launched: number;
	readonly arrange: (pool: LocalWorkerPool, backend: JournalDurableBackend) => Promise<void>;
}[] = [
	{ name: "nobody prepared it", child: "root", root: undefined, launched: 0, arrange: async () => {} },
	{
		name: "its root has no owner here",
		child: "root",
		root: "root",
		launched: 0,
		arrange: async (pool) => {
			await assert.rejects(pool.prepare("root"));
		},
	},
	{
		name: "its preparation failed before it opened the pool",
		child: "root",
		root: "root",
		launched: 1,
		arrange: async (pool, backend) => {
			await registerRoot(backend, "root");
			const failure = new Error("checkpoint retention failed");
			vi.spyOn(backend, "retainOwnCheckpoints").mockRejectedValueOnce(failure);
			await assert.rejects(pool.prepare("root"), (error) => error === failure);
		},
	},
	{
		name: "it was prepared for another root",
		child: "other",
		root: "other",
		launched: 1,
		arrange: async (pool, backend) => {
			await registerRoot(backend, "root");
			await pool.prepare("root");
		},
	},
];

async function registerRoot(backend: JournalDurableBackend, workflowId: string): Promise<void> {
	await backend.commitWorkflowRegistration({
		workflowId,
		name: workflowId,
		inputs: {},
		createdAt: 0,
		status: "running",
	});
}

test.each(UNPREPARED)(
	"a pool refuses a child when $name, typed with the root it is not prepared for (#4327)",
	async ({ child, root, launched, arrange }) => {
		const directory = makeTempDirectory("pool-coordinator-unprepared-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ path: join(directory, "child.ts"), exportName: "child", definition: CHILD }],
		});
		try {
			await arrange(pool, backend);
			await assert.rejects(
				pool.run(
					CHILD,
					{},
					{
						parentRun: { runId: child, stageId: "stage", rootRunId: child },
						durableScope: { rootWorkflowId: child, scopePrefix: "child" },
					},
				),
				poolNotInitialized(root),
			);
			assert.equal(launches.length, launched, "a coordinator runs only for a root the pool was prepared for");
			assert.deepEqual(
				launches.flatMap((launch) => launch.sent.filter((message) => message.kind === "start")),
				[],
				"the refused child started no workers",
			);
		} finally {
			vi.restoreAllMocks();
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
);

// An open file cannot be replaced by a directory on Windows.
test.skipIf(process.platform === "win32")(
	"a coordinator log that cannot be removed fails the pool's close instead of vanishing (#4327)",
	async () => {
		const directory = makeTempDirectory("pool-coordinator-log-");
		const { pool, backend, logPath } = await preparedPool(directory);
		try {
			await vi.waitFor(() => assert.equal(existsSync(logPath), true), { timeout: LOG_DRAIN_TIMEOUT_MS });
			rmSync(logPath);
			mkdirSync(join(logPath, "not-a-log"), { recursive: true });
			await assert.rejects(pool.close(), (error: unknown) => {
				assert.ok(typeof (error as { code?: unknown }).code === "string", String(error));
				return true;
			});
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
);

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
