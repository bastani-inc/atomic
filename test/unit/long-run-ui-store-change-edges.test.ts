import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { afterEach, describe, test, vi } from "vitest";
import { WorkflowActivityHub } from "../../packages/coding-agent/src/core/extensions/workflow-activity-hub.js";
import type {
	WorkflowActivityFrame,
	WorkflowGraphNode,
	WorkflowRootActivity,
} from "../../packages/coding-agent/src/core/extensions/workflow-events.js";
import {
	applyModelFallbackMetaToStage,
	applySessionMetaToStage,
} from "../../packages/workflows/src/runs/foreground/executor-lifecycle.js";
import {
	createWorkflowGraphExpander,
	expandWorkflowGraph,
	settledStageCount,
} from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createGraphStoreSnapshot } from "../../packages/workflows/src/shared/graph-store-snapshot.js";
import { indexRunFrom, runStageIndex } from "../../packages/workflows/src/shared/run-stage-index.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { Store } from "../../packages/workflows/src/shared/store-public-types.js";
import type { RunSnapshot, StageSnapshot, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	projectWorkflowActivity,
	type WorkflowActivityOwnership,
	WorkflowActivityProjector,
	workflowActivityNodeKey,
} from "../../packages/workflows/src/shared/workflow-activity.js";
import { isPublishedSnapshotArray } from "../../packages/workflows/src/shared/workflow-run-ownership.js";

afterEach(() => vi.restoreAllMocks());

function stage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status: "completed", parentIds: [], toolEvents: [], ...overrides };
}

function run(id: string, stages: StageSnapshot[], overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return { id, name: id, inputs: {}, status: "running", stages, toolNodes: [], startedAt: 1, ...overrides };
}

/** A chain of `count` stages, each ending `status` and depending on the one before it. */
function chain(count: number, status: StageSnapshot["status"] = "completed", prefix = "s"): StageSnapshot[] {
	return Array.from({ length: count }, (_, index) =>
		stage(`${prefix}-${index}`, {
			status,
			parentIds: index === 0 ? [] : [`${prefix}-${index - 1}`],
			executionOrder: index + 1,
		}),
	);
}

function fullSnapshot(store: Store): StoreSnapshot {
	return createGraphStoreSnapshot(store.runs(), store.notices(), store.graphSnapshot().version);
}

function collectGarbage(): void {
	v8.setFlagsFromString("--expose-gc");
	try {
		const gc = vm.runInNewContext("gc") as () => void;
		for (let round = 0; round < 3; round++) gc();
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

/** Lets microtasks and immediates run until a hub has delivered what it queued. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("a settled stage's model and session metadata (#4642)", () => {
	test("model fallback metadata reports a change only for the fields graph snapshots show (#4642)", () => {
		const settled = stage("a", { model: "m1", thinkingLevel: "low", warnings: ["w"] });
		assert.equal(applyModelFallbackMetaToStage(settled, { model: "m1", thinkingLevel: "low" }), false);
		assert.deepEqual([settled.model, settled.thinkingLevel, settled.warnings], ["m1", "low", ["w"]]);
		assert.equal(
			applyModelFallbackMetaToStage(settled, { model: "m1", thinkingLevel: "low", attemptedModels: ["x"] }),
			false,
		);
		assert.deepEqual(settled.attemptedModels, ["x"]);
		assert.equal(
			applyModelFallbackMetaToStage(settled, { model: "m1", thinkingLevel: "low", modelAttempts: [] }),
			false,
		);
		for (const meta of [
			{ model: "m2", thinkingLevel: "low" },
			{ model: "m2" },
			{ model: "m2", thinkingLevel: "high" },
			{ model: "m2", thinkingLevel: "high", rateLimits: [] },
			{ model: "m2", thinkingLevel: "high", routerSelection: { model: "m2" } as never },
			{ model: "m2", thinkingLevel: "high", warnings: [] },
			{ model: "m2", thinkingLevel: "high", warnings: ["new"] },
		])
			assert.equal(applyModelFallbackMetaToStage(settled, meta), true, JSON.stringify(meta));
		assert.equal(settled.model, "m2");
		assert.deepEqual(settled.warnings, ["new"]);
		applyModelFallbackMetaToStage(settled, { model: "m2", thinkingLevel: "high", warnings: [] });
		assert.equal("warnings" in settled, false);
		applyModelFallbackMetaToStage(settled, { model: "m2" });
		assert.equal("thinkingLevel" in settled, false);
		const kept = stage("b", {
			model: "m",
			thinkingLevel: "low",
			attemptedModels: ["m"],
			modelAttempts: [],
			rateLimits: [],
			routerSelection: { model: "m" } as never,
		});
		const before = { ...kept };
		assert.equal(applyModelFallbackMetaToStage(kept, { thinkingLevel: "low" }), false);
		assert.deepEqual(kept, before, "absent fields keep their values");
		const attempts = [{ model: "n" }] as never;
		applyModelFallbackMetaToStage(kept, { thinkingLevel: "low", modelAttempts: attempts });
		assert.equal(kept.modelAttempts, attempts);
	});

	test("session metadata reports a change when the session id or file changes (#4642)", () => {
		const settled = stage("a", { sessionId: "s1", sessionFile: "f1" });
		assert.equal(applySessionMetaToStage(settled, { sessionId: undefined, sessionFile: undefined }), false);
		assert.equal(applySessionMetaToStage(settled, { sessionId: "s1", sessionFile: "f1" }), false);
		assert.equal(applySessionMetaToStage(settled, { sessionId: "s2", sessionFile: undefined }), true);
		assert.equal(applySessionMetaToStage(settled, { sessionId: "s2", sessionFile: "f2" }), true);
		assert.deepEqual([settled.sessionId, settled.sessionFile], ["s2", "f2"]);
	});
});

describe("graph snapshot builder edges (#4642)", () => {
	test("failed, skipped and newly settled stages are not read by a change to another stage (#4642)", () => {
		const reads = new Map<string, number>();
		let counting = false;
		const watched = (source: StageSnapshot): StageSnapshot =>
			new Proxy(source, {
				get: (target, key, receiver) => {
					if (counting) reads.set(target.id, (reads.get(target.id) ?? 0) + 1);
					return Reflect.get(target, key, receiver);
				},
				ownKeys: (target) => {
					if (counting) reads.set(target.id, (reads.get(target.id) ?? 0) + 1);
					return Reflect.ownKeys(target);
				},
			});
		const store = createStore();
		const stages = [
			watched(stage("done")),
			watched(stage("failed", { status: "failed" })),
			watched(stage("skipped", { status: "skipped" })),
			watched(stage("live-a", { status: "running" })),
			watched(stage("live-b", { status: "running" })),
		];
		store.recordRunStart(run("r", stages));
		store.graphSnapshot();
		store.recordStageEnd("r", { ...stage("live-a"), status: "completed", endedAt: 2 });
		store.graphSnapshot();
		store.recordStageStart("r", watched(stage("appended", { status: "skipped" })));
		store.graphSnapshot();
		counting = true;
		store.recordToolStart("r", "live-b", { name: "tool", startedAt: 3 });
		reads.clear();
		const snapshot = store.graphSnapshot();
		counting = false;
		assert.deepEqual(
			[...reads.keys()].filter((id) => id !== "live-b"),
			[],
		);
		assert.deepStrictEqual(snapshot, fullSnapshot(store));
	});

	test("a settled stage reopened through its own store change is read again when it is edited unannounced (#4642)", () => {
		const store = createStore();
		const reopened = stage("a");
		store.recordRunStart(run("r", [reopened, stage("b", { status: "running" })]));
		store.graphSnapshot();
		reopened.status = "running";
		store.recordStageStart("r", reopened);
		store.graphSnapshot();
		reopened.error = "edited while running";
		store.recordToolStart("r", "b", { name: "tool", startedAt: 1 });
		assert.equal(store.graphSnapshot().runs[0]?.stages[0]?.error, "edited while running");
	});

	test("stages that share an id are all re-read by a change that names the id (#4642)", () => {
		const store = createStore();
		const second = stage("dup");
		store.recordRunStart(run("r", [stage("dup"), second, stage("other")]));
		store.graphSnapshot();
		second.error = "second";
		store.recordStageStart("r", second);
		assert.deepStrictEqual(store.graphSnapshot(), fullSnapshot(store));
		const appended = stage("other");
		store.run("r")!.stages.push(appended);
		store.recordStageStart("r", appended);
		store.graphSnapshot();
		appended.error = "appended twin";
		store.recordStageStart("r", appended);
		assert.deepStrictEqual(store.graphSnapshot(), fullSnapshot(store));
	});

	test("a stage object replaced in place is projected anew though no change names it (#4642)", () => {
		const store = createStore();
		store.recordRunStart(run("r", [stage("a"), stage("b"), stage("live", { status: "running" })]));
		store.graphSnapshot();
		store.run("r")!.stages[1] = stage("b", { status: "failed", error: "replaced" });
		store.recordToolStart("r", "live", { name: "tool", startedAt: 1 });
		assert.deepStrictEqual(store.graphSnapshot(), fullSnapshot(store));
	});

	test("a tool node removed from a run in place is gone from the next snapshot (#4642)", () => {
		const store = createStore();
		store.recordRunStart(run("r", [stage("a", { status: "running" })]));
		store.recordToolNodeStart("r", {
			kind: "tool",
			id: "tool:1",
			name: "t",
			status: "pending",
			parentIds: [],
			ordinal: 1,
			argsHash: "1",
			attachable: false,
		});
		assert.equal(store.graphSnapshot().runs[0]?.toolNodes.length, 1);
		store.run("r")!.toolNodes.pop();
		store.recordToolStart("r", "a", { name: "x", startedAt: 1 });
		assert.deepStrictEqual(store.graphSnapshot(), fullSnapshot(store));
	});

	test("a change scoped to a run keeps the projection of every stage it did not change (#4642)", () => {
		const store = createStore();
		store.recordRunStart(run("r", chain(20)));
		const before = store.graphSnapshot();
		store.recordRunExecutionState("r", { lastProgressAt: 5 });
		const after = store.graphSnapshot();
		assert.notEqual(after.runs[0], before.runs[0]);
		assert.ok(after.runs[0]!.stages.every((entry, index) => entry === before.runs[0]!.stages[index]));
		assert.deepStrictEqual(after, fullSnapshot(store));
	});

	test("a snapshot's tool nodes, notices and run fields are frozen, and its tool-node array is published (#4642)", () => {
		const store = createStore();
		store.recordRunStart(run("r", [stage("a", { status: "running" })], { result: { summary: "s" } }));
		store.recordToolNodeStart("r", {
			kind: "tool",
			id: "tool:1",
			name: "t",
			status: "pending",
			parentIds: ["a"],
			ordinal: 1,
			argsHash: "1",
			attachable: false,
		});
		store.recordNotice({ id: "n", runId: "r", level: "info", message: "m", createdAt: 1 });
		const snapshot = store.graphSnapshot();
		const [entry] = snapshot.runs;
		assert.ok(entry !== undefined && isPublishedSnapshotArray(entry.toolNodes));
		assert.ok(Object.isFrozen(entry.toolNodes[0]) && Object.isFrozen(entry.toolNodes[0]!.parentIds));
		assert.ok(Object.isFrozen(entry.inputs));
		assert.ok(Object.isFrozen(snapshot.notices) && Object.isFrozen(snapshot.notices[0]));
		store.recordToolStart("r", "a", { name: "x", startedAt: 1 });
		const patched = store.graphSnapshot().runs[0]!;
		assert.ok(Object.isFrozen(patched) && Object.isFrozen(patched.stages[0]!.toolEvents));
	});
});

describe("run stage index derived version to version (#4642)", () => {
	const frozenRun = (stages: StageSnapshot[]): RunSnapshot =>
		Object.freeze(
			run(
				"r",
				stages.map((entry) => Object.freeze(entry)),
			),
		);

	test("a derived index keeps finished stages out of the waiting list and lists stages in run order (#4642)", () => {
		const asks = { pendingPrompt: { id: "p", kind: "confirm" as const, message: "go?", createdAt: 1 } };
		const first = frozenRun([
			stage("a", { status: "running" }),
			stage("b", { status: "failed", ...asks }),
			stage("c", { status: "skipped", ...asks }),
			stage("d", { status: "pending" }),
		]);
		assert.deepEqual(runStageIndex(first), runStageIndex({ stages: [...first.stages] }));
		assert.deepEqual(runStageIndex(first).waiting, [], "finished stages that hold a prompt do not wait");
		const stages = [...first.stages];
		stages[0] = Object.freeze(stage("a", { status: "pending" }));
		stages[1] = Object.freeze(stage("b", { status: "failed" }));
		stages.push(Object.freeze(stage("e", { status: "awaiting_input" })));
		const second = Object.freeze({ ...first, stages });
		indexRunFrom(second, first, [0, 1], 4);
		const derived = runStageIndex(second);
		assert.deepEqual(derived, runStageIndex({ stages: [...second.stages] }));
		assert.deepEqual(
			derived.pending.map((entry) => entry.id),
			["a", "d"],
		);
		assert.deepEqual(
			derived.waiting.map((entry) => entry.id),
			["e"],
		);
		const answered = [...second.stages];
		answered[4] = Object.freeze(stage("e"));
		const third = Object.freeze({ ...second, stages: answered });
		indexRunFrom(third, second, [4], 5);
		assert.equal(runStageIndex(third).awaitingInput, true, "c still asks for input though it was skipped");
		assert.deepEqual(runStageIndex(third).waiting, []);
		const cleared = [...third.stages];
		cleared[2] = Object.freeze(stage("c", { status: "skipped" }));
		const fourth = Object.freeze({ ...third, stages: cleared });
		indexRunFrom(fourth, third, [2], 5);
		assert.equal(runStageIndex(fourth).awaitingInput, false);
		assert.deepEqual(runStageIndex(fourth), runStageIndex({ stages: [...fourth.stages] }));
		const reopened = [...fourth.stages];
		reopened[1] = Object.freeze(stage("b", { status: "pending" }));
		const fifth = Object.freeze({ ...fourth, stages: reopened });
		indexRunFrom(fifth, fourth, [1], 5);
		assert.deepEqual(
			runStageIndex(fifth).pending.map((entry) => entry.id),
			["a", "b", "d"],
			"a stage that is pending again keeps its place in run order",
		);
	});

	test("the index of a run's next version is derived without walking its stages (#4642)", () => {
		const store = createStore();
		store.recordRunStart(run("r", [...chain(200), stage("live", { status: "running" })]));
		runStageIndex(store.graphSnapshot().runs[0]!);
		const forEach = vi.spyOn(Array.prototype, "forEach");
		store.recordToolStart("r", "live", { name: "tool", startedAt: 1 });
		const next = store.graphSnapshot().runs[0]!;
		const index = runStageIndex(next);
		assert.equal(forEach.mock.contexts.filter((context) => context === next.stages).length, 0);
		forEach.mockRestore();
		assert.deepEqual(index, runStageIndex({ stages: [...next.stages] }));
	});

	test("a run that is not frozen is indexed as it is now, not from an earlier version (#4642)", () => {
		const first = frozenRun([stage("a", { status: "pending" })]);
		runStageIndex(first);
		const mutable = run("r", [stage("a", { status: "pending" })]);
		indexRunFrom(mutable, first, [0], 1);
		mutable.stages[0]!.status = "running";
		assert.deepEqual(runStageIndex(mutable).pending, []);
	});
});

describe("expansion edges (#4642)", () => {
	test("a stage list is counted once, and the next version's count is derived from it (#4642)", () => {
		const store = createStore();
		store.recordRunStart(run("r", [...chain(5), stage("live", { status: "running", executionOrder: 6 })]));
		const first = expandWorkflowGraph(store.graphSnapshot(), "r");
		assert.equal(settledStageCount(first.stages), 5);
		const counted = first.stages[0] as { status: string };
		counted.status = "running";
		assert.equal(settledStageCount(first.stages), 5, "the first count is kept");
		store.recordStageEnd("r", { ...stage("live"), status: "completed" });
		const second = expandWorkflowGraph(store.graphSnapshot(), "r");
		assert.equal(second.stages[0], first.stages[0]);
		assert.equal(settledStageCount(second.stages), 6, "derived from the first count");
		assert.equal(settledStageCount([...second.stages]), 5, "a list no expansion produced is counted as it is");
		store.recordStageStart("r", stage("next", { status: "skipped", executionOrder: 7 }));
		assert.equal(settledStageCount(expandWorkflowGraph(store.graphSnapshot(), "r").stages), 7);
		const plain = [stage("x"), stage("y", { status: "running" })];
		assert.equal(settledStageCount(plain), 1);
		plain[1]!.status = "failed";
		assert.equal(settledStageCount(plain), 2, "a list no expansion produced may change and is counted again");
	});

	test("a stage list whose earlier versions were never counted is counted, then kept (#4642)", () => {
		const store = createStore();
		store.recordRunStart(run("r", [...chain(3), stage("live", { status: "running", executionOrder: 4 })]));
		expandWorkflowGraph(store.graphSnapshot(), "r");
		store.recordToolStart("r", "live", { name: "tool", startedAt: 1 });
		const patched = expandWorkflowGraph(store.graphSnapshot(), "r");
		assert.equal(settledStageCount(patched.stages), 3);
		(patched.stages[0] as { status: string }).status = "running";
		assert.equal(settledStageCount(patched.stages), 3, "the count of an expansion's list is kept");
	});

	test("a renamed run, a run replaced with other stages, and a stage of tool kind expand as from scratch (#4642)", () => {
		const store = createStore();
		const expandsAsFull = (message: string) =>
			assert.deepStrictEqual(
				expandWorkflowGraph(store.graphSnapshot(), "r"),
				expandWorkflowGraph(fullSnapshot(store), "r"),
				message,
			);
		store.recordRunStart(run("r", chain(4)));
		expandsAsFull("first");
		Object.assign(store.run("r")!, { name: "renamed" });
		store.recordRunExecutionState("r", { lastProgressAt: 2 });
		expandsAsFull("renamed");
		store.recordRunStart(run("r", chain(2, "completed", "t"), { name: "renamed" }));
		expandsAsFull("fewer stages with other ids");
		store.recordRunStart(
			run("r", [stage("p", { executionOrder: 1 }), stage("q", { executionOrder: 2 })], { name: "renamed" }),
		);
		expandsAsFull("stages without parents");
		store.recordRunStart(
			run("r", [stage("v", { executionOrder: 1 }), stage("w", { executionOrder: 2 })], { name: "renamed" }),
		);
		expandsAsFull("the same positions and parents, other ids");
		store.recordStageStart("r", stage("tool-kind", { nodeKind: "tool", executionOrder: 9 }));
		expandsAsFull("a stage of tool kind");
		store.recordStageStart("r", stage("after", { executionOrder: 10 }));
		expandsAsFull("after a stage of tool kind");
		store.recordRunStart(run("r", chain(3), { name: "renamed" }));
		store.recordToolNodeStart("r", {
			kind: "tool",
			id: "tool:1",
			name: "t",
			status: "pending",
			parentIds: [],
			ordinal: 1,
			argsHash: "1",
			attachable: false,
		});
		expandsAsFull("with a tool node");
		store.run("r")!.toolNodes.pop();
		store.recordRunExecutionState("r", { lastProgressAt: 3 });
		expandsAsFull("its tool node removed");
	});

	test("the expansion kept for a removed run is released (#4642)", async () => {
		const store = createStore();
		store.recordRunStart(run("gone", chain(3)));
		store.recordRunStart(run("kept", chain(3, "completed", "k")));
		let removed: WeakRef<object> | undefined;
		(() => {
			const graph = expandWorkflowGraph(store.graphSnapshot(), "gone");
			removed = new WeakRef(graph.nodes);
			expandWorkflowGraph(store.graphSnapshot(), "kept");
			store.removeRun("gone");
			createWorkflowGraphExpander(store.graphSnapshot())("kept");
		})();
		// A WeakRef keeps its target alive until the job that created it ends.
		await nextTurn();
		collectGarbage();
		assert.equal(removed?.deref(), undefined);
	});

	test("the expansion kept for a removed run is released even when more runs remain than were expanded (#4642)", async () => {
		const store = createStore();
		store.recordRunStart(run("gone", chain(3)));
		for (const id of ["kept-1", "kept-2", "kept-3"]) store.recordRunStart(run(id, chain(3, "completed", id)));
		let removed: WeakRef<object> | undefined;
		(() => {
			removed = new WeakRef(expandWorkflowGraph(store.graphSnapshot(), "gone").nodes);
			store.removeRun("gone");
			createWorkflowGraphExpander(store.graphSnapshot())("kept-1");
		})();
		await nextTurn();
		collectGarbage();
		assert.equal(removed?.deref(), undefined);
	});
});

describe("activity projection edges (#4642)", () => {
	const ownership = (overrides: Partial<WorkflowActivityOwnership> = {}): WorkflowActivityOwnership => ({
		ownerSessionId: "owner",
		liveRunIds: new Set(),
		executingStageIds: new Set(),
		executingToolNodeIds: new Set(),
		stoppingRunIds: new Set(),
		retryingStageIds: new Set(),
		acknowledgedFailureRunIds: new Set(),
		...overrides,
	});

	test("projecting the next version reads no stage that is the same object and has finished (#4642)", () => {
		let reads = 0;
		let counting = false;
		const watched = (source: StageSnapshot): StageSnapshot =>
			new Proxy(Object.freeze(source), {
				get: (target, key, receiver) => {
					if (counting) reads++;
					return Reflect.get(target, key, receiver);
				},
			});
		const stages = [
			...chain(30).map(watched),
			watched(stage("f", { status: "failed" })),
			watched(stage("k", { status: "skipped" })),
		];
		const live = Object.freeze(stage("live", { status: "running" }));
		const snapshotOf = (all: readonly StageSnapshot[]): StoreSnapshot =>
			Object.freeze({ runs: Object.freeze([Object.freeze(run("r", [...all]))]), notices: [], version: 1 });
		const projector = new WorkflowActivityProjector();
		const first = snapshotOf([...stages, live]);
		projector.project({ snapshot: first, ownership: ownership() });
		const second = snapshotOf([...stages, Object.freeze(stage("live", { status: "completed" }))]);
		expandWorkflowGraph(second, "r");
		counting = true;
		const projected = projector.project({ snapshot: second, ownership: ownership() });
		counting = false;
		assert.equal(reads, 0);
		assert.deepStrictEqual(projected, projectWorkflowActivity({ snapshot: second, ownership: ownership() }));
	});

	test("an executing key names a stage of its own run only, when two runs share stage ids (#4642)", () => {
		const snapshot: StoreSnapshot = Object.freeze({
			runs: Object.freeze([Object.freeze(run("run-a", chain(3))), Object.freeze(run("run-b", chain(3)))]),
			notices: [],
			version: 1,
		});
		const owned = ownership({
			liveRunIds: new Set(["run-a", "run-b"]),
			executingStageIds: new Set([workflowActivityNodeKey("run-a", "s-1")]),
			retryingStageIds: new Set([workflowActivityNodeKey("run-b", "s-2")]),
		});
		const projected = new WorkflowActivityProjector().project({ snapshot, ownership: owned });
		assert.deepStrictEqual(projected, projectWorkflowActivity({ snapshot, ownership: owned }));
		assert.deepEqual(
			projected.map((root) => [root.rootRunId, root.activeExecutionCount, root.reason]),
			[
				["run-a", 1, "executing"],
				["run-b", 0, "retrying"],
			],
		);
	});

	test("projection follows every stage of a run whose stages share ids (#4642)", () => {
		const snapshot: StoreSnapshot = Object.freeze({
			runs: Object.freeze([
				Object.freeze(
					run("r", [stage("dup"), stage("dup"), stage("p", { status: "pending", parentIds: ["dup"] })]),
				),
			]),
			notices: [],
			version: 1,
		});
		const owned = ownership({
			liveRunIds: new Set(["r"]),
			executingStageIds: new Set([workflowActivityNodeKey("r", "dup")]),
		});
		const projector = new WorkflowActivityProjector();
		const single: StoreSnapshot = Object.freeze({ ...snapshot, runs: Object.freeze([run("r", [stage("dup")])]) });
		projector.project({ snapshot: single, ownership: owned });
		const projected = projector.project({ snapshot, ownership: owned });
		assert.deepStrictEqual(projected, projectWorkflowActivity({ snapshot, ownership: owned }));
		assert.equal(projected[0]?.activeExecutionCount, 2);
	});

	test("a retrying finished stage keeps its root working while a child run of it stops (#4642)", () => {
		const child = run("child", [stage("c", { status: "running" })], {
			parentRunId: "root",
			parentStageId: "b",
			rootRunId: "root",
		});
		const snapshot: StoreSnapshot = Object.freeze({
			runs: Object.freeze([
				Object.freeze(run("root", [stage("a"), stage("b", { status: "running" })])),
				Object.freeze(child),
			]),
			notices: [],
			version: 1,
		});
		const owned = ownership({
			liveRunIds: new Set(["root", "child"]),
			executingStageIds: new Set([workflowActivityNodeKey("child", "c")]),
			retryingStageIds: new Set([workflowActivityNodeKey("root", "a")]),
			stoppingRunIds: new Set(["child"]),
		});
		const [projected] = new WorkflowActivityProjector().project({ snapshot, ownership: owned });
		assert.deepStrictEqual([projected], projectWorkflowActivity({ snapshot, ownership: owned }));
		assert.equal(projected?.reason, "retrying");
	});

	test("a live run whose stages all ended keeps its root working while another of its runs waits for input (#4642)", () => {
		const waiting = run("child", [stage("c", { status: "running" })], {
			parentRunId: "root",
			parentStageId: "x",
			rootRunId: "root",
			pendingPrompt: { id: "p", kind: "input", message: "name?", createdAt: 1 },
		});
		const snapshot: StoreSnapshot = Object.freeze({
			runs: Object.freeze([Object.freeze(run("root", chain(3))), Object.freeze(waiting)]),
			notices: [],
			version: 1,
		});
		const owned = ownership({ liveRunIds: new Set(["root"]) });
		const [projected] = new WorkflowActivityProjector().project({ snapshot, ownership: owned });
		assert.deepStrictEqual([projected], projectWorkflowActivity({ snapshot, ownership: owned }));
		assert.equal(projected?.state, "working");
	});

	test("the executing and retrying keys are read once per projection, however many runs the root has (#4642)", () => {
		const readsOf = (children: number): number => {
			let reads = 0;
			class CountingSet extends Set<string> {
				override [Symbol.iterator](): SetIterator<string> {
					reads++;
					return super[Symbol.iterator]();
				}
			}
			const runs = [
				run("root", chain(2)),
				...Array.from({ length: children }, (_, index) =>
					run(`child:${index}`, chain(2), { parentRunId: "root", parentStageId: "s-0", rootRunId: "root" }),
				),
			].map((entry) => Object.freeze(entry));
			const snapshot: StoreSnapshot = Object.freeze({ runs: Object.freeze(runs), notices: [], version: 1 });
			const keys = new CountingSet(runs.map((entry) => workflowActivityNodeKey(entry.id, "s-1")));
			const owned = ownership({
				liveRunIds: new Set(runs.map((entry) => entry.id)),
				executingStageIds: keys,
				retryingStageIds: new CountingSet([workflowActivityNodeKey("child:1", "s-0")]),
			});
			const projected = new WorkflowActivityProjector().project({ snapshot, ownership: owned });
			const projectorReads = reads;
			assert.deepStrictEqual(projected, projectWorkflowActivity({ snapshot, ownership: owned }));
			return projectorReads;
		};
		assert.equal(readsOf(60), readsOf(5));
		assert.equal(readsOf(60), 2);
	});

	test("projected graph nodes are frozen with their parents and prompt (#4642)", () => {
		const prompt = { id: "p", kind: "select" as const, message: "pick", choices: ["a", "b"], createdAt: 1 };
		const snapshot: StoreSnapshot = Object.freeze({
			runs: Object.freeze([
				Object.freeze(
					run("r", [
						stage("a"),
						stage("b", { status: "awaiting_input", parentIds: ["a"], pendingPrompt: prompt }),
					]),
				),
			]),
			notices: [],
			version: 1,
		});
		const [root] = new WorkflowActivityProjector().project({ snapshot, ownership: ownership() });
		const node = root?.graph?.nodes[1];
		assert.ok(node?.kind === "stage" && node.pendingPrompt !== undefined);
		assert.ok(Object.isFrozen(node) && Object.isFrozen(node.parentIds));
		assert.ok(Object.isFrozen(node.pendingPrompt) && Object.isFrozen(node.pendingPrompt.choices));
		assert.ok(Object.isFrozen(root?.graph?.nodes[0]));
	});
});

describe("activity hub sharing edges (#4642)", () => {
	function node(id: string, extra: Partial<WorkflowGraphNode> = {}): WorkflowGraphNode {
		return {
			kind: "stage",
			id,
			runId: "r",
			nodeId: id,
			name: id,
			status: "completed",
			parentIds: [],
			depth: 0,
			...extra,
		} as WorkflowGraphNode;
	}

	function frozenNode(id: string): WorkflowGraphNode {
		const built = node(id);
		Object.freeze(built.parentIds);
		return Object.freeze(built);
	}

	function root(nodes: readonly WorkflowGraphNode[], extra: Partial<WorkflowRootActivity> = {}): WorkflowRootActivity {
		return {
			rootRunId: "r",
			ownerSessionId: "owner",
			state: "working",
			reason: "executing",
			activeExecutionCount: 1,
			actionableBlockCount: 0,
			needsAttention: false,
			...extra,
			graph: { nodes, ...(extra.graph ?? {}) },
		};
	}

	function observed(hub: WorkflowActivityHub): WorkflowActivityFrame[] {
		const frames: WorkflowActivityFrame[] = [];
		hub.observeWorkflowActivity((frame) => {
			frames.push(frame);
		});
		return frames;
	}

	const changedRoot = (frame: WorkflowActivityFrame | undefined): WorkflowRootActivity => {
		if (frame?.kind !== "changed") throw new Error("expected a changed frame");
		return frame.root;
	};

	test("a node a publisher may still change is copied and frozen, and a frozen one is shared (#4642)", async () => {
		const hub = new WorkflowActivityHub();
		const events: WorkflowRootActivity[] = [];
		hub.bindDispatcher(async (event) => {
			if (event.type === "workflow_activity_changed") events.push(event.root);
		});
		const frames = observed(hub);
		const publisher = hub.registerWorkflowActivityPublisher();
		publisher.publishSnapshot({ availability: "ready", roots: [] });
		const mutable = node("mutable");
		const shallowFrozen = Object.freeze(node("shallow", { parentIds: ["mutable"] }));
		const shared = frozenNode("shared");
		publisher.publishChanged(root([mutable, shallowFrozen, shared]));
		await nextTurn();
		const delivered = changedRoot(frames.at(-1)).graph!.nodes;
		assert.notEqual(delivered[0], mutable);
		assert.notEqual(delivered[1], shallowFrozen);
		assert.equal(delivered[2], shared);
		assert.ok(delivered.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.parentIds)));
		assert.equal(events.at(-1)?.graph?.nodes[2], shared);
		mutable.status = "running";
		(shallowFrozen.parentIds as string[]).push("late");
		await nextTurn();
		assert.equal(delivered[0]?.status, "completed");
		publisher.publishChanged(root([mutable, shallowFrozen, shared], { activeExecutionCount: 2 }));
		await nextTurn();
		const redelivered = changedRoot(frames.at(-1)).graph!.nodes;
		assert.equal(redelivered[0]?.status, "running", "a node published again as the same object is read again");
		assert.deepEqual(redelivered[1]?.parentIds, ["mutable", "late"]);
		assert.equal(redelivered[2], shared);
	});

	test("every observer, frame and event gets its own nodes array and graph fields (#4642)", async () => {
		const hub = new WorkflowActivityHub();
		const events: WorkflowRootActivity[] = [];
		hub.bindDispatcher(async (event) => {
			if (event.type === "workflow_activity_changed") events.push(event.root);
		});
		const first = observed(hub);
		const second = observed(hub);
		const publisher = hub.registerWorkflowActivityPublisher();
		const nodes = [frozenNode("a"), frozenNode("b")];
		const runPrompts = [{ id: "p", kind: "input" as const, message: "m", createdAt: 1, runId: "r" }];
		publisher.publishSnapshot({ availability: "ready", roots: [root(nodes, { graph: { nodes, runPrompts } })] });
		await nextTurn();
		const snapshotRoots = (frames: WorkflowActivityFrame[]) => {
			const frame = frames.at(-1);
			if (frame?.kind !== "snapshot" || frame.availability !== "ready") throw new Error("expected a ready snapshot");
			return frame.roots;
		};
		const [mine] = snapshotRoots(first);
		const [theirs] = snapshotRoots(second);
		assert.equal(mine?.graph?.nodes[0], nodes[0], "a snapshot frame shares the frozen nodes");
		assert.deepEqual(mine?.graph?.runPrompts, runPrompts);
		const mineNodes = mine?.graph?.nodes as WorkflowGraphNode[] | undefined;
		mineNodes?.push(frozenNode("c"));
		assert.equal(mineNodes?.length, 3);
		assert.equal(theirs?.graph?.nodes.length, 2);
		publisher.publishChanged(root(nodes, { graph: { nodes, runPrompts } }));
		await nextTurn();
		const changed = changedRoot(first.at(-1));
		const changedNodes = changed.graph?.nodes as WorkflowGraphNode[] | undefined;
		changedNodes?.pop();
		assert.equal(changedNodes?.length, 1);
		assert.equal(changedRoot(second.at(-1)).graph?.nodes.length, 2);
		assert.equal(events.at(-1)?.graph?.nodes.length, 2);
		assert.deepEqual(events.at(-1)?.graph?.runPrompts, runPrompts);
		publisher.publishChanged(root([], { activeExecutionCount: 0 }));
		await nextTurn();
		assert.deepEqual(changedRoot(first.at(-1)).graph?.nodes, []);
		publisher.publishChanged(root([], { rootRunId: "first-publication" }));
		await nextTurn();
		assert.deepEqual(changedRoot(first.at(-1)).graph?.nodes, []);
	});

	test("a frame waiting for a slow observer keeps the nodes it was published with (#4642)", async () => {
		const hub = new WorkflowActivityHub();
		const seen: string[][] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		hub.observeWorkflowActivity(async (frame) => {
			if (frame.kind === "changed") seen.push(frame.root.graph?.nodes.map((entry) => entry.status) ?? []);
			await gate;
		});
		const publisher = hub.registerWorkflowActivityPublisher();
		publisher.publishSnapshot({ availability: "ready", roots: [] });
		const done = Object.freeze({ ...frozenNode("x"), status: "completed" as const });
		const running = Object.freeze({ ...frozenNode("x"), status: "running" as const });
		publisher.publishChanged(root([frozenNode("a"), running]));
		publisher.publishChanged(root([frozenNode("a"), done]));
		publisher.publishChanged(root([frozenNode("a")]));
		release();
		for (let turn = 0; turn < 5; turn++) await nextTurn();
		assert.deepEqual(seen, [["completed", "running"], ["completed", "completed"], ["completed"]]);
	});

	test("republishing a root reads only the nodes that are new objects (#4642)", async () => {
		const lookups = async (count: number): Promise<number> => {
			const hub = new WorkflowActivityHub();
			observed(hub);
			const publisher = hub.registerWorkflowActivityPublisher();
			const nodes = Array.from({ length: count }, (_, index) => frozenNode(`n-${index}`));
			publisher.publishSnapshot({ availability: "ready", roots: [root(nodes)] });
			publisher.publishChanged(root(nodes));
			await nextTurn();
			const has = vi.spyOn(WeakSet.prototype, "has");
			const isFrozen = vi.spyOn(Object, "isFrozen");
			publisher.publishChanged(root([...nodes.slice(0, -1), frozenNode("replaced")]));
			publisher.publishSnapshot({ availability: "ready", roots: [root(nodes)] });
			const calls = has.mock.calls.length + isFrozen.mock.calls.length;
			has.mockRestore();
			isFrozen.mockRestore();
			await nextTurn();
			return calls;
		};
		assert.equal(await lookups(600), await lookups(10));
	});

	test("the hub releases the nodes of a root that is removed, dropped from a snapshot or unpublished (#4642)", async () => {
		const released = async (
			act: (
				publisher: ReturnType<WorkflowActivityHub["registerWorkflowActivityPublisher"]>,
				hub: WorkflowActivityHub,
			) => void,
		): Promise<boolean> => {
			const hub = new WorkflowActivityHub();
			let watched: WeakRef<object> | undefined;
			(() => {
				const publisher = hub.registerWorkflowActivityPublisher();
				publisher.publishSnapshot({ availability: "ready", roots: [] });
				const nodes = [frozenNode("a")];
				watched = new WeakRef(nodes);
				publisher.publishChanged(root(nodes));
				act(publisher, hub);
			})();
			// A WeakRef keeps its target alive until the job that created it ends.
			await nextTurn();
			collectGarbage();
			const wasReleased = watched?.deref() === undefined;
			hub.dispose();
			return wasReleased;
		};
		assert.equal(await released((publisher) => publisher.publishRemoved("r")), true, "removed");
		assert.equal(
			await released((publisher) => publisher.publishSnapshot({ availability: "ready", roots: [] })),
			true,
			"dropped from a snapshot",
		);
		assert.equal(
			await released((publisher) => publisher.publishChanged({ ...root([]), graph: undefined })),
			true,
			"published without a graph",
		);
		assert.equal(await released((publisher) => publisher.dispose()), true, "its publisher disposed");
		assert.equal(
			await released((_publisher, hub) => hub.registerWorkflowActivityPublisher()),
			true,
			"another publisher registered",
		);
	});
});
