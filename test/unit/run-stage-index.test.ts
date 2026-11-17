import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { pendingWorkflowStageStatuses } from "../../packages/workflows/src/shared/pending-stage-status.js";
import { runIndicatorStatus } from "../../packages/workflows/src/shared/run-indicator-status.js";
import { runStageIndex } from "../../packages/workflows/src/shared/run-stage-index.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingPrompt, RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function stage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status: "completed", parentIds: [], toolEvents: [], ...overrides };
}

function run(stages: StageSnapshot[], overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return { id: "run", name: "run", inputs: {}, status: "running", stages, toolNodes: [], startedAt: 1, ...overrides };
}

const prompt: PendingPrompt = { id: "p1", message: "Proceed?", kind: "input" } as PendingPrompt;

describe("the index of a run's stages (#4642)", () => {
	test("lists, in run order, the stages that are pending and those still waiting for input", () => {
		const stages = [
			stage("done"),
			stage("queued-a", { status: "pending" }),
			stage("asking", { status: "running", pendingPrompt: prompt }),
			stage("awaiting", { status: "awaiting_input" }),
			stage("since", { status: "running", awaitingInputSince: 5 }),
			stage("requesting", {
				status: "running",
				inputRequest: { id: "r1", kind: "input", questions: [] } as unknown as StageSnapshot["inputRequest"],
			}),
			stage("queued-b", { status: "pending" }),
			stage("finished-with-prompt", { status: "completed", pendingPrompt: prompt }),
		];
		const index = runStageIndex(run(stages));

		assert.deepEqual(
			index.pending.map((entry) => entry.id),
			["queued-a", "queued-b"],
		);
		assert.deepEqual(
			index.waiting.map((entry) => entry.id),
			["asking", "awaiting", "since", "requesting"],
			"a finished stage no longer waits",
		);
		assert.equal(index.awaitingInput, true);
		assert.equal(runStageIndex(run([stage("a"), stage("b")])).awaitingInput, false);
		assert.equal(
			runStageIndex(run([stage("f", { status: "failed", pendingPrompt: prompt })])).awaitingInput,
			true,
			"any stage holding a prompt counts, finished or not",
		);
	});

	function countingStages(count: number, reads: { status: number }): StageSnapshot[] {
		return Array.from({ length: count }, (_, position) => {
			const entry = stage(`s${position}`);
			let status: StageSnapshot["status"] = "completed";
			Object.defineProperty(entry, "status", {
				enumerable: true,
				get() {
					reads.status += 1;
					return status;
				},
				set(next: StageSnapshot["status"]) {
					status = next;
				},
			});
			return Object.freeze(entry);
		});
	}

	test("a frozen run is walked once, however many surfaces ask about it", () => {
		const reads = { status: 0 };
		const frozen = Object.freeze(run(Object.freeze(countingStages(500, reads)) as StageSnapshot[]));
		const runs = Object.freeze([frozen]);

		const ask = () => {
			runIndicatorStatus(frozen, runs);
			pendingWorkflowStageStatuses(frozen);
			runStageIndex(frozen).waiting;
		};
		ask();
		const afterFirst = reads.status;
		assert.ok(afterFirst >= 500, `the first question walks the stages: ${afterFirst}`);
		for (let repaint = 0; repaint < 20; repaint++) ask();
		assert.equal(reads.status, afterFirst, "twenty more repaints read no stage");
	});

	test("a run that is not frozen is read as it is now", () => {
		const live = run([stage("a")]) as { -readonly [K in keyof RunSnapshot]: RunSnapshot[K] };
		assert.equal(runStageIndex(live).pending.length, 0);
		live.stages = [stage("a"), stage("b", { status: "pending" })];
		assert.deepEqual(
			runStageIndex(live).pending.map((entry) => entry.id),
			["b"],
		);
		(live.stages[1] as { status: string }).status = "running";
		assert.equal(runStageIndex(live).pending.length, 0);
		assert.equal(runIndicatorStatus(live, [live]), "running");
		live.stages = [stage("c", { status: "awaiting_input" })];
		assert.equal(runIndicatorStatus(live, [live]), "awaiting_input");
	});

	test("pause, resume, and block keep a stage's pending prompt waiting, and answering while paused clears it (#3027, #5224)", () => {
		const store = createStore();
		store.recordRunStart({
			id: "pause-owner",
			name: "pausable",
			inputs: {},
			status: "running",
			startedAt: 1_000,
			toolNodes: [],
			stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
		});
		const pausePrompt: PendingPrompt = {
			id: "pp",
			kind: "confirm",
			message: "Approve while paused?",
			createdAt: 1,
		};
		assert.equal(store.recordStagePendingPrompt("pause-owner", "ask", pausePrompt), true);

		const assertWaiting = () => {
			const runs = store.runs();
			assert.equal(runIndicatorStatus(runs[0]!, runs), "awaiting_input");
			assert.equal(runStageIndex(runs[0]!).awaitingInput, true);
			assert.deepEqual(
				runStageIndex(runs[0]!).waiting.map((entry) => entry.id),
				["ask"],
			);
		};

		assert.equal(store.recordStagePaused("pause-owner", "ask"), true);
		const paused = store.runs()[0]!.stages[0]!;
		assert.equal(paused.status, "paused");
		assert.equal(paused.awaitingInputSince, undefined);
		assert.equal(paused.pendingPrompt?.id, "pp");
		assertWaiting();

		assert.equal(store.recordStageResumed("pause-owner", "ask"), true);
		assertWaiting();

		assert.equal(store.recordStageBlocked("pause-owner", "ask", "other"), true);
		assertWaiting();

		const answering = createStore();
		answering.recordRunStart({
			id: "pause-owner",
			name: "pausable",
			inputs: {},
			status: "running",
			startedAt: 1_000,
			toolNodes: [],
			stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
		});
		assert.equal(answering.recordStagePendingPrompt("pause-owner", "ask", pausePrompt), true);
		assert.equal(answering.recordStagePaused("pause-owner", "ask"), true);
		assert.equal(answering.resolveStagePendingPrompt("pause-owner", "ask", "pp", true), true);
		const runs = answering.runs();
		assert.equal(runs[0]!.stages[0]!.status, "paused");
		assert.equal(runIndicatorStatus(runs[0]!, runs), "running");
		assert.equal(runStageIndex(runs[0]!).awaitingInput, false);
		assert.deepEqual(runStageIndex(runs[0]!).waiting, []);
	});
});
