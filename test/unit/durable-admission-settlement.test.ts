import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	DBOS_ADMISSION_TIMEOUT_MS,
	DbosDependencyError,
	dbosAdmissionContext,
} from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import {
	launchDbosOnce,
	resetDbosLifecycleForTests,
	shutdownDbos,
} from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { killRun, pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

afterEach(() => {
	vi.useRealTimers();
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

// #3072 / #3074: every admission exit shares the same settlement contract.
const exits = [
	"success",
	"deadline",
	"dependency",
	"rejection",
	"cancel-before",
	"cancel-after",
	"quit-before",
	"quit-after",
	"quit-before-then-kill",
	"continuation-cancel-before",
	"pause-then-deadline",
	"pause-then-dependency",
	"pause-then-rejection",
	"pause",
	"continuation",
	"continuation-dependency",
	"continuation-rejection",
	"continuation-quit-before",
	"continuation-quit-before-dependency",
	"continuation-quit-before-rejection",
	"continuation-quit-before-deadline",
	"shutdown",
] as const;

test.each(exits)("admission exit matrix: %s (#3413)", async (exit) => {
	vi.useFakeTimers();
	const sdk = createMockSdk();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const caller = new AbortController();
	const store = createStore();
	const controls = createToolControlRegistry();
	const cancellation = createCancellationRegistry();
	const runId = `matrix-${exit}`;
	const rejection = new Error("permission denied for admission");
	const continuation = exit.startsWith("continuation");
	const quit = exit.includes("quit");
	const paused = exit.startsWith("pause");
	const deadline = exit.endsWith("deadline");
	const unavailable = deadline || exit.endsWith("dependency");
	const rejected = exit.endsWith("rejection");
	const recovered = paused && unavailable;
	let admissionAttempts = 0;
	let bodyCalls = 0;
	let armed = false;
	let control: Promise<unknown> | undefined;
	let admissionSignal: AbortSignal | undefined;
	const gate = async () => {
		if (!armed) return;
		admissionSignal ??= dbosAdmissionContext.getStore();
		entered.resolve();
		await release.promise;
		if (unavailable && !deadline) throw new DbosDependencyError();
		if (rejected) throw rejection;
	};
	const backend = new DbosDurableBackend({
		...sdk,
		startWorkflow: async (...args) => {
			admissionAttempts++;
			await gate();
			await sdk.startWorkflow(...args);
		},
		resumeWorkflow: async (...args) => {
			await gate();
			await sdk.resumeWorkflow(...args);
		},
		recordStepOutput: async (...args) => {
			await sdk.recordStepOutput(...args);
			if (!armed || control !== undefined) return;
			if (exit === "cancel-after") {
				caller.abort(new Error("user cancelled"));
				control = Promise.resolve();
			}
			if (exit === "quit-after") control = quitRun(runId, { store, toolControlRegistry: controls });
		},
	});
	setDurableBackend(backend);
	if (continuation) {
		backend.registerWorkflow({
			workflowId: runId,
			name: runId,
			inputs: {},
			status: "paused",
			createdAt: 1,
			resumable: true,
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "prior-stage",
			name: "prior-stage",
			replayKey: "prior-stage",
			completedAt: 1,
			result: "ok",
		});
		await backend.flush(runId);
		assert.equal(backend.getWorkflow(runId)?.completedCheckpoints, 1);
	}
	const priorSteps = [...sdk.state.steps.entries()];
	const shutdown = vi.fn(async () => {});
	if (exit === "shutdown") {
		resetDbosLifecycleForTests(
			async () => ({ backend, launch: async () => {}, shutdown }),
			async () => {},
			async () => {},
		);
		await launchDbosOnce();
	}
	armed = true;
	const author = vi.fn(async () => ({}));
	const definition = workflow({
		name: runId,
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			if (recovered) assert.equal(controls.runControl(runId), owner, "retry retains the same executor");
			bodyCalls++;
			await ctx.tool("effect", {}, author);
			return {};
		},
	});
	const pending = run(
		definition,
		{},
		{
			runId,
			store,
			durableBackend: backend,
			signal: caller.signal,
			toolControlRegistry: controls,
			cancellation,
			...(continuation
				? {
						continuation: {
							source: {
								id: runId,
								name: runId,
								inputs: {},
								status: "paused" as const,
								startedAt: 1,
								stages: [],
							},
						},
					}
				: {}),
		},
	);
	const outcome = pending.then(
		(result) => result,
		(error: unknown) => error,
	);
	await entered.promise;
	const owner = controls.runControl(runId);
	if (exit === "cancel-before" || exit === "continuation-cancel-before") caller.abort(new Error("user cancelled"));
	if (exit === "quit-before" || exit === "quit-before-then-kill" || (continuation && quit)) {
		control = quitRun(runId, { store, toolControlRegistry: controls }).catch((error: unknown) => error);
	}
	if (paused) {
		control = pauseRun(runId, { store, toolControlRegistry: controls }).catch((error: unknown) => error);
	}
	if (control !== undefined && (paused || quit)) {
		await vi.advanceTimersByTimeAsync(0);
		const acknowledgement = await control;
		assert.ok(acknowledgement && typeof acknowledgement === "object" && "ok" in acknowledgement);
		assert.equal(acknowledgement.ok, true, "control acknowledges before admission settles");
		assert.equal(author.mock.calls.length, 0);
	}
	if (exit === "quit-before-then-kill") {
		await vi.advanceTimersByTimeAsync(0);
		assert.equal((await killRun(runId, { store, cancellation })).ok, true);
	}
	if (exit === "shutdown") control = shutdownDbos();
	if (deadline) await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
	else if (!exit.endsWith("cancel-before")) release.resolve();
	await vi.advanceTimersByTimeAsync(0);
	if (paused && (unavailable || rejected)) {
		assert.match(store.runs()[0]?.error ?? "", rejected ? /permission denied/ : /database|timed out/);
		assert.equal(store.runs()[0]?.status, "paused");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		assert.ok(controls.runControl(runId), "failed pause retains its initialization owner until resume");
		if (rejected) {
			await assert.rejects(resumeRun(runId, { store, toolControlRegistry: controls }), (error: Error) => {
				assert.notEqual(error, rejection);
				assert.equal(error.message, rejection.message);
				assert.equal(error.cause, undefined);
				assert.equal(error.stack?.includes(rejection.stack ?? ""), false);
				return true;
			});
		} else {
			// #3078: explicit concurrent resumes retry the retained owner, not a replacement executor.
			assert.equal(controls.runControl(runId), owner);
			assert.equal(backend.isAdmissionUnavailable(runId), true);
			assert.equal(bodyCalls, 0);
			armed = false;
			release.resolve();
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(admissionAttempts, 1, "recovery alone must not retry a paused owner");
			const results = await Promise.all([
				resumeRun(runId, { store, toolControlRegistry: controls }),
				resumeRun(runId, { store, toolControlRegistry: controls }),
			]);
			assert.ok(results.every((result) => result.ok));
		}
	}
	if (exit === "pause") {
		await control;
		assert.equal(store.runs()[0]?.status, "paused");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		assert.equal(author.mock.calls.length, 0);
		assert.equal((await resumeRun(runId, { store, toolControlRegistry: controls })).ok, true);
	}
	const controlResult = await control;
	const result = await outcome;
	if (rejected && !quit) {
		assert.ok(result instanceof Error);
		assert.notEqual(result, rejection);
		assert.equal(result.message, rejection.message);
		assert.equal(result.cause, undefined);
		assert.equal(result.stack?.includes(rejection.stack ?? ""), false);
		assert.equal(result instanceof DbosDependencyError, false, "an admission rejection remains a hard failure");
	}
	if (quit && (unavailable || rejected)) {
		assert.ok(controlResult && typeof controlResult === "object" && "ok" in controlResult);
		assert.equal(controlResult.ok, true);
		const error = store.runs()[0]?.error ?? "";
		assert.match(error, /durable paused transition failed/);
		assert.match(error, rejected ? /permission denied/ : /database|timed out/);
		assert.doesNotMatch(error, /not resumable/);
		assert.deepEqual([...sdk.state.steps.entries()], priorSteps, "failed re-admission preserves prior metadata");
		assert.equal((await quitRun(runId, { store, toolControlRegistry: controls })).ok, true);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(store.runs()[0]?.error, error, "repeated quit retains the original admission diagnostic");
	} else if (quit) {
		assert.ok(controlResult && typeof controlResult === "object" && "ok" in controlResult);
		assert.equal(controlResult.ok, true);
	}
	const cancelled = exit.includes("cancel");
	const status = cancelled
		? "cancelled"
		: quit
			? "paused"
			: recovered
				? "completed"
				: unavailable || rejected
					? "failed"
					: "completed";
	assert.equal(backend.getWorkflow(runId)?.status, status);
	assert.equal(store.runs()[0]?.status, cancelled || exit === "quit-before-then-kill" ? "killed" : status);
	assert.equal(backend.isAdmissionUnavailable(runId), unavailable && !recovered);
	assert.equal(author.mock.calls.length, status === "completed" ? 1 : 0);
	if (recovered) {
		assert.equal(bodyCalls, 1);
		assert.equal(admissionAttempts, 2, "concurrent resumes share a single readmission");
		assert.deepEqual([...sdk.state.workflows.keys()], [runId]);
		assert.equal(store.runs()[0]?.error, undefined);
		assert.equal(store.runs()[0]?.dependencyError, undefined);
	}
	assert.deepEqual(sdk.state.cancels, exit === "cancel-after" || exit === "continuation-cancel-before" ? [runId] : []);
	if (quit) {
		assert.equal(backend.getWorkflow(runId)?.resumable, continuation);
		assert.equal(store.runs()[0]?.resumable, continuation);
		assert.equal(
			backend.listResumableWorkflows().some((entry) => entry.workflowId === runId),
			continuation,
		);
		if (continuation) {
			const fresh = new DbosDurableBackend(sdk);
			await fresh.hydrateWorkflow(runId);
			assert.equal(fresh.getWorkflow(runId)?.completedCheckpoints, unavailable || rejected ? 1 : 2);
			assert.equal(fresh.getWorkflow(runId)?.resumable, true);
			assert.equal(
				fresh.listResumableWorkflows().some((entry) => entry.workflowId === runId),
				true,
			);
		}
	} else if (cancelled || rejected) assert.equal(backend.getWorkflow(runId)?.resumable, false);
	if (exit === "continuation-cancel-before") {
		assert.equal(backend.getWorkflow(runId)?.completedCheckpoints, 1);
	}
	if (unavailable && !quit && !recovered)
		assert.equal(
			backend.getWorkflow(runId)?.resumable,
			true,
			"local same-ID retry, not evidence of persisted admission",
		);
	assert.equal(controls.runControl(runId), undefined);
	assert.equal(controls.admissionBoundary(runId), undefined);
	const persisted = [...sdk.state.steps.entries()];
	release.resolve();
	await vi.advanceTimersByTimeAsync(0);
	assert.deepEqual([...sdk.state.steps.entries()], persisted, "abandoned admission cannot publish late metadata");
	if (exit === "shutdown") {
		await shutdownDbos();
		assert.equal(shutdown.mock.calls.length, 1);
	}
	if (recovered || (!unavailable && !rejected && exit !== "cancel-before")) {
		const fresh = new DbosDurableBackend(sdk);
		await fresh.hydrateWorkflow(runId);
		assert.equal(fresh.getWorkflow(runId)?.status, status, "authoritative metadata agrees with local settlement");
	}
	assert.equal(vi.getTimerCount(), 0);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	assert.ok(admissionSignal);
	assert.equal(getEventListeners(admissionSignal, "abort").length, 0);
	assert.equal(dbosAdmissionContext.getStore(), undefined);
});

// #3077: a rejected pause must not poison every later resume of its retained owner.
test("resume retries durable persistence after an admitted owner's pause fails", async () => {
	const sdk = createMockSdk();
	const persistenceFailure = new Error("control persistence unavailable");
	let failPersistence = false;
	const backend = new DbosDurableBackend({
		...sdk,
		recordStepOutput: async (...args) => {
			if (failPersistence) throw persistenceFailure;
			await sdk.recordStepOutput(...args);
		},
	});
	setDurableBackend(backend);
	const store = createStore();
	const controls = createToolControlRegistry();
	const entered = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	const author = vi.fn(async () => ({}));
	const runId = "failed-pause-retry";
	const pending = run(
		workflow({
			name: runId,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				entered.resolve();
				await proceed.promise;
				await ctx.tool("effect", {}, author);
				return {};
			},
		}),
		{},
		{ runId, store, durableBackend: backend, toolControlRegistry: controls },
	);
	await entered.promise;
	const owner = controls.runControl(runId);
	assert.ok(owner);
	failPersistence = true;
	await assert.rejects(pauseRun(runId, { store, toolControlRegistry: controls }), /control persistence unavailable/);
	proceed.resolve();
	await assert.rejects(resumeRun(runId, { store, toolControlRegistry: controls }), /control persistence unavailable/);
	assert.equal(owner.paused, true);
	assert.equal(controls.runControl(runId), owner);
	assert.equal(author.mock.calls.length, 0, "failed persistence cannot release author execution");
	failPersistence = false;
	assert.equal((await resumeRun(runId, { store, toolControlRegistry: controls })).ok, true);
	await pending;
	assert.equal(author.mock.calls.length, 1);
	assert.equal(store.runs()[0]?.status, "completed");
	assert.equal(controls.runControl(runId), undefined);
});
