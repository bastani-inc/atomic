import assert from "node:assert/strict";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDependencyError } from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend, type DbosSdkHandle } from "../../packages/workflows/src/durable/dbos-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

test("live resume recovers a lost owner generation without restarting the runtime (#3621)", async () => {
	const sdk = createMockSdk();
	let lost = false;
	let forks = 0;
	let adopted = false;
	const successorId = `atomic-db-${crypto.randomUUID()}`;
	const successor: DbosSdkHandle = {
		...sdk,
		executorId: successorId,
		generationLost: () => false,
		adoptPreviousGeneration: async () => {
			adopted = true;
			return undefined;
		},
		recordStepOutput: async (...args) => {
			assert.equal(adopted, true, "successor writes require fenced adoption");
			await sdk.recordStepOutput(...args);
		},
	};
	const backend = new DbosDurableBackend({
		...sdk,
		executorId: `atomic-db-${crypto.randomUUID()}`,
		generationLost: () => lost,
		forkGeneration: () => {
			forks++;
			return successor;
		},
		recordStepOutput: async (...args) => {
			if (lost) throw new DbosDependencyError("ownership connection was lost");
			await sdk.recordStepOutput(...args);
		},
	});
	const store = createStore();
	const controls = createToolControlRegistry();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const controller = new AbortController();
	const definition = workflow({
		name: "owner-fence-resume",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			entered.resolve();
			await release.promise;
			await ctx.tool("after-recovery", {}, async () => "done");
			return {};
		},
	});
	const runId = crypto.randomUUID();
	const pending = run(
		definition,
		{},
		{
			runId,
			store,
			durableBackend: backend,
			toolControlRegistry: controls,
			signal: controller.signal,
		},
	);
	try {
		await entered.promise;
		const control = controls.runControl(runId);
		assert.ok(control);
		lost = true;
		await control.pause();
		assert.equal(control.paused, true);
		await control.resume();
		assert.equal(control.paused, false);
		assert.equal(forks, 1);
		release.resolve();
		assert.equal((await pending).status, "completed");
		assert.equal(backend.getWorkflow(runId)?.status, "completed");
		const fresh = new DbosDurableBackend(sdk);
		await fresh.hydrateWorkflow(runId);
		assert.equal(fresh.getWorkflow(runId)?.status, "completed");
		assert.equal(fresh.getWorkflow(runId)?.ownerExecutorId, successorId);
	} finally {
		controller.abort();
		release.resolve();
		await pending;
	}
});
