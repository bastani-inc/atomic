import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { isRetryableWorkflowError, WorkflowInfrastructureError } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import {
	fileExists,
	fileExistsSync,
	makeTempDirectory,
	readJson,
	readStreamText,
	readText,
	readTextSync,
	removeTempDirectory,
	spawnProcess,
} from "../helpers/runtime.js";

const WORKER_FAILURE_ROOT_TIMEOUT_MS = 150_000;
const ROOT_PROCESS_TIMEOUT_MS = 120_000;
const LOCAL_WORKER_STARTUP_TEST_TIMEOUT_MS = 120_000;
const CONFIGURED_STARTUP_TIMEOUT_MS = 500;
const DESCENDANT_STDERR_HOLD_MS = 60_000;
const STARTUP_STDERR = "pool startup fixture stderr (#3887)";
const ROOT = "pool-startup-root";
const rootFixture = fileURLToPath(new URL("../fixtures/pool-worker-failure-root.mjs", import.meta.url));
const startupChildPath = fileURLToPath(new URL("../fixtures/pool-startup-child.ts", import.meta.url));

interface RootOutcome {
	readonly status: string;
	readonly error: string | null;
	readonly children: readonly { readonly status: string; readonly firstPid: number; readonly finalPid: number }[];
	readonly workerPids: readonly number[];
	readonly failedWorker: number;
}

async function runRootProcess(mode: "unanswered" | "killed", directory: string) {
	const root = spawnProcess([process.execPath, rootFixture, mode, directory], {
		cwd: directory,
		stdout: "ignore",
		stderr: "pipe",
		timeout: ROOT_PROCESS_TIMEOUT_MS,
	});
	const stderr = readStreamText(root.stderr);
	const exitCode = await root.exited;
	return { exitCode, stderr: await stderr };
}

function assertReplayedOnReplacement(outcome: RootOutcome, index: number): void {
	const child = outcome.children[index];
	assert.ok(child, JSON.stringify(outcome));
	assert.equal(child.status, "completed");
	assert.equal(child.firstPid, outcome.failedWorker, "the committed checkpoint is replayed, not repeated");
	assert.notEqual(child.finalPid, outcome.failedWorker);
	assert.ok(outcome.workerPids.includes(child.finalPid), "a replacement worker finished the child");
	assert.ok(!outcome.workerPids.includes(outcome.failedWorker));
}

test.skipIf(process.platform === "win32")(
	"the root survives failed replies to a worker that died with requests pending (#3887)",
	async () => {
		const directory = makeTempDirectory("pool-unanswered-worker-");
		try {
			const { exitCode, stderr } = await runRootProcess("unanswered", directory);
			assert.equal(exitCode, 0, stderr);
			assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error' event/);
			const outcome = await readJson<RootOutcome>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assertReplayedOnReplacement(outcome, 0);
		} finally {
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker SIGKILLed mid-child is fenced and its child replays on a replacement (#3887)",
	async () => {
		const directory = makeTempDirectory("pool-killed-worker-");
		try {
			const { exitCode, stderr } = await runRootProcess("killed", directory);
			assert.equal(exitCode, 0, stderr);
			const outcome = await readJson<RootOutcome>(join(directory, "outcome.json"));
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assertReplayedOnReplacement(outcome, 0);
			assert.equal(outcome.children[1]?.status, "completed");
			assert.notEqual(outcome.children[1]?.firstPid, outcome.failedWorker);
		} finally {
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);

interface StartupPoolOptions {
	readonly workers: number;
	readonly mode?: "exit" | "exit-with-descendant" | "hang-first" | "hang-all";
	readonly startupTimeoutMs?: number;
	readonly beforeRun?: (journalPath: string) => Promise<void>;
}

async function runStartupPool(
	directory: string,
	options: StartupPoolOptions,
): Promise<{ result: RunResult; pid?: number }> {
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const child = await loadWorkerDefinition({
		path: startupChildPath,
		exportName: "child",
		digest: await definitionDigest(startupChildPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: options.workers,
		definitions: [{ definition: child, path: startupChildPath, exportName: "child" }],
		startupTimeoutMs: options.startupTimeoutMs,
	});
	let pid: number | undefined;
	const parent = workflow({
		name: ROOT,
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			pid = Number((await ctx.workflow(child)).outputs.pid);
			return {};
		},
	});
	if (options.mode) {
		process.env.ATOMIC_TEST_POOL_STARTUP_DIR = directory;
		process.env.ATOMIC_TEST_POOL_STARTUP_MODE = options.mode;
	}
	try {
		await options.beforeRun?.(path);
		const result = await run(
			parent,
			{},
			{ runId: ROOT, cwd: directory, store: createStore(), durableBackend: backend },
		);
		return { result, pid };
	} finally {
		delete process.env.ATOMIC_TEST_POOL_STARTUP_DIR;
		delete process.env.ATOMIC_TEST_POOL_STARTUP_MODE;
		await pool.close();
		await backend.close();
	}
}

function namedWorkerLog(directory: string, error: string | undefined): string {
	const path = /worker stderr log: (\S+\.log)/.exec(error ?? "")?.[1];
	assert.ok(path, error);
	assert.ok(path.startsWith(join(directory, "worker-logs", ROOT)), path);
	return path;
}

test.skipIf(process.platform === "win32")(
	"a worker that exits before readiness keeps its stderr in a durable log named by the failure (#3887)",
	async () => {
		const directory = makeTempDirectory("pool-startup-exit-");
		try {
			const { result } = await runStartupPool(directory, { workers: 1, mode: "exit" });
			assert.equal(result.status, "failed", JSON.stringify(result));
			assert.match(result.error ?? "", /Local worker exited before readiness/);
			assert.ok(result.error?.includes(STARTUP_STDERR), result.error);
			const log = namedWorkerLog(directory, result.error);
			assert.ok((await readText(log)).includes(STARTUP_STDERR));
		} finally {
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_STARTUP_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"startup fails when a worker exits while a descendant still holds its stderr (#3887)",
	async () => {
		const directory = makeTempDirectory("pool-startup-descendant-");
		try {
			const started = performance.now();
			const { result } = await runStartupPool(directory, { workers: 1, mode: "exit-with-descendant" });
			assert.ok(performance.now() - started < DESCENDANT_STDERR_HOLD_MS, "startup settled while stderr stayed open");
			assert.equal(result.status, "failed", JSON.stringify(result));
			assert.match(result.error ?? "", /Local worker exited before readiness/);
		} finally {
			const descendant = Number(readTextSync(join(directory, "descendant"), "utf8"));
			if (descendant > 0) process.kill(descendant, "SIGKILL");
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_STARTUP_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"the local worker startup timeout is configurable and its failure names the stderr log (#3887)",
	async () => {
		const directory = makeTempDirectory("pool-startup-timeout-");
		try {
			const { result } = await runStartupPool(directory, {
				workers: 1,
				mode: "hang-all",
				startupTimeoutMs: CONFIGURED_STARTUP_TIMEOUT_MS,
			});
			assert.equal(result.status, "failed", JSON.stringify(result));
			assert.match(
				result.error ?? "",
				new RegExp(`Local worker startup timed out after ${CONFIGURED_STARTUP_TIMEOUT_MS} ms`),
			);
			assert.ok(await fileExists(namedWorkerLog(directory, result.error)));
		} finally {
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_STARTUP_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a pool runs children once one worker is ready while another is still starting (#3887)",
	async () => {
		const directory = makeTempDirectory("pool-startup-slow-");
		try {
			const { result, pid } = await runStartupPool(directory, { workers: 2, mode: "hang-first" });
			assert.equal(result.status, "completed", JSON.stringify(result));
			const slowWorker = Number(readTextSync(join(directory, "slow-worker"), "utf8"));
			assert.ok(pid !== undefined && pid !== slowWorker && pid !== process.pid, String(pid));
			assert.equal(
				fileExistsSync(join(directory, "worker-logs", ROOT)),
				false,
				"logs of workers stopped with the pool are removed",
			);
		} finally {
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_STARTUP_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"local worker readiness does not read unrelated journal runs (#3887)",
	async () => {
		const directory = makeTempDirectory("pool-startup-unrelated-");
		try {
			const { result } = await runStartupPool(directory, {
				workers: 1,
				async beforeRun(path) {
					const writer = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
					await writer.commitWorkflowRegistration({
						workflowId: "unrelated",
						name: "unrelated",
						inputs: {},
						createdAt: 0,
						status: "completed",
					});
					await writer.close();
					const database = new TestSqliteDatabase(path);
					try {
						database.run("UPDATE wf_events SET payload = '{' WHERE run_id = 'unrelated'");
					} finally {
						database.close();
					}
				},
			});
			assert.equal(result.status, "completed", JSON.stringify(result));
		} finally {
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_STARTUP_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a pool fault it cannot absorb reaches every waiting ctx.workflow as a typed retryable error (#3889)",
	async () => {
		const directory = makeTempDirectory("pool-typed-fault-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const childPath = fileURLToPath(new URL("../fixtures/pool-crashing-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "crashingChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 2,
			definitions: [{ definition: child, path: childPath, exportName: "crashingChild" }],
		});
		const caught: unknown[] = [];
		const parent = workflow({
			name: "pool-typed-fault-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const settled = await Promise.allSettled([ctx.workflow(child), ctx.workflow(child)]);
				for (const outcome of settled) if (outcome.status === "rejected") caught.push(outcome.reason);
				return {};
			},
		});
		try {
			await run(
				parent,
				{},
				{ runId: "pool-typed-fault-root", cwd: directory, store: createStore(), durableBackend: backend },
			);
			assert.equal(caught.length, 2, "both concurrent children fail");
			for (const error of caught) {
				assert.ok(isRetryableWorkflowError(error), String(error));
				assert.ok(error instanceof WorkflowInfrastructureError);
				assert.equal(error.code, "worker_retry_limit");
				assert.match(error.message, /Local worker retry limit/);
			}
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);
