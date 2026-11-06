import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { STAGE_INPUT_PROMPT_ANSWER } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import {
	isWorkspaceRestoreUnavailableError,
	WorkspaceRestoreUnavailableError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import {
	closeCoordinationJournals,
	coordinationPath,
	poolDurableJournal,
} from "../../packages/workflows/src/workers/pool-journal.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { sleep } from "../helpers/runtime.js";
import {
	binding,
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	fanOut,
	fixture,
	libsql,
	PREFIX,
	satellite,
	stubWorker,
} from "../helpers/workflow-shared-pool-coordinator.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

/** Bound work at a worker host of a shared pool (#4310): it restores the workspace a child is bound to or already has it warm. */

test(
	"a worker host restores bound children the root's own workers leave, runs them there, and the root receives their results (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-restore", { workspace: binding });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(3)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		let host: PoolCoordinator | undefined;
		try {
			const root = await f.root();
			assert.deepEqual(
				root.config.definitions.map((definition) => definition.exportName),
				["boundChild"],
			);
			assert.equal(root.config.claimWindowMs, 60_000);
			const restores: string[] = [];
			const failures: Error[] = [];
			host = await satellite(
				f,
				root,
				{
					restore: async (requested) => {
						restores.push(requested.tree);
						return restored;
					},
				},
				failures,
			);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed", "completed", "completed"]);
			assert.deepEqual(
				f.claims().map(([claimer, , cwd]) => [claimer, cwd]),
				[
					["host-b", restored],
					["host-b", restored],
					["host-b", restored],
				],
				"only the host that restores runs bound work, at the restored path",
			);
			assert.deepEqual(restores, ["t1", "t1", "t1"]);
			assert.deepEqual(failures, []);
			assert.ok(
				f.starts().every((start) => start.promptNodes === undefined),
				"a root without prompt nodes has no host raise them",
			);
			const records = await f.shared.stageWorkspaces("root");
			assert.equal(records.length, 3);
			for (const record of records)
				assert.deepEqual([record.host, record.worktree, record.binding], ["host-b", restored, binding]);
			assert.deepEqual((await f.shared.stats("root")).completed, 3);
			// The pool's tables are the journal's own: no outbox to a remote journal, as a pool beside another database has.
			const outboxes = await sqlPoolStorage(f.hostJournal)!.read((executor) =>
				executor.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%outbox%'"),
			);
			assert.deepEqual(outboxes, []);
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"warm work runs at the warm worktree; a host that cannot restore leaves cold bound work, which fails typed once no capable host is live (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-window", { workspace: binding, claimWindowMs: 300 });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			// A capable host is registered, so the window passes without failing the child.
			await f.shared.reportHost({
				host: "capable",
				labels: {},
				git: "system",
				restore: true,
				workers: 1,
				maxWorkers: 1,
				roots: ["root"],
			});
			// A capable host that serves other roots only never claims this root's work: it keeps nothing waiting.
			await f.shared.reportHost({
				host: "elsewhere",
				labels: {},
				git: "system",
				restore: true,
				workers: 1,
				maxWorkers: 1,
				roots: ["another-root"],
			});
			host = await satellite(f, root, { prefer: async () => undefined });
			await sleep(1_500);
			assert.equal((await f.shared.stats("root")).failed, 0, "a live capable host keeps bound work waiting");
			assert.deepEqual(f.claims(), [], "a host without the tree or a restore port never takes bound work");
			await f.shared.forgetHost("capable");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			const [failure] = outcomes;
			assert.ok(isWorkspaceRestoreUnavailableError(failure), String(failure));
			const typed = failure as WorkspaceRestoreUnavailableError;
			assert.deepEqual(
				[typed.code, typed.reason, typed.claimWindowMs, typed.binding.tree],
				["workspace-restore-unavailable", "no-capable-host", 300, "t1"],
			);
			assert.equal((await f.shared.stats("root")).failed, 1);
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a host takes bound work it has warm without restoring, and gives the stage its queued prompt answers (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-warm", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			const preferred: string[] = [];
			const restores: string[] = [];
			host = await satellite(f, root, {
				prefer: async (requested) => {
					preferred.push(requested.tree);
					return requested.tree === "t1" ? warm : undefined;
				},
				restore: async (requested) => {
					restores.push(requested.tree);
					return join(f.directory, "restored");
				},
			});
			while (f.claims().length === 0) await sleep(25);
			const [[claimer, workId, cwd]] = f.claims() as [[string, string, string]];
			assert.deepEqual([claimer, cwd], ["host-b", warm]);
			assert.ok(preferred.includes("t1"));
			assert.deepEqual(restores, [], "a host restores nothing it has warm, even with a restore port");
			// The root answers a prompt of the stage on host B: the answer is the stage's next input there.
			const work = (await f.shared.stats("root")).leases[0]!;
			assert.equal(work.work, workId);
			// The stub refuses an answer whose prompt id names a refusal, and asks for "stale-once" again once.
			for (const promptId of ["p1", "stale-once", "refuse-PromptNotPending", "refuse-StageNotLive", "p2"])
				await f.shared.appendStageInput(root.lease, {
					work: workId,
					runId: work.childRunId,
					stageId: "stage",
					kind: STAGE_INPUT_PROMPT_ANSWER,
					op: `prompt:${promptId}`,
					payload: JSON.stringify({ kind: "prompt", promptId, response: "yes" }),
				});
			await f.shared.appendStageInput(root.lease, {
				work: workId,
				runId: work.childRunId,
				stageId: "stage",
				kind: "steer",
				op: "steer:1",
				payload: "{}",
			});
			const settled = async () =>
				(await f.shared.stageInputs("root", work.childRunId, "stage")).map((input) => [
					input.op,
					input.state,
					input.receipt,
				]);
			while ((await settled()).some(([, state]) => state !== "done")) await sleep(25);
			assert.deepEqual(await settled(), [
				["prompt:p1", "done", '{"ok":true}'],
				["prompt:stale-once", "done", '{"ok":true}'],
				["prompt:refuse-PromptNotPending", "done", '{"ok":false,"refusal":"PromptNotPending"}'],
				["prompt:refuse-StageNotLive", "done", '{"ok":false,"refusal":"StageNotLive"}'],
				["prompt:p2", "done", '{"ok":true}'],
				["steer:1", "done", '{"ok":false,"refusal":"UnsupportedInput"}'],
			]);
			const answers = readFileSync(f.log, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("answer "));
			assert.deepEqual(
				answers,
				["p1", "stale-once", "stale-once", "refuse-PromptNotPending", "refuse-StageNotLive", "p2"].map(
					(promptId) => `answer ${work.childRunId} stage ${promptId}`,
				),
				"in order, one at a time: an answer the stage could not take yet is its next input until it takes it",
			);
			// While it holds the child, the host relays its run's activity for the root to show.
			while (!(await f.shared.activityAfter("root", 0)).some((entry) => entry.work.id === workId)) await sleep(25);
			writeFileSync(release, "");
			const result = await execution;
			assert.equal(result.status, "completed");
			assert.deepEqual(outcomes, ["completed"]);
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host stops at once while a child's workspace is restoring, and puts the child back in the queue (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-restoring-stop", { workspace: binding });
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		let started!: () => void;
		const restoreStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let finishRestore!: () => void;
		const restoreGate = new Promise<void>((resolve) => {
			finishRestore = resolve;
		});
		try {
			await f.root();
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				hostId: "host-b",
				workerEntry: stubWorker,
				restore: async () => {
					started();
					await restoreGate;
					return f.directory;
				},
			});
			await restoreStarted;
			// The host stops at once while the child's workspace restores, without waiting for the restore.
			await host.stop();
			const stats = await f.shared.stats("root");
			assert.deepEqual(
				[stats.ready, stats.leased],
				[1, 0],
				"the child is back in the queue, not leased to a stopped worker",
			);
			assert.deepEqual(f.claims(), [], "no worker ran it");
		} finally {
			finishRestore();
			await host?.stop();
			await f.pool.close();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host runs the git it was given: its workers find it first on their PATH, and its restore is given it (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-host-git", { workspace: binding });
		const gitDirectory = join(f.directory, "host-git");
		mkdirSync(gitDirectory);
		const gitPath = join(gitDirectory, "git");
		writeFileSync(gitPath, "#!/bin/sh\necho 'git version 2.45.0'\n", { mode: 0o755 });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		const given: unknown[] = [];
		const git = { path: gitPath, env: { SHARED_POOL_GIT_MARKER: "host-git" } };
		try {
			await f.root();
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				hostId: "host-b",
				workerEntry: stubWorker,
				git,
				restore: async (_binding, options) => {
					given.push(options.git);
					return restored;
				},
			});
			assert.equal((await host.stats()).git, "system");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(given, [git], "the restore port runs the host's git");
			const [worker] = f.starts().filter((start) => (start.shared as { host: string }).host === "host-b");
			assert.deepEqual([worker?.pathHead, worker?.gitMarker], [gitDirectory, "host-git"]);
		} finally {
			await host?.stop();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker that dies while its child's workspace restores puts the child back, and its replacement takes it (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-restoring-death", { workspace: binding });
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		// Every restore hangs: only the worker's death ends the first one.
		const restores: AbortSignal[] = [];
		try {
			await f.root();
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				hostId: "host-b",
				workerEntry: stubWorker,
				restore: (_binding, { signal }) => {
					restores.push(signal);
					return new Promise<string>(() => {});
				},
			});
			while (restores.length === 0) await sleep(25);
			const [worker] = f.starts().filter((start) => (start.shared as { host: string }).host === "host-b");
			process.kill(worker!.pid as number, "SIGKILL");
			while (restores.length < 2) await sleep(25);
			assert.equal(restores[0]!.aborted, true, "the dead worker's restore was abandoned");
			assert.equal(restores[1]!.aborted, false, "the replacement worker claimed the child again");
			assert.equal(
				f.starts().filter((start) => (start.shared as { host: string }).host === "host-b").length,
				2,
				"one replacement worker",
			);
		} finally {
			await host?.stop();
			await f.pool.close();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a satellite whose worker dies mid-restore reports no placement failure, and its replacement takes the child (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-restoring-death-quiet", { workspace: binding });
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		let host: PoolCoordinator | undefined;
		const restores: AbortSignal[] = [];
		const failures: Error[] = [];
		try {
			const root = await f.root();
			host = await satellite(
				f,
				root,
				{
					restore: (_binding, { signal }) => {
						restores.push(signal);
						return new Promise<string>(() => {});
					},
				},
				failures,
				"host-b",
				1,
			);
			while (restores.length === 0) await sleep(25);
			const [worker] = f.starts().filter((start) => (start.shared as { host: string }).host === "host-b");
			process.kill(worker!.pid as number, "SIGKILL");
			while (restores.length < 2) await sleep(25);
			assert.equal(restores[0]!.aborted, true);
			assert.deepEqual(failures, [], "a worker that died is no failed placement");
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await f.pool.close();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a host whose warm hook fails takes no bound work, reports why, and asks the hook at most once a second (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-prefer-fails", { workspace: binding, claimWindowMs: 3_000 });
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			const failures: Error[] = [];
			const asked: number[] = [];
			const started = performance.now();
			host = await satellite(
				f,
				root,
				{
					prefer: async () => {
						asked.push(performance.now() - started);
						throw new Error("the worktree index is locked");
					},
				},
				failures,
				"host-b",
				1,
			);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.ok(isWorkspaceRestoreUnavailableError(outcomes[0]), String(outcomes[0]));
			assert.deepEqual(f.claims(), [], "a host that cannot tell where the tree is never takes bound work");
			assert.ok(asked.length > 0);
			assert.ok(
				failures.length > 0 && failures.every((failure) => failure.message === "the worktree index is locked"),
			);
			for (let index = 1; index < asked.length; index++)
				assert.ok(asked[index]! - asked[index - 1]! >= 900, `asked at ${asked.map(Math.round).join(", ")} ms`);
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host restores bound work it does not have, and a drain lets the child it holds finish (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-host-restore", { workspace: binding });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			await f.root();
			let asked = 0;
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				hostId: "host-b",
				workerEntry: stubWorker,
				// The first ask fails; the host then restores the tree it does not have.
				placement: {
					prefer: async () => {
						// A hook's own error that wraps a placement error is recorded as the hook's, by name and message.
						if (asked++ === 0)
							throw new TypeError("the worktree index is busy", {
								cause: new WorkspaceRestoreUnavailableError("no-restore-port", binding),
							});
						return undefined;
					},
				},
				restore: async () => restored,
			});
			while (f.claims().length === 0) await sleep(25);
			const stats = await host.stats();
			assert.equal(stats.restore, true);
			assert.deepEqual(stats.lastPlacementFailure, { name: "TypeError", message: "the worktree index is busy" });
			assert.deepEqual(
				f.claims().map(([claimer, , cwd]) => [claimer, cwd]),
				[["host-b", restored]],
			);
			let drained = false;
			const drain = host.drain().then(() => {
				drained = true;
			});
			await sleep(1_500);
			assert.equal(drained, false, "a drain waits for the child the host holds");
			writeFileSync(release, "");
			await drain;
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.equal(f.claims().length, 1, "the drained child finished where it ran");
			assert.deepEqual(await f.shared.registeredHosts(), [], "a drained host leaves the registry");
		} finally {
			writeFileSync(release, "");
			await host?.stop();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host counts a child whose workspace is restoring as busy, and a drain waits for it (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-restoring-drain", { workspace: binding });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		let started!: () => void;
		const restoreStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let finishRestore!: () => void;
		const restoreGate = new Promise<void>((resolve) => {
			finishRestore = resolve;
		});
		try {
			await f.root();
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				hostId: "host-b",
				workerEntry: stubWorker,
				restore: async () => {
					started();
					await restoreGate;
					return restored;
				},
			});
			await restoreStarted;
			assert.equal((await host.stats()).busy, 1, "the worker whose child is restoring is busy");
			let drained = false;
			const drain = host.drain().then(() => {
				drained = true;
			});
			await sleep(1_500);
			assert.equal(drained, false, "a drain waits for the child that is restoring");
			finishRestore();
			while (f.claims().length === 0) await sleep(25);
			assert.deepEqual(
				f.claims().map(([claimer, , cwd]) => [claimer, cwd]),
				[["host-b", restored]],
			);
			writeFileSync(release, "");
			await drain;
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.equal(f.claims().length, 1, "the restored child ran once, on the draining host");
		} finally {
			finishRestore();
			writeFileSync(release, "");
			await host?.stop();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a root whose journal another process opens keeps its pool beside it on this machine, without shared placement (#4310)",
	async () => {
		const directory = makeLibsqlDirectory("unshared-pool-");
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		const journal = await resolveRunJournal({
			agentDir: join(directory, "agent"),
			journal: { adapter: libsql, options: { url: pathToFileURL(join(directory, "root.db")).href }, prefix: PREFIX },
		});
		const backend = await JournalDurableBackend.open(journal);
		const durable = poolDurableJournal(journal);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			rootId: "root",
			journalPath: coordinationPath(durable),
			durable,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		try {
			const { parent, outcomes } = await fanOut(1)(child as never);
			const result = await run(
				parent,
				{},
				{ runId: "root", cwd: directory, store: createStore(), durableBackend: backend },
			);
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.deepEqual(
				readFileSync(log, "utf8")
					.split("\n")
					.filter((line) => line.startsWith("unshared ")).length,
				1,
				"this machine's worker ran the child",
			);
			const tables = await sqlPoolStorage(journal)!.read((executor) =>
				executor.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_work'"),
			);
			assert.deepEqual(tables, [], "the pool's queue is not in the root's journal");
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			await closeCoordinationJournals();
			vi.unstubAllEnvs();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
