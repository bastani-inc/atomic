import assert from "node:assert/strict";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDependencyError } from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

// #3072 / #3074: durable registration settlement excludes independent startup drains.
test("registration settlement releases controls while an extended startup flush remains pending", async () => {
	const sdk = createMockSdk();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	class DelayedFlush extends DbosDurableBackend {
		override async flush(runId?: string): Promise<void> {
			await super.flush(runId);
			entered.resolve();
			await release.promise;
		}
	}
	const backend = new DelayedFlush(sdk);
	const runId = "registration-before-startup-drain";
	let admitted = false;
	const pending = backend
		.admitWorkflow(
			runId,
			{ workflowId: runId, name: runId, inputs: {}, createdAt: 1, status: "running" },
			new AbortController().signal,
		)
		.then(() => {
			admitted = true;
		});
	try {
		await entered.promise;
		let registered = false;
		const settled = backend.settleWorkflowAdmission(runId).then(() => {
			registered = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(registered, true, "registration must not wait for the extended startup drain");
		await settled;
		assert.equal(admitted, false, "author admission still waits for the startup drain");
		const fresh = new DbosDurableBackend(sdk);
		await fresh.hydrateWorkflow(runId);
		assert.equal(fresh.getWorkflow(runId)?.status, "running");
	} finally {
		release.resolve();
		await pending;
	}
	assert.equal(admitted, true);
});

// #3072: cancellation after registration still owns its durable cancellation record.
test("cancellation during an extended startup drain durably cancels before that drain releases", async () => {
	const sdk = createMockSdk();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	class DelayedFlush extends DbosDurableBackend {
		override async flush(runId?: string): Promise<void> {
			await super.flush(runId);
			entered.resolve();
			await release.promise;
		}
	}
	const backend = new DelayedFlush(sdk);
	const caller = new AbortController();
	const runId = "cancel-during-startup-drain";
	const definition = workflow({
		name: runId,
		description: "",
		inputs: {},
		outputs: {},
		run: async () => {
			assert.fail("cancelled admission must never execute author code");
		},
	});
	const pending = run(definition, {}, { runId, durableBackend: backend, store: createStore(), signal: caller.signal });
	try {
		await entered.promise;
		caller.abort(new Error("cancel startup"));
		assert.equal((await pending).status, "killed");
		const fresh = new DbosDurableBackend(sdk);
		await fresh.hydrateWorkflow(runId);
		assert.equal(fresh.getWorkflow(runId)?.status, "cancelled");
		assert.deepEqual(sdk.state.cancels, [runId]);
	} finally {
		release.resolve();
		await pending;
	}
});

// #3077: acknowledgement precedes actual SDK registration, not just an extended flush.
test.each(["quit", "pause", "quit-refused"] as const)(
	"%s acknowledges while SDK registration is held",
	async (action) => {
		const sdk = createMockSdk();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const backend = new DbosDurableBackend({
			...sdk,
			startWorkflow: async (...args) => {
				entered.resolve();
				await release.promise;
				await sdk.startWorkflow(...args);
			},
		});
		if (action === "quit-refused") backend.transitionWorkflowStatus = async () => false;
		setDurableBackend(backend);
		const store = createStore();
		const controls = createToolControlRegistry();
		const runId = `sdk-held-${action}`;
		let calls = 0;
		const definition = workflow({
			name: runId,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				calls++;
				await ctx.tool("effect", {}, async () => "ok");
				return {};
			},
		});
		const pending = run(definition, {}, { runId, store, durableBackend: backend, toolControlRegistry: controls });
		await entered.promise;
		let acknowledged = false;
		const control = (action !== "pause" ? quitRun : pauseRun)(runId, { store, toolControlRegistry: controls }).then(
			(result) => {
				acknowledged = true;
				assert.equal(result.ok, true);
			},
		);
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(acknowledged, true, "control must acknowledge before SDK registration is released");
			assert.equal(calls, 0);
			if (action === "pause") assert.ok(controls.runControl(runId), "pause retains the initialization owner");
		} finally {
			release.resolve();
			await control;
			if (action === "pause") await resumeRun(runId, { store, toolControlRegistry: controls });
			await pending;
			await backend.settleWorkflowAdmission(runId);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await backend.flush(runId);
			setDurableBackend(undefined);
		}
		assert.equal(calls, action === "pause" ? 1 : 0);
		assert.equal(backend.getWorkflow(runId)?.status, action === "pause" ? "completed" : "paused");
		if (action === "quit-refused") {
			assert.match(store.runs()[0]?.error ?? "", /refused the durable paused transition/);
			// Paused persistence errors use the existing public run.error; no new durable status model.
			assert.equal(backend.isAdmissionUnavailable(runId), false);
			assert.deepEqual(sdk.state.cancels, []);
		}
	},
);

// #3077: failed pause settlement retains both the initialization owner and prior progress.
test.each(["dependency", "rejection"] as const)(
	"checkpointed pause retains progress after admission %s (#3413)",
	async (failure) => {
		const sdk = createMockSdk();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		let recovered = false;
		let attempts = 0;
		let bodyCalls = 0;
		let effects = 0;
		const error = failure === "dependency" ? new DbosDependencyError() : new Error("permission denied for admission");
		const backend = new DbosDurableBackend({
			...sdk,
			resumeWorkflow: async (...args) => {
				attempts++;
				entered.resolve();
				await release.promise;
				if (!recovered) throw error;
				await sdk.resumeWorkflow(...args);
			},
		});
		const runId = `checkpointed-pause-${failure}`;
		backend.registerWorkflow({
			workflowId: runId,
			name: runId,
			inputs: {},
			createdAt: 1,
			status: "paused",
			resumable: true,
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "prior",
			name: "prior",
			replayKey: "prior",
			completedAt: 1,
			result: "ok",
		});
		await backend.flush(runId);
		setDurableBackend(backend);
		const priorSteps = [...sdk.state.steps.entries()];
		const priorCheckpoint = backend.listCheckpoints(runId)[0];
		const store = createStore();
		const controls = createToolControlRegistry();
		const definition = workflow({
			name: runId,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				assert.ok(recovered, "failed admission must not execute author code");
				assert.equal(controls.runControl(runId), owner, "retry retains the same executor");
				assert.equal(store.runs()[0]?.error, undefined);
				bodyCalls++;
				await ctx.tool("new-effect", {}, async () => ++effects);
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
				toolControlRegistry: controls,
				signal: controller.signal,
				continuation: {
					source: { id: runId, name: runId, inputs: {}, status: "paused", startedAt: 1, stages: [] },
				},
			},
		).catch((failure: unknown) => failure);
		await entered.promise;
		const owner = controls.runControl(runId);
		try {
			assert.equal((await pauseRun(runId, { store, toolControlRegistry: controls })).ok, true);
			release.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(store.runs()[0]?.status, "paused");
			assert.equal(store.runs()[0]?.resumable, true);
			assert.equal(store.runs()[0]?.error, error.message);
			assert.ok(controls.runControl(runId));
			assert.equal(backend.getWorkflow(runId)?.status, "paused");
			assert.equal(backend.getWorkflow(runId)?.resumable, true);
			assert.equal(backend.getWorkflow(runId)?.completedCheckpoints, 1);
			assert.equal(backend.isAdmissionUnavailable(runId), failure === "dependency");
			assert.deepEqual([...sdk.state.steps.entries()], priorSteps);
			const fresh = new DbosDurableBackend(sdk);
			await fresh.hydrateWorkflow(runId);
			assert.equal(fresh.getWorkflow(runId)?.resumable, true);
			assert.equal(fresh.getWorkflow(runId)?.completedCheckpoints, 1);
			assert.deepEqual(sdk.state.cancels, []);
			assert.equal(bodyCalls, 0);
			assert.equal(effects, 0);
			if (failure === "dependency") {
				// #3078: only an explicit resume retries this checkpointed identity.
				recovered = true;
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(attempts, 1);
				assert.equal(controls.runControl(runId), owner);
				const results = await Promise.all([
					resumeRun(runId, { store, toolControlRegistry: controls }),
					resumeRun(runId, { store, toolControlRegistry: controls }),
				]);
				assert.ok(results.every((result) => result.ok));
				await pending;
				assert.equal(store.runs()[0]?.status, "completed");
				assert.equal(store.runs()[0]?.dependencyError, undefined);
				assert.equal(attempts, 2);
				assert.equal(bodyCalls, 1);
				assert.equal(effects, 1);
				assert.deepEqual([...sdk.state.workflows.keys()], [runId]);
				assert.equal(backend.isAdmissionUnavailable(runId), false);
				assert.ok(backend.getWorkflow(runId)!.completedCheckpoints >= 2);
				const restored = new DbosDurableBackend(sdk);
				await restored.hydrateWorkflow(runId);
				assert.equal(restored.getWorkflow(runId)?.status, "completed");
				assert.ok(restored.getWorkflow(runId)!.completedCheckpoints >= 2);
				assert.deepEqual(
					restored.listCheckpoints(runId).find((checkpoint) => checkpoint.checkpointId === "prior"),
					priorCheckpoint,
					"same-ID recovery preserves the earlier checkpoint unchanged",
				);
				assert.deepEqual(sdk.state.cancels, []);
			} else {
				await assert.rejects(resumeRun(runId, { store, toolControlRegistry: controls }), (failure) => {
					assert.ok(failure instanceof Error);
					assert.notEqual(failure, error);
					assert.equal(failure.message, error.message);
					assert.equal(failure.cause, undefined);
					assert.equal(failure.stack?.includes(error.stack ?? ""), false);
					assert.equal(failure instanceof DbosDependencyError, false);
					return true;
				});
				await pending;
			}
		} finally {
			release.resolve();
			controller.abort();
			await pending;
			setDurableBackend(undefined);
		}
		assert.equal(controls.runControl(runId), undefined);
		assert.equal(controls.admissionBoundary(runId), undefined);
	},
);
