import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	DBOS_ADMISSION_TIMEOUT_MS,
	DbosDependencyError,
	dbosAdmissionContext,
} from "../../packages/workflows/src/durable/dbos-admission.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { classifyLatestMetadata } from "../../packages/workflows/src/durable/dbos-metadata.js";
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

// #3072: persisting a pause does not complete an independent startup admission drain.
test("durable pause keeps starting phase until the root admission drain settles", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	class StartupDrainBackend extends DbosDurableBackend {
		private firstFlush = true;
		override async flush(workflowId?: string): Promise<void> {
			if (this.firstFlush) {
				this.firstFlush = false;
				entered.resolve();
				await release.promise;
			}
			await super.flush(workflowId);
		}
	}
	const backend = new StartupDrainBackend(createMockSdk());
	const store = createStore();
	const toolControlRegistry = createToolControlRegistry();
	const controller = new AbortController();
	let calls = 0;
	const pending = run(
		workflow({
			name: "startup-drain",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("effect", {}, async () => ++calls);
				return {};
			},
		}),
		{},
		{ runId: "startup-drain", store, toolControlRegistry, durableBackend: backend, signal: controller.signal },
	);
	await entered.promise;
	try {
		assert.equal((await pauseRun("startup-drain", { store, toolControlRegistry })).ok, true);
		await toolControlRegistry.runControl("startup-drain")!.resume();
		const snapshot = store.runs()[0]!;
		assert.equal(snapshot.phase, "starting");
		assert.equal(summarizeRunSnapshot(snapshot).status, "pending");
		assert.equal(isWorkflowHeartbeatEligibleRun(snapshot), false);
		assert.equal(calls, 0);
		release.resolve();
		const result = await pending;
		assert.equal(result.status, "completed", result.error);
		assert.equal(calls, 1);
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
				assert.equal(store.runs()[0]!.error, undefined, "successful readmission clears the pause failure");
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
		assert.equal(backend.isAdmissionUnavailable(snapshot.id), true);
		assert.match(snapshot.error ?? "", /database.*timed out/i);
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
		assert.equal(backend.isAdmissionUnavailable(snapshot.id), false);
		assert.ok(summarizeRunSnapshot(snapshot).lastProgressAt! > progress!);
	} finally {
		controller.abort();
		late.resolve();
		await pending;
	}
});

// #3072: a live owner cannot promise a durable pause or release on failed resume.
test.each([false, true])(
	"outage controls are bounded and truthful (await pause deadline: %s)",
	async (awaitPauseDeadline) => {
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
			assert.equal(
				store.runs()[0]!.dependencyError,
				undefined,
				"acknowledgement timeout is not a dependency failure",
			);
			assert.notEqual(store.runs()[0]!.phase, "blocked_dependency");
			if (awaitPauseDeadline) {
				await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS - 501);
				assert.equal(store.runs()[0]!.dependencyError, undefined);
				await vi.advanceTimersByTimeAsync(1);
				assert.equal(store.runs()[0]!.phase, "blocked_dependency");
				assert.match(store.runs()[0]!.dependencyError ?? "", /database unavailable during pause/i);
				assert.equal(store.runs()[0]!.controlPersistence, "observed");
			}
			const resume = assert.rejects(resumeRun("control-owner", { store, toolControlRegistry }), /database/i);
			await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
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
	},
);

// #3072: healthy remote database round trips must not inherit the pause acknowledgement deadline.
test.each([95, 100, 150, 200])("pause settles durably and resume confirms on a healthy %ims database", async (rtt) => {
	vi.useFakeTimers();
	const sdk = createMockSdk();
	const delay = () => new Promise<void>((resolve) => setTimeout(resolve, rtt));
	const backend = new DbosDurableBackend({
		...sdk,
		startWorkflow: async (...args) => {
			await delay();
			return sdk.startWorkflow(...args);
		},
		listStepRecords: async (...args) => {
			await delay();
			return sdk.listStepRecords(...args);
		},
		recordStepOutput: async (...args) => {
			await delay();
			return sdk.recordStepOutput(...args);
		},
		resumeWorkflow: async (...args) => {
			await delay();
			return sdk.resumeWorkflow(...args);
		},
		retrieveWorkflow: async (...args) => {
			await delay();
			return sdk.retrieveWorkflow(...args);
		},
	});
	const store = createStore();
	const toolControlRegistry = createToolControlRegistry();
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const body = Promise.withResolvers<void>();
	const runId = "slow-healthy";
	let effects = 0;
	const pending = run(
		workflow({
			name: runId,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				entered.resolve();
				await body.promise;
				await ctx.tool("after", {}, async () => ++effects);
				return {};
			},
		}),
		{},
		{ runId, store, toolControlRegistry, durableBackend: backend, signal: controller.signal },
	);
	try {
		await vi.advanceTimersByTimeAsync(3_000);
		await entered.promise;
		const owner = toolControlRegistry.runControl(runId);
		assert.ok(owner);
		const pause = pauseRun(runId, { store, toolControlRegistry });
		await vi.advanceTimersByTimeAsync(500);
		assert.equal((await pause).ok, true);
		assert.equal(store.runs()[0]!.status, "paused");
		await vi.advanceTimersByTimeAsync(3_000);
		assert.equal(store.runs()[0]!.controlPersistence, "durable", "healthy pause must settle after acknowledgement");
		assert.equal(store.runs()[0]!.dependencyError, undefined);
		assert.notEqual(store.runs()[0]!.phase, "blocked_dependency");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		const persisted = classifyLatestMetadata(await sdk.listStepRecords(runId), runId);
		assert.equal(persisted.kind === "current" ? persisted.metadata.status : persisted.kind, "paused");
		const resume = resumeRun(runId, { store, toolControlRegistry });
		// Observe rejection immediately so a regression does not leak an unhandled rejection.
		const confirmed = resume.then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);
		await vi.advanceTimersByTimeAsync(3_000);
		const outcome = await confirmed;
		assert.ok(!("error" in outcome), `healthy resume failed: ${"error" in outcome ? outcome.error : ""}`);
		assert.equal(outcome.result.ok, true);
		assert.equal(toolControlRegistry.runControl(runId), owner);
		assert.equal(store.runs()[0]!.status, "running");
		assert.equal(store.runs()[0]!.controlPersistence, "durable");
		assert.equal(store.runs()[0]!.dependencyError, undefined);
		body.resolve();
		await vi.advanceTimersByTimeAsync(3_000);
		assert.equal((await pending).status, "completed");
		assert.equal(effects, 1);
		assert.equal(backend.getWorkflow(runId)?.status, "completed");
		assert.deepEqual([...sdk.state.workflows.keys()], [runId]);
		assert.deepEqual(sdk.state.cancels, []);
	} finally {
		controller.abort();
		body.resolve();
		await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
		await pending;
	}
});

function createFencedCheckpointSdk(roundTripMs: number) {
	const sdk = createMockSdk();
	const rows = new Map<string, "PENDING" | "SUCCESS">();
	const roundTrip = () => new Promise<void>((resolve) => setTimeout(resolve, roundTripMs));
	const backend = new DbosDurableBackend({
		...sdk,
		startWorkflow: async (...args) => {
			await roundTrip();
			return sdk.startWorkflow(...args);
		},
		listStepRecords: async (...args) => {
			await roundTrip();
			return sdk.listStepRecords(...args);
		},
		resumeWorkflow: async (...args) => {
			await roundTrip();
			return sdk.resumeWorkflow(...args);
		},
		retrieveWorkflow: async (...args) => {
			await roundTrip();
			return sdk.retrieveWorkflow(...args);
		},
		recordStepOutput: async (workflowId, stepName, output) => {
			const admission = dbosAdmissionContext.getStore();
			const id = `${workflowId}:checkpoint:${stepName}`;
			await roundTrip();
			if (admission?.aborted) throw new DbosDependencyError();
			if (rows.has(id)) {
				while (rows.get(id) !== "SUCCESS") {
					if (admission?.aborted) throw new DbosDependencyError();
					await new Promise<void>((resolve) => setTimeout(resolve, 25));
				}
				return;
			}
			rows.set(id, "PENDING");
			await roundTrip();
			if (admission?.aborted) throw new DbosDependencyError();
			rows.set(id, "SUCCESS");
			await sdk.recordStepOutput(workflowId, stepName, output);
		},
	});
	return { sdk, backend, abandonedCheckpoints: () => [...rows].filter(([, state]) => state === "PENDING") };
}

test("resume issued at the pause acknowledgement waits for the in-flight durable pause (#3377)", async () => {
	vi.useFakeTimers();
	const { sdk, backend, abandonedCheckpoints } = createFencedCheckpointSdk(200);
	const store = createStore();
	const toolControlRegistry = createToolControlRegistry();
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const body = Promise.withResolvers<void>();
	const runId = "resume-after-ack";
	let effects = 0;
	const pending = run(
		workflow({
			name: runId,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				entered.resolve();
				await body.promise;
				await ctx.tool("after", {}, async () => ++effects);
				return {};
			},
		}),
		{},
		{ runId, store, toolControlRegistry, durableBackend: backend, signal: controller.signal },
	);
	try {
		await vi.advanceTimersByTimeAsync(3_000);
		await entered.promise;
		const pause = pauseRun(runId, { store, toolControlRegistry });
		await vi.advanceTimersByTimeAsync(500);
		assert.equal((await pause).ok, true);
		assert.equal(store.runs()[0]!.status, "paused");
		const resume = resumeRun(runId, { store, toolControlRegistry });
		const confirmed = resume.then(
			(result) => ({ result }),
			(error: Error) => ({ error: error.message }),
		);
		await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
		const outcome = await confirmed;
		assert.ok(
			!("error" in outcome),
			`resume after the pause acknowledgement failed: ${"error" in outcome ? outcome.error : ""}`,
		);
		assert.equal(outcome.result.ok, true);
		assert.equal(store.runs()[0]!.status, "running");
		assert.equal(store.runs()[0]!.controlPersistence, "durable");
		assert.equal(store.runs()[0]!.dependencyError, undefined);
		assert.equal(backend.getWorkflow(runId)?.status, "running");
		assert.deepEqual(abandonedCheckpoints(), [], "no durable write may be abandoned between its row and its outcome");
		body.resolve();
		await vi.advanceTimersByTimeAsync(3_000);
		assert.equal((await pending).status, "completed");
		assert.equal(effects, 1);
		assert.equal(backend.getWorkflow(runId)?.status, "completed");
		assert.deepEqual(sdk.state.cancels, []);
	} finally {
		controller.abort();
		body.resolve();
		await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
		await pending;
	}
});

test("pause issued during an in-flight resume write waits for it instead of cancelling it (#3377)", async () => {
	vi.useFakeTimers();
	const { backend, abandonedCheckpoints } = createFencedCheckpointSdk(200);
	const store = createStore();
	const toolControlRegistry = createToolControlRegistry();
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const body = Promise.withResolvers<void>();
	const runId = "pause-during-resume";
	let effects = 0;
	const pending = run(
		workflow({
			name: runId,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				entered.resolve();
				await body.promise;
				await ctx.tool("after", {}, async () => ++effects);
				return {};
			},
		}),
		{},
		{ runId, store, toolControlRegistry, durableBackend: backend, signal: controller.signal },
	);
	try {
		await vi.advanceTimersByTimeAsync(3_000);
		await entered.promise;
		const firstPause = pauseRun(runId, { store, toolControlRegistry });
		await vi.advanceTimersByTimeAsync(500);
		assert.equal((await firstPause).ok, true);
		await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		const resume = resumeRun(runId, { store, toolControlRegistry });
		const superseded = assert.rejects(resume, /superseded by pause/);
		await vi.advanceTimersByTimeAsync(500);
		const pause = pauseRun(runId, { store, toolControlRegistry });
		await vi.advanceTimersByTimeAsync(500);
		assert.equal((await pause).ok, true);
		await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
		await superseded;
		assert.equal(store.runs()[0]!.status, "paused");
		assert.equal(store.runs()[0]!.dependencyError, undefined);
		assert.notEqual(store.runs()[0]!.phase, "blocked_dependency");
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		assert.deepEqual(abandonedCheckpoints(), [], "no durable write may be abandoned between its row and its outcome");
		const resumed = resumeRun(runId, { store, toolControlRegistry });
		await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
		assert.equal((await resumed).ok, true);
		body.resolve();
		await vi.advanceTimersByTimeAsync(3_000);
		assert.equal((await pending).status, "completed");
		assert.equal(effects, 1);
	} finally {
		controller.abort();
		body.resolve();
		await vi.advanceTimersByTimeAsync(DBOS_ADMISSION_TIMEOUT_MS);
		await pending;
	}
});
