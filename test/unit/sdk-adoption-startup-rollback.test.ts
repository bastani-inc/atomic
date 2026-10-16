import assert from "node:assert/strict";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import {
	createMemoryTestBackend,
	type MemoryJournalBackend as InMemoryDurableBackend,
} from "../helpers/workflow-journal.js";

async function fixture(
	backend: Awaited<ReturnType<typeof createMemoryTestBackend>> | undefined = undefined,
	overrides: Partial<Parameters<InMemoryDurableBackend["registerWorkflow"]>[0]> = {},
) {
	backend ??= await createMemoryTestBackend();

	backend.workflowOwnership = async () => "available";
	const definition = workflow({
		name: "adoption-startup",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => ({}),
	});
	const id = crypto.randomUUID();
	await backend.registerWorkflow({
		workflowId: id,
		name: definition.name,
		inputs: {},
		status: "running",
		createdAt: 1,
		updatedAt: 1,
		invocationCwd: process.cwd(),
		modelOwner: "old-session",
		ownerExecutorId: "atomic-db-00000000-0000-4000-8000-000000000001",
		ownerLiveness: "dead",
		completedCheckpoints: 1,
		...overrides,
	});
	const store = createStore();
	const source = {
		id,
		name: definition.name,
		inputs: {},
		startedAt: 1,
		endedAt: 2,
		status: "running" as const,
		toolNodes: [],
		stages: [],
	};
	store.recordRunStart(source);
	return {
		id,
		backend,
		store,
		source,
		deps: {
			registry: createRegistry([definition]),
			durableBackend: backend,
			jobs: createJobTracker(),
			baseRunOpts: { store, cwd: process.cwd(), modelOwner: "new-session" },
		},
	};
}

for (const status of ["running", "paused", "cancelled", "completed"] as const) {
	test(`adoption failed startup preserves newer ${status} control and snapshot (#3419)`, async () => {
		const f = await fixture();
		let controlled: ReturnType<typeof f.store.runs>[number] | undefined;
		const result = await resumeDurableWorkflow(f.id, {
			...f.deps,
			baseRunOpts: {
				...f.deps.baseRunOpts,
				persistence: {
					async appendEntry() {
						await f.backend.setWorkflowStatus(f.id, status, 2, false);
						controlled = { ...f.source, status: status === "cancelled" ? "failed" : status, endedAt: 3 };
						f.store.recordRunStart(controlled);
						throw new Error("startup write failed");
					},
				},
			},
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "startup_failed");
		assert.equal(f.backend.getWorkflow(f.id)?.status, status);
		assert.equal(f.backend.getWorkflow(f.id)?.modelOwner, "new-session");
		assert.equal(f.backend.getWorkflow(f.id)?.pendingPrompts, 2);
		assert.equal(f.backend.getWorkflow(f.id)?.completedCheckpoints, 1);
		assert.equal(f.store.runs()[0], controlled);
	});
}

test("uncontended synchronous adoption rollback retains the adopted owner and checkpoints (#3419)", async () => {
	const f = await fixture();
	const result = await resumeDurableWorkflow(f.id, {
		...f.deps,
		jobs: Object.assign(createJobTracker(), {
			register() {
				throw new Error("startup registration failed");
			},
		}),
	});
	assert.equal(result.ok, false);
	assert.equal(f.backend.getWorkflow(f.id)?.status, "running");
	assert.equal(f.backend.getWorkflow(f.id)?.modelOwner, "new-session");
	assert.equal(f.backend.getWorkflow(f.id)?.completedCheckpoints, 1);
	assert.equal(f.store.runs()[0], f.source);
});

test("adoption preserves current startup failure metadata rather than restoring running (#3419)", async () => {
	const f = await fixture();
	const result = await resumeDurableWorkflow(f.id, {
		...f.deps,
		baseRunOpts: {
			...f.deps.baseRunOpts,
			persistence: {
				appendEntry() {
					throw new Error("startup write failed");
				},
			},
		},
	});
	assert.equal(result.ok, false);
	assert.equal(f.backend.getWorkflow(f.id)?.status, "failed");
	assert.match(f.backend.getWorkflow(f.id)?.error ?? "", /startup write failed/);
	assert.equal(f.backend.getWorkflow(f.id)?.modelOwner, "new-session");
	assert.equal(f.backend.getWorkflow(f.id)?.completedCheckpoints, 1);
});

test("synchronous adoption launch refusal preserves newer pause and snapshot (#3419)", async () => {
	const f = await fixture();
	const controlled = { ...f.source, status: "paused" as const, endedAt: 3 };
	let pauseWrite = Promise.resolve();
	const result = await resumeDurableWorkflow(f.id, {
		...f.deps,
		jobs: Object.assign(createJobTracker(), {
			register() {
				pauseWrite = f.backend.setWorkflowStatus(f.id, "paused", 2, false);
				f.store.recordRunStart(controlled);
				throw new Error("startup registration failed");
			},
		}),
	});
	await pauseWrite;
	assert.equal(result.ok, false);
	assert.equal(f.backend.getWorkflow(f.id)?.status, "paused");
	assert.equal(f.backend.getWorkflow(f.id)?.modelOwner, "new-session");
	assert.equal(f.backend.getWorkflow(f.id)?.pendingPrompts, 2);
	assert.equal(f.store.runs()[0], controlled);
});

test("aborted adoption claim retains newer running metadata without launching (#3419)", async () => {
	const claimed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const settled = Promise.withResolvers<void>();
	async function createDelayedClaimBackend() {
		const backend = Object.assign(await createMemoryTestBackend(), {});
		const basetransitionWorkflowStatus = backend.transitionWorkflowStatus.bind(backend);
		return Object.assign(backend, {
			async transitionWorkflowStatus(...args: Parameters<InMemoryDurableBackend["transitionWorkflowStatus"]>) {
				const accepted = await basetransitionWorkflowStatus(...args);
				claimed.resolve();
				await release.promise;
				settled.resolve();
				return accepted;
			},
		});
	}
	const f = await fixture(await createDelayedClaimBackend());
	const controller = new AbortController();
	const reason = new Error("abort adoption");
	const pending = resumeDurableWorkflow(f.id, { ...f.deps, signal: controller.signal }).catch((error) => error);
	await claimed.promise;
	controller.abort(reason);
	assert.equal(await pending, reason);
	await f.backend.setWorkflowStatus(f.id, "running", 4, false);
	const controlled = f.backend.getWorkflow(f.id);
	release.resolve();
	await settled.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(f.backend.getWorkflow(f.id), controlled);
	assert.equal(f.backend.getWorkflow(f.id)?.modelOwner, "new-session");
	assert.equal(f.deps.jobs.has(f.id), false);
});

test("failed startup of a released-owner adoption restores the paused run under the adopter (#3566)", async () => {
	const f = await fixture(await createMemoryTestBackend(), {
		status: "paused",
		releasedModelOwner: "old-session",
		ownerLiveness: "alive",
	});
	const result = await resumeDurableWorkflow(f.id, {
		...f.deps,
		jobs: Object.assign(createJobTracker(), {
			register() {
				throw new Error("startup registration failed");
			},
		}),
	});
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.reason, "startup_failed");
	const handle = f.backend.getWorkflow(f.id);
	assert.equal(handle?.status, "paused");
	assert.equal(handle?.modelOwner, "new-session");
	assert.equal(handle?.releasedModelOwner, undefined);
	assert.equal(handle?.completedCheckpoints, 1);
	assert.equal(f.store.runs()[0], f.source);
});
