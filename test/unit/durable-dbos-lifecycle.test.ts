import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
	type ConfiguredDbosDurability,
	DbosDurableBackend,
	type DbosSdkHandle,
} from "../../packages/workflows/src/durable/dbos-backend.js";
import {
	DbosDurabilityError,
	dbosLifecycleState,
	getReadyDbosBackend,
	resetDbosLifecycleForTests,
	shutdownDbos,
} from "../../packages/workflows/src/durable/dbos-lifecycle.js";

function sdk(events: string[]): DbosSdkHandle {
	return {
		launch: async () => {},
		shutdown: async () => {},
		startWorkflow: async () => {
			events.push("start");
		},
		retrieveWorkflow: async () => undefined,
		cancelWorkflow: async () => {},
		resumeWorkflow: async () => {},
		listAllWorkflows: async () => [],
		listStepRecords: async () => [],
		recordStepOutput: async () => {
			events.push("record");
		},
		deleteWorkflowData: async () => {},
	};
}

function configured(
	events: string[],
	launch: () => Promise<void> = async () => {
		events.push("launch");
	},
	shutdown: () => Promise<void> = async () => {
		events.push("shutdown");
	},
): ConfiguredDbosDurability {
	return {
		backend: new DbosDurableBackend(sdk(events)),
		launch,
		shutdown,
	};
}

afterEach(() => resetDbosLifecycleForTests());

describe("mandatory DBOS lifecycle", () => {
	test.sequential("configures and launches exactly once for concurrent callers", async () => {
		const events: string[] = [];
		let configurationCalls = 0;
		const durability = configured(events);
		resetDbosLifecycleForTests(async () => {
			configurationCalls += 1;
			return durability;
		});

		const backends = await Promise.all([getReadyDbosBackend(), getReadyDbosBackend(), getReadyDbosBackend()]);

		assert.equal(configurationCalls, 1);
		assert.deepEqual(events, ["launch"]);
		assert.ok(backends.every((backend) => backend === durability.backend));
		assert.equal(dbosLifecycleState(), "ready");
	});

	test.sequential("starts local DBOS Postgres once after a default connection refusal", async () => {
		const originalUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		let launchCalls = 0;
		let provisionCalls = 0;
		resetDbosLifecycleForTests(
			async () =>
				configured([], async () => {
					launchCalls += 1;
					if (launchCalls === 1) throw new Error("connect failed with ECONNREFUSED");
				}),
			async () => {
				provisionCalls += 1;
			},
		);
		try {
			await getReadyDbosBackend();
			assert.equal(launchCalls, 2);
			assert.equal(provisionCalls, 1);
			assert.equal(dbosLifecycleState(), "ready");
		} finally {
			if (originalUrl === undefined) delete process.env.DBOS_SYSTEM_DATABASE_URL;
			else process.env.DBOS_SYSTEM_DATABASE_URL = originalUrl;
		}
	});

	test.sequential("memoizes launch failure without selecting another backend", async () => {
		let launchCalls = 0;
		resetDbosLifecycleForTests(async () =>
			configured([], async () => {
				launchCalls += 1;
				throw new Error("postgres unavailable");
			}),
		);

		await assert.rejects(getReadyDbosBackend(), DbosDurabilityError);
		await assert.rejects(getReadyDbosBackend(), /postgres unavailable/);
		assert.equal(launchCalls, 1);
		assert.equal(dbosLifecycleState(), "failed");
	});

	test.sequential("flushes queued writes before shutting DBOS down once", async () => {
		const events: string[] = [];
		resetDbosLifecycleForTests(async () => configured(events));
		const backend = await getReadyDbosBackend();
		backend.registerWorkflow({
			workflowId: "shutdown-order",
			name: "shutdown-order",
			inputs: {},
			createdAt: 1,
			status: "running",
		});

		await Promise.all([shutdownDbos(), shutdownDbos()]);

		assert.equal(events[0], "launch");
		assert.ok(events.includes("start"));
		assert.ok(events.includes("record"));
		assert.equal(events.at(-1), "shutdown");
		assert.equal(events.filter((event) => event === "shutdown").length, 1);
	});

	test.sequential("invokes resolved local teardown after DBOS shutdown", async () => {
		const events: string[] = [];
		resetDbosLifecycleForTests(
			async () => configured(events),
			async () => {},
			async () => {
				events.push("local-shutdown");
			},
		);
		await getReadyDbosBackend();

		await shutdownDbos();

		assert.deepEqual(events.slice(-2), ["shutdown", "local-shutdown"]);
		assert.equal(dbosLifecycleState(), "shut_down");
	});

	test.sequential("shutdown after a configuration failure cleans the local provider without rethrowing", async () => {
		let localShutdowns = 0;
		resetDbosLifecycleForTests(
			async () => {
				throw new Error("initdb: error: cannot be run as root");
			},
			async () => {},
			async () => {
				localShutdowns += 1;
			},
		);

		await assert.rejects(getReadyDbosBackend(), DbosDurabilityError);
		// Session dispose keeps the original configuration failure state but still
		// releases any embedded cluster started before configuration rejected.
		await shutdownDbos();
		await shutdownDbos();
		assert.equal(localShutdowns, 1);
		assert.equal(dbosLifecycleState(), "failed");
	});

	test.sequential("shutdown after a launch failure cleans the local provider without SDK shutdown", async () => {
		const events: string[] = [];
		let localShutdowns = 0;
		resetDbosLifecycleForTests(
			async () =>
				configured(events, async () => {
					throw new Error("postgres unavailable");
				}),
			async () => {},
			async () => {
				localShutdowns += 1;
			},
		);

		await assert.rejects(getReadyDbosBackend(), DbosDurabilityError);
		await shutdownDbos();
		assert.equal(events.filter((event) => event === "shutdown").length, 0);
		assert.equal(localShutdowns, 1);
		assert.equal(dbosLifecycleState(), "failed");
	});

	test.sequential("shutdown after a failed local-provisioning retry cleans the selected provider", async () => {
		const events: string[] = [];
		let launchCalls = 0;
		let localShutdowns = 0;
		const originalUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		resetDbosLifecycleForTests(
			async () =>
				configured(events, async () => {
					launchCalls += 1;
					throw new Error(launchCalls === 1 ? "connect ECONNREFUSED 127.0.0.1:5439" : "retry failed");
				}),
			async () => {
				events.push("provision");
			},
			async () => {
				localShutdowns += 1;
			},
		);
		try {
			await assert.rejects(getReadyDbosBackend(), /retry failed/);
			await shutdownDbos();
			assert.equal(launchCalls, 2);
			assert.ok(events.includes("provision"));
			assert.equal(localShutdowns, 1);
			assert.equal(dbosLifecycleState(), "failed");
		} finally {
			if (originalUrl === undefined) delete process.env.DBOS_SYSTEM_DATABASE_URL;
			else process.env.DBOS_SYSTEM_DATABASE_URL = originalUrl;
		}
	});

	test.sequential("flush failure still attempts SDK and local shutdown", async () => {
		const events: string[] = [];
		const durability = configured(events);
		durability.backend.flush = async () => {
			events.push("flush-failed");
			throw new Error("flush exploded");
		};
		resetDbosLifecycleForTests(
			async () => durability,
			async () => {},
			async () => {
				events.push("local-shutdown");
			},
		);
		await getReadyDbosBackend();

		await assert.rejects(shutdownDbos(), /flush exploded/);

		assert.deepEqual(events.slice(-3), ["flush-failed", "shutdown", "local-shutdown"]);
		assert.equal(dbosLifecycleState(), "failed");
	});

	test.sequential("SDK and local shutdown failures are both surfaced after cleanup", async () => {
		const events: string[] = [];
		resetDbosLifecycleForTests(
			async () =>
				configured(events, undefined, async () => {
					events.push("shutdown-failed");
					throw new Error("sdk exploded");
				}),
			async () => {},
			async () => {
				events.push("local-failed");
				throw new Error("local exploded");
			},
		);
		await getReadyDbosBackend();

		await assert.rejects(shutdownDbos(), /sdk exploded.*local exploded/s);

		assert.deepEqual(events.slice(-2), ["shutdown-failed", "local-failed"]);
		assert.equal(dbosLifecycleState(), "failed");
	});
});
