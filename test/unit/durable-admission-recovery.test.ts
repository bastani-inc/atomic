import assert from "node:assert/strict";
import { test } from "vitest";
import { DbosDependencyError, dbosAdmissionContext } from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { getAtomicExecutorId } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

// #3074: reset removes outage history before admitting an unrelated root.
test("reset clears failed admission state and its readiness fence", async () => {
	const sdk = createMockSdk();
	let fail = true;
	let readinessChecks = 0;
	const backend = new DbosDurableBackend(
		{
			...sdk,
			async startWorkflow(id, name, inputs) {
				if (fail) throw new DbosDependencyError();
				return sdk.startWorkflow(id, name, inputs);
			},
		},
		{
			checkReady: async () => {
				readinessChecks++;
			},
		},
	);
	const registration = (workflowId: string) => ({
		workflowId,
		name: "test",
		inputs: {},
		createdAt: 1,
		status: "running" as const,
	});
	await assert.rejects(backend.admitWorkflow("old", registration("old"), new AbortController().signal));
	assert.equal(backend.isAdmissionUnavailable("old"), true);
	backend.reset();
	assert.equal(backend.isAdmissionUnavailable("old"), false);
	fail = false;
	await backend.admitWorkflow("new", registration("new"), new AbortController().signal);
	assert.equal(readinessChecks, 0);
});

// #3072/#3074: owned admission faults only, no external database is contacted.
for (const accepted of [false, true]) {
	test(`explicit reconciliation retains the id and fenced owner after root acceptance=${accepted} (#3419)`, async () => {
		const sdk = createMockSdk();
		let fail = true;
		const backend = new DbosDurableBackend({
			...sdk,
			async startWorkflow(id, name, inputs) {
				if (!fail || accepted) {
					await sdk.startWorkflow(id, name, inputs);
					sdk.state.workflows.set(id, { workflowId: id, name, inputs, status: "SUCCESS", createdAt: 1 });
				}
				if (fail) throw new DbosDependencyError();
			},
		});
		await assert.rejects(
			backend.admitWorkflow(
				"same-id",
				{ workflowId: "same-id", name: "test", inputs: { x: 1 }, createdAt: 1, status: "running" },
				new AbortController().signal,
			),
			DbosDependencyError,
		);
		assert.equal(backend.isAdmissionUnavailable("same-id"), true);
		const before = sdk.state.steps.size;
		await backend.hydrateWorkflow("same-id");
		assert.equal(sdk.state.steps.size, before, "inspection must not repair or create durable state");
		fail = false;
		await Promise.all([backend.reconcileWorkflowAdmission("same-id"), backend.reconcileWorkflowAdmission("same-id")]);
		assert.equal(backend.isAdmissionUnavailable("same-id"), false);
		assert.equal(backend.getWorkflow("same-id")?.status, "blocked");
		assert.deepEqual(
			backend.listResumableWorkflows().map((entry) => entry.workflowId),
			["same-id"],
		);
		const fresh = new DbosDurableBackend(sdk);
		await fresh.hydrateWorkflow("same-id");
		assert.equal(fresh.getWorkflow("same-id")?.name, "test");
		assert.equal(fresh.getWorkflow("same-id")?.status, "blocked");
		assert.equal(fresh.getWorkflow("same-id")?.ownerExecutorId, getAtomicExecutorId());
		assert.equal(sdk.state.workflows.size, 1);
	});
}

test("reconciliation refuses conflicting root identity and unproven orphan records", async () => {
	for (const conflict of ["inputs", "checkpoint"]) {
		const sdk = createMockSdk();
		const backend = new DbosDurableBackend({
			...sdk,
			async startWorkflow() {
				throw new DbosDependencyError();
			},
		});
		await assert.rejects(
			backend.admitWorkflow(
				"id",
				{ workflowId: "id", name: "test", inputs: {}, createdAt: 1, status: "running" },
				new AbortController().signal,
			),
		);
		if (conflict === "inputs")
			sdk.state.workflows.set("id", {
				workflowId: "id",
				name: "test",
				inputs: { foreign: true },
				status: "SUCCESS",
				createdAt: 1,
			});
		else sdk.state.steps.set("id:checkpoint:foreign", "unproven");
		const before = [...sdk.state.steps];
		await backend.reconcileWorkflowAdmission("id");
		assert.equal(backend.isWorkflowLoadable("id"), false);
		assert.deepEqual([...sdk.state.steps], before);
		assert.equal(sdk.state.starts.length, 0);
	}
});

test("a stale running resume observation cannot claim a later running generation", async () => {
	const baseSdk = createMockSdk();
	// Real DBOS step ids are first-writer-wins.
	const sdk: ReturnType<typeof createMockSdk> = {
		...baseSdk,
		async recordStepOutput(id, step, value) {
			if (!baseSdk.state.steps.has(`${id}:checkpoint:${step}`)) await baseSdk.recordStepOutput(id, step, value);
		},
	};
	const first = new DbosDurableBackend(sdk);
	first.registerWorkflow({
		workflowId: "id",
		name: "test",
		inputs: {},
		status: "running",
		createdAt: 1,
		updatedAt: 1,
	});
	await first.flush();
	const second = new DbosDurableBackend(sdk);
	await second.hydrateWorkflow("id");
	const observed = second.getWorkflow("id")!.updatedAt;
	assert.equal(
		await first.transitionWorkflowStatus("id", ["running"], "running", undefined, undefined, observed),
		true,
	);
	assert.equal(
		await second.transitionWorkflowStatus("id", ["running"], "running", undefined, undefined, observed),
		false,
	);
	assert.equal(sdk.state.resumes.length, 1);
});

test("a lost metadata acknowledgement is reconciled without replacing its identity", async () => {
	const sdk = createMockSdk();
	let fail = true;
	const backend = new DbosDurableBackend(
		{
			...sdk,
			async recordStepOutput(...args) {
				await sdk.recordStepOutput(...args);
				if (fail) throw new DbosDependencyError();
			},
		},
		{ executorId: "owner" },
	);
	await assert.rejects(
		backend.admitWorkflow(
			"id",
			{ workflowId: "id", name: "test", inputs: {}, createdAt: 1, status: "running", resumable: true },
			new AbortController().signal,
		),
	);
	fail = false;
	await backend.reconcileWorkflowAdmission("id");
	assert.equal(backend.getWorkflow("id")?.status, "blocked");
	assert.equal(backend.isAdmissionUnavailable("id"), false);
	assert.equal(sdk.state.starts.length, 1);
});

test("cancelled admission is never repaired into a resumable invocation", async () => {
	const sdk = createMockSdk();
	const backend = new DbosDurableBackend({
		...sdk,
		async startWorkflow() {
			throw new DbosDependencyError();
		},
	});
	await assert.rejects(
		backend.admitWorkflow(
			"id",
			{ workflowId: "id", name: "test", inputs: {}, createdAt: 1, status: "running" },
			new AbortController().signal,
		),
	);
	// Local cancellation is authoritative even when its database write is impossible.
	const fence = new AbortController();
	fence.abort();
	dbosAdmissionContext.run(fence.signal, () => backend.setWorkflowStatus("id", "cancelled", undefined, false));
	await backend.reconcileWorkflowAdmission("id");
	assert.equal(backend.getWorkflow("id")?.status, "cancelled");
	assert.equal(sdk.state.starts.length, 0);
	assert.equal(sdk.state.steps.size, 0);
});

test("cancellation while recovery reads identity prevents late repair and dispatch", async () => {
	const sdk = createMockSdk();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const backend = new DbosDurableBackend({
		...sdk,
		async startWorkflow() {
			throw new DbosDependencyError();
		},
		async retrieveWorkflow(id) {
			entered.resolve();
			await release.promise;
			return sdk.retrieveWorkflow(id);
		},
	});
	await assert.rejects(
		backend.admitWorkflow(
			"id",
			{ workflowId: "id", name: "test", inputs: {}, createdAt: 1, status: "running" },
			new AbortController().signal,
		),
	);
	const recovery = backend.reconcileWorkflowAdmission("id");
	const rejected = assert.rejects(recovery, /superseded by terminal control/);
	await entered.promise;
	const fence = new AbortController();
	fence.abort();
	dbosAdmissionContext.run(fence.signal, () => backend.setWorkflowStatus("id", "cancelled", undefined, false));
	release.resolve();
	await rejected;
	assert.equal(backend.getWorkflow("id")?.status, "cancelled");
	assert.equal(backend.getWorkflow("id")?.resumable, false);
	assert.equal(sdk.state.starts.length, 0);
	assert.equal(sdk.state.steps.size, 0);
});

test("valid but conflicting metadata never replaces the retained invocation", async () => {
	const sdk = createMockSdk();
	const backend = new DbosDurableBackend({
		...sdk,
		async startWorkflow() {
			throw new DbosDependencyError();
		},
	});
	await assert.rejects(
		backend.admitWorkflow(
			"id",
			{ workflowId: "id", name: "expected", inputs: {}, createdAt: 1, status: "running" },
			new AbortController().signal,
		),
	);
	const foreign = new DbosDurableBackend(sdk);
	foreign.registerWorkflow({
		workflowId: "id",
		name: "foreign",
		inputs: { foreign: true },
		createdAt: 1,
		status: "blocked",
		resumable: true,
	});
	await foreign.flush();
	// Root identity matches, so the metadata itself must also be checked.
	sdk.state.workflows.set("id", { workflowId: "id", name: "expected", inputs: {}, status: "SUCCESS", createdAt: 1 });
	const before = [...sdk.state.steps];
	await backend.reconcileWorkflowAdmission("id");
	assert.equal(backend.isWorkflowLoadable("id"), false);
	assert.deepEqual(backend.listResumableWorkflows(), []);
	assert.deepEqual([...sdk.state.steps], before);
});
