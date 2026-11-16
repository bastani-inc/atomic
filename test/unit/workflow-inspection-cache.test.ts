import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { test, vi } from "vitest";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { prepareTopLevelExpandedSnapshots } from "../../packages/workflows/src/extension/workflow-targets.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import * as inspectionStoreSnapshot from "../../packages/workflows/src/shared/inspection-store-snapshot.js";
import {
	expandedInspectionRun,
	prepareInspectionStoreSnapshot,
} from "../../packages/workflows/src/shared/inspection-store-snapshot.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { makeRun, makeStage } from "./overlay-graph-helpers.js";

const expansionCounter = vi.hoisted(() => ({
	perMacrotask: [] as number[],
	open: false,
	active: false,
	rawSetImmediate: globalThis.setImmediate,
}));

vi.mock("../../packages/workflows/src/shared/inspection-store-snapshot.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../packages/workflows/src/shared/inspection-store-snapshot.js")>();
	return {
		...actual,
		expandedInspectionRun: (...args: Parameters<typeof actual.expandedInspectionRun>) => {
			if (expansionCounter.active) {
				if (!expansionCounter.open) {
					expansionCounter.open = true;
					expansionCounter.perMacrotask.push(0);
					expansionCounter.rawSetImmediate(() => {
						expansionCounter.open = false;
					});
				}
				expansionCounter.perMacrotask[expansionCounter.perMacrotask.length - 1]!++;
			}
			return actual.expandedInspectionRun(...args);
		},
	};
});

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const collect = resolveCollect();
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function holdWeakly(read: () => RunSnapshot | undefined): WeakRef<RunSnapshot> {
	const run = read();
	assert.ok(run !== undefined);
	return new WeakRef(run);
}

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
	const pendingImmediates: Array<() => void> = [];
	const immediateSpy = vi.spyOn(globalThis, "setImmediate").mockImplementation(((
		callback: (...args: unknown[]) => void,
		...args: unknown[]
	) => {
		pendingImmediates.push(() => callback(...args));
		return 0 as unknown as NodeJS.Immediate;
	}) as typeof setImmediate);
	const flushNextImmediate = async () => {
		const next = pendingImmediates.shift();
		assert.ok(next !== undefined, "expected a queued immediate yield");
		next();
		await Promise.resolve();
	};
	try {
		const preparation = prepareInspectionStoreSnapshot(store);
		assert.equal(payloadReads, 16, "cold status preparation builds the first batch before yielding");
		await flushNextImmediate();
		assert.ok(payloadReads <= 32, `one immediate advance materialized ${payloadReads} runs`);
		store.recordStageEnd("run-0", { ...makeStage("stage"), status: "failed", error: "changed during preparation" });
		store.removeRun("run-17");
		while (pendingImmediates.length > 0) await flushNextImmediate();
		await preparation;
		assert.deepEqual(store.inspectionSnapshot!(), store.snapshot());
		const after = payloadReads;
		await prepareInspectionStoreSnapshot(store);
		assert.equal(pendingImmediates.length, 0, "warm status preparation schedules no work");
		assert.equal(payloadReads, after);
		store.clear();
		await prepareInspectionStoreSnapshot(store);
		assert.deepEqual(store.inspectionSnapshot!().runs, []);
	} finally {
		immediateSpy.mockRestore();
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
		const originalSetImmediate = globalThis.setImmediate;
		let maxSliceReads = 0;
		let addedDuringYield = false;
		let compactResultReads = 0;
		const flushSlice = () => {
			maxSliceReads = Math.max(maxSliceReads, sliceReads);
			sliceReads = 0;
		};
		const immediateSpy = vi.spyOn(globalThis, "setImmediate").mockImplementation(((
			callback: (...args: unknown[]) => void,
			...args: unknown[]
		) => {
			flushSlice();
			return originalSetImmediate(() => {
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
							result: {
								get summary() {
									compactResultReads++;
									return `summary-${index}`;
								},
							},
						});
					}
				}
				flushSlice();
				callback(...args);
				flushSlice();
			});
		}) as typeof setImmediate);
		try {
			const result = await execute({ action: "status" }, {} as never);
			flushSlice();
			assert.ok(maxSliceReads <= 16, `one synchronous slice materialized ${maxSliceReads} runs`);
			assert.equal(result.action, "status");
			const expectedCount = clearDuringYield ? 40 : 80;
			if (result.action === "status") assert.equal(result.runs.length, expectedCount);
			assert.equal(totalReads, clearDuringYield ? 56 : 80);
			assert.equal(compactResultReads, 80);
			compactResultReads = 0;
			store.graphSnapshot();
			assert.equal(compactResultReads, 0, "compact graph projections were warmed during preparation batches");
		} finally {
			immediateSpy.mockRestore();
		}
	},
);

test("status listing expands at most 16 uncached top-level runs per macrotask and performs zero yields when warm (#5234)", async () => {
	assert.equal(typeof inspectionStoreSnapshot.expandedInspectionRun, "function");
	const store = createStore();
	for (let index = 0; index < 100; index++) {
		store.recordRunStart({ ...makeRun([makeStage("stage")]), id: `run-${index}` });
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
	const origSetImmediate = globalThis.setImmediate;
	const origSetTimeout = globalThis.setTimeout;
	const countYields = async <T>(fn: () => Promise<T>): Promise<{ result: T; yields: number }> => {
		let yields = 0;
		const immSpy = vi.spyOn(globalThis, "setImmediate").mockImplementation(((
			cb: (...args: unknown[]) => void,
			...args: unknown[]
		) => {
			yields++;
			return origSetImmediate(cb, ...args);
		}) as typeof setImmediate);
		const tmSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			cb: (...args: unknown[]) => void,
			delay?: number,
			...args: unknown[]
		) => {
			yields++;
			return origSetTimeout(cb, delay, ...args);
		}) as typeof setTimeout);
		try {
			const result = await fn();
			return { result, yields };
		} finally {
			immSpy.mockRestore();
			tmSpy.mockRestore();
		}
	};

	expansionCounter.active = true;
	expansionCounter.open = false;
	try {
		const prep = await countYields(() => prepareInspectionStoreSnapshot(store));
		assert.ok(prep.yields <= Math.ceil(100 / 16) - 1, `cold preparation yields: ${prep.yields}`);

		expansionCounter.perMacrotask.length = 0;
		expansionCounter.open = false;
		const coldExpansion = await countYields(() => prepareTopLevelExpandedSnapshots(store));
		assert.equal(coldExpansion.result.length, 100);
		assert.equal(
			expansionCounter.perMacrotask.reduce((sum, count) => sum + count, 0),
			100,
		);
		assert.ok(
			expansionCounter.perMacrotask.every((count) => count <= 16),
			`expansions per macrotask: ${expansionCounter.perMacrotask.join(", ")}`,
		);
		assert.ok(
			expansionCounter.perMacrotask.length <= Math.ceil(100 / 16),
			`cold expansion macrotasks: ${expansionCounter.perMacrotask.length}`,
		);
		assert.ok(coldExpansion.yields <= Math.ceil(100 / 16), `cold expansion yields: ${coldExpansion.yields}`);

		expansionCounter.perMacrotask.length = 0;
		expansionCounter.open = false;
		const warm = await countYields(() => execute({ action: "status" }, {} as never));
		assert.equal(warm.result.action, "status");
		assert.deepEqual(expansionCounter.perMacrotask, [100]);
		assert.equal(warm.yields, 0, `warm listing yields: ${warm.yields}`);
	} finally {
		expansionCounter.active = false;
		expansionCounter.open = false;
	}
});

test("clearing the store releases the cached graph snapshot and its projections (#5234)", async () => {
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "cleared-run" });
	const projected = holdWeakly(() => store.graphSnapshot().runs[0]);
	await nextTurn();
	store.clear();
	await nextTurn();
	collect();
	collect();
	assert.equal(projected.deref(), undefined, "the cleared run's graph projection is still reachable");
});

test("control: a live run's graph projection stays reachable (#5234)", async () => {
	const store = createStore();
	store.recordRunStart({ ...makeRun([makeStage("stage")]), id: "live-run" });
	const projected = holdWeakly(() => store.graphSnapshot().runs[0]);
	await nextTurn();
	collect();
	collect();
	assert.notEqual(projected.deref(), undefined);
});
