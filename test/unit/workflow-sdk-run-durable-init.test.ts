import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, describe, test, vi } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { getDurableBackendProcessOwner } from "../../packages/workflows/src/durable/backend-process-owner.js";
import {
	type ConfiguredDbosDurability,
	DbosDurableBackend,
	type DbosSdkHandle,
	effectiveSystemDatabaseUrl,
} from "../../packages/workflows/src/durable/dbos-backend.js";
import {
	acquireDbosLease,
	dbosLifecycleState,
	resetDbosLifecycleForTests,
} from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { shouldProvisionLocalDbos } from "../../packages/workflows/src/durable/dbos-local-postgres.js";
import { explicitDbosSystemDatabaseUrl } from "../../packages/workflows/src/durable/dbos-system-database-url.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { run, WorkflowDurabilityRequiredError, workflow } from "../../packages/workflows/src/sdk-surface.js";

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

const HOSTED_URL = "postgresql://atomic:secret@db.example.com:5432/atomic_workflows";

describe("SDK run() durability option", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test.sequential("memory mode runs without configuring DBOS", async () => {
		withoutInjectedBackend();
		let configurations = 0;
		resetDbosLifecycleForTests(async () => {
			configurations++;
			throw new Error("memory mode must not configure DBOS");
		});

		const result = await run(greet, { name: "memory" }, { durability: { mode: "memory" } });

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(result.result, { greeting: "hello memory" });
		assert.equal(configurations, 0);
		assert.equal(dbosLifecycleState(), "uninitialized");
	});

	test.sequential("durable mode configures DBOS against the supplied system database URL", async () => {
		withoutInjectedBackend();
		vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "postgresql://env-host/ignored");
		const events: string[] = [];
		const seenUrls: (string | undefined)[] = [];
		const configure = launchingConfigurator(events);
		resetDbosLifecycleForTests(async () => {
			seenUrls.push(explicitDbosSystemDatabaseUrl());
			return await configure();
		});

		const result = await run(greet, {}, { durability: { mode: "durable", systemDatabaseUrl: ` ${HOSTED_URL}\n` } });

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(seenUrls, [HOSTED_URL]);
		assert.equal(effectiveSystemDatabaseUrl(undefined), HOSTED_URL);
		assert.equal(shouldProvisionLocalDbos(new Error("connection refused")), false);
		assert.deepEqual(events, ["launch", "shutdown"]);
	});

	test.sequential("durable mode without a URL keeps the default database resolution", async () => {
		withoutInjectedBackend();
		vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
		const seenUrls: (string | undefined)[] = [];
		const configure = launchingConfigurator([]);
		resetDbosLifecycleForTests(async () => {
			seenUrls.push(explicitDbosSystemDatabaseUrl());
			return await configure();
		});

		const result = await run(greet, {}, { durability: { mode: "durable" } });

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(seenUrls, [undefined]);
	});

	test.sequential("rejects a different system database URL once DBOS is configured in this process", async () => {
		withoutInjectedBackend();
		resetDbosLifecycleForTests(launchingConfigurator([]));
		const releaseHost = acquireDbosLease();
		try {
			await run(greet, {}, { durability: { mode: "durable", systemDatabaseUrl: HOSTED_URL } });

			await assert.rejects(
				run(greet, {}, { durability: { mode: "durable", systemDatabaseUrl: "postgresql://other-host/db" } }),
				/already configured/,
			);
			const same = await run(greet, {}, { durability: { mode: "durable", systemDatabaseUrl: HOSTED_URL } });
			assert.equal(same.status, "completed", same.error);
		} finally {
			await releaseHost();
		}
	});
});

const requiredGreet = workflow({
	name: "sdk-run-required-greet",
	description: "Workflow that must never execute non-durably (#3239).",
	durability: "required",
	outputs: { greeting: Type.String() },
	run: async (ctx) => ({ greeting: await ctx.tool("greet", {}, async () => "hello durable") }),
});

describe("required durability (#3239)", () => {
	test.sequential("explicit durable mode rejects instead of falling back to memory", async () => {
		withoutInjectedBackend();
		resetDbosLifecycleForTests(async () => {
			throw new Error("postgres unreachable");
		});
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await assert.rejects(
				run(greet, {}, { durability: { mode: "durable" } }),
				(error: unknown) =>
					error instanceof WorkflowDurabilityRequiredError && /postgres unreachable/.test(error.message),
			);
			assert.equal(getDurableBackendProcessOwner().initializedBackend, undefined);
			assert.equal(consoleSpy.mock.calls.length, 0);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	test.sequential("a required definition rejects when DBOS cannot start, even without a run option", async () => {
		withoutInjectedBackend();
		resetDbosLifecycleForTests(async () => {
			throw new Error("postgres unreachable");
		});
		await assert.rejects(run(requiredGreet, {}), WorkflowDurabilityRequiredError);
	});

	test.sequential("a failed caller-selected database is not told to set DBOS_SYSTEM_DATABASE_URL", async () => {
		withoutInjectedBackend();
		resetDbosLifecycleForTests(async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:55499");
		});

		await assert.rejects(
			run(greet, {}, { durability: { mode: "durable", systemDatabaseUrl: HOSTED_URL } }),
			(error: unknown) =>
				error instanceof WorkflowDurabilityRequiredError &&
				/Check that the selected workflow system database is reachable/.test(error.message) &&
				!error.message.includes("Set DBOS_SYSTEM_DATABASE_URL"),
		);
	});

	test.sequential("a required definition fails before running on an in-memory backend", async () => {
		let executed = false;
		const guarded = workflow({
			name: "sdk-run-required-guarded",
			description: "Records whether its body ran.",
			durability: "required",
			outputs: {},
			run: async () => {
				executed = true;
				return {};
			},
		});

		const memory = await run(guarded, {}, { durability: { mode: "memory" } });
		const hostDegraded = await run(guarded, {}, { durableBackend: new InMemoryDurableBackend() });

		for (const result of [memory, hostDegraded]) {
			assert.equal(result.status, "failed");
			assert.match(result.error ?? "", /requires durable execution/);
		}
		assert.equal(executed, false);
	});

	test.sequential("a required definition runs on a persistent backend", async () => {
		withoutInjectedBackend();
		resetDbosLifecycleForTests(launchingConfigurator([]));

		const result = await run(requiredGreet, {});

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(result.result, { greeting: "hello durable" });
	});

	test("workflow() rejects an unknown durability value", () => {
		assert.throws(
			() =>
				workflow({
					name: "bad-durability",
					description: "",
					durability: "optional" as "required",
					outputs: {},
					run: async () => ({}),
				}),
			/durability must be "required"/,
		);
	});
});
