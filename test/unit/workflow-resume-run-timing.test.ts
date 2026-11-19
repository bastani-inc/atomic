import { describe } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import {
	inheritedRunElapsedMs,
	priorRunElapsedMs,
	RUN_TIMING_CHECKPOINT_NAME,
	recordRunTimingCheckpointAsync,
} from "../../packages/workflows/src/durable/run-timing.js";
import { recordStageSessionCheckpoint } from "../../packages/workflows/src/durable/stage-primitive.js";
import { finalizeDurableTerminalStatus } from "../../packages/workflows/src/engine/run-durable-finalize.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { recordActiveBlockedFailure } from "../../packages/workflows/src/runs/foreground/executor-lifecycle.js";
import { restoreOnSessionStart, type SessionEntry } from "../../packages/workflows/src/shared/persistence-restore.js";
import { appendRunBlocked, appendRunStart } from "../../packages/workflows/src/shared/persistence-session-entries.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { elapsedRunMs } from "../../packages/workflows/src/shared/timing.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { currentStoreBackend as getDurableBackend } from "../helpers/store-backend.js";
import {
	createMemoryTestBackend,
	type MemoryJournalBackend as InMemoryDurableBackend,
} from "../helpers/workflow-journal.js";
import { assert, createStore, run, Type, test, workflow } from "./executor-shared.js";

const RUN_ID = "wf-run-timing";

function makeRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: RUN_ID,
		name: "timing",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 0,
		...overrides,
	};
}

async function makeBackend(): Promise<InMemoryDurableBackend> {
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: RUN_ID,
		name: "timing",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	return backend;
}

function recordProgressCheckpoint(backend: DurableWorkflowBackend, workflowId = RUN_ID): Promise<void> {
	return backend.commitCheckpoint({
		kind: "stage",
		workflowId,
		checkpointId: "stage-session:stage:work:1:seed",
		name: "work",
		replayKey: "stage:work:1",
		sessionFile: "/tmp/work.jsonl",
		startedAt: 2,
		durationMs: 700,
		completedAt: 5,
	});
}

describe("run timer math with inherited elapsed", () => {
	test("elapsedRunMs adds accumulated elapsed from prior sessions", async () => {
		const resumed = makeRun({ startedAt: 1000, accumulatedDurationMs: 500 });
		assert.equal(elapsedRunMs(resumed, 1600), 1100);
	});

	test("accumulated elapsed composes with pause accounting without double counting", async () => {
		const resumed = makeRun({
			startedAt: 1000,
			accumulatedDurationMs: 500,
			pausedDurationMs: 200,
			pausedAt: 1800,
		});
		// 500 inherited + (2000 - 1000 - 200 completed pause - 200 active pause)
		assert.equal(elapsedRunMs(resumed, 2000), 1100);
	});

	test("terminal durationMs wins over accumulated elapsed", async () => {
		const ended = makeRun({ startedAt: 1000, durationMs: 42, accumulatedDurationMs: 500 });
		assert.equal(elapsedRunMs(ended, 9999), 42);
	});
});

describe("durable run-timing checkpoints", () => {
	test("records run elapsed only once the workflow has durable progress", async () => {
		const backend = await makeBackend();
		const snapshot = makeRun({ startedAt: 0 });
		assert.equal(await recordRunTimingCheckpointAsync(backend, snapshot, { now: 10_000 }), false);
		assert.equal(priorRunElapsedMs(backend, RUN_ID), undefined);

		await recordProgressCheckpoint(backend);
		assert.equal(await recordRunTimingCheckpointAsync(backend, snapshot, { now: 10_000 }), true);
		assert.equal(priorRunElapsedMs(backend, RUN_ID), 10_000);
	});

	test("debounces inside a 30s bucket and refreshes across buckets", async () => {
		const backend = await makeBackend();
		await recordProgressCheckpoint(backend);
		const snapshot = makeRun({ startedAt: 0 });
		assert.equal(await recordRunTimingCheckpointAsync(backend, snapshot, { now: 10_000, debounce: true }), true);
		assert.equal(await recordRunTimingCheckpointAsync(backend, snapshot, { now: 20_000, debounce: true }), false);
		assert.equal(priorRunElapsedMs(backend, RUN_ID), 10_000);
		assert.equal(await recordRunTimingCheckpointAsync(backend, snapshot, { now: 40_000, debounce: true }), true);
		assert.equal(priorRunElapsedMs(backend, RUN_ID), 40_000);
	});

	test("never regresses the recorded elapsed", async () => {
		const backend = await makeBackend();
		await recordProgressCheckpoint(backend);
		assert.equal(await recordRunTimingCheckpointAsync(backend, makeRun({ startedAt: 0 }), { now: 40_000 }), true);
		// A snapshot with a smaller elapsed value must not overwrite the record.
		assert.equal(
			await recordRunTimingCheckpointAsync(backend, makeRun({ startedAt: 39_000 }), { now: 40_000 }),
			false,
		);
		assert.equal(priorRunElapsedMs(backend, RUN_ID), 40_000);
	});

	test("run timing survives journal reopen", async () => {
		const backend = await JournalTestBackend.create();
		await backend.commitWorkflowRegistration({
			workflowId: RUN_ID,
			name: "timing",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await recordProgressCheckpoint(backend);
		assert.equal(await recordRunTimingCheckpointAsync(backend, makeRun({ startedAt: 0 }), { now: 90_000 }), true);
		const rehydrated = await backend.reopen();
		assert.equal(priorRunElapsedMs(rehydrated, RUN_ID), 90_000);
	});

	test("inheritedRunElapsedMs prefers the live continuation source snapshot", async () => {
		const backend = await makeBackend();
		const source = makeRun({ startedAt: 1000, endedAt: 2000, durationMs: 1234, status: "failed" });
		assert.equal(inheritedRunElapsedMs({ backend, runId: RUN_ID, continuationSource: source }), 1234);
		assert.equal(inheritedRunElapsedMs({ backend, runId: RUN_ID }), undefined);

		await recordProgressCheckpoint(backend);
		await recordRunTimingCheckpointAsync(backend, makeRun({ startedAt: 0 }), { now: 5_000 });
		assert.equal(inheritedRunElapsedMs({ backend, runId: RUN_ID }), 5_000);
	});
});

describe("stage timing durability boundaries", () => {
	test("forced sub-30-second checkpoint records exact elapsed and topology", async () => {
		const backend = await makeBackend();
		const deps = {
			workflowId: RUN_ID,
			backend,
			nextCheckpointId: () => "unused",
			nextReplayKey: () => "stage:work:1",
			now: () => 10_000,
			runTopology: { runId: RUN_ID, runName: "timing" },
		};
		const stage = {
			id: "work-source",
			name: "work",
			replayKey: "stage:work:1",
			status: "paused" as const,
			parentIds: ["plan-source"],
			startedAt: 0,
			pausedAt: 10_000,
			sessionId: "work-session",
			toolEvents: [],
		};
		assert.equal(await recordStageSessionCheckpoint(deps, stage), true);
		deps.now = () => 20_000;
		stage.pausedAt = 20_000;
		assert.equal(await recordStageSessionCheckpoint(deps, stage), false, "ordinary updates remain bucketed");
		assert.equal(await recordStageSessionCheckpoint(deps, stage, { force: true }), true);
		const restored = backend.getStageSession(RUN_ID, "stage:work:1");
		assert.equal(restored?.durationMs, 20_000);
		const latest = backend
			.listCheckpoints(RUN_ID)
			.filter((checkpoint) => checkpoint.kind === "stage")
			.at(-1);
		assert.deepEqual(latest?.topology, {
			version: 1,
			stageId: "work-source",
			parentIds: ["plan-source"],
			status: "paused",
			run: { runId: RUN_ID, runName: "timing" },
		});
	});
});
describe("resumed runs inherit elapsed time", () => {
	test("durable resume seeds run total and mid-running stage timers", async () => {
		const runId = "wf-durable-resume-timing";
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "timing",
			inputs: {},
			createdAt: 1,
			status: "paused",
		});
		// Mid-running stage session persisted by the prior session (700ms elapsed).
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "stage-session:stage:work:1:prior",
			name: "work",
			replayKey: "stage:work:1",
			sessionId: "prior-session",
			startedAt: 2,
			durationMs: 700,
			completedAt: 5,
		});
		// Total run elapsed persisted at quit time (90s).
		await backend.commitCheckpoint({
			kind: "tool",
			workflowId: runId,
			checkpointId: "run-timing:90000",
			name: RUN_TIMING_CHECKPOINT_NAME,
			argsHash: RUN_TIMING_CHECKPOINT_NAME,
			output: { elapsedMs: 90_000 },
			completedAt: 6,
		});

		const store = createStore();
		const def = workflow({
			name: "timing",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("work").complete("continue") }),
		});
		const result = await run(
			def,
			{},
			{
				runId,
				store,
				durableBackend: backend,
				adapters: { complete: { complete: async (text: string) => text } },
			},
		);

		assert.equal(result.status, "completed");
		const snapshot = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(snapshot?.accumulatedDurationMs, 90_000);
		// Total workflow duration includes the prior 90s, not just this session.
		assert.ok((snapshot?.durationMs ?? 0) >= 90_000);
		// The resumed mid-running stage timer continues from its prior 700ms.
		const stage = snapshot?.stages.find((candidate) => candidate.name === "work");
		assert.ok((stage?.durationMs ?? 0) >= 700);
	});

	test("continuation resume inherits the source run's total elapsed", async () => {
		const store = createStore();
		const def = workflow({
			name: "cont-timing",
			description: "",
			inputs: {},
			outputs: { result: Type.String() },
			run: async (ctx) => ({ result: await ctx.stage("work").complete("go") }),
		});

		const first = await run(
			def,
			{},
			{
				store,
				adapters: {
					complete: {
						complete: async () => {
							throw new Error("boom");
						},
					},
				},
			},
		);
		assert.equal(first.status, "failed");
		const source = store.runs().find((candidate) => candidate.id === first.runId)!;
		// Deterministic prior total for the assertion below.
		source.durationMs = 4321;

		const continued = await run(
			def,
			{},
			{
				store,
				continuation: { source, resumeFromStageId: source.failedStageId! },
				adapters: { complete: { complete: async (text: string) => text } },
			},
		);

		assert.equal(continued.status, "completed");
		const snapshot = store.runs().find((candidate) => candidate.id === continued.runId);
		assert.equal(snapshot?.accumulatedDurationMs, 4321);
		assert.ok((snapshot?.durationMs ?? 0) >= 4321);
	});
});

test("a restored block keeps its generation without creating workflow progress (#5567)", async () => {
	const backend = await JournalTestBackend.create();
	await backend.commitWorkflowRegistration({
		workflowId: RUN_ID,
		name: "timing",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	const store = createStore();
	store.recordRunStart(makeRun());
	store.recordRunPaused(RUN_ID, 2);
	store.recordRunResumed(RUN_ID, 2);
	store.recordRunBlocked(RUN_ID, "provider unavailable", {
		failureKind: "provider",
		failureRecoverability: "recoverable",
		failureDisposition: "active_blocked",
		resumable: true,
		blockedAt: 2,
	});
	const before = panelItemsFromSnapshot(store.graphSnapshot())[0]!.runGeneration;
	await finalizeDurableTerminalStatus({
		runId: RUN_ID,
		runSnapshot: store.run(RUN_ID)!,
		isRoot: true,
		durableBackend: backend,
	});
	const reopened = await backend.reopen();
	const handle = reopened.getWorkflow(RUN_ID)!;
	assert.equal(handle.completedCheckpoints, 0);
	const restored = durableWorkflowRunSnapshots(reopened, handle);
	assert.equal(panelItemsFromSnapshot(restored)[0]!.runGeneration, before);
	const resumed = createStore();
	resumed.recordRunStart(restored[0]!);
	resumed.recordRunStart(makeRun());
	resumed.recordRunPaused(RUN_ID, 2);
	assert.ok(Number(panelItemsFromSnapshot(resumed.graphSnapshot())[0]!.runGeneration) > Number(before));
});

describe("run elapsed persistence at pause/failure boundaries", () => {
	test("quitRun persists the exact accumulated run elapsed durably", async () => {
		const backend = getDurableBackend();
		const runId = "wf-quit-timing";
		await backend.commitWorkflowRegistration({
			workflowId: runId,
			name: "timing",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await recordProgressCheckpoint(backend as InMemoryDurableBackend, runId);

		const store = createStore();
		const startedAt = Date.now() - 60_000;
		store.recordRunStart(makeRun({ id: runId, startedAt }));
		// Freeze the live clock contribution: an already-paused run accrues
		// exactly pausedAt - startedAt elapsed regardless of when quit lands.
		store.recordRunPaused(runId, startedAt + 8_000);

		const result = await quitRun(runId, { store });
		assert.equal(result.ok, true);
		assert.equal(priorRunElapsedMs(backend, runId), 8_000);
	});

	test("terminal failure finalize persists the exact accumulated elapsed", async () => {
		const backend = await makeBackend();
		await recordProgressCheckpoint(backend);
		const snapshot = makeRun({
			status: "failed",
			startedAt: 1000,
			endedAt: 2000,
			durationMs: 5555,
			resumable: true,
		});

		await finalizeDurableTerminalStatus({
			runId: RUN_ID,
			runSnapshot: snapshot,
			isRoot: true,
			durableBackend: backend,
		});

		assert.equal(priorRunElapsedMs(backend, RUN_ID), 5555);
		assert.equal(backend.getWorkflow(RUN_ID)?.status, "failed");
	});
});

test("replaying a chat's blocked workflow preserves the last pause sequence without advertising a resume (#5567)", async () => {
	const entries: SessionEntry[] = [];
	const api = {
		appendEntry(type: string, payload: Record<string, unknown>) {
			entries.push({ id: String(entries.length), type, payload: payload as SessionEntry["payload"] });
		},
	};
	const owner = createStore();
	const snapshot = makeRun();
	owner.recordRunStart(snapshot);
	await appendRunStart(api, { runId: RUN_ID, name: snapshot.name, inputs: {}, ts: 1 });
	owner.recordRunPaused(RUN_ID, 2);
	owner.recordRunResumed(RUN_ID, 2);
	await recordActiveBlockedFailure(RUN_ID, snapshot, owner, api, {
		errorMessage: "provider unavailable",
		failureKind: "provider",
		failureRecoverability: "recoverable",
		failureDisposition: "active_blocked",
		failureMessage: "provider unavailable",
		failedStageId: "work",
		resumable: true,
	});
	const restored = createStore();
	const frames: string[] = [];
	restored.subscribe(() => {
		frames.push(panelItemsFromSnapshot(restored.graphSnapshot())[0]!.state);
	});
	const recover = () =>
		restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "auto", persistRuns: true }, restored);
	for (let replay = 0; replay < 2; replay++) {
		recover();
		assert.equal(
			panelItemsFromSnapshot(restored.graphSnapshot())[0]!.runGeneration,
			panelItemsFromSnapshot(owner.graphSnapshot())[0]!.runGeneration,
		);
	}
	assert.ok(
		frames.every((state) => state === "paused"),
		`a replay published ${frames.join(", ")}`,
	);
});

test("restoring a returned block or a failed run never advertises a resume (#5567)", async () => {
	for (const ending of ["blocked", "failed", "invalid-exit"] as const) {
		const status = ending === "blocked" ? "blocked" : "failed";
		const store = createStore();
		const entries: SessionEntry[] = [];
		const persistence = {
			appendEntry(type: string, payload: Record<string, unknown>) {
				entries.push({ id: String(entries.length), type, payload: payload as SessionEntry["payload"] });
			},
		};
		const def = workflow({
			name: "review",
			description: "",
			inputs: {},
			outputs: { status: Type.String() },
			run: async (ctx) => {
				await ctx.stage("work").complete("go");
				store.recordRunPaused(RUN_ID);
				store.recordRunResumed(RUN_ID);
				if (ending === "invalid-exit") return ctx.exit({ outputs: { status: 1 as never } });
				if (ending === "failed") throw new Error("review failed");
				return { status: "needs_human" };
			},
		});
		const result = await run(
			def,
			{},
			{
				runId: RUN_ID,
				store,
				persistence,
				durableBackend: await createMemoryTestBackend(),
				adapters: { complete: { complete: async () => "done" } },
			},
		);
		assert.equal(result.status, status);
		for (const id of ["peer", "stage-block"])
			await appendRunStart(persistence, { runId: id, name: id, inputs: {}, ts: 1 });
		await appendRunBlocked(persistence, {
			runId: "stage-block",
			failedStageId: "review",
			error: "wait",
			failureKind: "provider",
			failureRecoverability: "recoverable",
			resumable: true,
			runGeneration: 3,
			ts: 2,
		});
		for (const mode of ["auto", "ask"] as const) {
			const restored = createStore();
			const frames: string[][] = [];
			const observe = () =>
				panelItemsFromSnapshot(restored.graphSnapshot())
					.map((row) => `${row.name}:${row.state}`)
					.sort();
			restored.subscribe(() => frames.push(observe()));
			const callbacks: string[][] = [];
			const onRestore = () => callbacks.push(observe());
			restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: mode, persistRuns: true }, restored, {
				onResume: onRestore,
				onCrashed: onRestore,
			});
			const complete = [
				`peer:${mode === "auto" ? "running" : "failed"}`,
				`review:${status === "blocked" ? "paused" : "failed"}`,
				"stage-block:paused",
			];
			assert.deepEqual(frames, [complete], ending);
			assert.deepEqual(callbacks, [complete], ending);
			assert.equal(restored.run(RUN_ID)?.runGeneration, status === "blocked" ? 2 : 1, ending);
		}
	}
});

describe("run.start persistence round-trip", () => {
	test("restores inherited elapsed onto the rehydrated run snapshot", async () => {
		const entries: SessionEntry[] = [];
		const api = {
			appendEntry: (type: string, payload: Record<string, unknown>): string => {
				entries.push({ id: `entry-${entries.length}`, type, payload: payload as SessionEntry["payload"] });
				return `entry-${entries.length}`;
			},
		};
		appendRunStart(api, { runId: "restored-run", name: "timing", inputs: {}, accumulatedDurationMs: 7777, ts: 1000 });

		const store = createStore();
		restoreOnSessionStart({ getEntries: () => entries }, { resumeInFlight: "auto", persistRuns: true }, store);

		const restored = store.runs().find((candidate) => candidate.id === "restored-run");
		assert.equal(restored?.accumulatedDurationMs, 7777);
		assert.equal(elapsedRunMs(restored!, 1500), 7777 + 500);
	});
});
