import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildWorkflowGraphSnapshot } from "../../packages/subagents/src/runs/shared/workflow-graph.js";

describe("workflow graph snapshots", () => {
	test("maps sequential chains with phase, label, output name, and stable flat indexes", () => {
		const graph = buildWorkflowGraphSnapshot({
			runId: "run-1",
			steps: [
				{ agent: "scout", task: "Scan", phase: "Research", label: "Find context", as: "context" },
				{ agent: "writer", task: "Use {outputs.context}", phase: "Synthesis", outputSchema: { type: "object" } },
			],
			results: [{ status: "ok" }, { status: "error", error: "bad output" }],
		});

		assert.equal(graph.nodes[0]?.id, "step-0");
		assert.equal(graph.nodes[0]?.label, "Find context");
		assert.equal(graph.nodes[0]?.flatIndex, 0);
		assert.equal(graph.nodes[0]?.outputName, "context");
		assert.equal(graph.nodes[1]?.structured, true);
		assert.equal(graph.nodes[1]?.status, "failed");
		assert.deepEqual(graph.phases, [
			{ title: "Research", nodeIds: ["step-0"] },
			{ title: "Synthesis", nodeIds: ["step-1"] },
		]);
	});

	test("maps parallel chain steps with stable group and child indexes", () => {
		const graph = buildWorkflowGraphSnapshot({
			runId: "run-2",
			steps: [
				{ agent: "setup", task: "Setup" },
				{
					parallel: [
						{ agent: "reviewer", label: "Correctness", phase: "Review", as: "correctness" },
						{ agent: "security", label: "Security", phase: "Review", as: "security" },
					],
				},
			],
			currentFlatIndex: 2,
		});

		const group = graph.nodes[1];
		assert.equal(group?.kind, "parallel-group");
		assert.equal(group?.children?.[0]?.id, "step-1-agent-0");
		assert.equal(group?.children?.[0]?.flatIndex, 1);
		assert.equal(group?.children?.[1]?.flatIndex, 2);
		assert.equal(group?.children?.[1]?.status, "running");
		assert.equal(graph.currentNodeId, "step-1-agent-1");
		assert.deepEqual(graph.phases, [{ title: "Review", nodeIds: ["step-1-agent-0", "step-1-agent-1"] }]);
	});

	test("marks partially completed parallel groups as running", () => {
		const graph = buildWorkflowGraphSnapshot({
			runId: "run-3",
			steps: [{ parallel: [{ agent: "first" }, { agent: "second" }] }],
			results: [{ status: "ok" }],
		});

		assert.equal(graph.nodes[0]?.status, "running");
		assert.equal(graph.nodes[0]?.children?.[0]?.status, "completed");
		assert.equal(graph.nodes[0]?.children?.[1]?.status, "pending");
	});

	test("summarizes mixed terminal parallel group statuses with explicit precedence", () => {
		const failedThenPaused = buildWorkflowGraphSnapshot({
			runId: "run-4",
			steps: [{ parallel: [{ agent: "first" }, { agent: "second" }] }],
			results: [{ status: "error" }, { status: "error", interrupted: true }],
		});
		const pausedThenFailed = buildWorkflowGraphSnapshot({
			runId: "run-5",
			steps: [{ parallel: [{ agent: "first" }, { agent: "second" }] }],
			results: [{ status: "error", interrupted: true }, { status: "error" }],
		});

		assert.equal(failedThenPaused.nodes[0]?.status, "failed");
		assert.equal(pausedThenFailed.nodes[0]?.status, "failed");
	});

	test("uses dynamic group status overrides for empty or aggregate-failure fanout states", () => {
		const steps = [
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {item}" },
				collect: { as: "reviews" },
			},
		];

		const emptySkip = buildWorkflowGraphSnapshot({
			runId: "run-dynamic-empty",
			steps,
			dynamicGroupStatuses: { 0: { status: "completed" } },
		});
		assert.equal(emptySkip.nodes[0]?.kind, "dynamic-parallel-group");
		assert.equal(emptySkip.nodes[0]?.status, "completed");
		assert.deepEqual(emptySkip.nodes[0]?.children, []);

		const collectFailure = buildWorkflowGraphSnapshot({
			runId: "run-dynamic-collect-fail",
			steps,
			dynamicChildren: { 0: [{ agent: "reviewer", flatIndex: 0, itemKey: "a" }] },
			results: [{ status: "ok" }],
			dynamicGroupStatuses: { 0: { status: "failed", error: "Collected output validation failed" } },
		});
		assert.equal(collectFailure.nodes[0]?.status, "failed");
		assert.match(collectFailure.nodes[0]?.error ?? "", /Collected output validation failed/);
		assert.equal(collectFailure.nodes[0]?.children?.[0]?.status, "completed");
	});
});
