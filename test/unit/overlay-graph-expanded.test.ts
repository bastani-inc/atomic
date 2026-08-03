// @ts-nocheck

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import * as h from "./overlay-graph-helpers.js";

const { makeStage, makeRun } = h;

describe("expanded workflow graph", () => {
	it("rewires parent stages after workflow boundaries to child terminal stages", () => {
		const rootBoundary: StageSnapshot = {
			...makeStage("workflow:child"),
			status: "completed",
			workflowChild: {
				alias: "child",
				workflow: "child-workflow",
				runId: "child-run",
				status: "completed",
				outputs: { result: "ok" },
			},
		};
		const rootAfter = makeStage("parent-after", ["workflow:child"]);
		const childFirst = makeStage("child-first");
		const childSecond = makeStage("child-second", ["child-first"]);
		const snap: StoreSnapshot = {
			runs: [
				makeRun([rootBoundary, rootAfter]),
				{
					id: "child-run",
					name: "child-workflow",
					inputs: {},
					status: "completed",
					stages: [childFirst, childSecond],
					startedAt: Date.now(),
					endedAt: Date.now(),
					parentRunId: "run-1",
					parentStageId: rootBoundary.id,
					rootRunId: "run-1",
				},
			],
			notices: [],
			version: 1,
		};

		const graph = expandWorkflowGraph(snap, "run-1");
		const after = graph.stages.find((stage) => stage.name === "parent-after");

		assert.deepEqual(after?.parentIds, ["child-run:child-second"]);
	});

	it("flattens the imported workflow: drops the boundary node and inlines child stages", () => {
		const rootBoundary: StageSnapshot = {
			...makeStage("workflow:child"),
			status: "completed",
			workflowChild: {
				alias: "child",
				workflow: "child-workflow",
				runId: "child-run",
				status: "completed",
				outputs: { result: "ok" },
			},
		};
		const rootAfter = makeStage("parent-after", ["workflow:child"]);
		const childFirst = makeStage("child-first");
		const childSecond = makeStage("child-second", ["child-first"]);
		const snap: StoreSnapshot = {
			runs: [
				makeRun([rootBoundary, rootAfter]),
				{
					id: "child-run",
					name: "child-workflow",
					inputs: {},
					status: "completed",
					stages: [childFirst, childSecond],
					startedAt: Date.now(),
					endedAt: Date.now(),
					parentRunId: "run-1",
					parentStageId: rootBoundary.id,
					rootRunId: "run-1",
				},
			],
			notices: [],
			version: 1,
		};

		const graph = expandWorkflowGraph(snap, "run-1");

		// The boundary "information" node is gone; the nested workflow reads flat.
		assert.equal(
			graph.stages.some((stage) => stage.name === "workflow:child"),
			false,
		);
		// Child root inherits the boundary's (empty) incoming parents.
		const first = graph.stages.find((stage) => stage.name === "child-first");
		assert.deepEqual(first?.parentIds, []);
		// Exactly the two inlined child stages + the downstream parent stage remain.
		assert.deepEqual(graph.stages.map((stage) => stage.name).sort(), ["child-first", "child-second", "parent-after"]);
	});

	it("keeps the boundary node when the imported workflow has no stages of its own", () => {
		const rootBoundary: StageSnapshot = {
			...makeStage("workflow:child"),
			status: "completed",
			workflowChild: {
				alias: "child",
				workflow: "child-workflow",
				runId: "child-run",
				status: "completed",
				outputs: { result: "ok" },
			},
		};
		const snap: StoreSnapshot = {
			runs: [
				makeRun([rootBoundary]),
				{
					id: "child-run",
					name: "child-workflow",
					inputs: {},
					status: "completed",
					stages: [],
					startedAt: Date.now(),
					endedAt: Date.now(),
					parentRunId: "run-1",
					parentStageId: rootBoundary.id,
					rootRunId: "run-1",
				},
			],
			notices: [],
			version: 1,
		};

		const graph = expandWorkflowGraph(snap, "run-1");

		assert.deepEqual(
			graph.stages.map((stage) => stage.name),
			["workflow:child"],
		);
	});

	it("does not flatten stale child metadata from skipped or failed workflow boundaries", () => {
		for (const status of ["skipped", "failed"] as const) {
			const rootBoundary: StageSnapshot = {
				...makeStage("workflow:child"),
				status,
				endedAt: Date.now(),
				...(status === "skipped" ? { skippedReason: "workflow-exit" } : { error: "boom" }),
				workflowChildRun: {
					alias: "child",
					workflow: "child-workflow",
					runId: "child-run",
				},
				workflowChild: {
					alias: "child",
					workflow: "child-workflow",
					runId: "child-run",
					status: "completed",
					outputs: { result: "stale" },
				},
			};
			const rootAfter = makeStage("parent-after", ["workflow:child"]);
			const childFirst = makeStage("child-first");
			const snap: StoreSnapshot = {
				runs: [
					makeRun([rootBoundary, rootAfter]),
					{
						id: "child-run",
						name: "child-workflow",
						inputs: {},
						status: "completed",
						stages: [childFirst],
						startedAt: Date.now(),
						endedAt: Date.now(),
					},
				],
				notices: [],
				version: 1,
			};

			const graph = expandWorkflowGraph(snap, "run-1");
			const after = graph.stages.find((stage) => stage.name === "parent-after");

			assert.equal(
				graph.stages.some((stage) => stage.name === "child-first"),
				false,
			);
			assert.equal(
				graph.stages.some((stage) => stage.name === "workflow:child"),
				true,
			);
			assert.deepEqual(after?.parentIds, ["workflow:child"]);
		}
	});
});
