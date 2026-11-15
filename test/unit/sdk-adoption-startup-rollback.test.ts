import assert from "node:assert/strict";
import { test, vi } from "vitest";
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
	overrides: Partial<Parameters<InMemoryDurableBackend["commitWorkflowRegistration"]>[0]> = {},
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
	await backend.commitWorkflowRegistration({
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
						await f.backend.commitWorkflowStatus(f.id, status, 2, false);
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
				pauseWrite = f.backend.commitWorkflowStatus(f.id, "paused", 2, false);
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
		const basetransitionWorkflowStatus = backend.commitWorkflowStatusTransition.bind(backend);
		return Object.assign(backend, {
			async commitWorkflowStatusTransition(
				...args: Parameters<InMemoryDurableBackend["commitWorkflowStatusTransition"]>
			) {
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
	await f.backend.commitWorkflowStatus(f.id, "running", 4, false);
	const controlled = f.backend.getWorkflow(f.id);
	release.resolve();
	await settled.promise;
	// #5149: the newer metadata stays, and the aborted adopter gives the run back to its previous owner.
	await vi.waitFor(() => assert.equal(f.backend.getWorkflow(f.id)?.modelOwner, "old-session"));
	const handle = f.backend.getWorkflow(f.id);
	assert.deepEqual(
		[handle?.status, handle?.pendingPrompts, handle?.resumable],
		[controlled?.status, controlled?.pendingPrompts, controlled?.resumable],
	);
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

test("an abort during the adoption claim restores the released run's paused status and owner (#5149)", async () => {
	const claimed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const backend = await createMemoryTestBackend();
	const claim = backend.commitWorkflowStatusTransition.bind(backend);
	let calls = 0;
	backend.commitWorkflowStatusTransition = async (...args) => {
		const accepted = await claim(...args);
		calls += 1;
		if (calls === 1) {
			claimed.resolve();
			await release.promise;
		}
		return accepted;
	};
	const f = await fixture(backend, { status: "paused", releasedModelOwner: "old-session", ownerLiveness: "alive" });
	const controller = new AbortController();
	const reason = new Error("abort adoption");
	const pending = resumeDurableWorkflow(f.id, { ...f.deps, signal: controller.signal }).catch((error) => error);
	await claimed.promise;
	controller.abort(reason);
	release.resolve();
	assert.equal(await pending, reason);
	await vi.waitFor(() => {
		const handle = f.backend.getWorkflow(f.id);
		assert.deepEqual(
			[handle?.status, handle?.modelOwner, handle?.releasedModelOwner],
			["paused", "old-session", "old-session"],
		);
	});
	assert.equal(f.deps.jobs.has(f.id), false);
});

/** Holds the first status transition (the adoption claim) until `release`, and reports the claim. */
function holdClaim(backend: InMemoryDurableBackend) {
	const claimed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const claim = backend.commitWorkflowStatusTransition.bind(backend);
	let calls = 0;
	backend.commitWorkflowStatusTransition = async (...args) => {
		const accepted = await claim(...args);
		calls += 1;
		if (calls === 1) {
			claimed.resolve();
			await release.promise;
		}
		return accepted;
	};
	return { claimed: claimed.promise, release: () => release.resolve() };
}

/** Runs `write` once, as the executor a resume launched is about to register the run it claimed. */
function beforeExecutorRegisters(
	backend: InMemoryDurableBackend,
	f: { readonly id: string; readonly deps: { readonly jobs: ReturnType<typeof createJobTracker> } },
	write: () => Promise<void>,
): void {
	let done = false;
	const before = async (): Promise<void> => {
		if (done || !f.deps.jobs.has(f.id)) return;
		done = true;
		await write();
	};
	const register = backend.commitWorkflowRegistration.bind(backend);
	backend.commitWorkflowRegistration = async (...args) => {
		await before();
		return await register(...args);
	};
	const registerClaimed = backend.commitClaimedWorkflowRegistration.bind(backend);
	backend.commitClaimedWorkflowRegistration = async (...args) => {
		await before();
		return await registerClaimed(...args);
	};
}

const RELEASED = { status: "paused", releasedModelOwner: "old-session", ownerLiveness: "alive" } as const;

for (const [label, status, pendingPrompts, resumable] of [
	["pending prompts", "running", 4, undefined],
	["resumability", "running", undefined, false],
	["pause", "paused", undefined, undefined],
] as const) {
	test(`an aborted adoption of a released run keeps the ${label} a write during the claim recorded, and returns the run to its previous owner (#5149)`, async () => {
		const backend = await createMemoryTestBackend();
		const held = holdClaim(backend);
		const f = await fixture(backend, RELEASED);
		const controller = new AbortController();
		const reason = new Error("abort adoption");
		const pending = resumeDurableWorkflow(f.id, { ...f.deps, signal: controller.signal }).catch((error) => error);
		await held.claimed;
		controller.abort(reason);
		await f.backend.commitWorkflowStatus(f.id, status, pendingPrompts, resumable);
		const written = f.backend.getWorkflow(f.id);
		held.release();
		assert.equal(await pending, reason);
		// The caller is released at once; the claim is undone once it settles.
		await vi.waitFor(() => {
			const handle = f.backend.getWorkflow(f.id);
			assert.deepEqual(
				{
					status: handle?.status,
					pendingPrompts: handle?.pendingPrompts,
					resumable: handle?.resumable,
					modelOwner: handle?.modelOwner,
					releasedModelOwner: handle?.releasedModelOwner,
				},
				{
					status: "paused",
					pendingPrompts: written?.pendingPrompts,
					resumable: written?.resumable,
					modelOwner: "old-session",
					releasedModelOwner: "old-session",
				},
			);
		});
		assert.equal(f.deps.jobs.has(f.id), false);
	});
}

for (const [kind, overrides, status] of [
	["crashed", {}, "running"],
	["released", RELEASED, "paused"],
] as const) {
	test(`an abort while the executor of a ${kind} run's adoption starts stops it and returns the run, still resumable, to its previous owner (#5149)`, async () => {
		const backend = await createMemoryTestBackend();
		const f = await fixture(backend, overrides);
		const controller = new AbortController();
		const reason = new Error("abort adoption");
		let aborted = false;
		beforeExecutorRegisters(backend, f, async () => {
			aborted = true;
			controller.abort(reason);
		});
		const result = await resumeDurableWorkflow(f.id, { ...f.deps, signal: controller.signal }).catch(
			(error) => error,
		);
		assert.equal(aborted, true);
		assert.equal(result, reason);
		await vi.waitFor(() => assert.equal(f.deps.jobs.has(f.id), false));
		await vi.waitFor(() => {
			const handle = f.backend.getWorkflow(f.id);
			assert.deepEqual(
				{
					status: handle?.status,
					resumable: handle?.resumable !== false,
					modelOwner: handle?.modelOwner,
					releasedModelOwner: handle?.releasedModelOwner,
				},
				{
					status,
					resumable: true,
					modelOwner: "old-session",
					releasedModelOwner: kind === "released" ? "old-session" : undefined,
				},
			);
		});
	});
}

test("an abort after the adopted executor is admitted does not undo the resume (#5149)", async () => {
	const backend = await createMemoryTestBackend();
	backend.workflowOwnership = async () => "available";
	const controller = new AbortController();
	const finish = Promise.withResolvers<void>();
	const definition = workflow({
		name: "adoption-startup",
		description: "",
		inputs: {},
		outputs: {},
		run: async () => {
			// The body runs only once the executor was admitted.
			controller.abort(new Error("abort adoption"));
			await finish.promise;
			return {};
		},
	});
	const f = await fixture(backend, RELEASED);
	try {
		const result = await resumeDurableWorkflow(f.id, {
			...f.deps,
			registry: createRegistry([definition]),
			signal: controller.signal,
		});
		assert.equal(controller.signal.aborted, true);
		assert.equal(result.ok, true);
		assert.equal(f.deps.jobs.has(f.id), true);
		assert.equal(f.backend.getWorkflow(f.id)?.status, "running");
		assert.equal(f.backend.getWorkflow(f.id)?.modelOwner, "new-session");
	} finally {
		finish.resolve();
		await f.deps.jobs.get(f.id)?.promise;
	}
});

for (const [kind, overrides] of [
	["crashed", {}],
	["released", RELEASED],
] as const) {
	test(`a pause written before the executor of a ${kind} run's adoption registers stops the executor and keeps the run paused (#5149)`, async () => {
		const backend = await createMemoryTestBackend();
		const f = await fixture(backend, { ...overrides, pendingPrompts: 1, resumable: true });
		let wrote = false;
		beforeExecutorRegisters(backend, f, async () => {
			wrote = true;
			await backend.commitWorkflowStatusTransition(f.id, ["running"], "paused", 1, true);
		});
		const result = await resumeDurableWorkflow(f.id, f.deps);
		assert.equal(wrote, true);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "stale");
		await vi.waitFor(() => assert.equal(f.deps.jobs.has(f.id), false));
		const handle = f.backend.getWorkflow(f.id);
		assert.deepEqual(
			{ status: handle?.status, pendingPrompts: handle?.pendingPrompts, resumable: handle?.resumable },
			{ status: "paused", pendingPrompts: 1, resumable: true },
		);
	});

	for (const [label, pendingPrompts, resumable] of [
		["pending prompts", 0, undefined],
		["resumability", undefined, false],
	] as const) {
		test(`the ${label} written before the executor of a ${kind} run's adoption registers are kept (#5149)`, async () => {
			const backend = await createMemoryTestBackend();
			const f = await fixture(backend, { ...overrides, pendingPrompts: 1, resumable: true });
			let written: ReturnType<typeof backend.getWorkflow>;
			beforeExecutorRegisters(backend, f, async () => {
				await backend.commitWorkflowStatusTransition(f.id, ["running"], "running", pendingPrompts, resumable);
				written = backend.getWorkflow(f.id);
			});
			const finish = Promise.withResolvers<void>();
			const definition = workflow({
				name: "adoption-startup",
				description: "",
				inputs: {},
				outputs: {},
				run: async () => {
					await finish.promise;
					return {};
				},
			});
			try {
				const result = await resumeDurableWorkflow(f.id, { ...f.deps, registry: createRegistry([definition]) });
				assert.equal(result.ok, true);
				const handle = f.backend.getWorkflow(f.id);
				assert.ok(written);
				assert.deepEqual(
					{ status: handle?.status, pendingPrompts: handle?.pendingPrompts, resumable: handle?.resumable },
					{ status: "running", pendingPrompts: written.pendingPrompts, resumable: written.resumable },
				);
			} finally {
				finish.resolve();
				await f.deps.jobs.get(f.id)?.promise;
			}
		});
	}
}

for (const [kind, overrides, preClaim] of [
	["crashed", {}, "running"],
	["released", RELEASED, "paused"],
] as const) {
	for (const [label, write, status, pendingPrompts] of [
		["an answer", "running", preClaim, 0],
		["a pause", "paused", "paused", 1],
	] as const) {
		test(`an adoption of a ${kind} run aborted while its executor starts, with ${label} written meanwhile, keeps that write, returns the run to its previous owner and leaves no run behind in the adopting session (#5149)`, async () => {
			const backend = await createMemoryTestBackend();
			const f = await fixture(backend, { ...overrides, pendingPrompts: 1, resumable: true });
			const controller = new AbortController();
			const reason = new Error("abort adoption");
			beforeExecutorRegisters(backend, f, async () => {
				controller.abort(reason);
				await backend.commitWorkflowStatusTransition(f.id, ["running"], write, write === "paused" ? 1 : 0);
			});
			assert.equal(
				await resumeDurableWorkflow(f.id, { ...f.deps, signal: controller.signal }).catch((error) => error),
				reason,
			);
			await vi.waitFor(() => assert.equal(f.deps.jobs.has(f.id), false));
			const handle = f.backend.getWorkflow(f.id);
			assert.deepEqual(
				{
					status: handle?.status,
					pendingPrompts: handle?.pendingPrompts,
					modelOwner: handle?.modelOwner,
					releasedModelOwner: handle?.releasedModelOwner,
				},
				{
					status,
					pendingPrompts,
					modelOwner: "old-session",
					// A paused run whose owner is gone is released by it, so another session can adopt it.
					releasedModelOwner: kind === "released" || status === "paused" ? "old-session" : undefined,
				},
			);
			assert.equal(f.store.run(f.id), f.source);
			// The adopting session holds no phantom run: its next resume is decided by the run, not refused as its own.
			const again = await resumeDurableWorkflow(f.id, f.deps);
			assert.doesNotMatch(again.message, /already running in this session/);
			assert.equal(again.ok, true, again.message);
			await f.deps.jobs.get(f.id)?.promise;
		});
	}
}

test("a crashed run paused during an aborted adoption's claim is released by its previous owner, so another session can adopt it (#5149)", async () => {
	const backend = await createMemoryTestBackend();
	const held = holdClaim(backend);
	const f = await fixture(backend, { pendingPrompts: 1, resumable: true });
	const controller = new AbortController();
	const reason = new Error("abort adoption");
	const pending = resumeDurableWorkflow(f.id, { ...f.deps, signal: controller.signal }).catch((error) => error);
	await held.claimed;
	controller.abort(reason);
	await f.backend.commitWorkflowStatusTransition(f.id, ["running"], "paused", 1, true);
	held.release();
	assert.equal(await pending, reason);
	await vi.waitFor(() => {
		const handle = f.backend.getWorkflow(f.id);
		assert.deepEqual(
			[handle?.status, handle?.pendingPrompts, handle?.modelOwner, handle?.releasedModelOwner],
			["paused", 1, "old-session", "old-session"],
		);
	});
	const adopted = await resumeDurableWorkflow(f.id, {
		...f.deps,
		baseRunOpts: { ...f.deps.baseRunOpts, modelOwner: "third-session" },
	});
	assert.equal(adopted.ok, true, adopted.message);
	await f.deps.jobs.get(f.id)?.promise;
});
