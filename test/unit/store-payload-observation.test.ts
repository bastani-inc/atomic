import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { COMPACT_RESULT_FIELD_LIMIT } from "../../packages/workflows/src/shared/graph-store-snapshot.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { ToolEvent, WorkflowChildReplaySnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderNodeCard } from "../../packages/workflows/src/tui/node-card.js";

describe("payload-free store observation", () => {
	test("notifies synchronously without traversing unrelated workflow inputs", () => {
		const store = createStore();
		let payloadReads = 0;
		const evidence: Record<string, string> = {};
		Object.defineProperty(evidence, "occurrences", {
			enumerable: true,
			get() {
				payloadReads++;
				return "large-unrelated-payload";
			},
		});
		store.recordRunStart({
			id: "run-large",
			name: "large-workflow",
			inputs: { evidence },
			status: "running",
			stages: [
				{
					id: "question",
					name: "question",
					status: "running",
					parentIds: [],
					toolEvents: [],
				},
			],
			startedAt: Date.now(),
		});
		payloadReads = 0;
		let calls = 0;
		const unsubscribe = store.subscribeInvalidation(() => {
			calls++;
			store.graphSnapshot();
		});
		assert.ok(unsubscribe);

		assert.equal(
			store.recordStageInputRequest("run-large", "question", {
				id: "question-1",
				kind: "ask_user_question",
				questions: [{ question: "Continue?", options: [] }],
				createdAt: Date.now(),
			}),
			true,
		);

		assert.equal(calls, 1);
		assert.equal(payloadReads, 0);
		assert.deepEqual(store.graphSnapshot().runs[0]?.inputs, {});
		unsubscribe();
	});

	test("preserves legacy full-snapshot subscribers", () => {
		const store = createStore();
		const versions: number[] = [];
		store.subscribe((snapshot) => versions.push(snapshot.version));
		store.recordRunStart({
			id: "run-legacy",
			name: "legacy",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		assert.deepEqual(versions, [1]);
	});

	test("excludes authored stage results but preserves durable tool summaries", () => {
		const store = createStore();
		store.recordRunStart({
			id: "run-results",
			name: "results",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "agent-stage",
					name: "agent-stage",
					status: "completed",
					parentIds: [],
					result: "unbounded agent output",
					toolEvents: [],
				},
			],
			toolNodes: [
				{
					kind: "tool",
					id: "tool-node",
					name: "verify",
					argsHash: "hash",
					ordinal: 1,
					parentIds: ["agent-stage"],
					status: "completed",
					resultSummary: "bounded tool summary",
					attachable: false,
				},
			],
			startedAt: Date.now(),
		});

		const snapshot = store.graphSnapshot();
		assert.ok(snapshot);
		assert.equal(snapshot.runs[0]?.stages[0]?.result, undefined);
		assert.equal(snapshot.runs[0]?.toolNodes?.[0]?.resultSummary, "bounded tool summary");
		const graph = expandWorkflowGraph(snapshot, "run-results");
		assert.equal(graph.renderStages.find((stage) => stage.nodeKind === "tool")?.result, "bounded tool summary");
	});

	test("preserves child output counts without retaining child outputs", () => {
		const store = createStore();
		const outputs = { artifact: "ready", checksum: "ok", notes: "done" };
		const workflowChild: WorkflowChildReplaySnapshot = {
			alias: "child",
			workflow: "publish-child",
			runId: "child-run",
			status: "completed",
			outputs,
		};
		store.recordRunStart({
			id: "run-child-output-count",
			name: "child-output-count",
			inputs: {},
			status: "running",
			stages: [
				{
					id: "child-boundary",
					name: "workflow:publish-child",
					status: "completed",
					parentIds: [],
					toolEvents: [],
					workflowChild,
				},
			],
			startedAt: Date.now(),
		});

		const projectedStage = store.graphSnapshot().runs[0]!.stages[0]!;
		const expectedCount = Object.keys(outputs).length;
		assert.deepEqual(projectedStage.workflowChild?.outputs, {});
		assert.equal(projectedStage.workflowChild?.outputCount, expectedCount);
		const projectedCard = renderNodeCard(projectedStage, { theme: deriveGraphTheme({}) }).join("\n");
		assert.match(projectedCard, new RegExp(`\\b${expectedCount} outs\\b`));

		const legacyStage = store.snapshot().runs[0]!.stages[0]!;
		assert.equal(legacyStage.workflowChild?.outputCount, undefined);
		const legacyCard = renderNodeCard(legacyStage, { theme: deriveGraphTheme({}) }).join("\n");
		assert.match(legacyCard, new RegExp(`\\b${expectedCount} outs\\b`));
		assert.equal(projectedCard, legacyCard, "compact and legacy snapshots must render byte-identically");
	});

	test("memoizes one graph snapshot per store version", () => {
		const store = createStore();
		const first = store.graphSnapshot();
		const second = store.graphSnapshot();
		assert.strictEqual(second, first);

		store.recordNotice({ id: "memo-bump", runId: "run-memo", level: "info", message: "changed", createdAt: 1 });
		const next = store.graphSnapshot();
		assert.notStrictEqual(next, first);
		assert.equal(next.version, first.version + 1);
		assert.strictEqual(store.graphSnapshot(), next);
	});

	test("bounds projected run results and tool events without changing short fields", () => {
		const store = createStore();
		const longSummary = "x".repeat(COMPACT_RESULT_FIELD_LIMIT * 5);
		const shortResult = "short result";
		const toolEvents: ToolEvent[] = [
			{ name: "read", input: { path: "secret-a" }, output: "payload-a", startedAt: 1, endedAt: 2 },
			{ name: "search", input: { query: "secret-b" }, output: "payload-b", startedAt: 3, endedAt: 4 },
			{ name: "write", input: { path: "secret-c" }, output: "payload-c", startedAt: 5, endedAt: 6 },
		];
		store.recordRunStart({
			id: "run-bounded-fields",
			name: "bounded-fields",
			inputs: {},
			status: "completed",
			result: { summary: longSummary, result: shortResult },
			stages: [
				{
					id: "tool-heavy-stage",
					name: "tool-heavy-stage",
					status: "completed",
					parentIds: [],
					toolEvents,
				},
			],
			startedAt: 1,
			endedAt: 2,
		});

		const projectedRun = store.graphSnapshot().runs[0]!;
		assert.equal(projectedRun.result?.summary, longSummary.slice(0, COMPACT_RESULT_FIELD_LIMIT));
		assert.equal(projectedRun.result?.summary?.length, COMPACT_RESULT_FIELD_LIMIT);
		assert.equal(projectedRun.result?.result, shortResult);
		assert.deepEqual(
			projectedRun.stages[0]!.toolEvents,
			toolEvents.slice(-1).map((event) => ({ name: event.name })),
		);
	});

	test("deep-freezes the shared graph snapshot", () => {
		const store = createStore();
		store.recordRunStart({
			id: "run-frozen",
			name: "frozen",
			inputs: {},
			status: "running",
			stages: [{ id: "nested-stage", name: "nested-stage", status: "running", parentIds: [], toolEvents: [] }],
			startedAt: Date.now(),
		});

		const snapshot = store.graphSnapshot();
		assert.equal(Object.isFrozen(snapshot), true);
		assert.equal(Object.isFrozen(snapshot.runs), true);
		assert.equal(Object.isFrozen(snapshot.runs[0]!.stages[0]!), true);
	});

	test("isolates invalidation and snapshot subscribers from listener failures", () => {
		const store = createStore();
		const calls: string[] = [];
		store.subscribeInvalidation(() => {
			calls.push("invalidation-thrower");
			throw new Error("invalidation listener failed");
		});
		store.subscribeInvalidation(() => calls.push("invalidation-later"));
		store.subscribe(() => {
			calls.push("snapshot-thrower");
			throw new Error("snapshot listener failed");
		});
		store.subscribe(() => calls.push("snapshot-later"));

		assert.doesNotThrow(() =>
			store.recordNotice({
				id: "listener-isolation",
				runId: "run-listeners",
				level: "info",
				message: "notice",
				createdAt: 1,
			}),
		);
		assert.deepEqual(calls, ["invalidation-thrower", "invalidation-later", "snapshot-thrower", "snapshot-later"]);
	});
});
