import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	DBOS_ADMISSION_TIMEOUT_MS,
	dbosAdmissionContext,
} from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

afterEach(() => vi.useRealTimers());

test("checkpoint records its receipt after database latency exceeds ten seconds (#3428)", async () => {
	vi.useFakeTimers();
	const sdk = createMockSdk();
	const entered = Promise.withResolvers<void>();
	const backend = new DbosDurableBackend({
		...sdk,
		async recordStepOutput(id, step, output) {
			if (step === "slow-effect") {
				entered.resolve();
				await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
			}
			await sdk.recordStepOutput(id, step, output);
		},
	});
	backend.registerWorkflow({ workflowId: "slow-id", name: "test", inputs: {}, createdAt: 1, status: "running" });
	await backend.flush();
	const pending = backend.recordCheckpointAsync({
		kind: "tool",
		workflowId: "slow-id",
		checkpointId: "slow-effect",
		argsHash: "effect",
		name: "effect",
		output: "receipt",
		completedAt: 1,
	});
	await entered.promise;
	await vi.advanceTimersByTimeAsync(15_000);
	await pending;
	const fresh = new DbosDurableBackend(sdk);
	await fresh.hydrateWorkflow("slow-id");
	assert.equal(fresh.getToolOutput("slow-id", "effect"), "receipt");
	assert.equal(vi.getTimerCount(), 0);
});

// #3072/#3074: a stalled checkpoint must release its queue without publishing late metadata.
for (const cancelled of [false, true]) {
	test(`checkpoint write is bounded and fenced on ${cancelled ? "cancellation" : "deadline"} (#3428)`, async () => {
		vi.useFakeTimers();
		const sdk = createMockSdk();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let writeSignal: AbortSignal | undefined;
		const backend = new DbosDurableBackend({
			...sdk,
			async recordStepOutput(id, step, output) {
				if (step === "effect") {
					writeSignal = dbosAdmissionContext.getStore();
					entered.resolve();
					await release.promise;
				}
				await sdk.recordStepOutput(id, step, output);
			},
		});
		backend.registerWorkflow({ workflowId: "id", name: "test", inputs: {}, createdAt: 1, status: "running" });
		await backend.flush();
		const controller = new AbortController();
		const pending = backend.recordCheckpointAsync(
			{
				kind: "tool",
				workflowId: "id",
				checkpointId: "effect",
				argsHash: "effect",
				name: "effect",
				output: "receipt",
				completedAt: 1,
			},
			{ signal: controller.signal },
		);
		const rejected = assert.rejects(pending, cancelled ? /operator cancelled/ : /checkpoint timed out/);
		await entered.promise;
		if (cancelled) {
			const cancelledAt = Date.now();
			controller.abort(new Error("operator cancelled"));
			await rejected;
			assert.equal(Date.now(), cancelledAt, "cancellation must settle without advancing the clock");
		} else {
			await vi.advanceTimersByTimeAsync(119_999);
			assert.equal(writeSignal?.aborted, false, "checkpoint retains its full two-minute budget");
			await vi.advanceTimersByTimeAsync(1);
		}
		await rejected;
		assert.equal(writeSignal?.aborted, true);
		await backend.flush("id");
		assert.equal(backend.getToolOutput("id", "effect"), undefined);
		backend.setWorkflowStatus("id", "paused", undefined, true);
		await backend.flush("id");
		const before = [...sdk.state.steps.keys()].filter((key) => key.includes("__atomic_metadata"));
		release.resolve();
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(
			[...sdk.state.steps.keys()].filter((key) => key.includes("__atomic_metadata")),
			before,
		);
		assert.equal(backend.getWorkflow("id")?.status, "paused");
		const fresh = new DbosDurableBackend(sdk);
		await fresh.hydrateWorkflow("id");
		assert.equal(
			fresh.getToolOutput("id", "effect"),
			"receipt",
			"late committed receipt remains discoverable without repeating its external effect",
		);
	});
}

test("checkpoint deadline settles the executor without unbounded inspection or terminal writes", async () => {
	vi.useFakeTimers();
	const sdk = createMockSdk();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let writesAfterOutage = 0;
	let offline = false;
	const backend = new DbosDurableBackend({
		...sdk,
		async recordStepOutput(id, step, value) {
			if (step.startsWith("tool:")) offline = true;
			if (offline) {
				writesAfterOutage++;
				entered.resolve();
				await release.promise;
			}
			await sdk.recordStepOutput(id, step, value);
		},
	});
	const store = createStore();
	const definition = workflow({
		name: "checkpoint-outage",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("effect", {}, async () => "receipt");
			return {};
		},
	});
	const pending = run(definition, {}, { runId: "id", store, durableBackend: backend });
	await entered.promise;
	await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
	try {
		assert.equal((await pending).status, "failed");
		assert.match(store.runs()[0]?.error ?? "", /checkpoint timed out/);
		assert.equal(
			writesAfterOutage,
			1,
			"failure inspection and terminal finalization must not start another database write",
		);
	} finally {
		release.resolve();
		await vi.advanceTimersByTimeAsync(0);
	}
});
