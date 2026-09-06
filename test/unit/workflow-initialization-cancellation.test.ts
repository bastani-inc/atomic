import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { DurableWorkflowStatus } from "../../packages/workflows/src/durable/types.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import type { WorkflowToolArgs } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import { interruptRun, pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { renderWidgetLines } from "../../packages/workflows/src/tui/widget.js";

afterEach(() => setDurableBackend(undefined));

for (const outcome of ["resolve", "reject"] as const) {
	test(`caller abort during startup cancels the allocated root before late ${outcome}`, async () => {
		const entered = Promise.withResolvers<void>();
		const admission = Promise.withResolvers<void>();
		class DelayedAdmissionBackend extends InMemoryDurableBackend {
			override async flush(): Promise<void> {
				entered.resolve();
				await admission.promise;
			}
		}
		const backend = new DelayedAdmissionBackend();
		setDurableBackend(backend);
		const store = createStore();
		const cancellation = createCancellationRegistry();
		const jobs = createJobTracker();
		let bodyCalls = 0;
		const definition = workflow({
			name: "cancel-initialization",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				bodyCalls += 1;
				await ctx.tool("must-not-start", {}, async () => "done");
				return {};
			},
		});
		const runtime = createExtensionRuntime({ definitions: [definition], store, cancellation, jobs });
		const execute = makeExecuteWorkflowTool(runtime, () => undefined);
		const caller = new AbortController();
		const reason = new Error("user interrupted startup");
		let acceptedId: string | undefined;
		const pending = execute({ action: "run", workflow: definition.name }, {}, caller.signal, (id) => {
			acceptedId = id;
		});
		const rejected = assert.rejects(pending, (error) => error === reason);
		await entered.promise;
		assert.ok(acceptedId);
		const job = jobs.get(acceptedId);
		assert.ok(job);
		try {
			assert.equal(store.runs()[0]?.status, "running");
			assert.deepEqual(store.runs()[0]?.stages, []);
			assert.deepEqual(store.runs()[0]?.toolNodes, []);
			caller.abort(reason);
			await rejected;
			assert.equal(
				cancellation.isAborted(acceptedId),
				true,
				"request cancellation must reach the initialization owner",
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(
				store.runs()[0]?.status,
				"killed",
				"a stalled admission write must not pin the local root as running",
			);
		} finally {
			if (outcome === "resolve") admission.resolve();
			else admission.reject(new Error("late admission failure"));
			await job.promise;
		}
		assert.equal(bodyCalls, 0, "late non-cancellable startup completion must not launch workflow code");
		assert.equal(store.runs()[0]?.status, "killed");
		assert.equal(backend.getWorkflow(acceptedId)?.status, "cancelled");
		assert.equal(jobs.get(acceptedId), undefined);
	});
}

test("quit controls a node-less workflow await without inventing graph nodes or admitting late work", async () => {
	const entered = Promise.withResolvers<void>();
	const body = Promise.withResolvers<void>();
	const late = Promise.withResolvers<void>();
	const store = createStore();
	const jobs = createJobTracker();
	const toolControls = createToolControlRegistry();
	setDurableBackend(new InMemoryDurableBackend());
	let toolCalls = 0;
	const definition = workflow({
		name: "quit-empty-root",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			entered.resolve();
			await body.promise;
			try {
				await assert.rejects(
					ctx.tool("late-tool", {}, async () => {
						toolCalls += 1;
						return "late";
					}),
				);
				assert.throws(() => ctx.stage("late-stage"));
			} finally {
				late.resolve();
			}
			return {};
		},
	});
	const accepted = runDetached(definition, {}, { store, jobs, toolControlRegistry: toolControls });
	const job = jobs.get(accepted.runId)!;
	await entered.promise;
	try {
		const result = await quitRun(accepted.runId, { store, jobs, toolControlRegistry: toolControls });
		assert.equal(
			store.runs()[0]?.resumable,
			false,
			"zero-progress roots must not advertise a nonexistent resume checkpoint",
		);
		assert.equal(result.ok, true, "a live root awaiting ordinary initialization work is controllable");
		assert.equal(store.runs()[0]?.status, "paused");
		assert.equal(store.runs()[0]?.exitReason, "quit");
		assert.equal(store.runs()[0]?.endedAt, undefined);
		assert.match(result.ok ? (result.message ?? "") : "", /untracked.*may still finish/i);
		assert.match(result.ok ? (result.message ?? "") : "", /cannot be resumed/);
	} finally {
		body.resolve();
		await job.promise;
		await late.promise;
	}
	assert.equal(toolCalls, 0);
	assert.deepEqual(store.runs()[0]?.stages, []);
	assert.deepEqual(store.runs()[0]?.toolNodes, []);
	assert.doesNotMatch(renderStatusList(store.runs()), /resumable via/);
	assert.doesNotMatch(
		renderWidgetLines({ runs: [...store.runs()], notices: [], version: 1 }).join("\n"),
		/resumable via/,
	);
	assert.equal(store.runs()[0]?.status, "paused");
});

for (const control of [quitRun, interruptRun, pauseRun]) {
	test(`${control.name} settles an initializing root before admission resolves`, async () => {
		const entered = Promise.withResolvers<void>();
		const admission = Promise.withResolvers<void>();
		class DelayedFirstFlush extends InMemoryDurableBackend {
			calls = 0;
			override async flush(): Promise<void> {
				if (++this.calls === 1) {
					entered.resolve();
					await admission.promise;
				}
			}
		}
		setDurableBackend(new DelayedFirstFlush());
		const store = createStore();
		const jobs = createJobTracker();
		const toolControls = createToolControlRegistry();
		let calls = 0;
		const definition = workflow({
			name: "control-initialization",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				calls += 1;
				await ctx.tool("after-initialization", {}, async () => "done");
				return {};
			},
		});
		const accepted = runDetached(definition, {}, { store, jobs, toolControlRegistry: toolControls });
		const job = jobs.get(accepted.runId)!;
		await entered.promise;
		try {
			const result = await control(accepted.runId, { store, toolControlRegistry: toolControls });
			assert.equal(result.ok, true);
			assert.equal(store.runs()[0]?.status, "paused");
			// PR #2885: pause/interrupt must retain the live initialization owner, not quit it.
			if (control !== quitRun) {
				assert.equal(store.runs()[0]?.exitReason, undefined);
				assert.notEqual(store.runs()[0]?.resumable, false);
				admission.resolve();
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(calls, 0);
				assert.equal(jobs.get(accepted.runId), job);
				assert.deepEqual(store.runs()[0]?.stages, []);
				assert.deepEqual(store.runs()[0]?.toolNodes, []);
				await resumeRun(accepted.runId, { store, toolControlRegistry: toolControls });
				await job.promise;
				assert.equal(store.runs()[0]?.status, "completed");
			}
		} finally {
			admission.resolve();
			job.controller.abort();
			await job.promise;
		}
		assert.equal(calls, control === quitRun ? 0 : 1);
	});
}

test("a run-start observer failure cannot leave an ownerless running root", async () => {
	setDurableBackend(new InMemoryDurableBackend());
	const store = createStore();
	const jobs = createJobTracker();
	const toolControls = createToolControlRegistry();
	const definition = workflow({
		name: "start-observer-failure",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => ({}),
	});
	const accepted = runDetached(
		definition,
		{},
		{
			store,
			jobs,
			toolControlRegistry: toolControls,
			onRunStart: () => {
				throw new Error("start observer failed");
			},
		},
	);
	await jobs.get(accepted.runId)?.promise;
	assert.equal(store.runs()[0]?.status, "failed");
	assert.match(store.runs()[0]?.error ?? "", /start observer failed/);
	assert.equal(toolControls.runControl(accepted.runId), undefined);
	assert.equal(jobs.get(accepted.runId), undefined);
});

test("pre-aborted public reads and mutations never start resource or runtime work", async () => {
	let calls = 0;
	const runtime = createExtensionRuntime();
	const execute = makeExecuteWorkflowTool(
		() => {
			calls += 1;
			return runtime;
		},
		() => {
			calls += 1;
		},
		() => {
			calls += 1;
		},
	);
	const caller = new AbortController();
	const reason = new Error("already cancelled");
	caller.abort(reason);
	const actions: NonNullable<WorkflowToolArgs["action"]>[] = [
		"models",
		"list",
		"get",
		"inputs",
		"status",
		"stages",
		"stage",
		"transcript",
		"run",
		"reload",
		"pause",
		"quit",
		"interrupt",
		"answer",
		"resume",
	];
	for (const action of actions)
		await assert.rejects(execute({ action }, {}, caller.signal), (error) => error === reason);
	assert.equal(calls, 0);
});

test("failed-run resume abort cancels startup and leaves the source available", async () => {
	const entered = Promise.withResolvers<void>();
	const admission = Promise.withResolvers<void>();
	class DelayedFirstFlush extends InMemoryDurableBackend {
		calls = 0;
		override async flush(): Promise<void> {
			if (++this.calls === 1) {
				entered.resolve();
				await admission.promise;
			}
		}
	}
	setDurableBackend(new DelayedFirstFlush());
	const store = createStore();
	const jobs = createJobTracker();
	let calls = 0;
	const definition = workflow({
		name: "cancel-resume",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => {
			calls += 1;
			return {};
		},
	});
	const sourceId = crypto.randomUUID();
	store.recordRunStart({
		id: sourceId,
		name: definition.name,
		inputs: {},
		status: "failed",
		startedAt: 1,
		endedAt: 2,
		resumable: true,
		failedStageId: "retry",
		stages: [{ id: "retry", name: "retry", status: "failed", parentIds: [], toolEvents: [] }],
	});
	const runtime = createExtensionRuntime({ definitions: [definition], store, jobs });
	const caller = new AbortController();
	const reason = new Error("cancel resume startup");
	const pending = runtime.resumeFailedRun(sourceId, undefined, { signal: caller.signal }).catch((error) => error);
	await entered.promise;
	const job = jobs.get(jobs.runIds()[0]!)!;
	try {
		caller.abort(reason);
		assert.equal(job.controller.signal.aborted, true);
		assert.equal(await pending, reason);
	} finally {
		admission.resolve();
		await pending;
		await job.promise;
	}
	assert.equal(calls, 0);
	assert.equal(store.runs().find((run) => run.id === sourceId)?.status, "failed");
});

test("an aborted public resume never mutates after non-cancellable resource loading completes", async () => {
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const runId = crypto.randomUUID();
	backend.registerWorkflow({
		workflowId: runId,
		name: "resume-after-load",
		inputs: {},
		status: "paused",
		createdAt: 1,
	});
	backend.setWorkflowStatus(runId, "paused", 1, true);
	const loading = Promise.withResolvers<void>();
	let resumeCalls = 0;
	const runtime = {
		...createExtensionRuntime(),
		prepareDurableResumable: async () => [],
		resumeDurableWorkflow: async () => {
			resumeCalls += 1;
			return { ok: false as const, reason: "not_resumable" as const, message: "fixture" };
		},
	};
	const execute = makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => loading.promise,
	);
	const caller = new AbortController();
	const pending = execute({ action: "resume", runId }, {}, caller.signal);
	caller.abort();
	await assert.rejects(pending);
	loading.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(resumeCalls, 0);
});

test("durable resume cancellation during its claim restores the source without launching late work", async () => {
	const claimed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	class DelayedClaim extends InMemoryDurableBackend {
		override async transitionWorkflowStatus(
			id: string,
			expected: readonly DurableWorkflowStatus[],
			status: DurableWorkflowStatus,
		): Promise<boolean> {
			const result = await super.transitionWorkflowStatus(id, expected, status);
			claimed.resolve();
			await release.promise;
			return result;
		}
	}
	const backend = new DelayedClaim();
	setDurableBackend(backend);
	const store = createStore();
	const jobs = createJobTracker();
	let calls = 0;
	const definition = workflow({
		name: "durable-cancel-resume",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => {
			calls += 1;
			return {};
		},
	});
	const runId = crypto.randomUUID();
	backend.registerWorkflow({ workflowId: runId, name: definition.name, inputs: {}, status: "paused", createdAt: 1 });
	backend.setWorkflowStatus(runId, "paused", 1, true);
	const runtime = createExtensionRuntime({ definitions: [definition], store, jobs });
	const caller = new AbortController();
	const reason = new Error("cancel durable resume");
	const pending = runtime.resumeDurableWorkflow(runId, { signal: caller.signal }).catch((error) => error);
	await claimed.promise;
	caller.abort(reason);
	release.resolve();
	const result = await pending;
	await jobs.get(runId)?.promise;
	assert.equal(calls, 0);
	assert.equal(result, reason);
	assert.equal(backend.getWorkflow(runId)?.status, "paused");
});

test("quit immediately after allocation suspends before the deferred startup turn", async () => {
	setDurableBackend(new InMemoryDurableBackend());
	const store = createStore();
	const jobs = createJobTracker();
	const controls = createToolControlRegistry();
	let calls = 0;
	const definition = workflow({
		name: "quit-before-turn",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => {
			calls += 1;
			return {};
		},
	});
	const accepted = runDetached(definition, {}, { store, jobs, toolControlRegistry: controls });
	const job = jobs.get(accepted.runId)!;
	const result = await quitRun(accepted.runId, { store, jobs, toolControlRegistry: controls });
	await job.promise;
	assert.equal(result.ok, true);
	assert.equal(store.runs()[0]?.status, "paused");
	assert.equal(calls, 0);
});

test("startup signal ownership is released once and post-acknowledgement abort stays detached", async () => {
	setDurableBackend(new InMemoryDurableBackend());
	const ready = Promise.withResolvers<void>();
	const body = Promise.withResolvers<void>();
	const store = createStore();
	const jobs = createJobTracker();
	const caller = new AbortController();
	const remove = vi.spyOn(caller.signal, "removeEventListener");
	const definition = workflow({
		name: "detach-startup",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await body.promise;
			await ctx.tool("done", {}, async () => "done");
			return {};
		},
	});
	const accepted = runDetached(
		definition,
		{},
		{ store, jobs, startupSignal: caller.signal, onWorkflowStartReady: ready.resolve },
	);
	const job = jobs.get(accepted.runId)!;
	await ready.promise;
	caller.abort();
	assert.equal(job.controller.signal.aborted, false);
	body.resolve();
	await job.promise;
	assert.equal(store.runs()[0]?.status, "completed");
	assert.equal(remove.mock.calls.length, 1);
	remove.mockRestore();
});

test("a retired node-less executor cannot hydrate cached stages after quit", async () => {
	const backend = new InMemoryDurableBackend();
	setDurableBackend(backend);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let waiting = false;
	let modelCalls = 0;
	const definition = workflow({
		name: "late-cached-stage",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			if (waiting) {
				entered.resolve();
				await release.promise;
			}
			await ctx.stage("cached").prompt("cached");
			return {};
		},
	});
	const runId = crypto.randomUUID();
	await run(
		definition,
		{},
		{
			runId,
			store: createStore(),
			adapters: {
				prompt: {
					prompt: async () => {
						modelCalls += 1;
						return "done";
					},
				},
			},
		},
	);
	waiting = true;
	const store = createStore();
	const jobs = createJobTracker();
	const controls = createToolControlRegistry();
	runDetached(definition, {}, { runId, store, jobs, toolControlRegistry: controls });
	const job = jobs.get(runId)!;
	await entered.promise;
	await quitRun(runId, { store, jobs, toolControlRegistry: controls });
	release.resolve();
	await job.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(modelCalls, 1);
	assert.deepEqual(store.runs()[0]?.stages, [], "a late cached stage must not mutate the retired run");
});

test("a suspended root stays visibly stopped while quit durability is stalled", async () => {
	const flushing = Promise.withResolvers<void>();
	const flush = Promise.withResolvers<void>();
	class DelayedQuitFlush extends InMemoryDurableBackend {
		calls = 0;
		override async flush(): Promise<void> {
			if (++this.calls === 2) {
				flushing.resolve();
				await flush.promise;
			}
		}
	}
	setDurableBackend(new DelayedQuitFlush());
	const entered = Promise.withResolvers<void>();
	const body = Promise.withResolvers<void>();
	const definition = workflow({
		name: "quit-durability-pending",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => {
			entered.resolve();
			await body.promise;
			return {};
		},
	});
	const store = createStore();
	const jobs = createJobTracker();
	const controls = createToolControlRegistry();
	const accepted = runDetached(definition, {}, { store, jobs, toolControlRegistry: controls });
	const job = jobs.get(accepted.runId)!;
	await entered.promise;
	const quitting = quitRun(accepted.runId, { store, jobs, toolControlRegistry: controls });
	await flushing.promise;
	try {
		assert.equal(
			store.runs()[0]?.status,
			"paused",
			"pending durability cannot leave a suspended root claiming to run",
		);
		assert.equal(store.runs()[0]?.resumable, false);
	} finally {
		flush.resolve();
		body.resolve();
		await quitting;
		await job.promise;
	}
});

test("quit fences a root waiting for its final pre-completion flush", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let bodyReturned = false;
	let gated = false;
	class DelayedCompletionFlush extends InMemoryDurableBackend {
		override async flush(): Promise<void> {
			if (bodyReturned && !gated) {
				gated = true;
				entered.resolve();
				await release.promise;
			}
		}
	}
	const backend = new DelayedCompletionFlush();
	setDurableBackend(backend);
	const store = createStore();
	const jobs = createJobTracker();
	const controls = createToolControlRegistry();
	const definition = workflow({
		name: "quit-completion-flush",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("completed", {}, async () => "done");
			bodyReturned = true;
			return {};
		},
	});
	const accepted = runDetached(definition, {}, { store, jobs, toolControlRegistry: controls });
	const job = jobs.get(accepted.runId)!;
	await entered.promise;
	const quitting = quitRun(accepted.runId, { store, jobs, toolControlRegistry: controls });
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(store.runs()[0]?.status, "paused");
	} finally {
		release.resolve();
		await quitting;
		await job.promise;
	}
	assert.equal(backend.getWorkflow(accepted.runId)?.status, "paused");
	assert.equal(store.runs()[0]?.toolNodes?.[0]?.status, "completed");
});

test("a concurrent quit preserves the accepted root while public startup acknowledgement settles", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	class DelayedFirstFlush extends InMemoryDurableBackend {
		calls = 0;
		override async flush(): Promise<void> {
			if (++this.calls === 1) {
				entered.resolve();
				await release.promise;
			}
		}
	}
	setDurableBackend(new DelayedFirstFlush());
	const store = createStore();
	const jobs = createJobTracker();
	const definition = workflow({
		name: "public-init-quit",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => ({}),
	});
	const runtime = createExtensionRuntime({ definitions: [definition], store, jobs });
	const pending = runtime.dispatch({ action: "run", workflow: definition.name });
	await entered.promise;
	const runId = store.runs()[0]!.id;
	try {
		const quit = await quitRun(runId, { store, jobs });
		assert.equal(quit.ok, true);
		const result = await pending;
		assert.equal("status" in result ? result.status : undefined, "paused");
		assert.equal(store.runs()[0]?.status, "paused");
	} finally {
		release.resolve();
		await pending;
		await jobs.get(runId)?.promise;
	}
});
