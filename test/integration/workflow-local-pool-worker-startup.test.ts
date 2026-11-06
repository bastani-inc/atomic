import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import {
	isWorkerStartupError,
	isWorkerStartupTimeoutError,
} from "../../packages/workflows/src/shared/workflow-infrastructure-error.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import {
	fileExists,
	fileExistsSync,
	makeTempDirectory,
	readText,
	readTextSync,
	removeTempDirectory,
} from "../helpers/runtime.js";

/** Worker startup failures in a local pool: exits, hangs and startup timeouts before readiness (#3887). */

const LOCAL_WORKER_STARTUP_TEST_TIMEOUT_MS = 120_000;
const CONFIGURED_STARTUP_TIMEOUT_MS = 500;
const DESCENDANT_STDERR_HOLD_MS = 60_000;
const STARTUP_STDERR = "pool startup fixture stderr (#3887)";
const ROOT = "pool-startup-root";
const startupChildPath = fileURLToPath(new URL("../fixtures/pool-startup-child.ts", import.meta.url));

interface StartupPoolOptions {
	readonly workers: number;
	readonly mode?: "exit" | "exit-with-descendant" | "hang-first" | "hang-all";
	readonly startupTimeoutMs?: number;
	readonly beforeRun?: (journalPath: string) => Promise<void>;
}

async function runStartupPool(
	directory: string,
	options: StartupPoolOptions,
): Promise<{ result: RunResult; pid?: number; failure?: unknown; store: Store }> {
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
	let failure: unknown;
	const parent = workflow({
		name: ROOT,
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			try {
				pid = Number((await ctx.workflow(child)).outputs.pid);
			} catch (error) {
				failure = error;
				throw error;
			}
			return {};
		},
	});
	if (options.mode) {
		process.env.ATOMIC_TEST_POOL_STARTUP_DIR = directory;
		process.env.ATOMIC_TEST_POOL_STARTUP_MODE = options.mode;
	}
	const store = createStore();
	try {
		await options.beforeRun?.(path);
		const result = await run(parent, {}, { runId: ROOT, cwd: directory, store, durableBackend: backend });
		return { result, pid, failure, store };
	} finally {
		delete process.env.ATOMIC_TEST_POOL_STARTUP_DIR;
		delete process.env.ATOMIC_TEST_POOL_STARTUP_MODE;
		await pool.close();
		await backend.close();
	}
}

/** The worker log a typed startup failure names, which lives beside the pool's journal. */
function namedWorkerLog(directory: string, failure: unknown): string {
	assert.ok(isWorkerStartupError(failure), String(failure));
	assert.equal(failure.code, "worker_startup_failed");
	assert.ok(failure.logPath.startsWith(join(directory, "worker-logs", ROOT)), failure.logPath);
	return failure.logPath;
}

test.skipIf(process.platform === "win32")(
	"a worker that exits before readiness keeps its stderr in a durable log named by the failure (#3887)",
	async () => {
		const directory = makeTempDirectory("pool-startup-exit-");
		try {
			const { result, failure } = await runStartupPool(directory, { workers: 1, mode: "exit" });
			assert.equal(result.status, "failed", JSON.stringify(result));
			assert.equal(result.failure?.code, "worker_startup_failed");
			assert.equal(isWorkerStartupTimeoutError(failure), false, "the worker exited; it did not time out");
			// The worker's stderr stays in its log; the error names the log instead of carrying the output.
			assert.equal(result.error?.includes(STARTUP_STDERR), false, result.error);
			const log = namedWorkerLog(directory, failure);
			assert.ok((await readText(log)).includes(STARTUP_STDERR));
		} finally {
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_STARTUP_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker log that cannot be written is named on the startup failure and reported once (#4327)",
	async () => {
		const unwritableLogs = (directory: string) => {
			mkdirSync(join(directory, "worker-logs"));
			writeFileSync(join(directory, "worker-logs", ROOT), "a file where the root's log directory belongs");
		};
		const warnings = (store: Store) =>
			store.notices().filter((notice) => notice.message.includes("could not be written")).length;
		const single = makeTempDirectory("pool-startup-unwritable-log-");
		const pair = makeTempDirectory("pool-startup-unwritable-logs-");
		try {
			unwritableLogs(single);
			const failed = await runStartupPool(single, { workers: 1, mode: "exit" });
			assert.equal(failed.result.status, "failed", JSON.stringify(failed.result));
			const failure = failed.failure;
			assert.ok(isWorkerStartupError(failure), String(failure));
			assert.ok(failure.logFailure === "ENOTDIR" || failure.logFailure === "EEXIST", String(failure.logFailure));
			assert.ok(failure.logPath.startsWith(join(single, "worker-logs", ROOT)), failure.logPath);
			assert.equal(warnings(failed.store), 1);
			// Two workers, the first of which exits: the pool runs on the other, and their unwritable logs are one warning.
			unwritableLogs(pair);
			const ran = await runStartupPool(pair, { workers: 2, mode: "exit" });
			assert.equal(ran.result.status, "completed", JSON.stringify(ran.result));
			assert.equal(warnings(ran.store), 1);
		} finally {
			removeTempDirectory(single);
			removeTempDirectory(pair);
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
			const { result, failure } = await runStartupPool(directory, { workers: 1, mode: "exit-with-descendant" });
			assert.ok(performance.now() - started < DESCENDANT_STDERR_HOLD_MS, "startup settled while stderr stayed open");
			assert.equal(result.status, "failed", JSON.stringify(result));
			namedWorkerLog(directory, failure);
			assert.equal(isWorkerStartupTimeoutError(failure), false);
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
			const { result, failure } = await runStartupPool(directory, {
				workers: 1,
				mode: "hang-all",
				startupTimeoutMs: CONFIGURED_STARTUP_TIMEOUT_MS,
			});
			assert.equal(result.status, "failed", JSON.stringify(result));
			assert.ok(isWorkerStartupTimeoutError(failure), String(failure));
			assert.equal(failure.timeoutMs, CONFIGURED_STARTUP_TIMEOUT_MS);
			assert.equal(failure.phase, "startup");
			assert.ok(failure.elapsedMs >= CONFIGURED_STARTUP_TIMEOUT_MS, String(failure.elapsedMs));
			assert.ok(await fileExists(namedWorkerLog(directory, failure)));
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
