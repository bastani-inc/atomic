import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import {
	claimActiveBlockedResume,
	finalizeActiveBlockedSourceAfterContinuation,
	finalizeResumedActiveBlockedSourceRun,
	isReplayTopologyMismatchFailure,
	releaseActiveBlockedClaim,
} from "../../packages/workflows/src/extension/runtime-active-block-claim.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

const runId = "active-blocked-claim";

afterEach(() => setDurableBackend(undefined));

function seedBlockedRun() {
	const store = createStore();
	store.recordRunStart({ id: runId, name: "claim-flow", inputs: {}, status: "running", stages: [], startedAt: 1 });
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
		if (handle.workflowId !== runId && handle.invocationCwd !== undefined) {
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

test("recognizes replay-topology mismatch and ambiguity reasons", () => {
	assert.equal(
		isReplayTopologyMismatchFailure(
			{ error: "atomic-workflows: insufficient_state: replay topology mismatch for tool t" },
			undefined,
		),
		true,
	);
	assert.equal(
		isReplayTopologyMismatchFailure(
			{ error: "atomic-workflows: insufficient_state: replay topology ambiguous for stage t" },
			undefined,
		),
		true,
	);
});

describe("active-blocked resume claim", () => {
	test("scopes duplicate claims to one store", () => {
		const firstStore = createStore();
		const secondStore = createStore();
		const first = claimActiveBlockedResume(firstStore, runId);
		assert.ok(first);
		assert.equal(claimActiveBlockedResume(firstStore, runId), undefined);
		const independent = claimActiveBlockedResume(secondStore, runId);
		assert.ok(independent);
		releaseActiveBlockedClaim(first);
		releaseActiveBlockedClaim(independent);
	});

	test("dispatches a fresh-ID continuation and keeps the durable source blocked/resumable", async () => {
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
		// A fresh-ID continuation is dispatched (its id differs from the source).
		assert.notEqual(continuationId, runId);
		await jobs.get(continuationId)?.promise;

		// The durable source is left blocked/resumable (not mutated), so the work
		// stays recoverable if this process dies.
		assert.equal(backend.getWorkflow(runId)?.status, "blocked");
		assert.equal(backend.getWorkflow(runId)?.resumable, true);
		// The local source snapshot is killed (same-session routing won't re-resume).
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "killed");
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
		assert.match(
			result.ok ? "" : result.message,
			/failed to start: run\.start persistence failed; source left resumable/u,
		);
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

	test("leaves the source resumable when durable invocation metadata registration fails", async () => {
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
			run: async () => {
				callbacks += 1;
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

		assert.equal(result.ok, false);
		assert.match(
			result.ok ? "" : result.message,
			/failed to start: invocation metadata persistence failed; source left resumable/u,
		);
		assert.equal(callbacks, 0);
		assert.equal(store.runs().filter((run) => run.id !== runId).length, 0);
		const source = store.runs().find((run) => run.id === runId);
		assert.ok(source);
		assert.equal(source.endedAt, undefined);
		assert.equal(backend.getWorkflow(runId)?.status, "blocked");
		assert.equal(backend.getWorkflow(runId)?.resumable, true);
		assert.deepEqual(
			backend.listResumableWorkflows().map((run) => run.workflowId),
			[runId],
		);
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
		// A second resume is refused because the local source is already killed.
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
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "killed");
		assert.equal(store.runs().find((run) => run.id === continuationId)?.status, "completed");
		assert.equal(terminalPersistenceCalls, 1);
		assert.equal(backend.getWorkflow(runId)?.status, "blocked");
		assert.equal(backend.getWorkflow(runId)?.resumable, true);
	});

	test("restoring a blocked source after a topology mismatch keeps prompt answers and notices", () => {
		const store = createStore();
		store.recordRunStart({
			id: runId,
			name: "claim-flow",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		store.recordStageStart(runId, {
			id: "ask",
			name: "ask",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		assert.equal(
			store.recordStagePromptAnswer(
				runId,
				"ask",
				{ id: "p1", kind: "confirm", message: "proceed?", createdAt: 2 },
				true,
			),
			true,
		);
		store.recordStageEnd(runId, {
			id: "ask",
			name: "ask",
			status: "completed",
			parentIds: [],
			toolEvents: [],
		});
		store.recordStageStart(runId, {
			id: "only",
			name: "only",
			status: "failed",
			parentIds: ["ask"],
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
		store.recordNotice({
			id: "blocked-notice",
			runId,
			level: "warning",
			message: "WORKFLOW BLOCKED",
			createdAt: 3,
		});
		const source = store.runs().find((run) => run.id === runId);
		assert.ok(source);
		const reserved = {
			...source,
			stages: source.stages.map((stage) => ({ ...stage })),
		};
		const claim = claimActiveBlockedResume(store, source.id);
		assert.ok(claim);
		finalizeResumedActiveBlockedSourceRun(claim, source, "continuation");
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "killed");
		finalizeActiveBlockedSourceAfterContinuation({
			claim,
			source: reserved,
			continuationRunId: "continuation",
			result: { error: "atomic-workflows: insufficient_state: replay topology mismatch for tool t" },
		});
		const restored = store.runs().find((run) => run.id === runId);
		assert.ok(restored);
		assert.notEqual(restored.status, "killed");
		assert.equal(restored.resumable, true);
		assert.equal(store.getStagePromptAnswer(runId, "ask")?.value, true);
		assert.equal(restored.stages.find((stage) => stage.id === "ask")?.promptAnswerState, "available");
		assert.equal(
			store.notices().some((notice) => notice.runId === runId && notice.message === "WORKFLOW BLOCKED"),
			true,
		);
	});

	test("restoring a blocked source after ambiguous replay topology keeps prompt answers and notices", () => {
		const store = createStore();
		store.recordRunStart({
			id: runId,
			name: "claim-flow",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		store.recordStageStart(runId, {
			id: "ask",
			name: "ask",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		assert.equal(
			store.recordStagePromptAnswer(
				runId,
				"ask",
				{ id: "p1", kind: "confirm", message: "proceed?", createdAt: 2 },
				true,
			),
			true,
		);
		store.recordStageEnd(runId, {
			id: "ask",
			name: "ask",
			status: "completed",
			parentIds: [],
			toolEvents: [],
		});
		store.recordStageStart(runId, {
			id: "only",
			name: "only",
			status: "failed",
			parentIds: ["ask"],
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
		store.recordNotice({
			id: "blocked-notice",
			runId,
			level: "warning",
			message: "WORKFLOW BLOCKED",
			createdAt: 3,
		});
		const source = store.runs().find((run) => run.id === runId);
		assert.ok(source);
		const reserved = {
			...source,
			stages: source.stages.map((stage) => ({ ...stage })),
		};
		const claim = claimActiveBlockedResume(store, source.id);
		assert.ok(claim);
		finalizeResumedActiveBlockedSourceRun(claim, source, "continuation");
		assert.equal(store.runs().find((run) => run.id === runId)?.status, "killed");
		finalizeActiveBlockedSourceAfterContinuation({
			claim,
			source: reserved,
			continuationRunId: "continuation",
			result: {
				error: 'atomic-workflows: insufficient_state: replay topology ambiguous for stage "t" (replayKey "stage:task:t:1") in source run source',
			},
		});
		const restored = store.runs().find((run) => run.id === runId);
		assert.ok(restored);
		assert.notEqual(restored.status, "killed");
		assert.equal(restored.resumable, true);
		assert.equal(store.getStagePromptAnswer(runId, "ask")?.value, true);
		assert.equal(restored.stages.find((stage) => stage.id === "ask")?.promptAnswerState, "available");
		assert.equal(
			store.notices().some((notice) => notice.runId === runId && notice.message === "WORKFLOW BLOCKED"),
			true,
		);
	});
});
