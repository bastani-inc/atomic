import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	createDurableTaskPrimitive,
	createStageReplayKeyGenerator,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

for (const boundary of ["tool", "task", "prompt", "complete", "ui"] as const) {
	test(`pause during replay persistence blocks the next ${boundary} until resume`, async () => {
		const backend = await createMemoryTestBackend();
		const toolControls = createToolControlRegistry();
		const store = createStore();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let replay = false;
		let callbacks = 0;
		const callback = async () => {
			callbacks++;
			assert.equal(toolControls.runControl(runId)?.paused, false);
			return "next";
		};
		const runId = `replay-pause-${boundary}`;
		const definition = workflow({
			name: runId,
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const cached = ctx.stage("cached");
				if (!replay) {
					await cached.complete("saved");
					return {};
				}
				if (boundary === "tool") await ctx.tool("next", {}, callback);
				if (boundary === "task") await ctx.task("next", { prompt: "next" });
				if (boundary === "prompt") await ctx.stage("next").prompt("next");
				if (boundary === "complete") await ctx.stage("next").complete("next");
				if (boundary === "ui") await ctx.ui.input("next");
				return {};
			},
		});
		const options = {
			runId,
			durableBackend: backend,
			toolControlRegistry: toolControls,
			adapters: {
				complete: { complete: async (text: string) => (replay ? callback() : text) },
				prompt: { prompt: callback },
			},
			ui: {
				input: callback,
				confirm: async () => false,
				select: async <T extends string>(_message: string, values: readonly T[]) => values[0]!,
				editor: async () => "",
				custom: async () => assert.fail("unused custom UI"),
			},
		};
		assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
		const commit = backend.commitCheckpoint.bind(backend);
		backend.commitCheckpoint = async (checkpoint, commitOptions) => {
			if (checkpoint.checkpointId.startsWith("stage-replay-meta:")) {
				entered.resolve();
				await release.promise;
			}
			await commit(checkpoint, commitOptions);
		};
		replay = true;
		const execution = run(definition, {}, { ...options, store });
		await entered.promise;
		const control = toolControls.runControl(runId);
		assert.ok(control);
		try {
			await control.pause();
			await setImmediate();
			assert.equal(backend.getWorkflow(runId)?.status, "paused");
			release.resolve();
			// Drain all promise continuations released by the controlled storage write.
			await setImmediate();
			assert.equal(callbacks, 0, "a paused run must not start the callback");
			assert.equal(store.runs()[0]?.status, "paused");
		} finally {
			release.resolve();
			await control.resume();
			await execution;
		}
		assert.equal((await execution).status, "completed");
		assert.equal(callbacks, 1);
	});
}

for (const [failureMode, outcome] of [
	["throw", "success"],
	["return", "success"],
	["return", "failure"],
] as const) {
	test(`cancel during replay persistence prevents ${failureMode} ${outcome} checkpoint and retries on resume`, async () => {
		const backend = await createMemoryTestBackend();
		const toolControls = createToolControlRegistry();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let replay = false;
		let attempts = 0;
		const runId = `replay-cancel-${failureMode}-${outcome}`;
		const definition = workflow({
			name: runId,
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				if (!replay) {
					await ctx.stage("cached").complete("saved");
					return {};
				}
				const callback = async () => {
					attempts++;
					ctx.stage("cached");
					if (outcome === "failure") throw new RangeError("callback failure");
					return "next";
				};
				if (failureMode === "return") await ctx.tool("next", {}, callback, { failureMode });
				else await ctx.tool("next", {}, callback, { failureMode });
				return {};
			},
		});
		const options = {
			runId,
			durableBackend: backend,
			toolControlRegistry: toolControls,
			adapters: { complete: { complete: async (text: string) => text } },
		};
		assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
		const commit = backend.commitCheckpoint.bind(backend);
		backend.commitCheckpoint = async (checkpoint, commitOptions) => {
			if (checkpoint.checkpointId.startsWith("stage-replay-meta:")) {
				entered.resolve();
				await release.promise;
			}
			await commit(checkpoint, commitOptions);
		};
		replay = true;
		const store = createStore();
		const execution = run(definition, {}, { ...options, store });
		await entered.promise;
		await setImmediate();
		const handle = toolControls.active(runId)[0];
		assert.ok(handle);
		handle.abort("node");
		release.resolve();
		await execution;
		assert.equal(store.runs()[0]?.toolNodes[0]?.status, "cancelled");
		assert.equal(
			backend.listCheckpoints(runId).filter((checkpoint) => checkpoint.checkpointId.startsWith("tool:")).length,
			0,
		);
		assert.equal(attempts, 1);
		await run(definition, {}, { ...options, store: createStore() });
		assert.equal(attempts, 2, "resume must retry the cancelled tool");
	});
}

test("quit during replay persistence refuses an already-admitted tool before its callback", async () => {
	const backend = await createMemoryTestBackend();
	const toolControls = createToolControlRegistry();
	const store = createStore();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let replay = false;
	let callbacks = 0;
	const runId = "replay-quit-admission";
	const definition = workflow({
		name: runId,
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const cached = ctx.stage("cached");
			if (!replay) {
				await cached.complete("saved");
				return {};
			}
			await ctx.tool("next", {}, async () => {
				callbacks++;
				return "next";
			});
			return {};
		},
	});
	const options = {
		runId,
		durableBackend: backend,
		toolControlRegistry: toolControls,
		adapters: { complete: { complete: async (text: string) => text } },
	};
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
	const commit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = async (checkpoint, commitOptions) => {
		if (checkpoint.checkpointId.startsWith("stage-replay-meta:")) {
			entered.resolve();
			await release.promise;
		}
		await commit(checkpoint, commitOptions);
	};
	replay = true;
	const execution = run(definition, {}, { ...options, store });
	await entered.promise;
	await setImmediate();
	const admission = toolControls.admissionBoundary(runId);
	assert.ok(admission);
	const quitting = quitRun(runId, { store, toolControlRegistry: toolControls });
	await setImmediate();
	assert.equal(admission.closed, true);
	release.resolve();
	assert.equal((await quitting).ok, true);
	assert.equal((await execution).status, "paused");
	assert.equal(callbacks, 0);
	assert.equal(backend.getWorkflow(runId)?.status, "paused");
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
	assert.equal(callbacks, 1);
});

for (const boundary of ["stage", "ui", "diagnostic"] as const) {
	test(`run cancellation during replay persistence prevents a later ${boundary} checkpoint`, async () => {
		const backend = await createMemoryTestBackend();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		let replay = false;
		let writes = 0;
		let declareCached: () => void = () => assert.fail("workflow has not started");
		const runId = `replay-cancel-checkpoint-${boundary}`;
		const definition = workflow({
			name: runId,
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				if (!replay) {
					await ctx.stage("cached").complete("saved");
					return {};
				}
				declareCached = () => {
					ctx.stage("cached");
				};
				if (boundary === "stage") await ctx.stage("live").complete("result");
				if (boundary === "ui") await ctx.ui.input("live");
				if (boundary === "diagnostic")
					await ctx.tool("live", {}, async () => {
						declareCached();
						throw new RangeError("callback failed");
					});
				return {};
			},
		});
		const options = {
			runId,
			durableBackend: backend,
			adapters: {
				complete: {
					complete: async (text: string) => {
						if (replay) declareCached();
						return text;
					},
				},
			},
			ui: {
				input: async () => {
					declareCached();
					return "answer";
				},
				confirm: async () => false,
				select: async <T extends string>(_message: string, values: readonly T[]) => values[0]!,
				editor: async () => "",
				custom: async () => assert.fail("unused custom UI"),
			},
		};
		assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
		const commit = backend.commitCheckpoint.bind(backend);
		backend.commitCheckpoint = async (checkpoint, commitOptions) => {
			if (checkpoint.checkpointId.startsWith("stage-replay-meta:")) {
				entered.resolve();
				await release.promise;
			}
			if (
				(checkpoint.kind === "stage" && checkpoint.name === "live" && checkpoint.output !== undefined) ||
				checkpoint.kind === "ui" ||
				checkpoint.checkpointId.startsWith("tool-failure:")
			)
				writes++;
			await commit(checkpoint, commitOptions);
		};
		replay = true;
		const execution = run(definition, {}, { ...options, store: createStore(), signal: controller.signal });
		await entered.promise;
		await setImmediate();
		controller.abort(new RangeError("cancelled before checkpoint"));
		release.resolve();
		await execution;
		assert.equal(writes, 0, "no new checkpoint may begin after cancellation wins the replay drain");
	});
}

test("a task tail cancelled during the replay drain never starts its checkpoint and can retry", async () => {
	const backend = await createMemoryTestBackend();
	const runId = "replay-task-tail-cancel";
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: runId,
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const control = Promise.withResolvers<AbortController>();
	let writes = 0;
	let callbacks = 0;
	const commit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = async (checkpoint, options) => {
		writes++;
		await commit(checkpoint, options);
	};
	const makeTask = () =>
		createDurableTaskPrimitive({
			workflowId: runId,
			backend,
			nextReplayKey: createStageReplayKeyGenerator(runId),
			task: async (name) => {
				callbacks++;
				return { name, stageName: name, text: "ready" };
			},
			beforeCheckpoint: () => {
				entered.resolve();
				return release.promise;
			},
			registerTailControl: ({ controller }) => {
				control.resolve(controller);
				return () => {};
			},
		});
	const pending = makeTask()("live", { prompt: "live" });
	await entered.promise;
	const reason = new RangeError("task cancelled during replay persistence");
	(await control.promise).abort(reason);
	release.resolve();
	await assert.rejects(pending, (error: Error) => error === reason);
	assert.equal(writes, 0);
	assert.equal(backend.getStageOutput(runId, "stage:task:live:1"), undefined);
	await makeTask()("live", { prompt: "live" });
	assert.equal(callbacks, 2);
	assert.equal(writes, 1);
});

test("quit releases a tool paused during the replay drain without starting or checkpointing it", async () => {
	const backend = await createMemoryTestBackend();
	const toolControls = createToolControlRegistry();
	const store = createStore();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let replay = false;
	let callbacks = 0;
	const runId = "replay-pause-then-quit";
	const definition = workflow({
		name: runId,
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			const cached = ctx.stage("cached");
			if (!replay) {
				await cached.complete("saved");
				return {};
			}
			await ctx.tool("next", {}, async () => {
				callbacks++;
				return "next";
			});
			return {};
		},
	});
	const options = {
		runId,
		durableBackend: backend,
		toolControlRegistry: toolControls,
		adapters: { complete: { complete: async (text: string) => text } },
	};
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
	const commit = backend.commitCheckpoint.bind(backend);
	backend.commitCheckpoint = async (checkpoint, commitOptions) => {
		if (checkpoint.checkpointId.startsWith("stage-replay-meta:")) {
			entered.resolve();
			await release.promise;
		}
		await commit(checkpoint, commitOptions);
	};
	replay = true;
	const execution = run(definition, {}, { ...options, store });
	await entered.promise;
	const control = toolControls.runControl(runId);
	assert.ok(control);
	await control.pause();
	let quitSettled = false;
	const quitting = quitRun(runId, { store, toolControlRegistry: toolControls }).then((result) => {
		quitSettled = true;
		return result;
	});
	try {
		await setImmediate();
		release.resolve();
		await setImmediate();
		assert.equal(quitSettled, true, "quit must not wait for a resume to release tool admission");
		assert.equal((await quitting).ok, true);
		assert.equal((await execution).status, "paused");
		assert.equal(callbacks, 0);
		assert.equal(
			backend.listCheckpoints(runId).some((checkpoint) => checkpoint.checkpointId.startsWith("tool:")),
			false,
		);
	} finally {
		release.resolve();
		if (!quitSettled) await control.resume();
		await quitting;
		await execution;
	}
});
