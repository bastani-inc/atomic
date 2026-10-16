import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { WorkflowActivityHub } from "../../packages/coding-agent/src/core/extensions/workflow-activity-hub.js";
import type {
	WorkflowActivityFrame,
	WorkflowEvent,
} from "../../packages/coding-agent/src/core/extensions/workflow-events.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createDurableResumeRuntime } from "../../packages/workflows/src/extension/runtime-durable-resume.js";
import { installWorkflowHeartbeatScheduler } from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";
import { createWorkflowObservation } from "../../packages/workflows/src/extension/workflow-observation.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

// #2891: restoring graph records must never manufacture execution ownership.
test("historical tool transitions without an executor stay idle", () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	store.recordRunStart({
		id: "run",
		name: "tool-only",
		inputs: {},
		toolNodes: [],
		stages: [],
		status: "running",
		startedAt: 1,
	});
	store.recordToolNodeStart("run", {
		kind: "tool",
		attachable: false,
		id: "tool",
		name: "read",
		status: "pending",
		parentIds: [],
		ordinal: 0,
		argsHash: "hash",
	});
	store.recordToolNodeRunning("run", "tool", 2);
	const active = hub.getSnapshotFrame();
	assert.equal(active.availability, "ready");
	assert.equal(active.availability === "ready" && active.roots[0]?.state, "idle");
	store.recordToolNodeEnd("run", "tool", { status: "completed", endedAt: 3 });
	store.recordRunEnd("run", "completed");
	const done = hub.getSnapshotFrame();
	assert.equal(done.availability === "ready" && done.roots[0]?.state, "idle");
	observation.dispose();
});

// #2891: availability changes before any durable hydration awaits.
test("durable catalog hydration publishes recovering before ready", async () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const release = Promise.withResolvers<void>();
	const runtime = createDurableResumeRuntime({
		store,
		registry: createRegistry(),
		runtimeCwd: process.cwd(),
		baseRunOpts: () => ({ store }),
		ensureReady: async () => {
			await release.promise;
			return await createMemoryTestBackend();
		},
	});
	const pending = runtime.prepareDurableResumable();
	const entered = Promise.withResolvers<void>();
	const finishTool = Promise.withResolvers<void>();
	const execution = run(
		workflow({
			name: "during-recovery",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("held", {}, async () => {
					entered.resolve();
					await finishTool.promise;
					return "done";
				});
				return {};
			},
		}),
		{},
		{ store, durableBackend: await createMemoryTestBackend() },
	);
	await entered.promise;
	const frames: WorkflowActivityFrame[] = [];
	const lease = hub.observeWorkflowActivity((frame) => {
		frames.push(frame);
	});
	try {
		assert.equal(hub.getSnapshotFrame().availability, "recovering");
	} finally {
		release.resolve();
		await pending;
	}
	try {
		const frame = hub.getSnapshotFrame();
		assert.ok(frame.availability === "ready");
		assert.equal(frame.roots[0]?.state, "working");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(
			frames.map((frame) => (frame.kind === "snapshot" ? frame.availability : frame.kind)),
			["recovering", "ready"],
		);
	} finally {
		finishTool.resolve();
		await execution;
		lease.dispose();
	}
	observation.dispose();
});

// #2891: history is activity recovery; only an executable replay emits replay lifecycle.
test("restored stages never synthesize completion and explicit replay is tagged", async () => {
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const events: WorkflowEvent[] = [];
	hub.bindDispatcher(async (event) => {
		events.push(event);
	});
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const definition = workflow({
		name: "replay",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("success").complete("done");
			await ctx.stage("resume").complete("done");
			return {};
		},
	});
	const adapters = { complete: { complete: async (text: string) => text } };
	assert.equal(
		(await run(definition, {}, { store, adapters, durableBackend: await createMemoryTestBackend() })).status,
		"completed",
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const source = structuredClone(store.runs()[0]!);
	source.status = "failed";
	source.stages[1]!.status = "failed";
	events.length = 0;
	store.clear();
	store.recordRunStart(source);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(
		events.some((event) => event.type === "workflow_stage_completed" || event.type === "workflow_lifecycle"),
		false,
	);
	assert.equal(
		(
			await run(
				definition,
				{},
				{
					store,
					adapters,
					durableBackend: await createMemoryTestBackend(),
					continuation: { source, resumeFromStageId: source.stages[1]!.id },
				},
			)
		).status,
		"completed",
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const completions = events.filter((event) => event.type === "workflow_stage_completed");
	assert.equal(completions.length, 2);
	assert.equal(completions[0]?.delivery, "replay");
	observation.dispose();
});

// #2891: late readers get full roots; non-activity store writes do not emit duplicates.
test("late attach is ready and structural invalidations publish replacements and removals", async () => {
	const store = createStore();
	store.recordRunStart({
		id: "root",
		name: "history",
		inputs: {},
		toolNodes: [],
		stages: [],
		status: "completed",
		startedAt: 1,
	});
	const hub = new WorkflowActivityHub();
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const frames: WorkflowActivityFrame[] = [];
	const lease = hub.observeWorkflowActivity((frame) => {
		frames.push(frame);
	});
	store.recordNotice({ id: "notice", level: "info", message: "unrelated", createdAt: 2 });
	store.clear();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(frames.length, 2);
	assert.equal(frames[0]?.kind, "snapshot");
	assert.ok(frames[0]?.kind === "snapshot" && frames[0].availability === "ready");
	assert.equal(frames[0].roots[0]?.rootRunId, "root");
	assert.equal(frames[1]?.kind, "removed");
	lease.dispose();
	observation.dispose();
});

// #2891: the hook follows existing scheduler boundaries, never a new timer cadence.
test("live tool workflow emits heartbeat observations at its configured cadence", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000);
	const store = createStore();
	const hub = new WorkflowActivityHub();
	const events: WorkflowEvent[] = [];
	hub.bindDispatcher(async (event) => {
		events.push(event);
	});
	const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "owner");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const execution = run(
		workflow({
			name: "heartbeat",
			description: "",
			inputs: {},
			outputs: {},
			heartbeatIntervalMinutes: 1,
			run: async (ctx) => {
				await ctx.tool("held", {}, async () => {
					entered.resolve();
					await release.promise;
					return "done";
				});
				return {};
			},
		}),
		{},
		{ store, durableBackend: await createMemoryTestBackend() },
	);
	await entered.promise;
	const scheduler = installWorkflowHeartbeatScheduler({
		store,
		resolveIntervalMinutes: () => 1,
		sendMessage: () => {},
	});
	try {
		await vi.advanceTimersByTimeAsync(59_999);
		assert.equal(events.filter((event) => event.type === "workflow_heartbeat").length, 0);
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(60_000);
		const beats = events.filter((event) => event.type === "workflow_heartbeat");
		assert.deepEqual(
			beats.map((event) => event.scheduledAt),
			[61_000, 121_000],
		);
		assert.ok(beats.every((event) => event.intervalMinutes === 1 && event.ownerSessionId === "owner"));
	} finally {
		release.resolve();
		await execution;
		scheduler.dispose();
		observation.dispose();
		vi.useRealTimers();
	}
});
