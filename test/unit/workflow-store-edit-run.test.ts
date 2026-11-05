import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflowObservationRuntime } from "../../packages/workflows/src/shared/store-factory.js";
import type { StoreRunChange } from "../../packages/workflows/src/shared/store-public-types.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function stage(id: string, status: StageSnapshot["status"] = "running"): StageSnapshot {
	return { id, name: id, status, parentIds: [], toolEvents: [] };
}

function tool(id: string, status: ToolNodeSnapshot["status"]): ToolNodeSnapshot {
	return { kind: "tool", attachable: false, id, name: id, status, parentIds: [], ordinal: 0, argsHash: id };
}

function run(): RunSnapshot {
	return {
		id: "run",
		name: "run",
		inputs: {},
		status: "running",
		stages: [stage("a", "completed"), stage("b")],
		toolNodes: [tool("t", "running")],
		startedAt: 0,
	};
}

test("editing a run in place shows only the edited nodes as changed, in one invalidation (#4317)", () => {
	const store = createStore();
	store.recordRunStart(run());
	const before = store.graphSnapshot().runs[0]!;
	const invalidations: (readonly StoreRunChange[] | undefined)[] = [];
	store.subscribeInvalidation((changes) => invalidations.push(changes));
	const version = store.graphSnapshot().version;
	const stored = store.run("run")!;
	assert.equal(
		store.editRun("run", (edited) => {
			assert.equal(edited, stored);
			edited.stages[1] = stage("b", "completed");
			edited.stages.push(stage("c"));
			edited.toolNodes[0] = tool("t", "completed");
			return { stageIds: ["b", "c"], toolNodeIds: ["t"] };
		}),
		true,
	);
	assert.deepEqual(invalidations, [
		[
			{ runId: "run", stageId: "b" },
			{ runId: "run", stageId: "c" },
			{ runId: "run", toolNodeId: "t" },
		],
	]);
	const after = store.graphSnapshot();
	assert.equal(after.version, version + 3);
	const graph = after.runs[0]!;
	assert.equal(graph.stages[0], before.stages[0], "an unedited stage keeps its frozen projection");
	assert.deepEqual(
		graph.stages.map((entry) => [entry.id, entry.status]),
		[
			["a", "completed"],
			["b", "completed"],
			["c", "running"],
		],
	);
	assert.equal(graph.toolNodes[0]?.status, "completed");
	assert.equal(store.run("run"), stored, "the run keeps its identity");
});

test("an edit of a run's own fields re-reads the run (#4317)", () => {
	const store = createStore();
	store.recordRunStart(run());
	store.graphSnapshot();
	store.editRun("run", (edited) => {
		edited.status = "completed";
		return { run: true };
	});
	assert.equal(store.graphSnapshot().runs[0]?.status, "completed");
	store.editRun("run", (edited) => {
		edited.error = "unreported";
		return {};
	});
	assert.equal(store.graphSnapshot().runs[0]?.error, undefined, "an edit that reports nothing invalidates nothing");
});

test("editing a run the store does not hold changes nothing and reports false (#4317)", () => {
	const store = createStore();
	let edited = false;
	let invalidated = false;
	store.subscribeInvalidation(() => {
		invalidated = true;
	});
	assert.equal(
		store.editRun("missing", () => {
			edited = true;
			return { run: true };
		}),
		false,
	);
	assert.equal(edited, false);
	assert.equal(invalidated, false);
});

test("observers re-read an edited stage that another edit moved in place, and skip one the run no longer has (#4317)", () => {
	const store = createStore();
	const runtime = workflowObservationRuntime(store);
	runtime.startRun("run");
	const events: string[] = [];
	runtime.listeners.add((event) => {
		if (event.kind === "lifecycle" && event.event.target.kind === "stage")
			events.push(`${event.event.target.stageId}:${event.event.target.status}`);
	});
	store.recordRunStart({ ...run(), stages: [stage("a"), stage("b"), stage("c")] });
	store.editRun("run", (edited) => {
		edited.stages[0] = stage("a", "completed");
		return { stageIds: ["a"] };
	});
	store.editRun("run", (edited) => {
		edited.stages.reverse();
		edited.stages[2] = stage("a", "failed");
		edited.stages[0] = stage("c", "failed");
		edited.stages[1] = stage("b", "completed");
		return { stageIds: ["a", "c", "missing", "b"] };
	});
	store.editRun("run", (edited) => {
		edited.stages.length = 1;
		edited.stages[0] = stage("c", "completed");
		return { stageIds: ["a", "c"] };
	});
	assert.deepEqual(events, ["a:completed", "c:failed", "b:completed", "a:failed", "c:completed"]);
});
