import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { test } from "vitest";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { isRetryableWorkflowError, WorkflowInfrastructureError } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowOutputValues } from "../../packages/workflows/src/shared/types.js";
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
	sleep,
	spawnProcess,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

const WORKER_FAILURE_ROOT_TIMEOUT_MS = 150_000;
const CONDITION_TIMEOUT_MS = 90_000;
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

test.skipIf(process.platform === "win32")(
	"a child that exhausts its own attempt limit fails alone, by name, while a sibling waiting on a prompt completes (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-child-retry-limit-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const crashingPath = fileURLToPath(new URL("../fixtures/pool-crashing-child.ts", import.meta.url));
		const promptPath = fileURLToPath(new URL("../fixtures/pool-prompt-child.ts", import.meta.url));
		const crashing = await loadWorkerDefinition({
			path: crashingPath,
			exportName: "crashingChild",
			digest: await definitionDigest(crashingPath),
		});
		const asking = await loadWorkerDefinition({
			path: promptPath,
			exportName: "child",
			digest: await definitionDigest(promptPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 2,
			definitions: [
				{ definition: crashing, path: crashingPath, exportName: "crashingChild" },
				{ definition: asking, path: promptPath, exportName: "child" },
			],
		});
		const root = "pool-child-retry-limit-root";
		let crashFailure: unknown;
		const parent = workflow({
			name: root,
			description: "",
			inputs: {},
			outputs: { branch: Type.String() },
			async run(ctx) {
				// Every attempt of the crashing child kills its worker; the asking child's worker is never touched.
				const crashed = ctx.workflow(crashing).then(
					() => {},
					(error: unknown) => {
						crashFailure = error;
					},
				);
				const asked = ctx.workflow(asking, {});
				await crashed;
				return { branch: String((await asked).outputs.branch) };
			},
		});
		const store = createStore();
		try {
			const execution = run(
				parent,
				{},
				{ runId: root, cwd: directory, store, durableBackend: backend, usePromptNodesForUi: true },
			);
			await untilOrRunEnds(async () => crashFailure !== undefined, execution, CONDITION_TIMEOUT_MS);
			let prompt: { runId: string; stageId: string; promptId: string } | undefined;
			await untilOrRunEnds(
				async () => {
					for (const candidate of store.runs())
						for (const stage of candidate.stages)
							if (stage.pendingPrompt !== undefined && stage.workerExecution !== undefined)
								prompt = { runId: candidate.id, stageId: stage.id, promptId: stage.pendingPrompt.id };
					return prompt !== undefined;
				},
				execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(prompt !== undefined);
			assert.equal(store.resolveStagePendingPrompt(prompt.runId, prompt.stageId, prompt.promptId, "main"), true);
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "main" });

			assert.ok(crashFailure instanceof WorkflowInfrastructureError, String(crashFailure));
			assert.ok(isRetryableWorkflowError(crashFailure));
			assert.equal(crashFailure.code, "worker_retry_limit");
			assert.match(crashFailure.message, /Local worker retry limit/);
			await pool.close();
			const work = await (await openSqlPoolQueue(journal)).inspect(root);
			const failed = work.find((item) => item.definition.endsWith("#crashingChild"));
			assert.ok(failed, JSON.stringify(work));
			assert.ok(crashFailure.message.includes(failed.childRunId), crashFailure.message);
			assert.deepEqual(
				Object.fromEntries(work.map((item) => [item.definition.split("#")[1], item.state])),
				{ crashingChild: "failed", child: "completed" },
				"every work row of the finished root is terminal",
			);
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);

/**
 * Fails the whole pool the way only a pool-wide fault does: every worker but the one whose pid `busyPidFile` names
 * is SIGKILLed as soon as it appears, so workers keep crashing without work, until `done`. Only replacement workers
 * may be idle when it starts: an initial worker killed before readiness is not replaced.
 */
async function crashIdleWorkers(pool: LocalWorkerPool, busyPidFile: string, done: () => boolean): Promise<void> {
	const killed = new Set<number>();
	const deadline = performance.now() + CONDITION_TIMEOUT_MS;
	while (!done()) {
		if (performance.now() > deadline) assert.fail("the pool never failed");
		const busy = fileExistsSync(busyPidFile) ? Number(readTextSync(busyPidFile, "utf8")) : 0;
		if (busy > 0)
			for (const pid of pool.workerPids)
				if (pid !== busy && !killed.has(pid)) {
					killed.add(pid);
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
		await sleep(25);
	}
}

const heldChildPath = fileURLToPath(new URL("../fixtures/pool-worker-failure-child.ts", import.meta.url));

test.skipIf(process.platform === "win32")(
	"a child started after the pool failed gets the pool's fault instead of running in the host (#3979)",
	async () => {
		const directory = makeTempDirectory("pool-fault-no-host-fallback-");
		const held = join(directory, "held");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const holding = await loadWorkerDefinition({
			path: heldChildPath,
			exportName: "releasedChild",
			digest: await definitionDigest(heldChildPath),
		});
		const laterPath = fileURLToPath(new URL("../fixtures/pool-resume-child.ts", import.meta.url));
		const later = await loadWorkerDefinition({
			path: laterPath,
			exportName: "resumedChild",
			digest: await definitionDigest(laterPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [
				{ definition: holding, path: heldChildPath, exportName: "releasedChild" },
				{ definition: later, path: laterPath, exportName: "resumedChild" },
			],
		});
		await writeFileEnsuringDir(join(held, "placeholder"), "");
		await writeFileEnsuringDir(join(directory, "release"), "");
		let first: unknown;
		let afterFault: unknown;
		let laterOutputs: WorkflowOutputValues | undefined;
		const parent = workflow({
			name: "pool-fault-no-host-fallback-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				// Its release file never appears: it holds its worker until the coordinator dies.
				await ctx.workflow(holding, { inputs: { directory: held, index: 0 } }).catch((error: Error) => {
					first = error;
				});
				try {
					laterOutputs = (await ctx.workflow(later, { inputs: { directory, index: 0 } })).outputs;
				} catch (error) {
					afterFault = error;
				}
				return {};
			},
		});
		try {
			const execution = run(
				parent,
				{},
				{
					runId: "pool-fault-no-host-fallback-root",
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
				},
			);
			// A coordinator that dies is a pool-wide fault.
			await untilOrRunEnds(async () => fileExistsSync(join(held, "started-0")), execution, CONDITION_TIMEOUT_MS);
			process.kill(pool.coordinatorPid!, "SIGKILL");
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.ok(first instanceof WorkflowInfrastructureError, String(first));
			assert.equal(laterOutputs, undefined, "the later child ran in the host process");
			assert.ok(afterFault instanceof WorkflowInfrastructureError, String(afterFault));
			assert.equal(afterFault.code, first.code);
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a pool that fails settles the work of its root, so none stays ready or leased after the root completes (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-fault-releases-leases-");
		const held = join(directory, "held");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const crashingPath = fileURLToPath(new URL("../fixtures/pool-crashing-child.ts", import.meta.url));
		const crashing = await loadWorkerDefinition({
			path: crashingPath,
			exportName: "crashingChild",
			digest: await definitionDigest(crashingPath),
		});
		const holding = await loadWorkerDefinition({
			path: heldChildPath,
			exportName: "releasedChild",
			digest: await definitionDigest(heldChildPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 2,
			definitions: [
				{ definition: crashing, path: crashingPath, exportName: "crashingChild" },
				{ definition: holding, path: heldChildPath, exportName: "releasedChild" },
			],
		});
		await writeFileEnsuringDir(join(held, "placeholder"), "");
		const root = "pool-fault-releases-leases-root";
		let settled: PromiseSettledResult<unknown>[] | undefined;
		let crashFailure: unknown;
		const parent = workflow({
			name: "pool-fault-releases-leases-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				// The holding child keeps its worker's lease until the pool fails: its release file never appears.
				settled = await Promise.allSettled([
					ctx.workflow(holding, { inputs: { directory: held, index: 0 } }),
					ctx.workflow(crashing).catch((error: unknown) => {
						crashFailure = error;
						throw error;
					}),
				]);
				return {};
			},
		});
		try {
			const execution = run(
				parent,
				{},
				{ runId: root, cwd: directory, store: createStore(), durableBackend: backend },
			);
			// The crashing child fails alone first; every worker not holding the other child is then a replacement.
			await untilOrRunEnds(async () => crashFailure !== undefined, execution, CONDITION_TIMEOUT_MS);
			assert.ok(crashFailure instanceof WorkflowInfrastructureError, String(crashFailure));
			assert.equal(crashFailure.code, "worker_retry_limit");
			await crashIdleWorkers(pool, join(held, "started-0"), () => settled !== undefined);
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.deepEqual(
				settled?.map((result) => result.status),
				["rejected", "rejected"],
			);
			await pool.close().catch(() => {});
			const work = await (await openSqlPoolQueue(journal)).inspect(root);
			assert.equal(work.length, 2);
			assert.deepEqual(
				work.filter((item) => item.state === "leased" || item.state === "ready").map((item) => item.childRunId),
				[],
				"no work of the finished root stays ready or leased",
			);
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);
