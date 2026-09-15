import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DBOS_ADMISSION_TIMEOUT_MS, DbosDependencyError } from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { resetDbosLifecycleForTests } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { admitDurableRootRun } from "../../packages/workflows/src/engine/run-durable-admission.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

afterEach(() => {
	vi.useRealTimers();
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

// #3072: local-only finalization must preserve immediate write rejection without a second flush.
test("immediate non-dependency admission write failure rejects with the original error and cleans up", async () => {
	const writeError = new Error("durable admission write failed");
	let flushes = 0;
	let executions = 0;
	class FailingWriteBackend extends InMemoryDurableBackend {
		override async flush(): Promise<void> {
			flushes++;
			throw writeError;
		}
	}
	const backend = new FailingWriteBackend();
	const store = createStore();
	const controls = createToolControlRegistry();
	const runId = "immediate-admission-failure";
	const definition = workflow({
		name: runId,
		description: "",
		inputs: {},
		outputs: {},
		run: async () => {
			executions++;
			return {};
		},
	});
	await assert.rejects(
		run(definition, {}, { runId, durableBackend: backend, store, toolControlRegistry: controls }),
		(error) => error === writeError,
	);
	assert.equal(flushes, 1, "failure cleanup must not retry durable writes");
	assert.equal(executions, 0);
	assert.equal(store.runs()[0]?.status, "failed");
	assert.equal(backend.getWorkflow(runId)?.status, "failed");
	assert.equal(controls.runControl(runId), undefined);
	assert.equal(controls.admissionBoundary(runId), undefined);
});

// #3072: a lost database must not pin root admission until the request deadline.
test("root admission has its own deadline and rejects late completion", async () => {
	vi.useFakeTimers();
	const write = Promise.withResolvers<void>();
	class UnavailableBackend extends InMemoryDurableBackend {
		override async flush(): Promise<void> {
			await write.promise;
		}
	}
	const options = {
		backend: new UnavailableBackend(),
		runId: "isolated-admission",
		isChildRun: false,
		registration: undefined,
		timeoutMs: 100,
	};
	let outcome = "pending";
	const pending = admitDurableRootRun(options).then(
		() => {
			outcome = "admitted";
		},
		() => {
			outcome = "rejected";
		},
	);
	await vi.advanceTimersByTimeAsync(100);
	try {
		assert.equal(outcome, "rejected");
	} finally {
		write.resolve();
		await pending;
	}
	assert.equal(outcome, "rejected", "late storage completion cannot admit the abandoned root");
});

// #3072: exercise the executor boundary, including an SDK that settles after cancellation.
test("timed-out DB root never executes late and the same identity admits once on retry", async () => {
	vi.useFakeTimers();
	const entered = Promise.withResolvers<void>();
	const late = Promise.withResolvers<void>();
	const sdk = createMockSdk();
	let attempts = 0;
	const unavailable = vi.fn();
	const backend = new DbosDurableBackend(
		{
			...sdk,
			startWorkflow: async (...args) => {
				if (++attempts === 1) {
					entered.resolve();
					await late.promise;
				}
				await sdk.startWorkflow(...args);
			},
		},
		{ onUnavailable: unavailable },
	);
	let calls = 0;
	const definition = workflow({
		name: "bounded-root",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			assert.equal(sdk.state.steps.size, 1, "retry publishes one admission record before author code");
			await ctx.tool("effect", {}, async () => {
				calls++;
				return "done";
			});
			return {};
		},
	});
	const opts = { runId: "same-root", durableBackend: backend, store: createStore() };
	const pending = run(definition, {}, opts);
	await entered.promise;
	await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
	assert.equal((await pending).status, "failed");
	assert.equal(opts.store.runs().find((entry) => entry.id === "same-root")?.status, "failed");
	assert.equal(backend.getWorkflow("same-root")?.status, "failed");
	assert.equal(backend.getWorkflow("same-root")?.completedCheckpoints, 0);
	// This is a local same-identity retry target, not evidence of persisted admission.
	assert.equal(backend.getWorkflow("same-root")?.resumable, true);
	assert.deepEqual(
		backend.listResumableWorkflows().map((entry) => entry.workflowId),
		["same-root"],
	);
	assert.equal(unavailable.mock.calls.length, 1);
	assert.ok(unavailable.mock.calls[0]?.[0] instanceof DbosDependencyError);
	late.resolve();
	await vi.advanceTimersByTimeAsync(0);
	assert.equal(calls, 0);
	assert.equal(sdk.state.steps.size, 0, "late registration cannot publish metadata");
	// Known #3072 residual, owned by #3074 automatic recovery: cancellation can
	// strand an identity without metadata even against a healthy, slow database.
	assert.deepEqual(
		sdk.state.starts.map((entry) => entry.workflowId),
		["same-root"],
	);
	const fresh = new DbosDurableBackend(sdk);
	assert.deepEqual(await fresh.hydrateWorkflowForInspection("same-root"), { kind: "malformed" });
	assert.equal(fresh.isWorkflowLoadable("same-root"), false, "fresh-session resume must fail closed");
	assert.deepEqual(sdk.state.deletions, [], "hydration must not delete incomplete admission data");
	// A new invocation gets a fresh execution view, retaining the durable identity and backend.
	assert.equal((await run(definition, {}, { ...opts, store: createStore() })).status, "completed");
	assert.equal(calls, 1);
	assert.deepEqual(
		sdk.state.starts.map((entry) => entry.workflowId),
		["same-root", "same-root"],
	);
	assert.deepEqual([...sdk.state.workflows.keys()], ["same-root"]);
});

// #3072: local repair failures must reach the caller without waiting on PostgreSQL.
test("run surfaces an unadmitted mirror repair failure", async () => {
	const repairError = new Error("local mirror repair failed");
	class BrokenMirrorBackend extends InMemoryDurableBackend {
		async admitWorkflow(): Promise<void> {
			throw new DbosDependencyError();
		}
		override setWorkflowStatus(): void {
			throw repairError;
		}
		override async flush(): Promise<void> {
			assert.fail("unadmitted finalization must not flush the database");
		}
	}
	const definition = workflow({
		name: "broken-mirror",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => {
			assert.fail("unadmitted author code must not run");
		},
	});
	await assert.rejects(
		run(definition, {}, { durableBackend: new BrokenMirrorBackend(), store: createStore() }),
		(error) => error === repairError,
	);
});
