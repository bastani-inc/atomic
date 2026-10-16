import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { testRunId } from "../helpers/run-id.js";
import { MemoryJournalBackend as InMemoryDurableBackend } from "../helpers/workflow-journal.js";

const runId = testRunId("active-blocked-claim");

afterEach(() => setDurableBackend(undefined));

function seedBlockedRun() {
	const store = createStore();
	store.recordRunStart({
		id: runId,
		name: "claim-flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	store.recordStageStart(runId, {
		id: "only",
		name: "only",
		status: "failed",
		parentIds: [],
		toolEvents: [],
		error: "login",
		failureKind: "auth",
		failureRecoverability: "recoverable",
		failureDisposition: "active_blocked",
		failureMessage: "login required",
	});
	store.recordRunBlocked(runId, "login", {
		failedStageId: "only",
		failureKind: "auth",
		failureRecoverability: "recoverable",
		failureDisposition: "active_blocked",
		failureMessage: "login required",
		resumable: true,
	});
	return store;
}

function registerBlockedDurable(backend: InMemoryDurableBackend, completedCheckpoints = 1) {
	backend.registerWorkflow({
		workflowId: runId,
		name: "claim-flow",
		inputs: {},
		createdAt: 1,
		status: "blocked",
		completedCheckpoints,
		resumable: true,
	});
}

class FailingInvocationMetadataBackend extends InMemoryDurableBackend {
	override registerWorkflow(handle: Parameters<InMemoryDurableBackend["registerWorkflow"]>[0]): void {
		if (handle.invocationCwd !== undefined) {
			throw new Error("invocation metadata persistence failed");
		}
		super.registerWorkflow(handle);
	}
}

function claimFlow() {
	return workflow({
		name: "claim-flow",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("only").prompt("go");
			return {};
		},
	});
}

describe("active-blocked resume claim", () => {
	test("continues the same identity and completes its durable state", async () => {
		const backend = new InMemoryDurableBackend();
		registerBlockedDurable(backend);
		setDurableBackend(backend);
		const store = seedBlockedRun();
		const jobs = createJobTracker();
		const runtime = createExtensionRuntime({
			registry: createRegistry([claimFlow()]),
			store,
			jobs,
			adapters: { prompt: { prompt: async () => "done" } },
		});

		const result = await runtime.resumeFailedRun(runId);
		assert.equal(result.ok, true);
		const continuationId = result.ok ? result.runId : "";
		// #3106: a continuation resumes the reserved instance, not a second run.
		assert.equal(continuationId, runId);
		await jobs.get(continuationId)?.promise;
		assert.equal(backend.getWorkflow(runId)?.status, "completed");
		assert.equal(store.runs().find((run) => run.id === continuationId)?.status, "completed");
	});

	test("keeps a zero-checkpoint block recoverable (durable source unchanged)", () => {
		const backend = new InMemoryDurableBackend();
		registerBlockedDurable(backend, 0);
		// The source is a zero-progress blocked handle; leaving it untouched (rather
		// than claiming `running`) keeps it listed and recoverable.
		assert.deepEqual(
			backend.listResumableWorkflows().map((run) => run.workflowId),
			[runId],
		);
	});

	test("returns failure when the continuation's startup (run.start) fails, leaving the source resumable", async () => {
		const backend = new InMemoryDurableBackend();
		registerBlockedDurable(backend);
		setDurableBackend(backend);
		const store = seedBlockedRun();
		const jobs = createJobTracker();
		let callbacks = 0;
		const def = workflow({
			name: "claim-flow",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				callbacks += 1;
				await ctx.stage("only").prompt("go");
				return {};
			},
		});
		const runtime = createExtensionRuntime({
			registry: createRegistry([def]),
			store,
			jobs,
			adapters: { prompt: { prompt: async () => "done" } },
			persistence: {
				appendEntry(type) {
					if (type === "workflow.run.start") throw new Error("run.start persistence failed");
					return "entry";
				},
			},
		});

		const result = await runtime.resumeFailedRun(runId);

		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.message, /run\.start persistence failed/u);
		assert.equal(callbacks, 0);
		// No orphan running continuation snapshot.
		assert.equal(store.runs().filter((run) => run.id !== runId).length, 0);
		// The source stays locally active-blocked/resumable so the same session can retry.
		const source = store.runs().find((run) => run.id === runId);
		assert.ok(source);
		assert.equal(source!.endedAt, undefined);
		assert.equal(backend.getWorkflow(runId)?.status, "blocked");
		assert.equal(backend.getWorkflow(runId)?.resumable, true);
	});

	test("same-ID continuation does not register unrelated invocation metadata", async () => {
		const backend = new FailingInvocationMetadataBackend();
		registerBlockedDurable(backend);
		setDurableBackend(backend);
		const store = seedBlockedRun();
		const jobs = createJobTracker();
		let callbacks = 0;
		const def = workflow({
			name: "claim-flow",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				callbacks += 1;
				await ctx.stage("only").prompt("go");
				return {};
			},
		});
		const runtime = createExtensionRuntime({
			registry: createRegistry([def]),
			store,
			jobs,
			adapters: { prompt: { prompt: async () => "done" } },
		});

		const result = await runtime.resumeFailedRun(runId);

		assert.equal(result.ok, true);
		assert.equal(result.runId, runId);
		await jobs.get(runId)?.promise;
		assert.equal(callbacks, 1);
		assert.equal(store.runs().length, 1);
		assert.equal(backend.getWorkflow(runId)?.status, "completed");
	});

	test("refuses a concurrent second resume (one winner)", async () => {
		const backend = new InMemoryDurableBackend();
		registerBlockedDurable(backend);
		setDurableBackend(backend);
		const store = seedBlockedRun();
		const jobs = createJobTracker();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const def = workflow({
			name: "claim-flow",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				calls += 1;
				await ctx.stage("only").prompt("go");
				return {};
			},
		});
		const runtime = createExtensionRuntime({
			registry: createRegistry([def]),
			store,
			jobs,
			adapters: {
				prompt: {
					prompt: async () => {
						await held;
						return "done";
					},
				},
			},
		});

		const first = await runtime.resumeFailedRun(runId);
		assert.equal(first.ok, true);
		// #3106: the identity already has an executor, not a killed source/link pair.
		const second = await runtime.resumeFailedRun(runId);
		assert.equal(second.ok, false);

		release();
		const continuationId = first.ok ? first.runId : "";
		await jobs.get(continuationId)?.promise;
		assert.equal(calls, 1);
	});

	test("contains a terminal persistence fault after a successful continuation", async () => {
		const backend = new InMemoryDurableBackend();
		registerBlockedDurable(backend);
		setDurableBackend(backend);
		const store = seedBlockedRun();
		const jobs = createJobTracker();
		let terminalPersistenceCalls = 0;
		const runtime = createExtensionRuntime({
			registry: createRegistry([claimFlow()]),
			store,
			jobs,
			adapters: { prompt: { prompt: async () => "done" } },
			persistence: {
				appendEntry(type, payload) {
					if (type === "workflow.run.end" && payload.runId === runId) {
						terminalPersistenceCalls += 1;
						throw new Error("run.end persistence failed");
					}
					return "entry";
				},
			},
		});
		const result = await runtime.resumeFailedRun(runId);
		assert.equal(result.ok, true);
		const continuationId = result.ok ? result.runId : "";
		await jobs.get(continuationId)?.promise;
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "completed");
		assert.equal(store.runs().find((run) => run.id === continuationId)?.status, "completed");
		assert.equal(terminalPersistenceCalls, 1);
		assert.equal(backend.getWorkflow(runId)?.status, "completed");
	});

	// #3106: the durable CAS, not a caller's snapshot, decides resume admission.
	test("a terminal control that wins pending resume admission is never overwritten", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		class HeldAdmissionBackend extends InMemoryDurableBackend {
			override async transitionWorkflowStatus(
				...args: Parameters<InMemoryDurableBackend["transitionWorkflowStatus"]>
			) {
				entered.resolve();
				await release.promise;
				return super.transitionWorkflowStatus(...args);
			}
		}
		const backend = new HeldAdmissionBackend();
		registerBlockedDurable(backend);
		setDurableBackend(backend);
		const store = seedBlockedRun();
		const jobs = createJobTracker();
		let calls = 0;
		const runtime = createExtensionRuntime({
			registry: createRegistry([claimFlow()]),
			store,
			jobs,
			adapters: {
				prompt: {
					prompt: async () => {
						calls += 1;
						return "done";
					},
				},
			},
		});
		const pending = runtime.resumeFailedRun(runId);
		await entered.promise;
		backend.setWorkflowStatus(runId, "cancelled", 0, false);
		assert.equal(store.recordRunEnd(runId, "killed"), true);
		release.resolve();
		const result = await pending;
		assert.equal(result.ok, false);
		assert.equal(calls, 0);
		assert.equal(jobs.has(runId), false);
		assert.equal(backend.getWorkflow(runId)?.status, "cancelled");
		assert.equal(store.runs()[0]?.status, "killed");
		assert.equal(store.runs().length, 1);
		assert.equal((await runtime.resumeFailedRun(runId)).ok, false);
	});

	// #3106: concurrent runtime views cannot each acquire the same instance.
	test("overlapping resumes from different runtime views admit one executor", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		class HeldAdmissionBackend extends InMemoryDurableBackend {
			override async transitionWorkflowStatus(
				...args: Parameters<InMemoryDurableBackend["transitionWorkflowStatus"]>
			) {
				entered.resolve();
				await release.promise;
				return super.transitionWorkflowStatus(...args);
			}
		}
		const backend = new HeldAdmissionBackend();
		registerBlockedDurable(backend);
		setDurableBackend(backend);
		const jobs = createJobTracker();
		let calls = 0;
		const makeRuntime = () =>
			createExtensionRuntime({
				registry: createRegistry([claimFlow()]),
				store: seedBlockedRun(),
				jobs,
				adapters: {
					prompt: {
						prompt: async () => {
							calls += 1;
							return "done";
						},
					},
				},
			});
		const first = makeRuntime().resumeFailedRun(runId);
		await entered.promise;
		const second = await makeRuntime().resumeFailedRun(runId);
		assert.equal(second.ok, false);
		assert.equal(calls, 0);
		release.resolve();
		const admitted = await first;
		assert.equal(admitted.ok, true);
		if (admitted.ok) assert.equal(admitted.runId, runId);
		await jobs.get(runId)?.promise;
		assert.equal(calls, 1);
		assert.equal(backend.getWorkflow(runId)?.status, "completed");
	});
});
