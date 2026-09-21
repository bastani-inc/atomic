import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { resetDbosLifecycleForTests } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import {
	getDurableBackend,
	initializeDurableBackend,
	setDurableBackend,
} from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { prepareWorkflowResumeCatalog } from "../../packages/workflows/src/extension/workflow-durable-resume-command.js";

const PROVISIONING_FAILURE = "initdb: error: cannot be run as root";
const EXPECTED_DEGRADATION_WARNING =
	"atomic-workflows: durable backend unavailable — continuing NON-DURABLY with an in-memory backend. " +
	"Workflow runs will execute, but their state will not survive this process and `/workflow resume` " +
	`after exit will not work. Restore durability by fixing Postgres provisioning: DBOS workflow durability configuration failed: ${PROVISIONING_FAILURE}. Set DBOS_SYSTEM_DATABASE_URL to an existing Postgres when local provisioning is unavailable.`;

afterEach(() => {
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

describe("durable factory non-durable degradation", () => {
	test.sequential("routes one warning through a UI sink while concurrent callers share the fallback", async () => {
		setDurableBackend(undefined); // clear the preload-injected test backend
		resetDbosLifecycleForTests(async () => {
			throw new Error(PROVISIONING_FAILURE);
		});
		const notifications: string[] = [];
		const consoleWarnings: string[] = [];
		const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleWarnings.push(args.map(String).join(" "));
		});
		try {
			const notify = (message: string): void => {
				notifications.push(message);
			};
			const [first, second] = await Promise.all([
				initializeDurableBackend(notify),
				initializeDurableBackend(notify),
			]);

			assert.ok(first instanceof InMemoryDurableBackend);
			assert.equal(first.persistent, false);
			assert.equal(second, first);
			assert.equal(await initializeDurableBackend(notify), first);
			assert.equal(getDurableBackend(), first);
			assert.deepEqual(notifications, [EXPECTED_DEGRADATION_WARNING]);
			assert.equal(consoleWarnings.filter((message) => message.includes("NON-DURABLY")).length, 0);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	test.sequential("prints one actionable warning when no UI sink is available", async () => {
		setDurableBackend(undefined);
		resetDbosLifecycleForTests(async () => {
			throw new Error(PROVISIONING_FAILURE);
		});
		const warnings: string[] = [];
		const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
		try {
			const [first, second] = await Promise.all([initializeDurableBackend(), initializeDurableBackend()]);

			assert.ok(first instanceof InMemoryDurableBackend);
			assert.equal(second, first);
			assert.deepEqual(
				warnings.filter((message) => message.includes("NON-DURABLY")),
				[EXPECTED_DEGRADATION_WARNING],
			);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	test.sequential("a throwing UI sink cannot block the in-memory fallback", async () => {
		setDurableBackend(undefined);
		resetDbosLifecycleForTests(async () => {
			throw new Error(PROVISIONING_FAILURE);
		});
		const warnings: string[] = [];
		const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
		try {
			let publishedBackend: ReturnType<typeof getDurableBackend> | undefined;
			const backend = await initializeDurableBackend(() => {
				publishedBackend = getDurableBackend();
				throw new Error("UI transport unavailable");
			});

			assert.ok(backend instanceof InMemoryDurableBackend);
			assert.equal(backend.persistent, false);
			assert.equal(publishedBackend, backend);
			assert.deepEqual(
				warnings.filter((message) => message.includes("NON-DURABLY")),
				[EXPECTED_DEGRADATION_WARNING],
			);
		} finally {
			consoleSpy.mockRestore();
		}
	});

	test.sequential("a provisionable DBOS backend is preferred and produces no degradation warning", async () => {
		const warnings: string[] = [];
		setDurableBackend(undefined); // clear the preload-injected test backend
		const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
		try {
			const backend = await initializeDurableBackendWithFakeDbos();
			assert.equal(backend.persistent, true);
			assert.equal(warnings.filter((message) => message.includes("NON-DURABLY")).length, 0);
		} finally {
			consoleSpy.mockRestore();
		}
	});
	test.sequential("failed launch shuts the partial executor down before the in-memory fallback", async () => {
		setDurableBackend(undefined);
		const events: string[] = [];
		const { DbosDurableBackend } = await import("../../packages/workflows/src/durable/dbos-backend.js");
		const sdk = {
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
		resetDbosLifecycleForTests(async () => ({
			backend: new DbosDurableBackend(sdk),
			launch: async () => {
				throw new Error("postgres unavailable");
			},
			shutdown: async () => {
				events.push("shutdown");
			},
		}));
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const backend = await initializeDurableBackend();
			assert.equal(backend.persistent, false);
			assert.ok(events.includes("shutdown"));
		} finally {
			consoleSpy.mockRestore();
		}
	});

	test.sequential("an in-flight durable catalog preparation keeps the backend that initialization returned", async () => {
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({
			workflowId: "stable-catalog-backend",
			name: "stable-catalog",
			inputs: {},
			status: "paused",
			createdAt: 1,
			completedCheckpoints: 1,
		});
		setDurableBackend(backend);
		const runtime = createExtensionRuntime({ definitions: [], durabilityWarningSink: () => undefined });

		const preparation = prepareWorkflowResumeCatalog(runtime, new Set());
		setDurableBackend(undefined);

		const catalog = await preparation;
		assert.deepEqual(
			catalog.resumable.map((entry) => entry.workflowId),
			["stable-catalog-backend"],
		);
	});
});

test("unconfirmed executor cleanup refuses the in-memory backend", async () => {
	setDurableBackend(undefined);
	const warnings = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await assert.rejects(
			initializeDurableBackendWithFakeDbos({
				launch: async () => {
					throw new Error("original launch failed");
				},
				shutdown: async () => {
					throw new Error("executor teardown failed");
				},
			}),
			/cleanup failed.*original launch failed.*executor teardown failed/s,
		);
		assert.throws(getDurableBackend, /not ready/i);
		assert.equal(warnings.mock.calls.length, 0);
	} finally {
		warnings.mockRestore();
	}
});

async function initializeDurableBackendWithFakeDbos(
	options: { launch?: () => Promise<void>; shutdown?: () => Promise<void> } = {},
) {
	const { DbosDurableBackend } = await import("../../packages/workflows/src/durable/dbos-backend.js");
	const sdk = {
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
	resetDbosLifecycleForTests(async () => ({
		backend: new DbosDurableBackend(sdk),
		launch: options.launch ?? (async () => {}),
		shutdown: options.shutdown ?? (async () => {}),
	}));
	return await initializeDurableBackend();
}
