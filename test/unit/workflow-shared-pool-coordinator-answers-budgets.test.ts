import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { isWorkspaceRestoreUnavailableError } from "../../packages/workflows/src/workers/placement-errors.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import type { AdmissionConfiguration } from "../../packages/workflows/src/workers/resource-admission.js";
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

/** What a root and its worker hosts tell each other: prompt answers, spending, saved settings and the pool's control (#4310). */

test(
	"the root answers a prompt of a stage that runs on another host as that stage's next input (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-remote-answer", { workspace: binding });
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
		const store = createStore();
		let host: PoolCoordinator | undefined;
		const execution = run(parent, {}, { runId: "root", cwd: f.directory, store, durableBackend: f.backend });
		try {
			const root = await f.root();
			host = await satellite(f, root, { prefer: async () => warm });
			while (f.claims().length === 0) await sleep(25);
			const { childRunId, generation } = (await f.shared.stats("root")).leases[0]!;
			// The root shows the child's run as the host relayed it.
			while (store.run(childRunId) === undefined) await sleep(25);
			assert.equal(store.run(childRunId)?.status, "running");
			const answered = await f.pool.answerPooledStagePrompt(childRunId, "stage", {
				kind: "prompt",
				promptId: "p7",
				response: "yes",
			} as never);
			assert.deepEqual(answered, { ok: true });
			// The answer waited for the stage's host to take it: its receipt is the result, and each answer is one input of the
			// attempt that asked.
			const inputs = async () =>
				(await f.shared.stageInputs("root", childRunId, "stage")).map((input) => [input.op, input.state]);
			assert.deepEqual(await inputs(), [[`prompt:p7:${generation}`, "done"]]);
			assert.deepEqual(
				await f.pool.answerPooledStagePrompt(childRunId, "stage", {
					kind: "prompt",
					promptId: "refuse-PromptNotPending",
					response: "yes",
				} as never),
				{ ok: false, refusal: "PromptNotPending" },
				"a refused answer comes back refused, for the root to hold for the attempt that asks again",
			);
			assert.ok(readFileSync(f.log, "utf8").includes(`answer ${childRunId} stage p7\n`));
			// A run no host relayed is answered by this host's workers, which do not hold it.
			assert.deepEqual(
				await f.pool.answerPooledStagePrompt("no-such-run", "stage", {
					kind: "prompt",
					promptId: "p8",
					response: "no",
				} as never),
				{ ok: false, refusal: "StaleAttempt" },
			);
			writeFileSync(release, "");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
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

test(
	"an answer no host takes waits, and is refused once its child ended or the root's pool closed (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-untaken-answer", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", join(f.directory, "release"));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const store = createStore();
		let host: PoolCoordinator | undefined;
		const execution = run(parent, {}, { runId: "root", cwd: f.directory, store, durableBackend: f.backend });
		try {
			const root = await f.root();
			host = await satellite(f, root, { prefer: async () => warm });
			while (f.claims().length === 0) await sleep(25);
			const { childRunId } = (await f.shared.stats("root")).leases[0]!;
			while (store.run(childRunId) === undefined) await sleep(25);
			// The stage's only host stops: its work goes back to the queue, and no host is left to take its inputs.
			await host.stopSatellite();
			const storage = sqlPoolStorage(f.hostJournal)!;
			const setWorkState = (state: string) =>
				storage.transaction((tx) =>
					tx.run(`UPDATE ${PREFIX}wf_runs_work SET state = ? WHERE root = 'root'`, state),
				);
			const queued = async (promptId: string) => {
				for (;;) {
					const inputs = await f.shared.stageInputs("root", childRunId, "stage");
					if (inputs.some((input) => input.op.startsWith(`prompt:${promptId}:`))) return;
					await sleep(25);
				}
			};
			const answer = (promptId: string) =>
				f.pool.answerPooledStagePrompt(childRunId, "stage", { kind: "prompt", promptId, response: "yes" } as never);
			for (const ended of ["completed", "failed"]) {
				const pending = answer(`after-${ended}`);
				await queued(`after-${ended}`);
				await setWorkState(ended);
				assert.deepEqual(await pending, { ok: false, refusal: "StageNotLive" }, `a child whose work ${ended}`);
				await setWorkState("ready");
			}
			const pending = answer("at-close");
			await queued("at-close");
			await f.pool.close();
			assert.deepEqual(await pending, { ok: false, refusal: "StaleAttempt" });
		} finally {
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"the root answers a prompt of a stage on its own worker there, not through the stage's input queue (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-local-answer", {});
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		const store = createStore();
		const execution = run(parent, {}, { runId: "root", cwd: f.directory, store, durableBackend: f.backend });
		try {
			while (f.claims().length === 0) await sleep(25);
			const { childRunId, host } = (await f.shared.stats("root")).leases[0]!;
			assert.equal(host, "root-host", "the root's own worker took the unbound child");
			while (store.run(childRunId) === undefined) await sleep(25);
			const answered = await f.pool.answerPooledStagePrompt(childRunId, "stage", {
				kind: "prompt",
				promptId: "local",
				response: "yes",
			} as never);
			assert.deepEqual(answered, { ok: true });
			assert.ok(readFileSync(f.log, "utf8").includes(`answer ${childRunId} stage local\n`));
			assert.deepEqual(await f.shared.stageInputs("root", childRunId, "stage"), []);
			writeFileSync(release, "");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
		} finally {
			writeFileSync(release, "");
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a root counts the usage its children record on other hosts, for its budgets (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-remote-usage", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			host = await satellite(f, root, { prefer: async () => warm });
			while (f.claims().length === 0) await sleep(25);
			const [held] = (await (await openSqlPoolQueue(f.hostJournal)).inspect("root")).filter(
				(work) => work.state === "leased",
			);
			assert.ok(held);
			// The child's host records its stage's spending, as its worker's heartbeat does; no worker of the root runs.
			const spent = { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: 1 };
			await (await openSqlPoolUsage(f.hostJournal)).report(root.lease, held, [
				{ key: "stage:remote:agent", usage: spent },
			]);
			while (f.pool.usage()?.input !== spent.input) await sleep(25);
			assert.deepEqual(f.pool.usage(), spent, "the root's budgets see what the remote child spent");
			writeFileSync(release, "");
			assert.equal((await execution).status, "completed");
		} finally {
			writeFileSync(release, "");
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host starts no child while the root's budget blocks spending, and resumes once it no longer does (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-budget", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
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
		// The root's budget decision, as its pool tells its coordinator.
		const budget = (blocked: boolean) =>
			(f.pool as unknown as { notice(notice: { kind: "budget"; blocked: boolean }): void }).notice({
				kind: "budget",
				blocked,
			});
		const published = async (blocked: boolean) => {
			while ((await f.shared.roots())[0]?.budgetBlocked !== blocked) await sleep(25);
		};
		try {
			await f.root();
			budget(true);
			await published(true);
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				restore: false,
				hostId: "host-b",
				workerEntry: stubWorker,
				placement: { prefer: async () => warm },
			});
			while ((await host.stats()).workers === 0) await sleep(25);
			await sleep(2_500);
			assert.deepEqual(f.claims(), [], "a blocked root's child is not started on the host it has warm");
			budget(false);
			await published(false);
			assert.equal((await execution).status, "completed");
			assert.deepEqual(outcomes, ["completed"]);
			assert.deepEqual(
				f.claims().map(([claimer]) => claimer),
				["host-b"],
			);
		} finally {
			await host?.stop();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"an idle worker of a shared pool follows its control without a write lock and asks for work at most twice a second (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-idle", { workspace: binding, claimWindowMs: 6_000 });
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
			// Every statement the host's pool runs on the shared journal goes through this storage.
			const storage = sqlPoolStorage(f.hostJournal)!;
			const counts = { transactions: 0, reads: 0 };
			const { transaction, read } = storage;
			Object.assign(storage, {
				transaction: (body: Parameters<typeof transaction>[0]) => {
					counts.transactions++;
					return transaction(body);
				},
				read: (body: Parameters<typeof read>[0]) => {
					counts.reads++;
					return read(body);
				},
			});
			// Two workers that can take nothing: the root's only child is bound to a tree this host neither has nor restores.
			host = await satellite(f, root, {});
			while (host.workerCounts().workers < 2) await sleep(25);
			await sleep(500);
			const start = { ...counts };
			await sleep(2_000);
			const idle = { transactions: counts.transactions - start.transactions, reads: counts.reads - start.reads };
			assert.equal(idle.transactions, 0, `write transactions of an idle host in 2 s: ${JSON.stringify(idle)}`);
			assert.ok(idle.reads <= 40, `reads of an idle host in 2 s: ${JSON.stringify(idle)}`);
			assert.deepEqual(f.claims(), []);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.ok(isWorkspaceRestoreUnavailableError(outcomes[0]), String(outcomes[0]));
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
	"a worker host runs a root's children with the root's saved settings, and every worker learns where it runs (#4310)",
	async () => {
		const admission = { limits: { session: 3 } } as AdmissionConfiguration;
		const f = await fixture("shared-coordinator-settings", {
			workspace: binding,
			admission,
			maxLoadPerCpu: 7,
			maxWorkerRssBytes: 2 ** 31,
		});
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const execution = run(parent, {}, {
			runId: "root",
			cwd: f.directory,
			store: createStore(),
			durableBackend: f.backend,
			// A root whose prompts are prompt nodes has its pooled children raise them so too, on any host.
			usePromptNodesForUi: true,
		} as never);
		try {
			const root = await f.root();
			const { config } = root;
			assert.deepEqual(
				[config.admission, config.stageStartMaxLoadPerCpu, config.maxWorkerRssBytes, config.claimWindowMs],
				[admission, 7, 2 ** 31, 60_000],
			);
			assert.ok(config.leaseMs > 0 && config.startupTimeoutMs > 0);
			assert.equal(config.promptNodes, true);
			host = await satellite(f, root, { prefer: async () => warm });
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			const starts = f.starts();
			const where = (start: Record<string, unknown>) => (start.shared as { host: string }).host;
			const rootWorker = starts.find((start) => where(start) === "root-host")!;
			const hostWorker = starts.find((start) => where(start) === "host-b")!;
			assert.deepEqual(
				rootWorker.shared,
				{ host: "root-host", routes: true },
				"the root's own workers route Intercom",
			);
			assert.deepEqual(hostWorker.shared, { host: "host-b", routes: false });
			for (const start of [rootWorker, hostWorker]) {
				assert.deepEqual(
					[start.root, start.journalPath, start.admission, start.stageStartMaxLoadPerCpu, start.maxRssBytes],
					["root", undefined, admission, 7, 2 ** 31],
				);
				assert.equal(start.promptNodes, true, "every host's workers raise the root's prompts as prompt nodes");
			}
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
