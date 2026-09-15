import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DBOS_ADMISSION_TIMEOUT_MS } from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { isWorkflowHeartbeatEligibleRun } from "../../packages/workflows/src/extension/workflow-heartbeat-scheduler.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import { inspectRun, pauseRun, resumeRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import { sleep } from "../helpers/runtime.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

afterEach(() => vi.useRealTimers());

// #3072: status and pause must not wait behind an unavailable admission write.
test("unadmitted root reports starting and acknowledges a local pause without DB persistence", async () => {
	vi.useFakeTimers();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	class DelayedBackend extends InMemoryDurableBackend {
		override readonly persistent = true;
		override async flush(): Promise<void> {
			entered.resolve();
			await release.promise;
		}
	}
	const store = createStore();
	const controls = createToolControlRegistry();
	const controller = new AbortController();
	let calls = 0;
	const pending = run(
		workflow({
			name: "dependency-status",
			description: "",
			inputs: {},
			outputs: {},
			run: async () => {
				calls++;
				return {};
			},
		}),
		{},
		{
			runId: "isolated-status",
			store,
			toolControlRegistry: controls,
			durableBackend: new DelayedBackend(),
			signal: controller.signal,
		},
	);
	await entered.promise;
	try {
		const snapshot = store.runs()[0]!;
		assert.equal(summarizeRunSnapshot(snapshot).status, "pending");
		assert.equal(isWorkflowHeartbeatEligibleRun(snapshot), false, "starting is not a healthy running heartbeat");
		const repeatedResume = await resumeRun(snapshot.id, { store, toolControlRegistry: controls });
		assert.ok(repeatedResume.ok);
		assert.match(repeatedResume.message ?? "", /admission is pending/);
		let paused = false;
		const pause = pauseRun(snapshot.id, { store, toolControlRegistry: controls }).then((result) => {
			assert.equal(result.ok, true);
			assert.match(result.ok ? (result.message ?? "") : "", /observed|not.*persisted/i);
			paused = true;
		});
		await vi.advanceTimersByTimeAsync(500);
		assert.equal(paused, true, "local pause must not wait for admission");
		await pause;
		assert.equal(calls, 0);
	} finally {
		controller.abort();
		release.resolve();
		await pending;
	}
});

// #3072: deferred and paused non-durable roots/children are not awaiting database admission.
test.each([
	{ persistent: false, child: false },
	{ persistent: false, child: true },
	{ persistent: true, child: true },
])("non-admitting run stays running before its body starts (%j)", async ({ persistent, child }) => {
	class Backend extends InMemoryDurableBackend {
		override readonly persistent = persistent;
	}
	const store = createStore();
	const toolControlRegistry = createToolControlRegistry();
	const controller = new AbortController();
	let calls = 0;
	const pending = run(
		workflow({
			name: "non-admitting",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("effect", {}, async () => ++calls);
				return {};
			},
		}),
		{},
		{
			store,
			toolControlRegistry,
			durableBackend: new Backend(),
			deferWorkflowStart: true,
			signal: controller.signal,
			...(child ? { parentRun: { runId: "parent", stageId: "child-stage", rootRunId: "parent" } } : {}),
		},
	);
	try {
		const snapshot = store.runs()[0]!;
		assert.equal(calls, 0);
		assert.equal(summarizeRunSnapshot(snapshot).status, "running");
		assert.notEqual(snapshot.phase, "starting");
		const repeatedResume = await resumeRun(snapshot.id, { store, toolControlRegistry });
		assert.ok(repeatedResume.ok);
		assert.doesNotMatch(repeatedResume.message ?? "", /admission is pending/);
		await pauseRun(snapshot.id, { store, toolControlRegistry });
		await sleep(0);
		assert.equal(snapshot.status, "paused");
		assert.notEqual(snapshot.phase, "starting");
		assert.equal(calls, 0);
		await resumeRun(snapshot.id, { store, toolControlRegistry });
		const result = await pending;
		assert.equal(result.status, "completed", result.error);
		assert.equal(calls, 1);
	} finally {
		controller.abort();
		await pending;
	}
});

// #3072: preserve the paused executor and root identity across an admission timeout.
test("paused admission reports dependency age and retries the same owner only on resume", async () => {
	vi.useFakeTimers();
	const entered = Promise.withResolvers<void>();
	const late = Promise.withResolvers<void>();
	const sdk = createMockSdk();
	let attempts = 0;
	const backend = new DbosDurableBackend({
		...sdk,
		startWorkflow: async (...args) => {
			if (++attempts === 1) {
				entered.resolve();
				await late.promise;
			}
			await sdk.startWorkflow(...args);
		},
	});
	const store = createStore();
	const toolControlRegistry = createToolControlRegistry();
	const controller = new AbortController();
	let calls = 0;
	const pending = run(
		workflow({
			name: "paused-admission",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("effect", {}, async () => {
					calls++;
					return "done";
				});
				return {};
			},
		}),
		{},
		{ runId: "same-owner", store, toolControlRegistry, durableBackend: backend, signal: controller.signal },
	);
	await entered.promise;
	try {
		await pauseRun("same-owner", { store, toolControlRegistry });
		const owner = toolControlRegistry.runControl("same-owner");
		await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
		const snapshot = store.runs()[0]!;
		let summary = summarizeRunSnapshot(snapshot);
		assert.equal(summary.phase, "blocked_dependency");
		assert.match(summary.dependencyError ?? "", /database.*timed out/i);
		assert.equal(summary.status, "paused");
		assert.equal(summary.controlPersistence, "observed");
		const progress = summary.lastProgressAt;
		await vi.advanceTimersByTimeAsync(200);
		summary = summarizeRunSnapshot(snapshot);
		assert.equal(summary.phaseAgeMs, 200);
		assert.equal(summary.lastProgressAt, progress, "inspection is not progress");
		const inspected = inspectRun(snapshot.id, { store });
		assert.ok(inspected.ok);
		assert.equal(inspected.detail.phaseAgeMs, 200);
		assert.match(renderRunDetail(inspected.detail), /blocked_dependency/);
		assert.match(
			renderWorkflowToolContent(
				{ action: "status", filter: "all", runs: [summary], snapshots: [snapshot] },
				{ action: "status" },
			),
			/phase: blocked_dependency, age: 200ms/,
		);
		assert.equal(isWorkflowHeartbeatEligibleRun({ ...snapshot, status: "running" }), false);
		late.resolve();
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(calls, 0);
		assert.equal(attempts, 1, "recovery does not implicitly resume a paused run");
		assert.equal(toolControlRegistry.runControl(snapshot.id), owner);
		await Promise.all([
			resumeRun(snapshot.id, { store, toolControlRegistry }),
			resumeRun(snapshot.id, { store, toolControlRegistry }),
		]);
		assert.equal((await pending).status, "completed");
		assert.equal(calls, 1);
		assert.equal(attempts, 2);
		assert.deepEqual([...sdk.state.workflows.keys()], [snapshot.id]);
		assert.equal(snapshot.dependencyError, undefined);
		assert.ok(summarizeRunSnapshot(snapshot).lastProgressAt! > progress!);
	} finally {
		controller.abort();
		late.resolve();
		await pending;
	}
});

// #3072: a live owner cannot promise a durable pause or release on failed resume.
test("outage controls are bounded, persistence is truthful, and recovery releases once", async () => {
	vi.useFakeTimers();
	const sdk = createMockSdk();
	const stalled = Promise.withResolvers<void>();
	let unavailable = false;
	const backend = new DbosDurableBackend({
		...sdk,
		listStepRecords: async (id) => {
			if (unavailable) await stalled.promise;
			return sdk.listStepRecords(id);
		},
	});
	const entered = Promise.withResolvers<void>();
	const body = Promise.withResolvers<void>();
	const store = createStore();
	const toolControlRegistry = createToolControlRegistry();
	let effects = 0;
	const pending = run(
		workflow({
			name: "control-outage",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("before", {}, async () => {
					effects++;
					return "before";
				});
				entered.resolve();
				await body.promise;
				await ctx.tool("after", {}, async () => {
					effects++;
					return "after";
				});
				return {};
			},
		}),
		{},
		{ runId: "control-owner", store, toolControlRegistry, durableBackend: backend },
	);
	await entered.promise;
	try {
		unavailable = true;
		let acknowledged = false;
		const pause = pauseRun("control-owner", { store, toolControlRegistry }).then((result) => {
			acknowledged = result.ok;
		});
		await vi.advanceTimersByTimeAsync(500);
		assert.equal(acknowledged, true, "pause must acknowledge the local barrier within 500ms");
		await pause;
		assert.equal(store.runs()[0]!.controlPersistence, "observed");
		const resume = assert.rejects(resumeRun("control-owner", { store, toolControlRegistry }), /database/i);
		await vi.advanceTimersByTimeAsync(500);
		await resume;
		assert.equal(store.runs()[0]!.status, "paused");
		assert.equal(store.runs()[0]!.phase, "blocked_dependency");
		body.resolve();
		unavailable = false;
		stalled.resolve();
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(effects, 1, "late persistence cannot release the pause");
		await Promise.all([
			resumeRun("control-owner", { store, toolControlRegistry }),
			resumeRun("control-owner", { store, toolControlRegistry }),
		]);
		assert.equal((await pending).status, "completed");
		assert.equal(effects, 2);
		assert.equal(store.runs()[0]!.controlPersistence, "durable");
	} finally {
		unavailable = false;
		stalled.resolve();
		body.resolve();
		await toolControlRegistry.runControl("control-owner")?.resume();
		await pending;
	}
});
