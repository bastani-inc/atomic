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
import { createStore } from "../../packages/workflows/src/shared/store.js";
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
