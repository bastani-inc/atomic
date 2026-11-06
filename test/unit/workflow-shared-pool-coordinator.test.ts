import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import {
	type SharedPoolRoot,
	SqlSharedPool,
	STAGE_INPUT_PROMPT_ANSWER,
} from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { RunJournal } from "../../packages/workflows/src/durable/journal/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	CoordinatorEvent,
	CoordinatorInbound,
	CoordinatorPort,
} from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import {
	isWorkspaceRestoreUnavailableError,
	WorkspaceRestoreUnavailableError,
} from "../../packages/workflows/src/workers/placement-errors.js";
import { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import {
	closeCoordinationJournals,
	coordinationPath,
	poolDurableJournal,
} from "../../packages/workflows/src/workers/pool-journal.js";
import type { AdmissionConfiguration } from "../../packages/workflows/src/workers/resource-admission.js";
import type { WorkspaceBinding } from "../../packages/workflows/src/workers/workspace-binding.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { sleep } from "../helpers/runtime.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

const libsql = fileURLToPath(new URL("../../packages/storage-libsql/libsql.js", import.meta.url));
const childPath = fileURLToPath(new URL("../fixtures/shared-pool-child.ts", import.meta.url));
const stubWorker = fileURLToPath(new URL("../fixtures/shared-pool-stub-worker.mjs", import.meta.url));
const PREFIX = "acme_";
/** Each test forks stub worker processes and loads the child definition: structural cost, not slowness. */
const COORDINATOR_TEST_TIMEOUT_MS = 120_000;
const binding: WorkspaceBinding = { remotes: ["https://example.invalid/r.git"], head: "h1", tree: "t1", envHash: "e1" };

interface Fixture {
	readonly directory: string;
	readonly log: string;
	readonly backend: JournalDurableBackend;
	readonly hostJournal: RunJournal;
	readonly pool: LocalWorkerPool;
	readonly shared: SqlSharedPool;
	claims(): string[][];
	/** The start options of every worker forked so far, as each received them. */
	starts(): Record<string, unknown>[];
	root(): Promise<SharedPoolRoot>;
	close(): Promise<void>;
}

async function fixture(
	label: string,
	options: {
		workspace?: WorkspaceBinding;
		claimWindowMs?: number;
		admission?: AdmissionConfiguration;
		maxLoadPerCpu?: number;
		maxWorkerRssBytes?: number;
		leaseMs?: number;
	},
): Promise<Fixture> {
	const directory = makeLibsqlDirectory(`${label}-`);
	const log = join(directory, "stub.log");
	writeFileSync(log, "");
	vi.stubEnv("SHARED_POOL_STUB_LOG", log);
	const selection = {
		adapter: libsql,
		options: { url: pathToFileURL(join(directory, "shared.db")).href },
		prefix: PREFIX,
	};
	const journal = await resolveRunJournal({ agentDir: join(directory, "root", "agent"), journal: selection });
	const hostJournal = await resolveRunJournal({ agentDir: join(directory, "host", "agent"), journal: selection });
	const backend = await JournalDurableBackend.open(journal);
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "boundChild",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		rootId: "root",
		durable: poolDurableJournal(journal),
		shared: {
			stateDirectory: join(directory, "root", "state"),
			host: "root-host",
			claimWindowMs: options.claimWindowMs ?? 60_000,
		},
		...(options.workspace === undefined ? {} : { workspace: options.workspace }),
		...(options.admission === undefined ? {} : { admission: options.admission }),
		...(options.maxLoadPerCpu === undefined ? {} : { maxLoadPerCpu: options.maxLoadPerCpu }),
		...(options.maxWorkerRssBytes === undefined ? {} : { maxWorkerRssBytes: options.maxWorkerRssBytes }),
		...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
		workerEntry: stubWorker,
		coordinator: "in-process",
	});
	const shared = await SqlSharedPool.open(hostJournal, await openSqlPoolQueue(hostJournal));
	return {
		directory,
		log,
		backend,
		hostJournal,
		pool,
		shared,
		claims: () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line !== "" && !line.startsWith("answer ") && !line.startsWith("start "))
				.map((line) => line.split(" ")),
		starts: () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("start "))
				.map((line) => JSON.parse(line.slice("start ".length)) as Record<string, unknown>),
		async root() {
			for (;;) {
				const [root] = await shared.roots();
				if (root !== undefined && root.status === "running") return root;
				await sleep(25);
			}
		},
		async close() {
			await pool.close().catch(() => {});
			await backend.close();
			await hostJournal.close();
			vi.unstubAllEnvs();
			await removeLibsqlDirectory(directory);
		},
	};
}

/** The start options of every stub worker that logged to `log`. */
function loggedStarts(log: string): Record<string, unknown>[] {
	return readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("start "))
		.map((line) => JSON.parse(line.slice("start ".length)) as Record<string, unknown>);
}

/** A coordinator port that goes nowhere, as a worker host's does; it keeps the health messages it is given. */
function quietPort(health: string[]): CoordinatorPort<CoordinatorEvent, CoordinatorInbound> {
	return {
		send(event) {
			if (event.kind === "health") health.push(event.message);
		},
		onMessage() {},
		onClose() {},
		async close() {},
	};
}

function fanOut(count: number) {
	return async (child: Parameters<typeof run>[0]) => {
		const outcomes: (string | Error)[] = [];
		const parent = workflow({
			name: "shared-pool-coordinator-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const results = await Promise.allSettled(
					Array.from({ length: count }, () => ctx.workflow(child as never, { inputs: {} })),
				);
				for (const result of results)
					outcomes.push(result.status === "fulfilled" ? result.value.status : (result.reason as Error));
				return {};
			},
		});
		return { parent, outcomes };
	};
}

async function satellite(
	f: Fixture,
	root: SharedPoolRoot,
	placement: {
		prefer?: (binding: WorkspaceBinding) => Promise<string | undefined>;
		restore?: (binding: WorkspaceBinding, options: { readonly signal: AbortSignal }) => Promise<string>;
	},
	failures: Error[] = [],
	host = "host-b",
	workers = 2,
): Promise<PoolCoordinator> {
	const coordinator = new PoolCoordinator(quietPort([]));
	await coordinator.attachSatellite({
		root: root.root,
		lease: root.lease,
		journal: f.hostJournal,
		config: root.config,
		sources: root.config.definitions,
		workers,
		durable: poolDurableJournal(f.hostJournal),
		stateDirectory: join(f.directory, "host", "state"),
		workerEntry: stubWorker,
		placement: {
			host,
			...placement,
			detached: (reason) => {
				if (reason !== undefined) failures.push(reason);
			},
			placementFailed: (error) => failures.push(error),
		},
	});
	return coordinator;
}

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
	"a worker host serves every running shared root with a share of its workers, reports them, and drains (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-host", {});
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		vi.stubEnv("SHARED_POOL_STUB_RECYCLE", "1");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const second = new LocalWorkerPool(f.backend, {
			rootId: "root-2",
			durable: poolDurableJournal(f.backend.journal),
			shared: { stateDirectory: join(f.directory, "root", "state-2"), host: "root-host", claimWindowMs: 60_000 },
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const first = await fanOut(3)(child as never);
		const other = await fanOut(3)(child as never);
		const executions = [
			run(first.parent, {}, { runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
			run(other.parent, {}, { runId: "root-2", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
		];
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			while ((await f.shared.roots()).filter((root) => root.status === "running").length < 2) await sleep(25);
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 2,
				hostId: "host-b",
				labels: { zone: "test" },
				workerEntry: stubWorker,
			});
			// Each root's children wait on the release; the host runs one of each root's at a time.
			for (;;) {
				const stats = await host.stats();
				if (stats.roots.length === 2 && stats.busy === 2) break;
				await sleep(25);
			}
			const stats = await host.stats();
			assert.deepEqual(
				[stats.hostId, stats.workers, stats.busy, stats.maxWorkers, stats.restore],
				["host-b", 2, 2, 2, false],
			);
			assert.deepEqual(stats.roots.map((root) => root.root).sort(), ["root", "root-2"]);
			for (const root of stats.roots) assert.equal(root.leases.filter((lease) => lease.host === "host-b").length, 1);
			// The host's next report lists the roots it serves.
			let registered = await f.shared.registeredHosts();
			for (let poll = 0; poll < 200 && registered[0]?.roots.length !== 2; poll++) {
				await sleep(25);
				registered = await f.shared.registeredHosts();
			}
			assert.deepEqual(
				registered.map((row) => [row.host, row.labels, row.roots]),
				[["host-b", { zone: "test" }, ["root", "root-2"]]],
			);
			writeFileSync(release, "");
			const results = await Promise.all(executions);
			assert.deepEqual(
				results.map((result) => result.status),
				["completed", "completed"],
			);
			assert.deepEqual(first.outcomes, ["completed", "completed", "completed"]);
			assert.deepEqual(other.outcomes, ["completed", "completed", "completed"]);
			assert.ok(
				f.claims().some(([claimer]) => claimer === "host-b"),
				"the host ran some of the children",
			);
			const claimed = f.claims().map(([, workId]) => workId);
			assert.equal(new Set(claimed).size, claimed.length, "a host serving steadily never gives a child back");
			// Workers past their memory limit after one child are replaced, and the host says why.
			assert.match((await host.stats()).lastHealth ?? "", /maxWorkerRssBytes/);
			// A root that ended is let go: its satellite stops and its workers with it.
			while ((await host.stats()).roots.length > 0) await sleep(25);
			assert.deepEqual([(await host.stats()).workers, (await host.stats()).busy], [0, 0]);
			await host.drain();
			assert.deepEqual(await f.shared.registeredHosts(), [], "a drained host leaves the registry");
			assert.deepEqual((await host.stats()).roots, []);
		} finally {
			await host?.stop();
			writeFileSync(release, "");
			await Promise.allSettled(executions);
			await second.close();
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a worker host that stops while its worker holds a child puts the child back, and another host finishes it (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-stop", { workspace: binding });
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
		const hosts: PoolCoordinator[] = [];
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			const warmHere = { prefer: async () => warm };
			const first = await satellite(f, root, warmHere, [], "host-b");
			hosts.push(first);
			while (f.claims().length === 0) await sleep(25);
			const [[, workId]] = f.claims() as [[string, string]];
			assert.deepEqual(
				(await f.shared.stats("root")).leases.map((lease) => [lease.work, lease.host]),
				[[workId, "host-b"]],
			);
			assert.deepEqual(first.workerCounts(), { workers: 2, busy: 1 });
			await first.stopSatellite();
			const stopped = await f.shared.stats("root");
			assert.deepEqual(
				[stopped.ready, stopped.leased, stopped.leases],
				[1, 0, []],
				"the stopped host's child waits for another host",
			);
			writeFileSync(release, "");
			hosts.push(await satellite(f, root, warmHere, [], "host-c"));
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.deepEqual(
				f.claims().map(([claimer, id]) => [claimer, id]),
				[
					["host-b", workId],
					["host-c", workId],
				],
			);
		} finally {
			for (const host of hosts) {
				await host.stopSatellite();
				await host.shutdown();
			}
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a draining worker host takes no more children and finishes the one it holds before it closes (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-drain", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(2)(child as never);
		const hosts: PoolCoordinator[] = [];
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			const warmHere = { prefer: async () => warm };
			const draining = await satellite(f, root, warmHere, [], "host-b");
			hosts.push(draining);
			while (draining.workerCounts().busy < 2) await sleep(25);
			let drained = false;
			const drain = draining.drain().then(() => {
				drained = true;
			});
			await sleep(1_000);
			assert.equal(drained, false, "a drain waits for the children its workers hold");
			assert.equal((await f.shared.stats("root")).leased, 2);
			writeFileSync(release, "");
			await drain;
			assert.deepEqual(
				draining.workerCounts(),
				{ workers: 0, busy: 0 },
				"a drained host closed: its workers stopped",
			);
			const stats = await f.shared.stats("root");
			assert.deepEqual([stats.completed, stats.ready, stats.leased], [2, 0, 0], "drained children completed");
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed", "completed"]);
			assert.equal(f.claims().length, 2);
		} finally {
			for (const host of hosts) {
				await host.stopSatellite();
				await host.shutdown();
			}
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

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
	"a worker host's stop and drain do not wait for a prefer hook that never settles, and abort its signal (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-prefer-hang", { workspace: binding });
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
		const hosts: Awaited<ReturnType<typeof startWorkflowWorkerHost>>[] = [];
		let restores = 0;
		try {
			await f.root();
			for (const end of ["stop", "drain"] as const) {
				let asked!: (signal: AbortSignal) => void;
				const hookSignal = new Promise<AbortSignal>((resolve) => {
					asked = resolve;
				});
				const host = await startWorkflowWorkerHost({
					journal: {
						adapter: libsql,
						options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
						prefix: PREFIX,
					},
					agentDir: join(f.directory, `host-${end}`, "agent"),
					maxWorkers: 1,
					hostId: `host-${end}`,
					workerEntry: stubWorker,
					// The hook never answers: the host asks it about the root's bound child, then waits.
					placement: {
						prefer: (_binding, { signal }) => {
							asked(signal);
							return new Promise<string | undefined>(() => {});
						},
					},
					// A host that stops or drains while it asks must not fall back to restoring the child instead.
					restore: async () => {
						restores++;
						return f.directory;
					},
				});
				hosts.push(host);
				const signal = await hookSignal;
				assert.equal(signal.aborted, false);
				await host[end]();
				assert.equal(signal.aborted, true, `${end} aborted the hook's signal`);
			}
			const stats = await f.shared.stats("root");
			assert.deepEqual([stats.ready, stats.leased], [1, 0], "no host held the child");
			assert.equal(restores, 0, "no host that was stopping or draining restored the child");
		} finally {
			for (const host of hosts) await host.stop();
			await f.pool.close();
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
	"a worker host stops at once while it attaches, its worker still starting up, and that worker is stopped (#4310)",
	async () => {
		// The root keeps running: its bound child waits for a host with its tree, which this host is not.
		const f = await fixture("shared-coordinator-stop-attaching", { workspace: binding });
		vi.stubEnv("SHARED_POOL_STUB_HANG_HOST", "host-b");
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
			});
			for (
				let poll = 0;
				poll < 1_200 && !f.starts().some((start) => (start.shared as { host: string }).host === "host-b");
				poll++
			)
				await sleep(25);
			const [worker] = f.starts().filter((start) => (start.shared as { host: string }).host === "host-b");
			// Its worker never reports ready, so the attach would last until the root's worker startup timeout.
			const stopped = await Promise.race([
				host.stop().then(() => "stopped"),
				sleep(10_000).then(() => "still attaching"),
			]);
			assert.equal(stopped, "stopped");
			host = undefined;
			assert.throws(() => process.kill(worker!.pid as number, 0), "the worker still starting up was stopped");
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

test.skipIf(process.platform === "win32")(
	"a worker host keeps its idle worker on its root while a later root has no ready work (#4310)",
	async () => {
		// The first root keeps running: its child waits for a host with its tree far longer than this test.
		const f = await fixture("shared-coordinator-no-yield", { workspace: binding, claimWindowMs: 600_000 });
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		// The later root's own worker holds its only child, so it has nothing ready for this host.
		const second = new LocalWorkerPool(f.backend, {
			rootId: "root-2",
			durable: poolDurableJournal(f.backend.journal),
			shared: { stateDirectory: join(f.directory, "root", "state-2"), host: "root-host", claimWindowMs: 60_000 },
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const first = await fanOut(1)(child as never);
		const other = await fanOut(1)(child as never);
		const executions = [
			run(first.parent, {}, { runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
		];
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			await f.root();
			executions.push(
				run(
					other.parent,
					{},
					{ runId: "root-2", cwd: f.directory, store: createStore(), durableBackend: f.backend },
				),
			);
			for (;;) {
				const stats = await f.shared.stats("root-2");
				if (stats.leased === 1) break;
				await sleep(25);
			}
			// The host serves the root published first, and the later root waits for a worker of it.
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
			});
			for (;;) {
				const stats = await host.stats();
				if (stats.workers === 1 && stats.roots.length === 1) break;
				await sleep(25);
			}
			// Past the idle yield interval, with the later root's pool running and nothing of it ready.
			await sleep(7_000);
			assert.equal((await f.shared.stats("root-2")).ready, 0);
			assert.deepEqual(
				(await host.stats()).roots.map((root) => root.root),
				["root"],
				"the host gives no worker to a root with no ready work",
			);
		} finally {
			writeFileSync(release, "");
			await host?.stop();
			await f.pool.close();
			await Promise.allSettled(executions);
			await second.close();
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a stop during a worker host's drain stops at once and puts the child it held back in the queue (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-drain-then-stop", { workspace: binding });
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
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
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
				placement: { prefer: async () => warm },
			});
			while (f.claims().length === 0) await sleep(25);
			let drained = false;
			const draining = host.drain().then(() => {
				drained = true;
			});
			await sleep(1_500);
			assert.equal(drained, false, "the drain waits for the child the host holds");
			// The child never finishes: its release is never written. A stop ends the drain anyway.
			await host.stop();
			await draining;
			const stats = await f.shared.stats("root");
			assert.deepEqual([stats.ready, stats.leased, stats.completed], [1, 0, 0], "the child is back, unfinished");
		} finally {
			writeFileSync(release, "");
			await host?.stop();
			await f.pool.close();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host's stop always leaves the registry and closes, and keeps its first failure with the cleanup failure attached (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-stop-failure", { workspace: binding });
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
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
			});
			while ((await host.stats()).roots.length === 0) await sleep(25);
			const primary = new Error("a worker's cleanup could not be confirmed");
			const cleanup = new Error("the registry is unreachable");
			const stopSatellite = PoolCoordinator.prototype.stopSatellite;
			const stopping = vi.spyOn(PoolCoordinator.prototype, "stopSatellite").mockImplementationOnce(async function (
				this: PoolCoordinator,
			) {
				await stopSatellite.call(this);
				throw primary;
			});
			const forgetting = vi.spyOn(SqlSharedPool.prototype, "forgetHost").mockRejectedValueOnce(cleanup);
			const polls = vi.spyOn(SqlSharedPool.prototype, "roots");
			const failure = await host.stop().then(
				() => undefined,
				(error: Error) => error,
			);
			assert.equal(failure, primary, "the satellite's failure is the one thrown");
			assert.equal((failure as Error & { cleanupCause?: unknown }).cleanupCause, cleanup);
			assert.equal(stopping.mock.calls.length, 1);
			assert.equal(forgetting.mock.calls.length, 1, "the host still tried to leave the registry");
			const pollsAfterStop = polls.mock.calls.length;
			await sleep(2_500);
			assert.equal(polls.mock.calls.length, pollsAfterStop, "a stopped host polls no more");
			assert.equal(await host.stop().catch((error: Error) => error), primary, "a second stop reports the same");
			vi.restoreAllMocks();
		} finally {
			vi.restoreAllMocks();
			await f.pool.close();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a child whose worker crashes on every host fails at the root with the retry limit, and only that child (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-crash", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		vi.stubEnv("SHARED_POOL_STUB_CRASH", "1");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const failures: Error[] = [];
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			host = await satellite(f, root, { prefer: async () => warm }, failures);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			const [failure] = outcomes as [Error];
			assert.ok(failure instanceof Error, String(failure));
			assert.match(
				failure.message,
				/^Local worker retry limit: child \S+ \(boundChild\) lost its worker on another host 3 times/,
			);
			assert.deepEqual(
				[failure.name, (failure as Error & { code?: string }).code],
				["WorkflowInfrastructureError", "worker_retry_limit"],
			);
			const claims = f.claims();
			assert.ok(claims.length >= 3, `claims: ${claims.length}`);
			assert.ok(claims.every(([claimer, id]) => claimer === "host-b" && id === claims[0]![1]));
			assert.equal(host.detached, false, "a crashing worker does not detach its host");
			assert.deepEqual(failures, []);
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

test.skipIf(process.platform === "win32")(
	"a worker host whose workers serve one root gives a root that starts later its share (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-yield", { workspace: binding, claimWindowMs: 20_000 });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const later: WorkspaceBinding = { ...binding, tree: "t2" };
		const second = new LocalWorkerPool(f.backend, {
			rootId: "root-2",
			durable: poolDurableJournal(f.backend.journal),
			shared: { stateDirectory: join(f.directory, "root", "state-2"), host: "root-host", claimWindowMs: 60_000 },
			workspace: later,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const first = await fanOut(1)(child as never);
		const other = await fanOut(2)(child as never);
		const executions = [
			run(first.parent, {}, { runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
		];
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			await f.root();
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 2,
				hostId: "host-b",
				workerEntry: stubWorker,
				// This host has only the later root's tree: the first root's child is never its to run.
				placement: { prefer: async (requested) => (requested.tree === "t2" ? warm : undefined) },
			});
			for (;;) {
				const stats = await host.stats();
				if (stats.workers === 2 && stats.roots.length === 1) break;
				await sleep(25);
			}
			executions.push(
				run(
					other.parent,
					{},
					{ runId: "root-2", cwd: f.directory, store: createStore(), durableBackend: f.backend },
				),
			);
			while (f.claims().length < 1) await sleep(25);
			const stats = await host.stats();
			assert.deepEqual(stats.roots.map((root) => root.root).sort(), ["root", "root-2"]);
			assert.equal(stats.workers, 2, "the host still runs its two workers, one for each root");
			assert.ok(f.claims().every(([claimer, , cwd]) => claimer === "host-b" && cwd === warm));
			writeFileSync(release, "");
			assert.equal((await executions[1]!).status, "completed");
			assert.deepEqual(other.outcomes, ["completed", "completed"]);
			assert.equal(f.claims().length, 2, "the later root's children ran on the host");
			const firstResult = await executions[0]!;
			assert.equal(firstResult.status, "completed");
			assert.ok(isWorkspaceRestoreUnavailableError(first.outcomes[0]), String(first.outcomes[0]));
		} finally {
			await host?.stop();
			writeFileSync(release, "");
			await Promise.allSettled(executions);
			await second.close();
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host with one worker gives it, once idle, to a later root whose ready work it can run (#4310)",
	async () => {
		// The first root keeps running: its child waits for a host with its tree far longer than this test.
		const f = await fixture("shared-coordinator-idle-yield", { workspace: binding, claimWindowMs: 600_000 });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const later: WorkspaceBinding = { ...binding, tree: "t2" };
		const second = new LocalWorkerPool(f.backend, {
			rootId: "root-2",
			durable: poolDurableJournal(f.backend.journal),
			shared: { stateDirectory: join(f.directory, "root", "state-2"), host: "root-host", claimWindowMs: 60_000 },
			workspace: later,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const first = await fanOut(1)(child as never);
		const other = await fanOut(2)(child as never);
		const executions = [
			run(first.parent, {}, { runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
		];
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
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
				// This host has only the later root's tree: its one worker has nothing of the first root's to run.
				placement: { prefer: async (requested) => (requested.tree === "t2" ? warm : undefined) },
			});
			for (;;) {
				const stats = await host.stats();
				if (stats.workers === 1 && stats.roots.length === 1) break;
				await sleep(25);
			}
			executions.push(
				run(
					other.parent,
					{},
					{ runId: "root-2", cwd: f.directory, store: createStore(), durableBackend: f.backend },
				),
			);
			assert.equal((await executions[1]!).status, "completed");
			assert.deepEqual(other.outcomes, ["completed", "completed"]);
			assert.deepEqual(
				f.claims().map(([claimer, , cwd]) => [claimer, cwd]),
				[
					["host-b", warm],
					["host-b", warm],
				],
				"the later root's children ran on the host's one worker",
			);
			assert.equal((await f.shared.stats("root")).ready, 1, "while the first root still waits for its tree");
		} finally {
			await host?.stop();
			await f.pool.close();
			await Promise.allSettled(executions);
			await second.close();
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

test(
	"a host keeps a bound child's lease through a restore longer than the lease, and puts back work whose restore failed (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-slow-restore", { workspace: binding, leaseMs: 2_000 });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
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
			let restores = 0;
			host = await satellite(
				f,
				root,
				{
					restore: async () => {
						restores++;
						// The first restore fails; the second takes twice the child's work lease.
						if (restores === 1) throw new Error("the remote is unreachable");
						await sleep(4_000);
						return restored;
					},
				},
				failures,
			);
			const result = await execution;
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.deepEqual(
				failures.map((failure) => failure.message),
				["the remote is unreachable"],
				"the failed restore is reported as the host's placement failure",
			);
			assert.equal(restores, 2, "a restore that outlasts the work lease is not run again");
			assert.deepEqual(
				f.claims().map(([claimer, , cwd]) => [claimer, cwd]),
				[["host-b", restored]],
				"the child ran once, at the restored path",
			);
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
	"a worker host's stop throws its first failure alone, or with every later cleanup failure attached (#4310)",
	async () => {
		const directory = makeLibsqlDirectory();
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		const selection = {
			adapter: libsql,
			options: { url: pathToFileURL(join(directory, "shared.db")).href },
			prefix: PREFIX,
		};
		const journal = await resolveRunJournal({ agentDir: join(directory, "root", "agent"), journal: selection });
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		const startHost = async (hostId: string) => {
			const host = await startWorkflowWorkerHost({
				journal: selection,
				agentDir: join(directory, hostId, "agent"),
				maxWorkers: 1,
				hostId,
				workerEntry: stubWorker,
			});
			while ((await host.stats()).workers === 0) await sleep(25);
			return host;
		};
		const stopSatellite = PoolCoordinator.prototype.stopSatellite;
		const shutdown = PoolCoordinator.prototype.shutdown;
		const failing = (error: Error, original: (this: PoolCoordinator) => Promise<void>) =>
			async function (this: PoolCoordinator) {
				await original.call(this);
				throw error;
			};
		try {
			const queue = await openSqlPoolQueue(journal);
			const shared = await SqlSharedPool.open(journal, queue);
			await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
			const acquired = await journal.acquire("root", "root-holder");
			if (acquired.status !== "acquired") assert.fail("no lease");
			await queue.initialize(acquired.lease, 60_000);
			await shared.publishConfig(acquired.lease, {
				definitions: [{ path: childPath, digest: await definitionDigest(childPath), exportName: "boundChild" }],
				leaseMs: 30_000,
				heartbeatMs: 7_500,
				startupTimeoutMs: 30_000,
				claimWindowMs: 60_000,
			});
			const primary = new Error("a worker's cleanup could not be confirmed");
			const alone = await startHost("host-alone");
			vi.spyOn(PoolCoordinator.prototype, "stopSatellite").mockImplementationOnce(failing(primary, stopSatellite));
			const lone = await alone.stop().then(
				() => undefined,
				(error: Error) => error,
			);
			assert.equal(lone, primary);
			assert.equal(Object.hasOwn(lone as Error, "cleanupCause"), false, "nothing failed after it: no cleanup cause");
			vi.restoreAllMocks();

			const several = await startHost("host-several");
			const shuttingDown = new Error("a worker log could not be removed");
			const forgetting = new Error("the registry is unreachable");
			vi.spyOn(PoolCoordinator.prototype, "stopSatellite").mockImplementationOnce(failing(primary, stopSatellite));
			vi.spyOn(PoolCoordinator.prototype, "shutdown").mockImplementationOnce(failing(shuttingDown, shutdown));
			vi.spyOn(SqlSharedPool.prototype, "forgetHost").mockRejectedValueOnce(forgetting);
			const gathered = (await several.stop().then(
				() => undefined,
				(error: Error) => error,
			)) as Error & { readonly cleanupCause?: unknown };
			assert.equal(gathered, primary, "the first failure stays the one thrown");
			assert.ok(gathered.cleanupCause instanceof AggregateError);
			assert.deepEqual(
				[gathered.cleanupCause.message, gathered.cleanupCause.errors],
				["Worker host cleanup failed", [shuttingDown, forgetting]],
			);
		} finally {
			vi.restoreAllMocks();
			await journal.close();
			vi.unstubAllEnvs();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host never runs more workers than maxWorkers, however many roots it could serve (#4310)",
	async () => {
		const directory = makeLibsqlDirectory();
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		const selection = {
			adapter: libsql,
			options: { url: pathToFileURL(join(directory, "shared.db")).href },
			prefix: PREFIX,
		};
		const journal = await resolveRunJournal({ agentDir: join(directory, "root", "agent"), journal: selection });
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			const queue = await openSqlPoolQueue(journal);
			const shared = await SqlSharedPool.open(journal, queue);
			const digest = await definitionDigest(childPath);
			for (const root of ["first", "second", "third"]) {
				await journal.createRun({ runId: root, name: root, cwd: directory, createdAt: 0, status: "running" });
				const acquired = await journal.acquire(root, "root-holder");
				if (acquired.status !== "acquired") assert.fail(`no lease for ${root}`);
				await queue.initialize(acquired.lease, 60_000);
				await shared.publishConfig(acquired.lease, {
					definitions: [{ path: childPath, digest, exportName: "boundChild" }],
					leaseMs: 30_000,
					heartbeatMs: 7_500,
					startupTimeoutMs: 30_000,
					claimWindowMs: 60_000,
				});
			}
			host = await startWorkflowWorkerHost({
				journal: selection,
				agentDir: join(directory, "host", "agent"),
				maxWorkers: 2,
				hostId: "host-b",
				workerEntry: stubWorker,
			});
			while ((await host.stats()).workers < 2) await sleep(25);
			// Several polls later, the third root still waits: two roots hold the host's two workers.
			await sleep(2_500);
			const stats = await host.stats();
			assert.deepEqual([stats.workers, stats.roots.length], [2, 2]);
			assert.equal(loggedStarts(log).length, 2, "no worker beyond maxWorkers was ever started");
		} finally {
			await host?.stop();
			await journal.close();
			vi.unstubAllEnvs();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host serves only running roots whose lease is fresh, with the definitions it has (#4310)",
	async () => {
		const directory = makeLibsqlDirectory();
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		const selection = {
			adapter: libsql,
			options: { url: pathToFileURL(join(directory, "shared.db")).href },
			prefix: PREFIX,
		};
		const journal = await resolveRunJournal({ agentDir: join(directory, "root", "agent"), journal: selection });
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			const queue = await openSqlPoolQueue(journal);
			const shared = await SqlSharedPool.open(journal, queue);
			const digest = await definitionDigest(childPath);
			const roots: Record<string, { path: string; digest: string }> = {
				good: { path: childPath, digest },
				stale: { path: childPath, digest },
				done: { path: childPath, digest },
				elsewhere: { path: join(directory, "not-on-this-host.ts"), digest },
				changed: { path: childPath, digest: "0".repeat(64) },
			};
			for (const [root, definition] of Object.entries(roots)) {
				await journal.createRun({ runId: root, name: root, cwd: directory, createdAt: 0, status: "running" });
				const acquired = await journal.acquire(root, "root-holder");
				if (acquired.status !== "acquired") assert.fail(`no lease for ${root}`);
				await queue.initialize(acquired.lease, 60_000);
				await shared.publishConfig(acquired.lease, {
					definitions: [{ ...definition, exportName: "boundChild" }],
					leaseMs: 30_000,
					heartbeatMs: 7_500,
					startupTimeoutMs: 30_000,
					claimWindowMs: 60_000,
				});
			}
			const storage = sqlPoolStorage(journal)!;
			await storage.transaction(async (tx) => {
				await tx.run(`UPDATE ${PREFIX}wf_leases SET renewed_at = 0 WHERE run_id = 'stale'`);
				await tx.run(`UPDATE ${PREFIX}wf_runs SET status = 'completed' WHERE run_id = 'done'`);
			});
			host = await startWorkflowWorkerHost({
				journal: selection,
				agentDir: join(directory, "host", "agent"),
				maxWorkers: 2,
				hostId: "host-b",
				workerEntry: stubWorker,
			});
			for (;;) {
				const stats = await host.stats();
				if (stats.roots.length > 0 && stats.workers === 2) break;
				await sleep(25);
			}
			await sleep(2_500);
			const stats = await host.stats();
			assert.deepEqual(
				stats.roots.map((root) => root.root),
				["good"],
				"a dead, finished, foreign or changed root is not served",
			);
			assert.equal(stats.workers, 2, "the one root it serves gets every worker");
			const hostStarts = () =>
				loggedStarts(log).filter((start) => (start.shared as { host: string }).host === "host-b");
			assert.equal(hostStarts().length, 2, "a root it keeps serving is not attached again");
			// The host reports itself when its workers change, then every few seconds: never on every poll.
			const registered = async () => (await shared.registeredHosts()).find((entry) => entry.host === "host-b")!;
			assert.equal((await registered()).workers, 2);
			let resets = 0;
			let previous = (await registered()).heartbeatAgoMs;
			for (const deadline = performance.now() + 6_000; performance.now() < deadline; ) {
				await sleep(200);
				const ago = (await registered()).heartbeatAgoMs;
				if (ago < previous) resets++;
				previous = ago;
			}
			assert.ok(resets >= 1 && resets <= 2, `${resets} reports in 6 s`);
			// Another incarnation takes the root's lease: the host lets go of the old one, and serves the new one once it
			// published its own settings.
			const state = (await journal.leaseState("good"))!;
			const resumed = await journal.takeover("good", "next-incarnation", state.holderId);
			if (resumed.status !== "acquired") assert.fail("no takeover");
			while ((await host.stats()).roots.length > 0) await sleep(25);
			await sleep(2_500);
			assert.equal(hostStarts().length, 2, "an incarnation that published nothing yet is not served");
			await shared.publishConfig(resumed.lease, {
				definitions: [{ ...roots.good!, exportName: "boundChild" }],
				leaseMs: 30_000,
				heartbeatMs: 7_500,
				startupTimeoutMs: 30_000,
				claimWindowMs: 60_000,
			});
			while (hostStarts().length < 4) await sleep(25);
			assert.deepEqual(
				(await host.stats()).roots.map((root) => root.root),
				["good"],
			);
			// A paused root keeps its host's workers, and their sessions with it, until it resumes or ends.
			const startsBeforePause = hostStarts().length;
			await storage.transaction((tx) =>
				tx.run(`UPDATE ${PREFIX}wf_runs SET status = 'paused' WHERE run_id = 'good'`),
			);
			await sleep(2_500);
			assert.deepEqual(
				(await host.stats()).roots.map((root) => root.root),
				["good"],
			);
			assert.equal(hostStarts().length, startsBeforePause, "pausing does not stop the host's workers");
			// A root that ended is let go even before its lease is released.
			await storage.transaction((tx) =>
				tx.run(`UPDATE ${PREFIX}wf_runs SET status = 'completed' WHERE run_id = 'good'`),
			);
			while ((await host.stats()).roots.length > 0) await sleep(25);
			assert.equal((await host.stats()).workers, 0);
			await host.stop();
			assert.deepEqual(await shared.registeredHosts(), [], "a stopped host leaves the registry");
		} finally {
			await host?.stop();
			await journal.close();
			vi.unstubAllEnvs();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a host stops serving a root whose lease another incarnation took, says why, and puts nothing back (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-lease-lost", { workspace: binding });
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
			const reasons: Error[] = [];
			host = await satellite(f, root, { prefer: async () => warm }, reasons);
			while (f.claims().length === 0) await sleep(25);
			const held = (await f.shared.stats("root")).leases;
			assert.equal(held.length, 1);
			const state = (await f.hostJournal.leaseState("root"))!;
			const taken = await f.hostJournal.takeover("root", "next-incarnation", state.holderId);
			assert.equal(taken.status, "acquired");
			while (!host.detached) await sleep(25);
			assert.ok(
				reasons.some((reason) => reason.name === "StaleLeaseError"),
				reasons.map(String).join("; "),
			);
			// Stopping puts nothing back: the root's next incarnation owns the work now.
			await host.stopSatellite();
			const after = await f.shared.stats("root");
			assert.deepEqual(
				after.leases.map((lease) => [lease.work, lease.generation]),
				held.map((lease) => [lease.work, lease.generation]),
			);
		} finally {
			writeFileSync(release, "");
			await host?.stopSatellite().catch(() => {});
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a host giving workers to a root that starts later lets the child it holds finish first (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-yield-held", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const second = new LocalWorkerPool(f.backend, {
			rootId: "root-2",
			durable: poolDurableJournal(f.backend.journal),
			shared: { stateDirectory: join(f.directory, "root", "state-2"), host: "root-host", claimWindowMs: 60_000 },
			workspace: { ...binding, tree: "t2" },
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "boundChild" }],
			workerEntry: stubWorker,
			coordinator: "in-process",
		});
		const first = await fanOut(1)(child as never);
		const other = await fanOut(2)(child as never);
		const executions = [
			run(first.parent, {}, { runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend }),
		];
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			await f.root();
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 2,
				hostId: "host-b",
				workerEntry: stubWorker,
				placement: { prefer: async () => warm },
			});
			while (f.claims().length < 1) await sleep(25);
			const [[, held]] = f.claims() as [[string, string]];
			executions.push(
				run(
					other.parent,
					{},
					{ runId: "root-2", cwd: f.directory, store: createStore(), durableBackend: f.backend },
				),
			);
			// The first root's satellite drains: it takes no more work, and keeps the child its worker holds.
			await sleep(3_000);
			assert.deepEqual(
				f.claims().map(([, workId]) => workId),
				[held],
				"nothing is claimed while the host drains, and the held child is not given back",
			);
			writeFileSync(release, "");
			const results = await Promise.all(executions);
			assert.deepEqual(
				results.map((result) => result.status),
				["completed", "completed"],
			);
			assert.deepEqual(first.outcomes, ["completed"]);
			assert.deepEqual(other.outcomes, ["completed", "completed"]);
			const claimed = f.claims().map(([, workId]) => workId);
			assert.equal(claimed.length, 3);
			assert.equal(new Set(claimed).size, 3, "each child ran once");
		} finally {
			await host?.stop();
			writeFileSync(release, "");
			await Promise.allSettled(executions);
			await second.close();
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

test.skipIf(process.platform === "win32")(
	"a host whose workers keep dying stops serving the root and says why (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-dying", { workspace: binding, claimWindowMs: 60_000 });
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
		try {
			await f.root();
			// The root's own worker is up: from here on, every worker this test's processes fork dies at once.
			vi.stubEnv("SHARED_POOL_STUB_EXIT_IDLE", "1");
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
			});
			let detached = (await host.stats()).lastDetach;
			while (detached === undefined) {
				await sleep(25);
				detached = (await host.stats()).lastDetach;
			}
			assert.deepEqual(Object.keys(detached).sort(), ["message", "name"], "a failure that is not a placement error");
			assert.match(detached.message, /Local worker retry limit/);
			assert.deepEqual(f.claims(), []);
		} finally {
			vi.unstubAllEnvs();
			await host?.stop();
			await f.pool.close().catch(() => {});
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host that stops puts the child its worker holds back in the queue (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-host-stop", { workspace: binding });
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
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
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
				placement: { prefer: async () => warm },
			});
			while (f.claims().length === 0) await sleep(25);
			assert.equal((await f.shared.stats("root")).leased, 1);
			await host.stop();
			const stats = await f.shared.stats("root");
			assert.deepEqual([stats.ready, stats.leased], [1, 0], "the stopped host's child waits for another host");
			assert.deepEqual(await f.shared.registeredHosts(), []);
		} finally {
			writeFileSync(release, "");
			await host?.stop();
			await f.pool.close().catch(() => {});
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a host whose root's lease moves during a restore hands out nothing and stops serving it (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-restore-lost", { workspace: binding, leaseMs: 2_000 });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
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
			const failures: Error[] = [];
			let restoring = false;
			host = await satellite(
				f,
				root,
				{
					restore: async () => {
						restoring = true;
						await sleep(3_000);
						return restored;
					},
				},
				failures,
				"host-b",
				1,
			);
			while (!restoring) await sleep(25);
			const state = (await f.hostJournal.leaseState("root"))!;
			assert.equal((await f.hostJournal.takeover("root", "next-incarnation", state.holderId)).status, "acquired");
			while (!host.detached) await sleep(25);
			await sleep(500);
			assert.deepEqual(f.claims(), [], "the restored child was never handed to a worker");
			assert.ok(
				failures.length > 0 && failures.every((failure) => failure.name === "StaleLeaseError"),
				String(failures),
			);
		} finally {
			await host?.stopSatellite().catch(() => {});
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test(
	"a host whose attempt is replaced during a restore hands it out to no worker and says why (#4310)",
	async () => {
		const f = await fixture("shared-coordinator-restore-replaced", { workspace: binding, leaseMs: 2_000 });
		const restored = join(f.directory, "restored");
		mkdirSync(restored);
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
			const failures: Error[] = [];
			let restoring = false;
			let restoredAt: number | undefined;
			host = await satellite(
				f,
				root,
				{
					restore: async () => {
						if (restoring) {
							await sleep(5_000);
							return restored;
						}
						restoring = true;
						await sleep(3_000);
						restoredAt = Date.now();
						return restored;
					},
				},
				failures,
				"host-b",
				1,
			);
			while (!restoring) await sleep(25);
			const storage = sqlPoolStorage(f.hostJournal)!;
			await storage.transaction((tx) =>
				tx.run(`UPDATE ${storage.tables.runs}_work SET generation = generation + 1 WHERE state = 'leased'`),
			);
			while (restoredAt === undefined) await sleep(25);
			await sleep(300);
			assert.deepEqual(f.claims(), [], "the replaced attempt was never handed to a worker");
			assert.deepEqual(
				failures.map((failure) => failure.message),
				["Stale work lease"],
			);
			assert.equal(host.detached, false, "the root's lease held: the host keeps serving it");
		} finally {
			await host?.stopSatellite().catch(() => {});
			await host?.shutdown();
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
