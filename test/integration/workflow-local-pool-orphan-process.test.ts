import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { WorkflowInfrastructureError } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import * as admissionHost from "../../packages/workflows/src/workers/admission-host.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import {
	fileExistsSync,
	makeTempDirectory,
	readJson,
	readTextSync,
	removeTempDirectory,
	sleep,
} from "../helpers/runtime.js";

const ORPHAN_PROCESS_TEST_TIMEOUT_MS = 120_000;
/** The shortest work lease a pool accepts, so the held lease expires while the reap is blocked. */
const SHORT_LEASE_MS = 2_000;
const childPath = fileURLToPath(new URL("../fixtures/pool-load-child.ts", import.meta.url));
const stubWorker = fileURLToPath(new URL("../fixtures/pool-orphan-process-stub-worker.mjs", import.meta.url));

function groupAlive(group: number): boolean {
	try {
		process.kill(-group, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

interface ChildOutcome {
	readonly index: number;
	readonly status?: string;
	readonly error?: Error;
}

interface RunningPool {
	readonly directory: string;
	readonly root: string;
	readonly path: string;
	readonly pool: LocalWorkerPool;
}

interface FinishedPool {
	readonly directory: string;
	readonly path: string;
	readonly result: RunResult;
	readonly children: readonly ChildOutcome[];
	readonly pool: LocalWorkerPool;
}

interface PoolOptions {
	readonly workers: number;
	readonly inProcess?: boolean;
	readonly leaseMs?: number;
}

/**
 * A pool whose children run on protocol stub workers (test/fixtures/pool-orphan-process-stub-worker.mjs).
 * The worker serving child 0 first takes a process permit bound to a detached `sleep` process group and
 * then SIGKILLs itself, or goes silent with ATOMIC_TEST_ORPHAN_MODE=stall, so that group outlives it.
 */
async function openOrphanPool(path: string, options: PoolOptions) {
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: options.workers,
		admission: {},
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
		workerEntry: stubWorker,
		...(options.inProcess ? { coordinator: "in-process" as const } : {}),
		...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
	});
	return { backend, child, pool };
}

type PooledChild = Awaited<ReturnType<typeof openOrphanPool>>["child"];

/** The root: runs `children` pooled children; with `settle`, a child failure is recorded instead of failing the root. */
function orphanRoot(child: PooledChild, children: number, outcomes: ChildOutcome[], settle = true) {
	return workflow({
		name: "pool-orphan-process-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const calls = Array.from({ length: children }, (_, index) => ctx.workflow(child, { inputs: { index } }));
			if (!settle) {
				for (const result of await Promise.all(calls))
					outcomes.push({ index: outcomes.length, status: result.status });
				return {};
			}
			const settled = await Promise.allSettled(calls);
			settled.forEach((outcome, index) => {
				outcomes.push(
					outcome.status === "fulfilled"
						? { index, status: outcome.value.status }
						: { index, error: outcome.reason as Error },
				);
			});
			return {};
		},
	});
}

function killOrphan(directory: string): void {
	const orphanMarker = join(directory, "orphan-group");
	if (!fileExistsSync(orphanMarker)) return;
	const group = Number(readTextSync(orphanMarker, "utf8"));
	if (groupAlive(group)) process.kill(-group, "SIGKILL");
}

async function runOrphanPool(
	options: PoolOptions & {
		readonly children: number;
		readonly whileRunning?: (pool: RunningPool) => Promise<void>;
		readonly afterRun: (pool: FinishedPool) => Promise<void>;
	},
): Promise<void> {
	const directory = makeTempDirectory("pool-orphan-process-");
	const path = join(directory, "journal.sqlite");
	const { backend, child, pool } = await openOrphanPool(path, options);
	const root = testRunId("pool-orphan-process-root");
	const children: ChildOutcome[] = [];
	try {
		const execution = run(
			orphanRoot(child, options.children, children),
			{},
			{ runId: root, cwd: directory, store: createStore(), durableBackend: backend },
		);
		await options.whileRunning?.({ directory, root, path, pool });
		const result = await execution;
		await options.afterRun({ directory, path, result, children, pool });
	} finally {
		await pool.close().catch(() => {});
		await backend.close();
		killOrphan(directory);
		removeTempDirectory(directory);
	}
}

function permitStates(path: string): string[][] {
	const journal = new DatabaseSync(path, { readOnly: true });
	try {
		return journal
			.prepare("SELECT kind, state, reason FROM wf_runs_resource_permits")
			.all()
			.map((row) => [String(row.kind), String(row.state), String(row.reason)]);
	} finally {
		journal.close();
	}
}

interface WorkRow {
	readonly id: string;
	readonly state: string;
	readonly worker: string;
	readonly generation: number;
}

function workRow(path: string, root: string): WorkRow {
	const journal = new DatabaseSync(path, { readOnly: true });
	try {
		const row = journal.prepare("SELECT id, state, worker, generation FROM wf_runs_work WHERE root = ?").get(root);
		assert.ok(row);
		return {
			id: String(row.id),
			state: String(row.state),
			worker: String(row.worker),
			generation: Number(row.generation),
		};
	} finally {
		journal.close();
	}
}

async function until(condition: () => boolean): Promise<void> {
	while (!condition()) await sleep(25);
}

/** A barrier the reap waits on at its first pause, released by the test. */
function reapBarrier() {
	let reapStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		reapStarted = resolve;
	});
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pause = vi.spyOn(admissionHost, "reapPause").mockImplementation(async () => {
		reapStarted();
		await released;
	});
	return { started, release, pause };
}

function unconfirmedCleanup(group: number): RegExp {
	return new RegExp(`Local worker process cleanup unconfirmed; process groups ${group} still running`);
}

test.skipIf(process.platform === "win32")(
	"a worker that dies while its tool process group runs replays only its child once that group is reaped (#3986)",
	async () => {
		await runOrphanPool({
			children: 1,
			workers: 1,
			async afterRun({ directory, path, result, children }) {
				assert.equal(result.status, "completed", result.error);
				assert.deepEqual(children, [{ index: 0, status: "completed" }]);
				const replay = await readJson<{ group: number; orphanAliveAtReplay: boolean }>(
					join(directory, "replay.json"),
				);
				assert.equal(
					replay.orphanAliveAtReplay,
					false,
					"the replay never overlaps the dead attempt's process group",
				);
				assert.equal(groupAlive(replay.group), false);
				assert.deepEqual(permitStates(path), [["process", "released", "process group cleanup confirmed"]]);
			},
		});
	},
	ORPHAN_PROCESS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a process group that survives the bounded reap fails only its own child, and a later close reports it (#3986)",
	async () => {
		// The probe never reports the group gone, signals are dropped, and the reap's pauses take no time.
		const probe = vi.spyOn(admissionHost, "processGroupState").mockReturnValue("alive");
		const signal = vi.spyOn(admissionHost, "signalProcessGroup").mockImplementation(() => {});
		const pause = vi.spyOn(admissionHost, "reapPause").mockResolvedValue();
		try {
			await runOrphanPool({
				children: 2,
				workers: 2,
				inProcess: true,
				async afterRun({ directory, path, result, children, pool }) {
					assert.equal(result.status, "completed", result.error);
					const group = Number(readTextSync(join(directory, "orphan-group"), "utf8"));
					const failed = children[0]?.error;
					assert.ok(failed instanceof WorkflowInfrastructureError, String(failed));
					assert.equal(failed.code, "worker_cleanup_unconfirmed");
					assert.equal(failed.retryable, true);
					assert.match(failed.message, unconfirmedCleanup(group));
					assert.deepEqual(children[1], { index: 1, status: "completed" }, "the rest of the pool keeps running");
					assert.equal(
						fileExistsSync(join(directory, "replay.json")),
						false,
						"the child never replays alongside the live group",
					);
					assert.ok(groupAlive(group));
					assert.deepEqual(
						signal.mock.calls.map(([, name]) => name),
						["SIGTERM", "SIGKILL"],
					);
					assert.deepEqual(
						permitStates(path).map(([, state]) => state),
						["granted"],
						"the live group's permit stays quarantined",
					);
					// The reap finished before close started: close still reports the surviving group.
					await assert.rejects(pool.close(), unconfirmedCleanup(group));
				},
			});
		} finally {
			probe.mockRestore();
			signal.mockRestore();
			pause.mockRestore();
		}
	},
	ORPHAN_PROCESS_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a close that starts while a surviving process group is reaped reports it (#3986)",
	async () => {
		const probe = vi.spyOn(admissionHost, "processGroupState").mockReturnValue("alive");
		const signal = vi.spyOn(admissionHost, "signalProcessGroup").mockImplementation(() => {});
		const barrier = reapBarrier();
		try {
			await runOrphanPool({
				children: 1,
				workers: 1,
				inProcess: true,
				async whileRunning({ directory, pool }) {
					await barrier.started;
					const group = Number(readTextSync(join(directory, "orphan-group"), "utf8"));
					const closing = pool.close();
					// The coordinator handles commands in order and marks itself closed as it starts closing, so a
					// reply to a later command proves its close began before the reap resumes.
					await pool.control("running");
					barrier.release();
					await assert.rejects(closing, unconfirmedCleanup(group));
				},
				async afterRun({ directory, children }) {
					assert.ok(children[0]?.error, "the closed pool did not run the child");
					assert.equal(fileExistsSync(join(directory, "replay.json")), false);
				},
			});
		} finally {
			barrier.release();
			probe.mockRestore();
			signal.mockRestore();
			barrier.pause.mockRestore();
		}
	},
	ORPHAN_PROCESS_TEST_TIMEOUT_MS,
);

for (const mode of ["exit", "stall"] as const)
	test.skipIf(process.platform === "win32")(
		`a worker's work is not claimable while its process groups are reaped after it ${mode === "exit" ? "exits" : "stalls and is stopped"}, and is claimed after (#3986)`,
		async () => {
			let reaped = false;
			const probe = vi
				.spyOn(admissionHost, "processGroupState")
				.mockImplementation(() => (reaped ? "gone" : "alive"));
			const signal = vi.spyOn(admissionHost, "signalProcessGroup").mockImplementation(() => {});
			// The reap holds at its first pause until the test has observed claims refused.
			const barrier = reapBarrier();
			const extend = vi.spyOn(SqlPoolQueue.prototype, "extend");
			const claim = vi.spyOn(SqlPoolQueue.prototype, "claim");
			if (mode === "stall") process.env.ATOMIC_TEST_ORPHAN_MODE = "stall";
			try {
				await runOrphanPool({
					children: 1,
					workers: 2,
					inProcess: true,
					leaseMs: SHORT_LEASE_MS,
					async whileRunning({ directory, root, path }) {
						await barrier.started;
						const extendsBefore = extend.mock.calls.length;
						const group = Number(readTextSync(join(directory, "orphan-group"), "utf8"));
						try {
							const held = workRow(path, root);
							assert.equal(held.state, "leased");
							// Recovery finds the stopped worker's lease expired and extends it instead of releasing it.
							await until(() => {
								const current = workRow(path, root);
								return (
									current.state !== "leased" ||
									current.generation !== held.generation ||
									extend.mock.calls.slice(extendsBefore).some(([, token]) => token.id === held.id)
								);
							});
							assert.deepEqual(
								workRow(path, root),
								held,
								"recovery does not release the work while it is reaped",
							);
							const before = claim.mock.results.length;
							await until(() => claim.mock.results.length > before + 1);
							for (const outcome of claim.mock.results.slice(before))
								assert.equal(
									await outcome.value,
									undefined,
									"another worker's claim during the reap is refused",
								);
							assert.deepEqual(workRow(path, root), held, "the work stays with the stopped worker's attempt");
						} finally {
							// Let the blocked reap finish, so a failed assertion cannot hold pool close on it.
							if (groupAlive(group)) process.kill(-group, "SIGKILL");
							await until(() => !groupAlive(group));
							reaped = true;
							barrier.release();
						}
					},
					async afterRun({ directory, result, children }) {
						assert.equal(result.status, "completed", result.error);
						assert.deepEqual(children, [{ index: 0, status: "completed" }], "the work is claimed after the reap");
						const replay = await readJson<{ orphanAliveAtReplay: boolean }>(join(directory, "replay.json"));
						assert.equal(replay.orphanAliveAtReplay, false);
					},
				});
			} finally {
				delete process.env.ATOMIC_TEST_ORPHAN_MODE;
				barrier.release();
				probe.mockRestore();
				signal.mockRestore();
				barrier.pause.mockRestore();
				extend.mockRestore();
				claim.mockRestore();
			}
		},
		ORPHAN_PROCESS_TEST_TIMEOUT_MS,
	);

test.skipIf(process.platform === "win32")(
	"a durable resume keeps quarantined work unclaimable while its process group runs, and replays it after (#3986)",
	async () => {
		const directory = makeTempDirectory("pool-orphan-resume-");
		const path = join(directory, "journal.sqlite");
		const root = testRunId("pool-orphan-resume-root");
		const claim = vi.spyOn(SqlPoolQueue.prototype, "claim");
		try {
			// The first incarnation quarantines child 0: its group survives the reap, so the root fails.
			const probe = vi.spyOn(admissionHost, "processGroupState").mockReturnValue("alive");
			const signal = vi.spyOn(admissionHost, "signalProcessGroup").mockImplementation(() => {});
			const pause = vi.spyOn(admissionHost, "reapPause").mockResolvedValue();
			const first = await openOrphanPool(path, { workers: 1, inProcess: true });
			try {
				const result = await run(
					orphanRoot(first.child, 1, [], false),
					{},
					{ runId: root, cwd: directory, store: createStore(), durableBackend: first.backend },
				);
				assert.equal(result.status, "failed");
				assert.match(result.error ?? "", /process groups \d+ still running/);
			} finally {
				await first.pool.close().catch(() => {});
				await first.backend.close();
				probe.mockRestore();
				signal.mockRestore();
				pause.mockRestore();
			}
			const group = Number(readTextSync(join(directory, "orphan-group"), "utf8"));
			assert.ok(groupAlive(group), "the quarantined group still runs");
			const quarantined = workRow(path, root);
			assert.equal(quarantined.state, "leased");

			// The resumed incarnation probes the real group.
			const resumed = await openOrphanPool(path, { workers: 1, inProcess: true });
			const outcomes: ChildOutcome[] = [];
			try {
				const store = createStore();
				const jobs = createJobTracker();
				let completion: Promise<unknown> | undefined;
				const claimsBefore = claim.mock.results.length;
				const accepted = await resumeDurableWorkflow(root, {
					registry: createRegistry().register(orphanRoot(resumed.child, 1, outcomes, false)),
					baseRunOpts: { store, cwd: directory },
					durableBackend: resumed.backend,
					jobs,
					onRunAccepted: (id) => {
						completion = jobs.get(id)?.promise;
					},
				});
				assert.ok(accepted.ok, accepted.ok ? "" : accepted.message);
				await until(() => claim.mock.results.length > claimsBefore + 1);
				for (const outcome of claim.mock.results.slice(claimsBefore))
					assert.equal(
						await outcome.value,
						undefined,
						"the resumed pool cannot claim work whose group still runs",
					);
				assert.deepEqual(workRow(path, root), quarantined, "the quarantined attempt keeps its lease across resume");
				assert.equal(fileExistsSync(join(directory, "replay.json")), false);

				process.kill(-group, "SIGKILL");
				await completion;
				const record = store.runs().find((candidate) => candidate.id === root);
				assert.equal(record?.status, "completed", record?.error);
				assert.deepEqual(outcomes, [{ index: 0, status: "completed" }]);
				const replay = await readJson<{ orphanAliveAtReplay: boolean }>(join(directory, "replay.json"));
				assert.equal(replay.orphanAliveAtReplay, false, "the replay starts only after the group exits");
			} finally {
				await resumed.pool.close().catch(() => {});
				await resumed.backend.close();
			}
		} finally {
			claim.mockRestore();
			killOrphan(directory);
			removeTempDirectory(directory);
		}
	},
	ORPHAN_PROCESS_TEST_TIMEOUT_MS,
);
