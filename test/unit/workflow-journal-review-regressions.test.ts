import assert from "node:assert/strict";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test, vi } from "vitest";
import { DurableNestedTopologyError } from "../../packages/workflows/src/durable/boundary-topology.js";
import {
	JournalDurableBackend,
	JournalOwnershipError,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import {
	RUN_EVENT_TYPES,
	type RunJournal,
	RunNotFoundError,
	StorageUnavailableError,
} from "../../packages/workflows/src/durable/journal/types.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS } from "../../packages/workflows/src/durable/resume-eligibility.js";
import {
	prepareTargetedDurableResumable,
	resumeDurableWorkflow,
} from "../../packages/workflows/src/durable/resume-runtime.js";
import type { DurableCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { STAGE_SESSION_HEARTBEAT_INTERVAL_MS } from "../../packages/workflows/src/runs/foreground/stage-session-heartbeat.js";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { assertLeaseStateUnchanged } from "../helpers/journal-lease-state.js";
import { testRunId } from "../helpers/run-id.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

function asyncJournal(journal: RunJournal): RunJournal {
	return {
		createRun: (header) => journal.createRun(header),
		getRun: (runId) => journal.getRun(runId),
		leaseState: (runId) => journal.leaseState(runId),
		takeoverExpired: (runId, holderId, staleAfterMs) => journal.takeoverExpired(runId, holderId, staleAfterMs),
		listRuns: (filter) => journal.listRuns(filter),
		acquire: (runId, holderId) => journal.acquire(runId, holderId),
		takeover: (runId, holderId, expectedHolder) => journal.takeover(runId, holderId, expectedHolder),
		renew: (lease) => journal.renew(lease),
		release: (lease) => journal.release(lease),
		append: (lease, event, options) => journal.append(lease, event, options),
		read: (runId, fromSeq) => journal.read(runId, fromSeq),
		readKey: (runId, key) => journal.readKey(runId, key),
		deleteOwnedRun: (lease) => journal.deleteOwnedRun(lease),
		deleteRun: (runId) => journal.deleteRun(runId),
		close: () => journal.close(),
	};
}

for (const method of ["takeoverExpired", "leaseState"] as const) {
	test(`VM-native ${method} preserves registration journal effects and local ownership`, async () => {
		const ForeignPromise = runInNewContext("Promise") as PromiseConstructor;
		const memory = new MemoryRunJournal();
		const journal = asyncJournal(memory);
		function foreign<T>(result: Promise<T>): Promise<T> {
			const promise = ForeignPromise.resolve(result);
			assert.ok(promise instanceof ForeignPromise);
			assert.ok(!(promise instanceof Promise));
			return promise;
		}
		if (method === "takeoverExpired") journal.takeoverExpired = (...args) => foreign(memory.takeoverExpired(...args));
		else journal.leaseState = (...args) => foreign(memory.leaseState(...args));
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		try {
			await backend.registerWorkflow({
				workflowId: "run",
				name: "test",
				inputs: {},
				createdAt: 1,
				status: "running",
			});
			assert.equal((await memory.getRun("run"))?.status, "running");
			const entries = [];
			for await (const entry of memory.read("run")) entries.push(entry);
			assert.deepEqual(
				entries.map((entry) => [entry.seq, entry.event.type]),
				[[1, RUN_EVENT_TYPES.runStarted]],
			);
			assert.equal(backend.getWorkflow("run")?.status, "running");
			const state = await memory.leaseState("run");
			assert.equal(state?.holderId, backend.holderId);
			assert.equal(await backend.workflowOwnership("run"), "local");
			assertLeaseStateUnchanged(await memory.leaseState("run"), state);
		} finally {
			await backend.close();
			await memory.close();
		}
	});

	test(`async-only ${method} preserves thrown and VM-rejected errors without poisoning retries`, async () => {
		const ForeignPromise = runInNewContext("Promise") as PromiseConstructor;
		const memory = new MemoryRunJournal();
		const journal = asyncJournal(memory);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const register = () =>
			backend.registerWorkflow({ workflowId: "run", name: "test", inputs: {}, createdAt: 1, status: "running" });
		try {
			for (const failure of [new RunNotFoundError("run"), new TypeError("adapter failed")]) {
				for (const completion of ["throw", "reject"] as const) {
					journal[method] = () => {
						if (completion === "throw") throw failure;
						const result = ForeignPromise.reject<never>(failure);
						assert.ok(result instanceof ForeignPromise);
						assert.ok(!(result instanceof Promise));
						return result;
					};
					await assert.rejects(
						Promise.resolve().then(() =>
							method === "takeoverExpired" ? register() : backend.workflowOwnership("run"),
						),
						(error: Error) => {
							if (failure instanceof RunNotFoundError) assert.equal(error, failure);
							else {
								assert.ok(error instanceof StorageUnavailableError);
								assert.equal(error.location, "custom journal");
								assert.equal(error.cause, failure);
							}
							return true;
						},
					);
					assert.equal(await memory.leaseState("run"), undefined);
					assert.equal(backend.getWorkflow("run"), undefined);
					const entries = [];
					for await (const entry of memory.read("run")) entries.push(entry);
					assert.deepEqual(entries, []);
				}
			}
			journal.takeoverExpired = (...args) => memory.takeoverExpired(...args);
			journal.leaseState = (...args) => memory.leaseState(...args);
			await register();
			assert.equal(await backend.workflowOwnership("run"), "local");
		} finally {
			await backend.close();
			await memory.close();
		}
	});
}

for (const storage of ["memory", "sqlite"] as const) {
	test(`rejected boundary writes preserve a reopenable ${storage} journal`, async () => {
		const directory = makeTempDirectory("boundary-rejection-");
		const journal =
			storage === "memory" ? new MemoryRunJournal() : await openSqlRunJournal(join(directory, "journal.sqlite"));
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		try {
			await backend.registerWorkflow({
				workflowId: "run",
				name: "boundary",
				inputs: {},
				createdAt: 1,
				status: "running",
			});
			const entriesBefore = [];
			for await (const entry of journal.read("run")) entriesBefore.push(entry);
			const checkpoint: DurableCheckpoint = {
				kind: "stage",
				workflowId: "run",
				checkpointId: "boundary",
				name: "workflow:child",
				replayKey: "child:1",
				completedAt: 2,
				topology: {
					version: 1,
					stageId: "boundary",
					parentIds: [],
					boundary: {
						version: 1,
						replayScope: "child:1",
						alias: "child",
						workflow: "child",
						event: "start",
						status: "running",
						invocationFingerprint: "fingerprint",
						child: {
							runId: "child",
							runName: "child",
							parentRunId: "run",
							parentStageId: "boundary",
							rootRunId: "run",
						},
					},
				},
			};
			assert.ok(checkpoint.topology?.boundary);
			Reflect.deleteProperty(checkpoint.topology.boundary, "invocationFingerprint");
			await assert.rejects(backend.recordCheckpointAsync(checkpoint), (error: Error) => {
				assert.ok(error instanceof DurableNestedTopologyError);
				assert.equal(error.reason, "missing invocation fingerprint at boundary");
				return true;
			});
			const entriesAfter = [];
			for await (const entry of journal.read("run")) entriesAfter.push(entry);
			assert.deepEqual(entriesAfter, entriesBefore);
			await backend.close();
			const reopened = await JournalDurableBackend.open(journal, { ownsJournal: false });
			assert.equal(reopened.getWorkflow("run")?.status, "running");
			assert.deepEqual(reopened.listCheckpoints("run"), []);
			await reopened.close();
		} finally {
			await backend.close();
			await journal.close();
			removeTempDirectory(directory);
		}
	});
}

test("reopened async-only journals resume unheld runs and replay completed tools, but refuse foreign owners", async () => {
	const memory = new MemoryRunJournal();
	const journal = asyncJournal(memory);
	let toolCalls = 0;
	const definition = workflow({
		name: "custom-journal-recovery",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("effect", {}, async () => {
				toolCalls++;
				return "saved";
			});
			return {};
		},
	});
	const runId = testRunId("custom-journal-recovery");
	const writer = await JournalDurableBackend.open(journal, { ownsJournal: false });
	let reader: Awaited<ReturnType<typeof JournalDurableBackend.open>> | undefined;
	try {
		assert.equal(
			(await run(definition, {}, { runId, durableBackend: writer, store: createStore() })).status,
			"completed",
		);
		await writer.setWorkflowStatus(runId, "running", 0, true);
		assert.ok(writer.listCheckpoints(runId).some((entry) => entry.kind === "tool" && entry.output === "saved"));
		await writer.close();
		reader = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const jobs = createJobTracker();
		const deps = {
			registry: createRegistry().register(definition),
			durableBackend: reader,
			baseRunOpts: { store: createStore() },
			jobs,
		};
		const foreign = await memory.acquire(runId, "foreign");
		assert.equal(foreign.status, "acquired");
		if (foreign.status !== "acquired") return assert.fail("foreign lease was not acquired");
		assert.equal(await reader.workflowOwnership(runId), "foreign");
		assert.deepEqual(await prepareTargetedDurableResumable(reader, [runId]), []);
		const refused = await resumeDurableWorkflow(runId, deps);
		assert.equal(refused.ok, false);
		if (refused.ok) return assert.fail("foreign run was resumed");
		assert.equal(refused.reason, "owned_elsewhere");
		await memory.release(foreign.lease);
		assert.equal(await reader.workflowOwnership(runId), "available");
		assert.deepEqual(
			(await prepareTargetedDurableResumable(reader, [runId])).map((entry) => entry.workflowId),
			[runId],
		);
		const resumed = await resumeDurableWorkflow(runId, deps);
		assert.equal(resumed.ok, true);
		await jobs.get(resumed.runId)?.promise;
		assert.equal(reader.getWorkflow(runId)?.status, "completed");
		assert.equal(toolCalls, 1);
	} finally {
		await reader?.close();
		await writer.close();
		await journal.close();
	}
});

test("async-only ownership inspection is read-only and expired takeover fences the previous holder", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000);
	const memory = new MemoryRunJournal();
	const journal = asyncJournal(memory);
	const writer = await JournalDurableBackend.open(journal, { ownsJournal: false });
	let reader: Awaited<ReturnType<typeof JournalDurableBackend.open>> | undefined;
	try {
		await writer.registerWorkflow({ workflowId: "run", name: "test", inputs: {}, createdAt: 1, status: "running" });
		reader = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const initial = await memory.leaseState("run");
		assert.ok(initial);
		vi.setSystemTime(1_001);
		assert.equal(await writer.workflowOwnership("run"), "local");
		assert.equal(await reader.workflowOwnership("run"), "foreign");
		assertLeaseStateUnchanged(await memory.leaseState("run"), initial);
		vi.setSystemTime(1_000 + FOREIGN_LIVE_WORKFLOW_WINDOW_MS + 1);
		assert.equal(await reader.workflowOwnership("run"), "available");
		assertLeaseStateUnchanged(await memory.leaseState("run"), initial);
		await reader.setWorkflowStatus("run", "paused");
		const current = await memory.leaseState("run");
		assert.equal(current?.epoch, initial.epoch + 1);
		assert.equal(current?.holderId, reader.holderId);
		await assert.rejects(
			Promise.resolve().then(() => writer.setWorkflowStatus("run", "failed")),
			JournalOwnershipError,
		);
		assert.equal((await memory.getRun("run"))?.status, "paused");
	} finally {
		await reader?.close();
		await writer.close();
		await memory.close();
		vi.useRealTimers();
	}
});

test("owned deletion rejects takeover between renewal and deletion without erasing the successor", async () => {
	const result = spawnSyncCollect([
		bunExecutable(),
		"run",
		join(moduleDir(import.meta.url), "../fixtures/journal-custom-delete-race.ts"),
	]);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.deepEqual(JSON.parse(result.stdout.toString()), {
		staleDeletionRejected: true,
		survivingRuns: [{ runId: "run", status: "running" }],
	});
});

test("release waits for an in-flight heartbeat and permits a fresh resume lease (#3674)", async () => {
	vi.useFakeTimers();
	const memory = new MemoryRunJournal();
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let releases = 0;
	const journal: RunJournal = {
		...asyncJournal(memory),
		async renew(lease) {
			started.resolve();
			await finish.promise;
			await memory.renew(lease);
		},
		async release(lease) {
			releases++;
			await memory.release(lease);
		},
	};
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	let releasing: Promise<void> | undefined;
	try {
		await backend.registerWorkflow({
			workflowId: "heartbeat",
			name: "test",
			inputs: {},
			createdAt: 1,
			status: "paused",
		});
		vi.advanceTimersByTime(STAGE_SESSION_HEARTBEAT_INTERVAL_MS);
		await started.promise;
		releasing = Promise.resolve(backend.releaseWorkflow("heartbeat"));
		await Promise.resolve();
		assert.equal(releases, 0, "release must not overtake a renewal of the same lease");
		finish.resolve();
		await releasing;
		assert.equal(releases, 1);
		await backend.setWorkflowStatus("heartbeat", "running");
		assert.equal(backend.getWorkflow("heartbeat")?.status, "running");
		assert.equal(await backend.workflowOwnership("heartbeat"), "local");
	} finally {
		finish.resolve();
		await releasing;
		await backend.close();
		await memory.close();
		vi.useRealTimers();
	}
});
