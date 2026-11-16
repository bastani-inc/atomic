import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import {
	expandedInspectionRun,
	prepareInspectionStoreSnapshot,
} from "../../packages/workflows/src/shared/inspection-store-snapshot.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeRun, makeStage } from "./overlay-graph-helpers.js";

test("notices preserve unchanged inspection runs and expanded views without reading payloads (#5234)", () => {
	const store = createStore();
	let payloadReads = 0;
	for (let index = 0; index < 40; index++) {
		store.recordRunStart({
			...makeRun([
				{
					...makeStage("stage"),
					structured: {
						get value() {
							payloadReads++;
							return index;
						},
					},
				},
			]),
			id: `run-${index}`,
		});
	}
	const before = store.inspectionSnapshot!();
	const expanded = before.runs.map((run) => expandedInspectionRun(before, run.id));
	payloadReads = 0;
	store.recordNotice({ id: "notice", runId: "run-0", level: "info", message: "Updated", createdAt: 1 });
	const after = store.inspectionSnapshot!();
	assert.equal(payloadReads, 0);
	assert.notEqual(after, before);
	assert.equal(after.notices.length, 1);
	for (let index = 0; index < before.runs.length; index++) {
		assert.equal(after.runs[index], before.runs[index]);
		assert.equal(expandedInspectionRun(after, after.runs[index]!.id), expanded[index]);
	}
	store.recordRunSummary!("run-0", "New summary", 2);
	const summarized = store.inspectionSnapshot!();
	assert.equal(summarized.runs[0]!.summary, "New summary");
	assert.equal(summarized.runs[1], after.runs[1]);
	assert.equal(payloadReads, 0);
	store.removeRun("run-1");
	assert.equal(expandedInspectionRun(store.inspectionSnapshot!(), "run-1"), undefined);
	store.clear();
	assert.equal(store.inspectionSnapshot!().runs.length, 0);
});

test("unrelated run updates reuse expanded inspection while nested updates refresh it (#5234)", () => {
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("boundary")]), id: "root" });
	store.recordRunStart({
		...makeRun([makeStage("child-stage")]),
		id: "child",
		parentRunId: "root",
		parentStageId: "boundary",
		rootRunId: "root",
	});
	store.recordStageWorkflowChildRun("root", "boundary", { runId: "child", alias: "child", workflow: "child" });
	store.recordRunStart({ ...makeRun([makeStage("other-stage")]), id: "other" });
	const before = store.inspectionSnapshot!();
	const expanded = expandedInspectionRun(before, "root")!;
	assert.equal(expanded.stages[0]!.id, "child:child-stage");
	store.recordToolStart("other", "other-stage", { name: "read", startedAt: 2 });
	const unrelated = store.inspectionSnapshot!();
	assert.equal(expandedInspectionRun(unrelated, "root"), expanded);
	store.recordStageEnd("child", { ...makeStage("child-stage"), status: "failed", error: "failure" });
	const changed = expandedInspectionRun(store.inspectionSnapshot!(), "root")!;
	assert.notEqual(changed, expanded);
	assert.equal(changed.stages[0]!.status, "failed");
	store.removeRun("child");
	const removed = expandedInspectionRun(store.inspectionSnapshot!(), "root")!;
	assert.equal(removed.stages[0]!.id, "boundary");
});

test("cold status preparation yields between bounded batches and preserves changes during preparation (#5234)", async () => {
	const store = createStore();
	let payloadReads = 0;
	for (let index = 0; index < 40; index++) {
		store.recordRunStart({
			...makeRun([
				{
					...makeStage("stage"),
					structured: {
						get value() {
							payloadReads++;
							return index;
						},
					},
				},
			]),
			id: `run-${index}`,
		});
	}
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const preparation = prepareInspectionStoreSnapshot(store);
		assert.equal(payloadReads, 0, "cold status preparation starts off the caller's turn");
		await vi.advanceTimersToNextTimerAsync();
		assert.ok(payloadReads <= 32, `one timer advance materialized ${payloadReads} runs`);
		store.recordStageEnd("run-0", { ...makeStage("stage"), status: "failed", error: "changed during preparation" });
		store.removeRun("run-17");
		await vi.runAllTimersAsync();
		await preparation;
		assert.deepEqual(store.inspectionSnapshot!(), store.snapshot());
		const after = payloadReads;
		await prepareInspectionStoreSnapshot(store);
		assert.equal(vi.getTimerCount(), 0, "warm status preparation schedules no work");
		assert.equal(payloadReads, after);
		store.clear();
		await prepareInspectionStoreSnapshot(store);
		assert.deepEqual(store.inspectionSnapshot!().runs, []);
	} finally {
		vi.useRealTimers();
	}
});

test("notices preserve unchanged compact graph runs without re-projecting their results (#5234)", () => {
	const store = createStore();
	let resultReads = 0;
	for (let index = 0; index < 40; index++) {
		store.recordRunStart({
			...makeRun([makeStage("stage")]),
			id: `run-${index}`,
			result: {
				get summary() {
					resultReads++;
					return `summary-${index}`;
				},
			},
		});
	}
	const before = store.graphSnapshot();
	assert.equal(resultReads, 40);
	resultReads = 0;
	store.recordNotice({ id: "notice", runId: "run-0", level: "info", message: "Updated", createdAt: 1 });
	const after = store.graphSnapshot();
	assert.equal(resultReads, 0);
	for (let index = 0; index < before.runs.length; index++) {
		assert.equal(after.runs[index], before.runs[index]);
	}
});

test("clearing a completed stage's prompt answer invalidates cached inspection and graph answer state (#5234)", () => {
	const store = createStore();
	store.recordRunStart({ ...makeRun([{ ...makeStage("stage"), status: "running", startedAt: 1 }]), id: "run-1" });
	assert.equal(
		store.recordStagePromptAnswer(
			"run-1",
			"stage",
			{ id: "prompt-1", kind: "input", message: "Confirm?", createdAt: 1 },
			"yes",
		),
		true,
	);
	store.recordStageEnd("run-1", {
		...makeStage("stage"),
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		durationMs: 1,
	});
	const before = store.inspectionSnapshot!();
	const beforeGraph = store.graphSnapshot();
	assert.equal(before.runs[0]?.stages[0]?.status, "completed");
	assert.equal(before.runs[0]?.stages[0]?.promptAnswerState, "available");
	assert.equal(beforeGraph.runs[0]?.stages[0]?.promptAnswerState, "available");
	store.clearStagePromptAnswer("run-1", "stage");
	const after = store.inspectionSnapshot!();
	const afterGraph = store.graphSnapshot();
	assert.equal(after.runs[0]?.stages[0]?.promptAnswerState, undefined);
	assert.equal(afterGraph.runs[0]?.stages[0]?.promptAnswerState, undefined);
	assert.deepEqual(after, store.snapshot());
});

test.each([false, true])(
	"cold workflow status listing prepares inspection snapshots in slices of at most 16 runs (cleared during yield: %s) (#5234)",
	async (clearDuringYield) => {
		const store = createStore();
		let sliceReads = 0;
		let totalReads = 0;
		for (let index = 0; index < 40; index++) {
			store.recordRunStart({
				...makeRun([
					{
						...makeStage("stage"),
						structured: {
							get value() {
								sliceReads++;
								totalReads++;
								return index;
							},
						},
					},
				]),
				id: `run-${index}`,
			});
		}
		const runtime = createExtensionRuntime();
		const execute = makeExecuteWorkflowTool(
			runtime,
			() => undefined,
			() => {},
			{
				store,
				jobs: createJobTracker(),
				toolControlRegistry: createToolControlRegistry(),
				stageControlRegistry: createStageControlRegistry(),
				stageUiBroker: new StageUiBroker(store),
			},
		);
		const originalSetTimeout = globalThis.setTimeout;
		let maxSliceReads = 0;
		let addedDuringYield = false;
		const flushSlice = () => {
			maxSliceReads = Math.max(maxSliceReads, sliceReads);
			sliceReads = 0;
		};
		const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			delay?: number,
		) => {
			flushSlice();
			return originalSetTimeout(() => {
				if (!addedDuringYield) {
					addedDuringYield = true;
					if (clearDuringYield) store.clear();
					for (let index = 40; index < 80; index++) {
						store.recordRunStart({
							...makeRun([
								{
									...makeStage("stage"),
									structured: {
										get value() {
											sliceReads++;
											totalReads++;
											return index;
										},
									},
								},
							]),
							id: `run-${index}`,
						});
					}
				}
				flushSlice();
				callback();
				flushSlice();
			}, delay);
		}) as typeof setTimeout);
		try {
			const result = await execute({ action: "status" }, {} as never);
			flushSlice();
			assert.ok(maxSliceReads <= 16, `one synchronous slice materialized ${maxSliceReads} runs`);
			assert.equal(result.action, "status");
			const expectedCount = clearDuringYield ? 40 : 80;
			if (result.action === "status") assert.equal(result.runs.length, expectedCount);
			assert.equal(totalReads, expectedCount);
		} finally {
			timerSpy.mockRestore();
		}
	},
);
