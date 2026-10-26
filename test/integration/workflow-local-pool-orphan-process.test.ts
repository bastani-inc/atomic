import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { WorkflowInfrastructureError } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import * as admissionHost from "../../packages/workflows/src/workers/admission-host.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
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
}

interface FinishedPool {
	readonly directory: string;
	readonly path: string;
	readonly result: RunResult;
	readonly children: readonly ChildOutcome[];
	readonly pool: LocalWorkerPool;
}

/**
 * A root whose children run on protocol stub workers (test/fixtures/pool-orphan-process-stub-worker.mjs).
 * The worker serving child 0 first takes a process permit bound to a detached `sleep` process group and
 * then SIGKILLs itself, so that group outlives it.
 */
async function runOrphanPool(options: {
	readonly children: number;
	readonly workers: number;
	readonly inProcess?: boolean;
	readonly leaseMs?: number;
	readonly whileRunning?: (pool: RunningPool) => Promise<void>;
	readonly afterRun: (pool: FinishedPool) => Promise<void>;
}): Promise<void> {
	const directory = makeTempDirectory("pool-orphan-process-");
	const path = join(directory, "journal.sqlite");
	const orphanMarker = join(directory, "orphan-group");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const childPath = fileURLToPath(new URL("../fixtures/pool-load-child.ts", import.meta.url));
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
		workerEntry: fileURLToPath(new URL("../fixtures/pool-orphan-process-stub-worker.mjs", import.meta.url)),
		...(options.inProcess ? { coordinator: "in-process" as const } : {}),
		...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
	});
	const root = testRunId("pool-orphan-process-root");
	const children: ChildOutcome[] = [];
	try {
		const execution = run(
			workflow({
				name: "pool-orphan-process-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const settled = await Promise.allSettled(
						Array.from({ length: options.children }, (_, index) => ctx.workflow(child, { inputs: { index } })),
					);
					settled.forEach((outcome, index) => {
						children.push(
							outcome.status === "fulfilled"
								? { index, status: outcome.value.status }
								: { index, error: outcome.reason as Error },
						);
					});
					return {};
				},
			}),
			{},
			{ runId: root, cwd: directory, store: createStore(), durableBackend: backend },
		);
		await options.whileRunning?.({ directory, root, path });
		const result = await execution;
		await options.afterRun({ directory, path, result, children, pool });
	} finally {
		await pool.close().catch(() => {});
		await backend.close();
		if (fileExistsSync(orphanMarker)) {
			const group = Number(readTextSync(orphanMarker, "utf8"));
			if (groupAlive(group)) process.kill(-group, "SIGKILL");
		}
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

async function until(condition: () => boolean): Promise<void> {
	while (!condition()) await sleep(25);
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
	"a process group that survives the bounded reap fails only its own child with a typed retryable error (#3986)",
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
					assert.match(failed.message, new RegExp(`process groups ${group} still running`));
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
					await pool.close();
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
	"the dead worker's work cannot be claimed while its process groups are reaped, and is claimed after (#3986)",
	async () => {
		let reapStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			reapStarted = resolve;
		});
		let finishReap!: () => void;
		const finished = new Promise<void>((resolve) => {
			finishReap = resolve;
		});
		let reaped = false;
		const probe = vi.spyOn(admissionHost, "processGroupState").mockImplementation(() => (reaped ? "gone" : "alive"));
		const signal = vi.spyOn(admissionHost, "signalProcessGroup").mockImplementation(() => {});
		// The reap holds at its first pause until the test has observed claims refused.
		const pause = vi.spyOn(admissionHost, "reapPause").mockImplementation(async () => {
			reapStarted();
			await finished;
		});
		const extend = vi.spyOn(SqlPoolQueue.prototype, "extend");
		const claim = vi.spyOn(SqlPoolQueue.prototype, "claim");
		try {
			await runOrphanPool({
				children: 1,
				workers: 2,
				inProcess: true,
				leaseMs: SHORT_LEASE_MS,
				async whileRunning({ directory, root, path }) {
					await started;
					const extendsBefore = extend.mock.calls.length;
					const group = Number(readTextSync(join(directory, "orphan-group"), "utf8"));
					const journal = new DatabaseSync(path, { readOnly: true });
					const work = () => {
						const row = journal.prepare("SELECT id, state, worker FROM wf_runs_work WHERE root = ?").get(root);
						assert.ok(row);
						return { id: String(row.id), state: String(row.state), worker: String(row.worker) };
					};
					try {
						const held = work();
						assert.equal(held.state, "leased");
						// Recovery found the dead worker's lease expired and extended it instead of releasing it.
						await until(
							() =>
								work().state !== "leased" ||
								work().worker !== held.worker ||
								extend.mock.calls.slice(extendsBefore).some(([, token]) => token.id === held.id),
						);
						assert.deepEqual(work(), held, "recovery does not release the work while it is reaped");
						const before = claim.mock.results.length;
						await until(() => claim.mock.results.length > before + 1);
						for (const outcome of claim.mock.results.slice(before))
							assert.equal(await outcome.value, undefined, "a claim during the reap is refused");
						assert.deepEqual(work(), held, "the work stays with the dead worker's attempt");
					} finally {
						journal.close();
						// Let the blocked reap finish, so a failed assertion cannot hold pool close on it.
						if (groupAlive(group)) process.kill(-group, "SIGKILL");
						await until(() => !groupAlive(group));
						reaped = true;
						finishReap();
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
			finishReap();
			probe.mockRestore();
			signal.mockRestore();
			pause.mockRestore();
			extend.mockRestore();
			claim.mockRestore();
		}
	},
	ORPHAN_PROCESS_TEST_TIMEOUT_MS,
);
