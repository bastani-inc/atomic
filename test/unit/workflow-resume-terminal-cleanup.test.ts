import assert from "node:assert/strict";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker, currentJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";
import { TEST_TIMEOUT_MS } from "../helpers/test-timeout.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

test.each([
	"live continuation",
	"durable ID during save",
	"durable ID as save finishes",
	"listed running ID as save finishes",
	"listed prefix as save finishes",
	"durable prefix before first checkpoint",
	"default job tracker",
] as const)("%s resumes the failed workflow after its final save (#5527, #5569)", async (route) => {
	const store = createStore();
	const backend = await createMemoryTestBackend();
	configureTestStoreBackend(store, backend);
	const jobs = route === "default job tracker" ? currentJobTracker() : createJobTracker();
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
			if (route === "durable prefix before first checkpoint") {
				if (++attempts === 1) return ctx.exit({ status: "failed", resumable: true });
				return { result: await ctx.tool("after-guard", {}, async () => "resumed") };
			}
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

		const oldJob = jobs.get(runId)!;
		let listed = backend.listResumableWorkflows();
		if (route === "listed running ID as save finishes" || route === "listed prefix as save finishes") {
			const catalog = await runtime.prepareDurableCatalog!();
			listed = catalog.resumable;
			assert.equal(catalog.resumable.find((entry) => entry.workflowId === runId)?.status, "running");
			const hydrate = backend.hydrateWorkflow.bind(backend);
			vi.spyOn(backend, "hydrateWorkflow").mockImplementationOnce(async (id) => {
				finishPersistence.resolve();
				await oldJob.promise;
				await hydrate(id);
				assert.equal(jobs.has(runId), false);
				assert.notEqual(
					backend.getWorkflow(id)?.updatedAt,
					catalog.resumable.find((entry) => entry.workflowId === id)?.updatedAt,
				);
			});
		} else if (route === "durable ID as save finishes") {
			// The targeted read sees the old lease, but by the time its answer arrives the job is gone.
			const ownership = backend.workflowOwnership.bind(backend);
			vi.spyOn(backend, "workflowOwnership").mockImplementationOnce(async (id) => {
				const observed = await ownership(id);
				finishPersistence.resolve();
				await oldJob.promise;
				return observed;
			});
		} else {
			// Hold the save until the resume request reaches the job it must wait for.
			const get = jobs.get.bind(jobs);
			vi.spyOn(jobs, "get").mockImplementation((id) => {
				const job = get(id);
				if (job === oldJob) finishPersistence.resolve();
				return job;
			});
		}
		const target =
			route === "durable prefix before first checkpoint" || route === "listed prefix as save finishes"
				? runId.slice(0, 8)
				: runId;
		const resumed = await (route === "live continuation"
			? runtime.resumeFailedRun(runId)
			: route === "listed prefix as save finishes"
				? resumeDurableWorkflow(
						target,
						{ registry: runtime.registry, baseRunOpts: { store }, jobs, durableBackend: backend },
						listed,
					)
				: route === "default job tracker"
					? resumeDurableWorkflow(
							runId,
							{ registry: runtime.registry, baseRunOpts: { store }, durableBackend: backend },
							[],
						)
					: runtime.resumeDurableWorkflow(target, { definition }));
		assert.equal(resumed.ok, true, JSON.stringify(resumed));
		const terminalStateWaitMs = TEST_TIMEOUT_MS / 2;
		await vi.waitFor(() => assert.equal(store.run(runId)?.status, "completed"), { timeout: terminalStateWaitMs });
		assert.equal(attempts, 2);
		assert.equal(
			siblings,
			route === "durable prefix before first checkpoint" ? 0 : 1,
			"the settled sibling replays rather than executing again",
		);
	} finally {
		finishPersistence.resolve();
		await Promise.all(jobs.runIds().map((id) => jobs.get(id)?.promise));
		vi.restoreAllMocks();
		configureTestStoreBackend(store, undefined);
	}
});
