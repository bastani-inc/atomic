import assert from "node:assert/strict";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

test("resuming a visibly failed workflow waits for the previous attempt's final persistence (#5527)", async () => {
	const store = createStore();
	const backend = await createMemoryTestBackend();
	configureTestStoreBackend(store, backend);
	const jobs = createJobTracker();
	const terminalPublished = Promise.withResolvers<void>();
	const finishPersistence = Promise.withResolvers<void>();
	let siblings = 0;
	let attempts = 0;
	const definition = workflow({
		name: "resume-terminal-cleanup",
		description: "",
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => {
			await ctx.tool("settled-sibling", {}, async () => ++siblings);
			const result = await ctx.tool("retry-target", {}, async () => {
				if (++attempts === 1) throw new Error("target failed");
				return "resumed";
			});
			return { result };
		},
	});
	const runtime = createExtensionRuntime({
		definitions: [definition],
		store,
		jobs,
		cancellation: createCancellationRegistry(),
		stageControlRegistry: createStageControlRegistry(),
		toolControlRegistry: createToolControlRegistry(),
		persistence: {
			async appendEntry(type, payload) {
				if (type === "workflow.run.end" && payload.status === "failed") {
					terminalPublished.resolve();
					await finishPersistence.promise;
				}
			},
		},
	});
	try {
		const launched = await runtime.dispatch({ action: "run", workflow: definition.name, inputs: {} });
		assert.ok("runId" in launched && typeof launched.runId === "string", JSON.stringify(launched));
		const runId = launched.runId;
		await terminalPublished.promise;
		assert.equal(store.run(runId)?.status, "failed");
		assert.equal(jobs.has(runId), true, "the prior attempt is still finishing persistence");

		const resuming = runtime.resumeFailedRun(runId);
		finishPersistence.resolve();
		const resumed = await resuming;
		assert.equal(resumed.ok, true, JSON.stringify(resumed));
		const terminalStateWaitMs = TEST_TIMEOUT_MS / 2;
		await vi.waitFor(() => assert.equal(store.run(runId)?.status, "completed"), { timeout: terminalStateWaitMs });
		assert.equal(attempts, 2);
		assert.equal(siblings, 1, "the settled sibling replays rather than executing again");
	} finally {
		finishPersistence.resolve();
		await Promise.all(jobs.runIds().map((id) => jobs.get(id)?.promise));
		configureTestStoreBackend(store, undefined);
	}
});
