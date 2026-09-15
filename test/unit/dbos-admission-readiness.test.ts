import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { DbosDependencyError } from "../../packages/workflows/src/durable/dbos-admission.js";
import { configureDbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import {
	DbosDurabilityError,
	dbosLifecycleState,
	getReadyDbosBackend,
	resetDbosLifecycleForTests,
	shutdownDbos,
} from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { getDbosProcessOwner } from "../../packages/workflows/src/durable/dbos-process-owner.js";
import {
	getDurableBackend,
	initializeDurableBackend,
	setDurableBackend,
} from "../../packages/workflows/src/durable/factory.js";
import { admitDurableRootRun } from "../../packages/workflows/src/engine/run-durable-admission.js";

const fake = vi.hoisted(() => ({ healthy: true, checks: 0, starts: 0, shutdowns: 0 }));
vi.mock("../../packages/workflows/src/durable/dbos-admission-config.js", () => ({
	configureAdmissionDatabase: () => ({
		launch: async () => {},
		checkReady: async () => {
			fake.checks++;
			if (!fake.healthy) throw new DbosDependencyError();
		},
	}),
}));
vi.mock("@dbos-inc/dbos-sdk", () => ({
	DBOS: {
		registerWorkflow: (fn: () => Promise<void>) => fn,
		startWorkflow: () => async () => {
			fake.starts++;
			if (!fake.healthy) throw new DbosDependencyError();
			return { getResult: async () => undefined };
		},
		shutdown: async () => {
			fake.shutdowns++;
		},
	},
}));

afterEach(() => {
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

// #3072: loss invalidates admission, not the launched executor or mirror access.
test("admission loss preserves synchronous access and predecessor shutdown eligibility", async () => {
	Object.assign(fake, { healthy: true, checks: 0, starts: 0, shutdowns: 0 });
	setDurableBackend(undefined);
	resetDbosLifecycleForTests(
		() => configureDbosDurableBackend(),
		async () => {},
		async () => {},
	);
	const backend = await initializeDurableBackend();
	fake.healthy = false;
	const admit = () =>
		admitDurableRootRun({
			backend,
			runId: "isolated-readiness",
			isChildRun: false,
			registration: {
				workflowId: "isolated-readiness",
				name: "readiness",
				inputs: {},
				status: "running",
				createdAt: 1,
				updatedAt: 1,
			},
		});
	await assert.rejects(admit(), DbosDependencyError);
	assert.equal(getDurableBackend(), backend);
	assert.equal(await initializeDurableBackend(), backend);
	assert.equal(dbosLifecycleState(), "ready", "predecessor shutdown only recognizes ready executors");
	assert.equal(getDbosProcessOwner().failure, undefined);
	await assert.rejects(admit(), DbosDependencyError);
	assert.equal(fake.starts, 1, "invalidated admission must check health before new registration");
	fake.healthy = true;
	await admit();
	assert.equal(fake.checks, 2);
	assert.equal(fake.starts, 3, "successful admission starts root and metadata exactly once");
	await shutdownDbos();
	assert.equal(fake.shutdowns, 1);
});

// #3072 / #2022: a predecessor's active object has only backend/launch/shutdown.
test("reused wrappers recover without adding members to the shared owner", async () => {
	Object.assign(fake, { healthy: true, checks: 0, starts: 0, shutdowns: 0 });
	setDurableBackend(undefined);
	resetDbosLifecycleForTests(
		() => configureDbosDurableBackend(),
		async () => {},
		async () => {},
	);
	await initializeDurableBackend();
	const owner = getDbosProcessOwner();
	assert.deepEqual(Object.keys(owner.active ?? {}).sort(), ["backend", "launch", "shutdown"]);
	const { backend } = await configureDbosDurableBackend();
	const admit = () =>
		admitDurableRootRun({
			backend,
			runId: "isolated-predecessor",
			isChildRun: false,
			registration: {
				workflowId: "isolated-predecessor",
				name: "predecessor",
				inputs: {},
				status: "running",
				createdAt: 1,
				updatedAt: 1,
			},
		});
	fake.healthy = false;
	await assert.rejects(admit(), DbosDependencyError);
	assert.equal(owner.state, "ready");
	assert.equal(owner.failure, undefined);
	fake.healthy = true;
	await admit();
	assert.equal(fake.checks, 0, "predecessor wrapper reuse recovers through admission writes");
	assert.equal(fake.starts, 3);
	await shutdownDbos();
	assert.equal(fake.shutdowns, 1);
});

// #3072: admission invalidation does not change first-initialization fallback.
for (const phase of ["configuration", "launch"] as const) {
	test(`initial ${phase} dependency failure stays memoized through lifecycle wrapping`, async () => {
		setDurableBackend(undefined);
		const dependency = new DbosDependencyError();
		const configure = vi.fn(async () => {
			if (phase === "configuration") throw dependency;
			return {
				...(await configureDbosDurableBackend()),
				launch: async () => {
					throw dependency;
				},
			};
		});
		resetDbosLifecycleForTests(
			configure,
			async () => {},
			async () => {},
		);
		await assert.rejects(getReadyDbosBackend(), (error) => {
			assert.ok(error instanceof DbosDurabilityError);
			assert.equal(error.cause, dependency);
			assert.equal("code" in error, false);
			return true;
		});
		const warning = vi.fn();
		const backend = await initializeDurableBackend(warning);
		assert.equal(backend.persistent, false);
		assert.equal(await initializeDurableBackend(), backend);
		assert.equal(configure.mock.calls.length, 1);
		assert.equal(warning.mock.calls.length, 1);
		assert.match(warning.mock.calls[0]?.[0], /NON-DURABLY/);
		assert.equal(dbosLifecycleState(), "failed");
	});
}
