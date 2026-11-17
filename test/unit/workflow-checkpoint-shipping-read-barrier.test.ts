import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { runLocalWorker } from "../../packages/workflows/src/workers/local-worker.js";
import { poolDurableJournal } from "../../packages/workflows/src/workers/pool-journal.js";
import { openPoolSessions } from "../../packages/workflows/src/workers/pool-session-store.js";
import type { WatchId, WatchResult } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { FakeWorker } from "../helpers/fake-pool-worker.js";
import { openCoordinator, SOURCE } from "../helpers/pool-coordinator.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const execution = vi.hoisted(() => ({ run: vi.fn() }));
const transport = vi.hoisted(() => ({ fork: vi.fn() }));

vi.mock("../../packages/workflows/src/engine/run.js", () => ({ run: execution.run }));
vi.mock("../../packages/workflows/src/workers/definitions.js", async (original) => ({
	...(await original<typeof import("../../packages/workflows/src/workers/definitions.js")>()),
	loadWorkerDefinition: async () => ({ name: "child" }),
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	fork: (...args: unknown[]) => transport.fork(...args),
}));

test("a root watch reads the running worker's unshipped session through the coordinator barrier (#5344)", async () => {
	const directory = makeTempDirectory("shipping-read-barrier-");
	const journal = await resolveRunJournal({ journal: { path: join(directory, "shared.sqlite") } });
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	const host = openCoordinator();
	const messages = new EventEmitter();
	const written = Promise.withResolvers<void>();
	void written.promise.catch(() => {});
	const finish = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	const realProcess = process;
	let worker: FakeWorker | undefined;
	let workerFailure: unknown;
	const sessionId = "unshipped-stage-session";
	const stageId = "agent";
	const fixture = poolWorkFixture();
	const workerProcess = Object.create(realProcess) as NodeJS.Process;
	workerProcess.on = messages.on.bind(messages) as typeof process.on;
	workerProcess.disconnect = () => {};
	workerProcess.send = ((message: object, sent?: (error: Error | null) => void) => {
		queueMicrotask(() => worker!.emit("message", message));
		sent?.(null);
		return true;
	}) as typeof process.send;
	transport.fork.mockImplementation((_module: string, args: readonly string[], options: ForkOptions) => {
		worker = new FakeWorker(4_000_000, args, options);
		workerProcess.env = { ...options.env };
		worker.send = (message, sent) => {
			queueMicrotask(() => messages.emit("message", message));
			sent?.(null);
			return true;
		};
		queueMicrotask(() => {
			void runLocalWorker(worker!.start)
				.catch((error: unknown) => {
					workerFailure = error;
					written.reject(error);
				})
				.finally(() => stopped.resolve());
		});
		return worker;
	});
	execution.run.mockImplementation(async (_definition: unknown, _inputs: unknown, options: RunOpts) => {
		const store = options.store!;
		const runId = options.runId!;
		store.recordRunStart({
			id: runId,
			name: "child",
			inputs: {},
			parentRunId: "root",
			parentStageId: "boundary",
			rootRunId: "root",
			status: "running",
			stages: [],
			toolNodes: [],
			startedAt: Date.now(),
		});
		store.recordStageStart(runId, {
			id: stageId,
			name: stageId,
			replayKey: "stage:agent",
			status: "running",
			parentIds: [],
			toolEvents: [],
			sessionId,
		});
		const sessions = options.adapters!.sessionStore!;
		await sessions.create(
			{
				id: sessionId,
				version: 4,
				createdAt: new Date(0).toISOString(),
				cwd: directory,
				workflow: { runId, stageId, stageName: stageId },
			},
			[],
		);
		await sessions.append(
			sessionId,
			[
				{
					type: "custom",
					id: "receipt",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					customType: "atomic-pooled-delivery-op",
					data: { op: "unshipped-op" },
				},
			],
			{ expectSeq: 0 },
		);
		const handle: StageControlHandle = {
			runId,
			stageId,
			stageName: stageId,
			status: "running",
			sessionId,
			sessionFile: undefined,
			isStreaming: false,
			messages: [],
			ensureAttached: async () => {},
			prompt: async () => {},
			steer: async () => {},
			followUp: async () => {},
			pause: async () => {},
			resume: async () => undefined,
			subscribe: () => () => {},
		};
		options.stageControlRegistry!.register(handle);
		written.resolve();
		await finish.promise;
		return { runId, status: "completed", outputs: {}, stages: [], toolNodes: [] };
	});
	try {
		vi.stubGlobal("process", workerProcess);
		await backend.commitWorkflowRegistration({
			workflowId: "root",
			name: "root",
			inputs: {},
			createdAt: 0,
			status: "running",
		});
		const acquired = await journal.acquire("root", backend.holderId);
		assert.equal(acquired.status, "acquired");
		if (acquired.status !== "acquired") assert.fail("root lease was not acquired");
		await host.command({
			kind: "prepare",
			root: "root",
			lease: acquired.lease,
			options: {
				durable: poolDurableJournal(journal),
				shared: {
					stateDirectory: join(directory, "state"),
					host: "host-a",
					claimWindowMs: 60_000,
					checkpointShipping: { intervalMs: 60_000, maxBatch: 64, maxLagMs: 600_000 },
				},
				workers: 1,
				leaseMs: 60_000,
				heartbeatMs: 15_000,
				startupTimeoutMs: 30_000,
				workerEntry: "fake-worker",
			},
		});
		await Promise.race([
			host.command({ kind: "start", sources: [SOURCE], cwd: directory, publish: false }),
			stopped.promise.then(() => {
				throw workerFailure ?? new Error("worker stopped before startup");
			}),
		]);
		await host.command({
			kind: "enqueue",
			descriptor: { ...fixture.work, definition: `${SOURCE.path}#${SOURCE.exportName}`, digest: SOURCE.digest },
			boundary: fixture.boundary,
		});
		await written.promise;
		const sessions = await openPoolSessions(sqlPoolStorage(journal)!);
		assert.ok(sessions);
		try {
			assert.equal(
				await sessions.readHeader(sessionId),
				undefined,
				"no interval, batch limit or stage end shipped the session",
			);
			let result: WatchResult | undefined;
			await vi.waitFor(async () => {
				result = (await host.command({
					kind: "stage-watch",
					watch: "watch" as WatchId,
					runId: fixture.work.childRunId,
					stageId,
				})) as WatchResult;
				assert.equal(result.ok, true);
			});
			assert.ok(result?.ok);
			assert.deepEqual(result.watch.snapshot.deliveredOps, ["unshipped-op"]);
			assert.deepEqual(
				(await sessions.load(sessionId)).entries.map((entry) => entry.id),
				["receipt"],
			);
			assert.equal(
				(
					await sqlPoolStorage(journal)!.read((read) =>
						read.get<{ n: number }>("SELECT COUNT(*) AS n FROM wf_runs_ship_batches"),
					)
				)?.n,
				1,
			);
		} finally {
			await sessions.close();
		}
	} finally {
		finish.resolve();
		await host.command({ kind: "control", state: "quit" }).catch(() => {});
		if (worker !== undefined) await stopped.promise;
		await host.command({ kind: "close" });
		await host.coordinator.shutdown();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await backend.close();
		await journal.close();
		removeTempDirectory(directory);
	}
	assert.equal(workerFailure, undefined);
});
