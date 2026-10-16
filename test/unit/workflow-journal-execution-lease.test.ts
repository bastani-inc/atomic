import assert from "node:assert/strict";
import { join } from "node:path";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	JournalDurableBackend,
	JournalExecutionRetiredError,
} from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { run as engineRun } from "../../packages/workflows/src/engine/run.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { readJournalEntries } from "../helpers/journal-internals.js";
import { assertLeaseStateUnchanged } from "../helpers/journal-lease-state.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

test("rejected same-id SDK inputs preserve the active execution lease (#3647)", async () => {
	const directory = makeTempDirectory("execution-lease-");
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
	const contender = await openSqlRunJournal(path);
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const definition = workflow({
		name: "same-id-lease",
		description: "",
		inputs: { value: Type.String() },
		outputs: {},
		async run(ctx) {
			await ctx.tool("effect", {}, async () => {
				started.resolve();
				await release.promise;
				return "saved";
			});
			return {};
		},
	});
	const running = run(
		definition,
		{ value: "valid" },
		{ runId: "active", store: createStore(), durableBackend: backend },
	);
	try {
		await started.promise;
		await assert.rejects(
			run(definition, {}, { runId: "active", store: createStore(), durableBackend: backend }),
			/value/,
		);
		assert.equal((await contender.acquire("active", "contender")).status, "held");
		release.resolve();
		assert.equal((await running).status, "completed");
	} finally {
		release.resolve();
		await running.catch((error: Error) => {
			assert.ok(error instanceof Error);
		});
		await contender.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});

class DeferredPauseBackend extends JournalDurableBackend {
	readonly pauseWritten = Promise.withResolvers<void>();
	readonly finishPause = Promise.withResolvers<void>();
	override async transitionWorkflowStatus(...args: Parameters<JournalDurableBackend["transitionWorkflowStatus"]>) {
		const result = await super.transitionWorkflowStatus(...args);
		if (args[2] === "paused") {
			this.pauseWritten.resolve();
			await this.finishPause.promise;
		}
		return result;
	}
}

test("detached quit releases only its own lease after final persistence and permits resume (#3647)", async () => {
	const runId = testRunId("detached-quit-lease");
	const directory = makeTempDirectory("detached-quit-lease-");
	const path = join(directory, "journal.sqlite");
	const backend = new DeferredPauseBackend(await openSqlRunJournal(path));
	const contender = await openSqlRunJournal(path);
	const controls = createToolControlRegistry();
	const jobs = createJobTracker();
	const store = createStore();
	const started = Promise.withResolvers<void>();
	const releaseBody = Promise.withResolvers<void>();
	const unrelatedStarted = Promise.withResolvers<void>();
	const releaseUnrelated = Promise.withResolvers<void>();
	let savedEffects = 0;
	let resumedEffects = 0;
	const definition = workflow({
		name: "detached-quit-lease",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("saved", {}, async () => {
				savedEffects++;
				return "saved";
			});
			started.resolve();
			await releaseBody.promise;
			await ctx.tool("resumed", {}, async () => {
				resumedEffects++;
				return "resumed";
			});
			return {};
		},
	});
	const unrelatedDefinition = workflow({
		name: "unrelated-active",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("active", {}, async () => {
				unrelatedStarted.resolve();
				await releaseUnrelated.promise;
				return "done";
			});
			return {};
		},
	});
	setDurableBackend(backend);
	runDetached(
		definition,
		{},
		{ runId, origin: "user", store, durableBackend: backend, toolControlRegistry: controls, jobs },
	);
	const quittingJob = jobs.get(runId)!;
	const unrelated = engineRun(unrelatedDefinition, {}, { runId: "unrelated", store, durableBackend: backend });
	let quitting: ReturnType<typeof quitRun> | undefined;
	try {
		await Promise.all([started.promise, unrelatedStarted.promise]);
		quitting = quitRun(runId, { store, toolControlRegistry: controls, jobs });
		await backend.pauseWritten.promise;
		assert.equal(
			(await contender.acquire(runId, "contender")).status,
			"held",
			"final persistence still owns its lease",
		);
		assert.equal((await contender.acquire("unrelated", "contender")).status, "held");
		backend.finishPause.resolve();
		assert.equal((await quitting).ok, true);
		await quittingJob.promise;
		const acquired = await contender.acquire(runId, "contender");
		assert.equal(acquired.status, "acquired", "settled detached quit releases its lease");
		if (acquired.status === "acquired") await contender.release(acquired.lease);
		assert.equal((await contender.acquire("unrelated", "contender")).status, "held");
		const source = store.runs().find((candidate) => candidate.id === runId);
		assert.ok(source);
		assert.equal(source.status, "paused");
		assert.equal(source.resumable, true);
		releaseBody.resolve();
		const successor = await JournalDurableBackend.open(await openSqlRunJournal(path));
		try {
			const resumedStore = createStore();
			let completion: Promise<void> | undefined;
			const resumed = await resumeDurableWorkflow(runId, {
				registry: createRegistry().register(definition),
				baseRunOpts: { store: resumedStore },
				durableBackend: successor,
				jobs,
				onRunAccepted: (id) => {
					completion = jobs.get(id)?.promise;
				},
			});
			assert.equal(resumed.ok, true);
			assert.ok(completion);
			await completion;
			assert.equal(resumedStore.runs().find((candidate) => candidate.id === runId)?.status, "completed");
			assert.equal(savedEffects, 1);
			assert.equal(resumedEffects, 1);
			assert.equal(await successor.workflowOwnership(runId), "available");
			assert.equal((await contender.acquire("unrelated", "contender")).status, "held");
		} finally {
			await successor.close();
		}
	} finally {
		backend.finishPause.resolve();
		releaseBody.resolve();
		releaseUnrelated.resolve();
		await quitting;
		await quittingJob.promise;
		await unrelated;
		setDurableBackend(undefined);
		await contender.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("quit retires a cancelled tool's executor without waiting for caught-cancellation cleanup (#3647)", async () => {
	const runId = testRunId("quit-pending-cleanup");
	const directory = makeTempDirectory("quit-pending-cleanup-");
	const backend = new DeferredPauseBackend(await openSqlRunJournal(join(directory, "journal.sqlite")));
	const store = createStore();
	const controls = createToolControlRegistry();
	const jobs = createJobTracker();
	const started = Promise.withResolvers<void>();
	const caught = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	const resumedStarted = Promise.withResolvers<void>();
	const resumeBody = Promise.withResolvers<void>();
	const lateWrites = Promise.withResolvers<void>();
	const attemptWhileReleased = Promise.withResolvers<void>();
	const releasedWrites = Promise.withResolvers<void>();
	const finishRetiredJob = Promise.withResolvers<void>();
	let executions = 0;
	let savedEffects = 0;
	let completion: Promise<void> | undefined;
	let bodySettled = false;
	const verifyLateWrites = async (): Promise<void> => {
		await assert.rejects(
			async () => await backend.setWorkflowStatus(runId, "completed"),
			JournalExecutionRetiredError,
		);
		await assert.rejects(async () => await backend.releaseWorkflow(runId), JournalExecutionRetiredError);
		await assert.rejects(
			backend.withWorkflowLease(runId, async () => backend.setWorkflowStatus(runId, "completed")),
			JournalExecutionRetiredError,
		);
	};
	const definition = workflow({
		name: "quit-pending-cleanup",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const first = ++executions === 1;
			await ctx.tool("saved", {}, async () => {
				savedEffects++;
				return "saved";
			});
			try {
				await ctx.tool("cancelled", {}, async ({ signal }) => {
					if (!first) {
						resumedStarted.resolve();
						await resumeBody.promise;
						return "resumed";
					}
					started.resolve();
					return await new Promise<never>((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() => reject(signal.reason instanceof Error ? signal.reason : new Error("tool aborted")),
							{ once: true },
						);
					});
				});
			} catch (error) {
				assert.ok(error instanceof Error);
				caught.resolve();
				await attemptWhileReleased.promise;
				await verifyLateWrites().then(releasedWrites.resolve, releasedWrites.reject);
				await cleanup.promise;
				await verifyLateWrites().then(lateWrites.resolve, lateWrites.reject);
			}
			if (first) bodySettled = true;
			return {};
		},
	});
	setDurableBackend(backend);
	runDetached(
		definition,
		{},
		{
			runId,
			origin: "user",
			store,
			durableBackend: backend,
			toolControlRegistry: controls,
			jobs,
			onRawSettled: () => finishRetiredJob.promise,
		},
	);
	const job = jobs.get(runId)!;
	let quitting: ReturnType<typeof quitRun> | undefined;
	try {
		await started.promise;
		quitting = quitRun(runId, { store, toolControlRegistry: controls, jobs });
		await Promise.all([caught.promise, backend.pauseWritten.promise]);
		assert.equal(controls.active(runId).length, 0);
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		backend.finishPause.resolve();
		// Drain the current turn without releasing author cleanup or using a timeout.
		const observed = Promise.withResolvers<"pending">();
		setImmediate(() => observed.resolve("pending"));
		assert.equal(await Promise.race([quitting.then(() => "quit" as const), observed.promise]), "quit");
		assert.equal(bodySettled, false);
		assert.equal((await quitting).ok, true);
		assert.equal(controls.runControl(runId), undefined);
		assert.equal(jobs.get(runId), undefined);
		assert.equal(await backend.workflowOwnership(runId), "available");
		const pausedEntries = await readJournalEntries(backend.journal, runId);
		attemptWhileReleased.resolve();
		await releasedWrites.promise;
		assert.deepEqual(await readJournalEntries(backend.journal, runId), pausedEntries);
		assert.equal(await backend.workflowOwnership(runId), "available", "retired writes cannot reacquire a free lease");
		const resumed = await resumeDurableWorkflow(runId, {
			registry: createRegistry().register(definition),
			baseRunOpts: { store, toolControlRegistry: controls },
			durableBackend: backend,
			jobs,
			onRunAccepted: (id) => {
				completion = jobs.get(id)?.promise;
			},
		});
		assert.equal(resumed.ok, true);
		assert.ok(completion);
		await resumedStarted.promise;
		assert.equal(executions, 2);
		assert.equal(savedEffects, 1, "resume replays the persisted checkpoint");
		assert.equal(bodySettled, false);
		const entries = await readJournalEntries(backend.journal, runId);
		const lease = await backend.journal.leaseState(runId);
		cleanup.resolve();
		await lateWrites.promise;
		finishRetiredJob.resolve();
		await job.promise;
		assert.equal(bodySettled, true);
		assert.deepEqual(await readJournalEntries(backend.journal, runId), entries);
		assertLeaseStateUnchanged(
			await backend.journal.leaseState(runId),
			lease,
			"late settlement cannot release the resumed lease",
		);
		resumeBody.resolve();
		await completion;
		assert.equal(backend.getWorkflow(runId)?.status, "completed");
		assert.equal(await backend.workflowOwnership(runId), "available");
	} finally {
		attemptWhileReleased.resolve();
		backend.finishPause.resolve();
		cleanup.resolve();
		resumeBody.resolve();
		finishRetiredJob.resolve();
		await quitting;
		await job.promise;
		await completion;
		setDurableBackend(undefined);
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("completed detached runs release their lease for deletion without unlocking active runs (#3647)", async () => {
	const directory = makeTempDirectory("detached-completed-lease-");
	const path = join(directory, "journal.sqlite");
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
	const successor = await JournalDurableBackend.open(await openSqlRunJournal(path));
	const contender = await openSqlRunJournal(path);
	const jobs = createJobTracker();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const observerStarted = Promise.withResolvers<void>();
	const finishObserver = Promise.withResolvers<void>();
	const definition = workflow({
		name: "detached-completed-lease",
		description: "",
		inputs: { hold: Type.Boolean() },
		outputs: {},
		async run(ctx) {
			await ctx.tool("effect", {}, async () => {
				if (ctx.inputs.hold) {
					started.resolve();
					await release.promise;
				}
				return "saved";
			});
			return {};
		},
	});
	runDetached(
		definition,
		{ hold: true },
		{ runId: "active", origin: "user", store: createStore(), durableBackend: backend, jobs },
	);
	const active = jobs.get("active")!;
	try {
		await started.promise;
		let completed: RunResult | undefined;
		let completionError: Error | undefined;
		runDetached(
			definition,
			{ hold: false },
			{
				runId: "completed",
				origin: "user",
				store: createStore(),
				durableBackend: backend,
				jobs,
				onRawSettled: async (_ok, result, error) => {
					completed = result;
					if (error instanceof Error) completionError = error;
					observerStarted.resolve();
					await finishObserver.promise;
					await backend.setWorkflowStatus("completed", "completed");
				},
			},
		);
		const completedJob = jobs.get("completed")!;
		await observerStarted.promise;
		assert.equal((await contender.acquire("completed", "contender")).status, "held", "final writes retain ownership");
		finishObserver.resolve();
		await completedJob.promise;
		assert.ifError(completionError);
		assert.equal(completed?.status, "completed");
		assert.equal((await contender.acquire("active", "contender")).status, "held");
		await successor.hydrateWorkflow("completed");
		assert.equal(successor.getWorkflow("completed")?.status, "completed");
		assert.deepEqual(await successor.deleteWorkflowIfInactive("completed"), { ok: true });
		assert.equal(
			(await contender.listRuns()).some((run) => run.runId === "completed"),
			false,
		);
		assert.equal((await contender.acquire("active", "contender")).status, "held");
	} finally {
		finishObserver.resolve();
		release.resolve();
		await active.promise;
		await successor.close();
		await contender.close();
		await backend.close();
		removeTempDirectory(directory);
	}
});
