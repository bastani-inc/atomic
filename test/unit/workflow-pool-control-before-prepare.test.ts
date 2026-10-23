import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { childWorkerDispatchers } from "../../packages/workflows/src/workers/dispatch.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

afterEach(closeMemoryTestBackends);

async function startBlockedRoot(options: { readonly budget?: { readonly maxTokens: number } } = {}) {
	const backend = await createMemoryTestBackend();
	const prepareEntered = Promise.withResolvers<void>();
	const prepareRelease = Promise.withResolvers<void>();
	let prepared = false;
	childWorkerDispatchers.set(backend, {
		validateOptions() {},
		async prepare() {
			prepareEntered.resolve();
			await prepareRelease.promise;
			prepared = true;
		},
		usage: () => (prepared ? { input: 40, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } : undefined),
		run: () => Promise.reject(new Error("unused")),
	});
	const toolControlRegistry = createToolControlRegistry();
	const store = createStore();
	let bodyCalls = 0;
	const definition = workflow({
		name: "blocked-pool-prepare",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			bodyCalls++;
			await ctx.tool("once", {}, async () => "done");
			return {};
		},
	});
	const finished = run(
		definition,
		{},
		{ runId: "root", store, durableBackend: backend, toolControlRegistry, ...options },
	);
	await prepareEntered.promise;
	return { toolControlRegistry, store, finished, prepareRelease, bodyCalls: () => bodyCalls };
}

test("pause registered before pool preparation holds the root until resume (#3869)", async () => {
	const root = await startBlockedRoot();
	const control = root.toolControlRegistry.runControl("root");
	assert.ok(control, "root control is registered while pool preparation is still pending");
	await control.pause();
	root.prepareRelease.resolve();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(root.bodyCalls(), 0, "a paused root does not start its body when preparation finishes");
	assert.equal(root.store.runs()[0]?.status, "paused");
	await control.resume();
	const finished = await root.finished;
	assert.equal(finished.status, "completed", JSON.stringify(finished));
	assert.equal(root.bodyCalls(), 1);
});

test("quit registered before pool preparation suspends without waiting for it (#3869)", async () => {
	const root = await startBlockedRoot();
	const control = root.toolControlRegistry.runControl("root");
	assert.ok(control, "root control is registered while pool preparation is still pending");
	const quitting = control.quit();
	const result = await root.finished;
	await quitting;
	assert.equal(result.status, "paused");
	assert.equal(root.bodyCalls(), 0);
	root.prepareRelease.resolve();
});

test("pool usage is loaded before the first budget check after delayed preparation (#3869)", async () => {
	const root = await startBlockedRoot({ budget: { maxTokens: 10 } });
	root.prepareRelease.resolve();
	const result = await root.finished;
	assert.match(result.error ?? "", /tokens budget exceeded \(40tokens \/ 10tokens\)/, JSON.stringify(result));
	assert.equal(root.bodyCalls(), 0, "recovered pool spending is charged before the body starts");
});

test("a pause that arrives while resume persists keeps the pool paused (#3869)", async () => {
	const backend = await createMemoryTestBackend();
	const controls: string[] = [];
	childWorkerDispatchers.set(backend, {
		validateOptions() {},
		async control(state) {
			controls.push(state);
		},
		run: () => Promise.reject(new Error("unused")),
	});
	const toolControlRegistry = createToolControlRegistry();
	const store = createStore();
	const bodyGate = Promise.withResolvers<void>();
	const bodyStarted = Promise.withResolvers<void>();
	const definition = workflow({
		name: "resume-pause-race",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("gate", {}, async () => {
				bodyStarted.resolve();
				await bodyGate.promise;
				return "released";
			});
			return {};
		},
	});
	const finished = run(definition, {}, { runId: "root", store, durableBackend: backend, toolControlRegistry });
	const control = toolControlRegistry.runControl("root");
	assert.ok(control);
	await bodyStarted.promise;
	await control.pause();
	const persisting = Promise.withResolvers<void>();
	const persistRelease = Promise.withResolvers<void>();
	const transition = backend.commitWorkflowStatusTransition.bind(backend);
	vi.spyOn(backend, "commitWorkflowStatusTransition").mockImplementation(async (...args) => {
		if (args[2] === "running") {
			persisting.resolve();
			await persistRelease.promise;
		}
		return transition(...args);
	});
	const resuming = control.resume();
	const resumeOutcome = resuming.then(
		() => "resumed",
		(error: unknown) => String(error),
	);
	await persisting.promise;
	const repausing = control.pause();
	persistRelease.resolve();
	assert.match(await resumeOutcome, /superseded/);
	await repausing;
	assert.equal(controls.at(-1), "paused", JSON.stringify(controls));
	assert.equal(store.runs()[0]?.status, "paused");
	vi.restoreAllMocks();
	await control.resume();
	bodyGate.resolve();
	assert.equal((await finished).status, "completed");
});
