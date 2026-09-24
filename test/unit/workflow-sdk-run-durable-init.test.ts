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
const ENV_URL = "postgresql://operator:secret@env-host:5432/atomic_workflows";

function recordingConfigurator(events: string[], seenUrls: (string | undefined)[]) {
	const configure = launchingConfigurator(events);
	return async () => {
		seenUrls.push(explicitDbosSystemDatabaseUrl());
		return await configure();
	};
}

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
		vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
		const events: string[] = [];
		const seenUrls: (string | undefined)[] = [];
		resetDbosLifecycleForTests(recordingConfigurator(events, seenUrls));

		const result = await run(greet, {}, { durability: { mode: "durable", systemDatabaseUrl: ` ${HOSTED_URL}\n` } });

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(seenUrls, [HOSTED_URL]);
		assert.equal(effectiveSystemDatabaseUrl(undefined), HOSTED_URL);
		assert.equal(shouldProvisionLocalDbos(new Error("connection refused")), false);
		assert.deepEqual(events, ["launch", "shutdown"]);
	});

	test.sequential("DBOS_SYSTEM_DATABASE_URL overrides the supplied system database URL", async () => {
		withoutInjectedBackend();
		vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", ENV_URL);
		const seenUrls: (string | undefined)[] = [];
		resetDbosLifecycleForTests(recordingConfigurator([], seenUrls));
		const releaseHost = acquireDbosLease();
		try {
			const first = await run(greet, {}, { durability: { mode: "durable", systemDatabaseUrl: HOSTED_URL } });
			const second = await run(
				greet,
				{},
				{ durability: { mode: "durable", systemDatabaseUrl: "postgresql://x/y" } },
			);

			assert.equal(first.status, "completed", first.error);
			assert.equal(second.status, "completed", second.error);
			assert.deepEqual(seenUrls, [ENV_URL]);
		} finally {
			await releaseHost();
		}
	});

	test.sequential("durable mode without a URL keeps the default database resolution", async () => {
		withoutInjectedBackend();
		vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
		const seenUrls: (string | undefined)[] = [];
		resetDbosLifecycleForTests(recordingConfigurator([], seenUrls));

		const result = await run(greet, {}, { durability: { mode: "durable" } });

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(seenUrls, [undefined]);
	});

	test.sequential("rejects a different system database URL once DBOS is configured in this process", async () => {
		withoutInjectedBackend();
		vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
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

describe("durable mode fails fast (#3239)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test.sequential("rejects instead of falling back to memory when DBOS cannot start", async () => {
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

	test.sequential("does not reuse an in-memory fallback installed by an earlier default run", async () => {
		withoutInjectedBackend();
		resetDbosLifecycleForTests(async () => {
			throw new Error("postgres unreachable");
		});
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const degraded = await run(greet, {});
			assert.equal(degraded.status, "completed", degraded.error);
			assert.ok(getDurableBackendProcessOwner().initializedBackend instanceof InMemoryDurableBackend);

			await assert.rejects(run(greet, {}, { durability: { mode: "durable" } }), WorkflowDurabilityRequiredError);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	test.sequential("rejects before running on a preset in-memory backend", async () => {
		let executed = false;
		const guarded = workflow({
			name: "sdk-run-durable-guarded",
			description: "Records whether its body ran.",
			outputs: {},
			run: async () => {
				executed = true;
				return {};
			},
		});

		await assert.rejects(
			run(guarded, {}, { durability: { mode: "durable" }, durableBackend: new InMemoryDurableBackend() }),
			WorkflowDurabilityRequiredError,
		);
		assert.equal(executed, false);
	});

	test.sequential("a failed caller-selected database is not told to set DBOS_SYSTEM_DATABASE_URL", async () => {
		withoutInjectedBackend();
		vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
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
});
