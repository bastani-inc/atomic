import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { getDurableBackendProcessOwner } from "../../packages/workflows/src/durable/backend-process-owner.js";
import {
	type ConfiguredDbosDurability,
	DbosDurableBackend,
	type DbosSdkHandle,
} from "../../packages/workflows/src/durable/dbos-backend.js";
import {
	acquireDbosLease,
	dbosLifecycleState,
	resetDbosLifecycleForTests,
} from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";

const greet = workflow({
	name: "sdk-run-greet",
	description: "Standalone SDK run with a single tool node.",
	inputs: { name: Type.String({ default: "world" }) },
	outputs: { greeting: Type.String() },
	run: async (ctx) => {
		const greeting = await ctx.tool("greet", { name: ctx.inputs.name }, async () => `hello ${ctx.inputs.name}`);
		return { greeting };
	},
});

function stubSdk(): DbosSdkHandle {
	return {
		launch: async () => {},
		shutdown: async () => {},
		startWorkflow: async () => {},
		retrieveWorkflow: async () => undefined,
		cancelWorkflow: async () => {},
		resumeWorkflow: async () => {},
		listAllWorkflows: async () => [],
		listStepRecords: async () => [],
		recordStepOutput: async () => {},
		deleteWorkflowData: async () => {},
	};
}

function launchingConfigurator(events: string[]): () => Promise<ConfiguredDbosDurability> {
	return async () => ({
		backend: new DbosDurableBackend(stubSdk()),
		launch: async () => {
			events.push("launch");
		},
		shutdown: async () => {
			events.push("shutdown");
		},
	});
}

function withoutInjectedBackend(): void {
	getDurableBackendProcessOwner().injectedBackend = undefined;
}

afterEach(() => {
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

describe("SDK run() outside an Atomic host", () => {
	test.sequential("initializes the durable backend instead of throwing DbosNotReadyError", async () => {
		withoutInjectedBackend();
		resetDbosLifecycleForTests(async () => {
			throw new Error("no postgres in this test");
		});
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const result = await run(greet, { name: "Atomic" });

			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(result.result, { greeting: "hello Atomic" });
			assert.ok(getDurableBackendProcessOwner().initializedBackend instanceof InMemoryDurableBackend);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	test.sequential("shuts down the DBOS executor it started once the run settles", async () => {
		withoutInjectedBackend();
		const events: string[] = [];
		resetDbosLifecycleForTests(launchingConfigurator(events));

		const result = await run(greet, {});

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(events, ["launch", "shutdown"]);
		assert.equal(dbosLifecycleState(), "shut_down");
	});

	test.sequential("leaves a host-owned DBOS executor running", async () => {
		withoutInjectedBackend();
		const events: string[] = [];
		resetDbosLifecycleForTests(launchingConfigurator(events));
		const releaseHost = acquireDbosLease();
		try {
			const result = await run(greet, {});

			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(events, ["launch"]);
			assert.equal(dbosLifecycleState(), "ready");
		} finally {
			await releaseHost();
		}
		assert.deepEqual(events, ["launch", "shutdown"]);
	});
});
