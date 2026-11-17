import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { workflowPanelSource } from "../../packages/workflows/src/extension/workflow-panel-source.js";
import { createStageControlHandle } from "../../packages/workflows/src/runs/foreground/executor-stage-control.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowModelUsage } from "../../packages/workflows/src/shared/types.js";
import { buildGraphOverlayAdapter } from "../../packages/workflows/src/tui/overlay-adapter.js";
import { viewedWorkflowRuns } from "../../packages/workflows/src/tui/panel-runs.js";

function completedStore() {
	const store = createStore();
	store.recordRunStart({
		id: "run",
		name: "release",
		inputs: {},
		status: "completed",
		startedAt: 1_000,
		endedAt: 2_000,
		toolNodes: [],
		stages: [],
	});
	return store;
}

test("a workflow graph unavailable in this host is not opened or marked viewed (#5224)", () => {
	const store = completedStore();
	const adapter = buildGraphOverlayAdapter({}, store);
	const source = workflowPanelSource(
		{ ...captureWorkflowOwnerResources(), store },
		{
			open: (runId, options) => adapter.open(runId, undefined, undefined, undefined, options),
			quit: async () => {
				throw new Error("not used");
			},
		},
	);
	assert.equal(source.open?.("run:run"), false);
	assert.equal(viewedWorkflowRuns(store).has("run"), false);
	assert.notEqual(source.items()[0]?.viewed, true);
	assert.equal(adapter.open("run"), false);
	assert.equal(viewedWorkflowRuns(store).has("run"), false);
});

test("idle workflow listings reuse projections and refresh when a run or its viewed state changes (#5224)", () => {
	const store = completedStore();
	const source = workflowPanelSource(
		{ ...captureWorkflowOwnerResources(), store },
		{
			open: () => true,
			quit: async () => {
				throw new Error("not used");
			},
		},
	);
	const initial = source.items();
	for (let frame = 0; frame < 20; frame++) assert.equal(source.items(), initial);
	assert.equal(source.open?.("run:run"), true);
	const viewed = source.items();
	assert.equal(viewed[0]?.viewed, true);
	assert.notEqual(viewed, initial);
	assert.equal(source.items(), viewed);
	store.removeRun("run");
	assert.deepEqual(source.items(), []);
	assert.equal(viewedWorkflowRuns(store).size, 0);
	store.recordRunStart({
		id: "live",
		name: "live",
		inputs: {},
		status: "running",
		startedAt: Date.now(),
		toolNodes: [],
		stages: [],
	});
	assert.equal(source.items()[0]?.state, "running");
	store.recordRunEnd("live", "failed", undefined, "boom");
	assert.equal(source.items()[0]?.state, "failed");
});

test("workflow elapsed advances without store events while paused and settled runs stay frozen (#5224)", () => {
	let now = 10_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	try {
		const store = completedStore();
		for (const id of ["live", "paused"]) {
			store.recordRunStart({
				id,
				name: id,
				inputs: {},
				status: id === "live" ? "running" : "paused",
				startedAt: 1_000,
				...(id === "paused" ? { pausedAt: 5_000 } : {}),
				toolNodes: [],
				stages: [],
			});
		}
		const source = workflowPanelSource(
			{ ...captureWorkflowOwnerResources(), store },
			{
				open: () => true,
				quit: async () => {
					throw new Error("not used");
				},
			},
		);
		const snapshot = store.graphSnapshot();
		const initial = source.items();
		const elapsed = (items: ReturnType<typeof source.items>, id: string) =>
			items.find((item) => item.id === `run:${id}`)?.elapsedMs;
		assert.equal(elapsed(initial, "live"), 9_000);
		assert.equal(elapsed(initial, "paused"), 4_000);
		assert.equal(elapsed(initial, "run"), 1_000);

		now += 5_000;
		assert.equal(store.graphSnapshot(), snapshot, "elapsed refresh needs no store invalidation");
		const later = source.items();
		assert.equal(elapsed(later, "live"), 14_000);
		assert.equal(elapsed(later, "paused"), 4_000);
		assert.equal(elapsed(later, "run"), 1_000);
		now += 250;
		assert.equal(source.items(), later, "reads in the same displayed second reuse the items");
		assert.equal(elapsed(source.items(), "live"), 14_250, "cached projections still sample at each read");
	} finally {
		clock.mockRestore();
	}
});

test("workflow source clocks sample when items is called, not after projection work (#5224)", () => {
	let now = 10_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const store = createStore();
	store.recordRunStart({
		id: "live",
		name: "live",
		inputs: {},
		status: "running",
		startedAt: 1_000,
		toolNodes: [],
		stages: [],
	});
	const snapshot = store.graphSnapshot();
	const projection = vi.spyOn(store, "graphSnapshot").mockImplementation(() => {
		now += 750;
		return snapshot;
	});
	try {
		const source = workflowPanelSource(
			{ ...captureWorkflowOwnerResources(), store },
			{
				open: () => true,
				quit: async () => {
					throw new Error("not used");
				},
			},
		);
		const sampledAt = now;
		const first = source.items();
		assert.equal(first[0]?.elapsedMs, sampledAt - 1_000);
		now += 500;
		const nextSample = now;
		assert.equal(source.items(), first);
		assert.equal(first[0]?.elapsedMs, nextSample - 1_000);
	} finally {
		projection.mockRestore();
		clock.mockRestore();
	}
});

test("numbered workflow answers keep exact option identity and reject invalid indices (#5224)", async () => {
	for (const variant of [
		{ choices: ["2", "1"], index: 0, text: "1", expected: "2" },
		{ choices: ["YES", "yes"], index: 1, text: "yes", expected: "yes" },
		{ choices: ["yes ", "yes"], index: 1, text: "yes", expected: "yes" },
		{ choices: ["\u202eyes\x1b[31m", "yes"], index: 0, text: "yes", expected: "\u202eyes\x1b[31m" },
	]) {
		const store = createStore();
		store.recordRunStart({
			id: "live",
			name: "live",
			inputs: {},
			status: "running",
			startedAt: 1_000,
			toolNodes: [],
			stages: [],
		});
		store.recordPendingPrompt("live", {
			id: "choice",
			kind: "select",
			message: "Choose?",
			choices: variant.choices,
			createdAt: 1_000,
		});
		const source = workflowPanelSource(
			{ ...captureWorkflowOwnerResources(), store },
			{
				open: () => true,
				quit: async () => {
					throw new Error("not used");
				},
			},
		);
		const item = source.items()[0]!;
		for (const choiceIndex of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, variant.choices.length]) {
			assert.equal((await source.answer!(item.id, variant.choices[0]!, { ...item, choiceIndex })).ok, false);
			assert.equal(store.run("live")?.pendingPrompt?.id, "choice");
		}
		const answer = store.awaitPendingPrompt("live", "choice");
		assert.deepEqual(await source.answer!(item.id, variant.text, { ...item, choiceIndex: variant.index }), {
			ok: true,
		});
		assert.equal(await answer, variant.expected);
	}
});

test("an earlier prompt identity cannot answer a replacement with identical question and choices (#5224)", async () => {
	const store = createStore();
	store.recordRunStart({
		id: "live",
		name: "live",
		inputs: {},
		status: "running",
		startedAt: 1_000,
		toolNodes: [],
		stages: [],
	});
	const source = workflowPanelSource(
		{ ...captureWorkflowOwnerResources(), store },
		{
			open: () => true,
			quit: async () => {
				throw new Error("not used");
			},
		},
	);
	const prompt = { id: "first", kind: "select" as const, message: "Pick?", choices: ["2", "1"], createdAt: 1_000 };
	store.recordPendingPrompt("live", prompt);
	const first = source.items()[0];
	assert.ok(first?.promptId);
	store.resolvePendingPrompt("live", "first", "2");
	store.recordPendingPrompt("live", { ...prompt, id: "second" });
	const second = source.items()[0];
	assert.ok(second?.promptId);
	assert.notEqual(first.promptId, second.promptId);
	assert.equal((await source.answer!("run:live", "2", first)).ok, false);
	assert.equal(store.run("live")?.pendingPrompt?.id, "second");
	assert.equal((await source.answer!("run:live", "2")).ok, false);
	const answered = store.awaitPendingPrompt("live", "second");
	assert.deepEqual(await source.answer!("run:live", second.choices![0]!, second), { ok: true });
	assert.equal(await answered, "2", "a raw numeric label selects itself, not another option index");
});

test("workflowPanelSource adds in-flight attempt usage to recorded stage attempts across retries and close handoff, coalesces handle events, and unsubscribes when stages finish or listeners leave (#5224)", async () => {
	const store = createStore();
	const stageControlRegistry = createStageControlRegistry();
	store.recordRunStart({
		id: "review",
		name: "review",
		inputs: {},
		status: "running",
		startedAt: 1_000,
		toolNodes: [],
		stages: [
			{
				id: "plan",
				name: "plan",
				status: "completed",
				parentIds: [],
				toolEvents: [],
				modelAttempts: [{ model: "mock/model", success: true, usage: { input: 80, output: 42 } }],
			},
			{
				id: "inspect",
				name: "inspect",
				status: "running",
				parentIds: ["plan"],
				toolEvents: [],
			},
		],
	});

	let inFlightUsage: WorkflowModelUsage | undefined = { input: 80, output: 120 };
	const handleListeners = new Set<(event: unknown) => void>();
	const makeHandle = (stageId: string): StageControlHandle =>
		({
			runId: "review",
			stageId,
			stageName: stageId,
			status: "running",
			sessionId: `session-${stageId}`,
			sessionFile: undefined,
			isStreaming: true,
			messages: [],
			inFlightAttemptUsage: () => inFlightUsage,
			ensureAttached: async () => {},
			prompt: async () => {},
			steer: async () => {},
			followUp: async () => {},
			pause: async () => {},
			resume: async () => undefined,
			subscribe(listener) {
				handleListeners.add(listener as (event: unknown) => void);
				return () => {
					handleListeners.delete(listener as (event: unknown) => void);
				};
			},
		}) as StageControlHandle;

	stageControlRegistry.register(makeHandle("inspect"));
	const source = workflowPanelSource(
		{ ...captureWorkflowOwnerResources(), store, stageControlRegistry },
		{
			open: () => true,
			quit: async () => {
				throw new Error("not used");
			},
		},
	);

	assert.equal(handleListeners.size, 0, "no handle subscription before source has subscribers");
	assert.equal(source.items()[0]?.tokens, 322, "completed plan (122) + in-flight inspect (80 + 120 = 200)");

	let notifications = 0;
	const unsubscribe = source.subscribe(() => {
		notifications++;
	});
	try {
		assert.equal(handleListeners.size, 1, "subscribes to active stage handle while source is observed");

		// Simulate 1st attempt failing (60 tokens recorded) and 2nd attempt in flight (200 tokens pending).
		const run = store.run("review")!;
		run.stages[1]!.modelAttempts = [{ model: "mock/primary", success: false, usage: { input: 50, output: 10 } }];
		inFlightUsage = { input: 80, output: 120 };
		for (const listener of [...handleListeners]) {
			listener({ type: "message_end" });
			listener({ type: "message_end" });
			listener({ type: "message_end" });
		}
		assert.equal(notifications, 0, "handle events coalesce before microtask flush");
		await Promise.resolve();
		assert.equal(notifications, 1, "burst of handle events emits one coalesced notification");
		assert.equal(
			source.items()[0]?.tokens,
			382,
			"completed plan (122) + inspect 1st recorded attempt (60) + inspect 2nd in-flight attempt (200)",
		);

		// Close handoff: takeAttemptUsage closes the window (undefined) and records the 2nd attempt in modelAttempts.
		inFlightUsage = undefined;
		store.recordStageEnd("review", {
			id: "inspect",
			name: "inspect",
			status: "completed",
			parentIds: ["plan"],
			toolEvents: [],
			modelAttempts: [
				{ model: "mock/primary", success: false, usage: { input: 50, output: 10 } },
				{ model: "mock/fallback", success: true, usage: { input: 80, output: 120 } },
			],
		});
		source.items();
		assert.equal(handleListeners.size, 0, "completed stage handle is immediately unsubscribed");
		assert.equal(source.items()[0]?.tokens, 382, "close handoff preserves exact 382 total without double counting");

		store.recordStageStart("review", {
			id: "verify",
			name: "verify",
			status: "running",
			parentIds: ["inspect"],
			toolEvents: [],
		});
		inFlightUsage = { input: 10, output: 8 };
		stageControlRegistry.register(makeHandle("verify"));
		assert.equal(source.items()[0]?.tokens, 400);
		assert.equal(handleListeners.size, 1, "subscribes to newly started running stage handle");
	} finally {
		unsubscribe();
	}
	assert.equal(handleListeners.size, 0, "unsubscribing the source releases all handle subscriptions");

	const runtimeHandle = createStageControlHandle({
		runId: "review",
		stageId: "verify",
		name: "verify",
		stageSnapshot: { id: "verify", name: "verify", status: "running", parentIds: [], toolEvents: [] },
		state: {
			liveHandleReleased: false,
			stageFinalized: false,
			sessionCheckpointed: false,
			stageClosedByWorkflowExit: false,
			latestUserMessage: undefined,
			userMessageSeq: 0,
		},
		activeStore: store,
		innerCtx: {
			isStreaming: true,
			__sessionMeta: () => ({}),
			__inFlightAttemptUsage: () => ({ input: 80, output: 120 }),
			__isReleased: () => false,
			subscribe: () => () => {},
		},
	} as never);
	assert.deepEqual(runtimeHandle.inFlightAttemptUsage?.(), { input: 80, output: 120 });
});
