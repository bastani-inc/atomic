import assert from "node:assert/strict";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { resumeDurableWorkflow } from "../../packages/workflows/src/durable/resume-runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

function fixture(backend = new InMemoryDurableBackend()) {
	const definition = workflow({
		name: "adoption-startup",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => ({}),
	});
	const id = crypto.randomUUID();
	backend.registerWorkflow({
		workflowId: id,
		name: definition.name,
		inputs: {},
		status: "running",
		createdAt: 1,
		updatedAt: 1,
		invocationCwd: process.cwd(),
		modelOwner: "old-session",
		ownerExecutorId: "dead-executor",
		completedCheckpoints: 1,
	});
	const store = createStore();
	const source = {
		id,
		name: definition.name,
		inputs: {},
		startedAt: 1,
		endedAt: 2,
		status: "running" as const,
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
		const f = fixture();
		let controlled: ReturnType<typeof f.store.runs>[number] | undefined;
		const result = await resumeDurableWorkflow(f.id, {
			...f.deps,
			baseRunOpts: {
				...f.deps.baseRunOpts,
				persistence: {
					appendEntry() {
						f.backend.setWorkflowStatus(f.id, status, 2, false);
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

test("adoption failed startup admission preserves newer control metadata (#3419)", async () => {
	class ControlledAdmissionBackend extends InMemoryDurableBackend {
		async admitWorkflow(): Promise<void> {
			throw new Error("admission failed");
		}
		override setWorkflowStatus(...args: Parameters<InMemoryDurableBackend["setWorkflowStatus"]>): void {
			super.setWorkflowStatus(...args);
			if (args[1] === "failed") super.setWorkflowStatus(args[0], "paused", 3, false);
		}
	}
	const f = fixture(new ControlledAdmissionBackend());
	const result = await resumeDurableWorkflow(f.id, f.deps);
	assert.equal(result.ok, false);
	assert.equal(f.backend.getWorkflow(f.id)?.status, "paused");
	assert.equal(f.backend.getWorkflow(f.id)?.pendingPrompts, 3);
	assert.equal(f.backend.getWorkflow(f.id)?.modelOwner, "new-session");
	assert.equal(f.backend.getWorkflow(f.id)?.completedCheckpoints, 1);
});

test("uncontended synchronous adoption rollback retains the adopted owner and checkpoints (#3419)", async () => {
	const f = fixture();
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
	const f = fixture();
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
	const f = fixture();
	const controlled = { ...f.source, status: "paused" as const, endedAt: 3 };
	const result = await resumeDurableWorkflow(f.id, {
		...f.deps,
		jobs: Object.assign(createJobTracker(), {
			register() {
				f.backend.setWorkflowStatus(f.id, "paused", 2, false);
				f.store.recordRunStart(controlled);
				throw new Error("startup registration failed");
			},
		}),
	});
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
	class DelayedClaimBackend extends InMemoryDurableBackend {
		override async transitionWorkflowStatus(...args: Parameters<InMemoryDurableBackend["transitionWorkflowStatus"]>) {
			const accepted = await super.transitionWorkflowStatus(...args);
			claimed.resolve();
			await release.promise;
			settled.resolve();
			return accepted;
		}
	}
	const f = fixture(new DelayedClaimBackend());
	const controller = new AbortController();
	const reason = new Error("abort adoption");
	const pending = resumeDurableWorkflow(f.id, { ...f.deps, signal: controller.signal }).catch((error) => error);
	await claimed.promise;
	controller.abort(reason);
	assert.equal(await pending, reason);
	f.backend.setWorkflowStatus(f.id, "running", 4, false);
	const controlled = f.backend.getWorkflow(f.id);
	release.resolve();
	await settled.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(f.backend.getWorkflow(f.id), controlled);
	assert.equal(f.backend.getWorkflow(f.id)?.modelOwner, "new-session");
	assert.equal(f.deps.jobs.has(f.id), false);
});
