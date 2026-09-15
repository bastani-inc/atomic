import assert from "node:assert/strict";
import { test } from "vitest";
import { dbosAdmissionContext } from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

// #3072: timed-out control continuations must not change newer local state.
for (const lateRead of [1, 2, 0]) {
	const phase = lateRead === 1 ? "read" : lateRead === 2 ? "claim read" : "claim write";
	test(`aborted transition cannot mutate the mirror after late ${phase}`, async () => {
		const sdk = createMockSdk();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let reads = 0;
		let intercept = false;
		const backend = new DbosDurableBackend({
			...sdk,
			listStepRecords: async (id) => {
				const records = await sdk.listStepRecords(id);
				if (intercept && ++reads === lateRead) {
					entered.resolve();
					await release.promise;
				}
				return records;
			},
			recordStepOutput: async (...args) => {
				await sdk.recordStepOutput(...args);
				if (intercept && lateRead === 0) {
					entered.resolve();
					await release.promise;
				}
			},
		});
		backend.registerWorkflow({ workflowId: "late", name: "test", inputs: {}, createdAt: 1, status: "running" });
		await backend.flush();
		intercept = true;
		const controller = new AbortController();
		const reason = new Error("control deadline elapsed");
		const pending = dbosAdmissionContext.run(controller.signal, () =>
			backend.transitionWorkflowStatus("late", ["running"], "paused"),
		);
		const settled = pending.then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		await entered.promise;
		const writesAtAbort = sdk.state.steps.size;
		controller.abort(reason);
		release.resolve();
		assert.deepEqual(await settled, { error: reason });
		assert.equal(backend.getWorkflow("late")?.status, "running");
		assert.equal(sdk.state.steps.size, writesAtAbort);
		assert.equal(reads, lateRead || 1);
	});
}
