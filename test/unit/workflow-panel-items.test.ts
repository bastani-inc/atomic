/**
 * Workflow runs as agent-panel rows: ported from the retired BACKGROUND widget's rendering tests (#5224), which now
 * apply to the panel's run rows.
 */
import assert from "node:assert/strict";
import { visibleWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import {
	type AgentPanelStyle,
	formatPanelElapsed,
	renderAgentPanelRows,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";

const plain: AgentPanelStyle = {
	dim: (t) => t,
	text: (t) => t,
	muted: (t) => t,
	border: (t) => t,
	bold: (t) => t,
	accent: (t) => t,
	success: (t) => t,
	error: (t) => t,
	warning: (t) => t,
};

const stage = (id: string, status: StageSnapshot["status"], extra: Partial<StageSnapshot> = {}): StageSnapshot => ({
	id,
	name: id,
	status,
	parentIds: [],
	toolEvents: [],
	...extra,
});

function run(
	id: string,
	status: RunSnapshot["status"],
	stages: StageSnapshot[] = [],
	extra: Partial<RunSnapshot> = {},
) {
	return { id, name: id, inputs: {}, status, toolNodes: [], stages, startedAt: 1_000, ...extra } as RunSnapshot;
}

test("elapsed time reads seconds, minutes, then hours and minutes, and never goes negative (#5224)", () => {
	assert.equal(formatPanelElapsed(-5_000), "0s");
	assert.equal(formatPanelElapsed(59_000), "59s");
	assert.equal(formatPanelElapsed(60_000), "1m");
	assert.equal(formatPanelElapsed(3_600_000), "1h 0m");
	assert.equal(formatPanelElapsed(3_660_000), "1h 1m");
});

test("run states map to panel states: running, paused for blocked, done, failed, stopped for quit (#5224)", () => {
	const items = panelItemsFromSnapshot(
		[
			run("live", "running", [stage("a", "running")]),
			run("blocked", "blocked", [stage("a", "blocked")]),
			run(
				"quit",
				"paused",
				[stage("a", "paused", { pendingPrompt: { id: "p", kind: "confirm", message: "Go?", createdAt: 1 } })],
				{
					exitReason: "quit",
					quitAt: 2_000,
					resumable: true,
				},
			),
			run("done", "completed", [stage("a", "completed")], { endedAt: 61_000 }),
			run("failed", "failed", [stage("a", "failed", { error: "boom\nstack" })], { endedAt: 5_000 }),
			run("cancelled", "cancelled", [], { endedAt: 5_000 }),
		],
		100_000,
	);
	const state = Object.fromEntries(items.map((item) => [item.name, item.state]));
	assert.deepEqual(state, {
		live: "running",
		blocked: "paused",
		quit: "stopped",
		done: "done",
		failed: "failed",
		cancelled: "stopped",
	});
	const byName = (name: string) => items.find((item) => item.name === name)!;
	assert.equal(byName("quit").question, undefined, "a quit run waits for resume, not for an answer");
	assert.equal(byName("done").elapsedMs, 60_000, "a finished run's time stops at its end");
	assert.equal(byName("failed").reason, "boom", "a failure reason is one line");
	assert.equal(byName("live").task, "stage a");
});

test("every top-level run gets a row, however many run at once, and nested runs none (#5224)", () => {
	const runs = Array.from({ length: 7 }, (_, index) => run(`root-${index}`, "running"));
	runs.push(run("child", "running", [], { parentRunId: "root-0", rootRunId: "root-0" }));
	assert.deepEqual(
		panelItemsFromSnapshot(runs).map((item) => item.name),
		runs.slice(0, 7).map((item) => item.name),
	);
});

test("stage progress counts settled stages of the run (#5224)", () => {
	const [item] = panelItemsFromSnapshot([
		run("progress", "running", [
			stage("a", "completed"),
			stage("b", "skipped"),
			stage("c", "running"),
			stage("d", "pending"),
		]),
	]);
	assert.deepEqual(item?.progress, { done: 2, total: 4 });
});

test("run rows stay well formed at the requested width with hostile, wide and surrogate text (#5224)", () => {
	const rows = panelItemsFromSnapshot([
		run("\ud83d bad surrogate", "running", [stage("名前の長いステージ\u202e\u0000", "running")]),
		run("zero\u200b\u0301width", "running"),
	]);
	for (const width of [30, 40, 56, 80, 160]) {
		for (const line of renderAgentPanelRows(rows, width, plain)) {
			assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
			const text = line.replace(/\x1b\[[0-9;]*m/g, "");
			assert.doesNotMatch(text, /[\x00-\x1f\x7f\u202e\u200b]/);
			assert.equal(text, text.toWellFormed(), "no unpaired surrogates");
		}
	}
});

test("nested, dynamic and fan-out runs match the expanded graph's stage progress and current stage (#5224)", () => {
	const store = createStore();
	store.recordRunStart(
		run("root", "running", [
			stage("composition", "running", { workflowChildRun: { runId: "child", workflow: "sub", alias: "sub" } }),
			stage("verify", "pending", { parentIds: ["composition"] }),
		]),
	);
	store.recordRunStart(
		run(
			"child",
			"running",
			[
				stage("step-1", "completed"),
				stage("step-2", "running", { parentIds: ["step-1"] }),
				stage("step-3", "pending", { parentIds: ["step-2"] }),
			],
			{ parentRunId: "root", parentStageId: "composition", rootRunId: "root" },
		),
	);
	const initialGraph = expandWorkflowGraph(store.graphSnapshot(), "root");
	const [initialItem] = panelItemsFromSnapshot(store.runs());
	assert.deepEqual(initialItem?.progress, {
		done: initialGraph.stages.filter((s) => s.status === "completed").length,
		total: initialGraph.stages.length,
	});
	assert.deepEqual(initialItem?.progress, { done: 1, total: 4 });
	assert.equal(initialItem?.task, "stage step-2");

	store.recordStageEnd("child", stage("step-2", "completed", { parentIds: ["step-1"] }));
	store.recordStageStart("child", stage("step-4", "pending", { parentIds: ["step-3"] }));
	store.editRun("child", (target) => {
		const next = target.stages.find((candidate) => candidate.id === "step-3");
		if (next) next.status = "running";
		return { stageIds: ["step-3"] };
	});
	const updatedGraph = expandWorkflowGraph(store.graphSnapshot(), "root");
	const [updatedItem] = panelItemsFromSnapshot(store.runs());
	assert.deepEqual(updatedItem?.progress, { done: 2, total: updatedGraph.stages.length });
	assert.deepEqual(updatedItem?.progress, { done: 2, total: 5 });
	assert.equal(updatedItem?.task, "stage step-3");

	const fanoutStore = createStore();
	fanoutStore.recordRunStart(
		run("fanout-root", "running", [
			stage("fan-a", "completed", {
				workflowChild: {
					runId: "fan-child-a",
					workflow: "sub",
					alias: "a",
					status: "completed",
					outputs: {},
				},
			}),
			stage("fan-b", "running", { workflowChildRun: { runId: "fan-child-b", workflow: "sub", alias: "b" } }),
			stage("final", "pending", { parentIds: ["fan-a", "fan-b"] }),
		]),
	);
	fanoutStore.recordRunStart(
		run("fan-child-a", "completed", [stage("a1", "completed"), stage("a2", "completed", { parentIds: ["a1"] })], {
			parentRunId: "fanout-root",
			parentStageId: "fan-a",
			rootRunId: "fanout-root",
			endedAt: 2_000,
		}),
	);
	fanoutStore.recordRunStart(
		run("fan-child-b", "running", [stage("b1", "completed"), stage("merge", "running", { parentIds: ["b1"] })], {
			parentRunId: "fanout-root",
			parentStageId: "fan-b",
			rootRunId: "fanout-root",
		}),
	);
	const fanoutGraph = expandWorkflowGraph(fanoutStore.graphSnapshot(), "fanout-root");
	const [fanoutItem] = panelItemsFromSnapshot(fanoutStore.runs());
	assert.deepEqual(fanoutItem?.progress, { done: 3, total: fanoutGraph.stages.length });
	assert.deepEqual(fanoutItem?.progress, { done: 3, total: 5 });
	assert.equal(fanoutItem?.task, "stage merge");
	assert.deepEqual(panelItemsFromSnapshot(fanoutStore.graphSnapshot())[0]?.progress, { done: 3, total: 5 });
});

test("a tools-only completed run omits empty stage progress and never renders a 0/0 bar (#5224)", () => {
	const tools: ToolNodeSnapshot[] = [
		{
			id: "t1",
			kind: "tool",
			name: "collect",
			argsHash: "h1",
			ordinal: 0,
			status: "completed",
			parentIds: [],
			attachable: false,
			startedAt: 1_000,
			endedAt: 2_000,
		},
		{
			id: "t2",
			kind: "tool",
			name: "publish",
			argsHash: "h2",
			ordinal: 1,
			status: "completed",
			parentIds: ["t1"],
			attachable: false,
			startedAt: 2_000,
			endedAt: 3_000,
		},
	];
	const items = panelItemsFromSnapshot([run("ship-notes", "completed", [], { toolNodes: tools, endedAt: 3_000 })]);
	assert.equal(items[0]?.state, "done");
	assert.equal(items[0]?.progress, undefined);
	for (const width of [80, 160]) {
		const rendered = renderAgentPanelRows(items, width, plain).join("\n");
		assert.match(rendered, /✓ ship-notes/);
		assert.doesNotMatch(rendered, /0\/0 stages/);
		assert.doesNotMatch(rendered, /▱/);
	}
});

test("run and stage names strip escape sequences, format control bytes as \\xNN and bidi controls as <U+XXXX> (#5224)", () => {
	const [item] = panelItemsFromSnapshot([
		run("ship\x1b[31m\x1b]0;pwned\x07\x00\u202enotes", "running", [
			stage("build\x1b[2J\x07\x7f\u2066step", "running"),
		]),
	]);
	assert.equal(item?.name, "ship\\x00<U+202E>notes");
	assert.equal(item?.task, "stage build\\x07\\x7f<U+2066>step");
});

test("workflow names strip complete cursor and control-string sequences without swallowing visible text (#5239)", () => {
	const [item] = panelItemsFromSnapshot([
		run("ship\x1b[?25l hello m\u009b2Jdone\x07", "running", [
			stage("build\x1bPpayload\x1b\\\x07\u009dhidden title\u009cstep", "running"),
		]),
	]);
	assert.equal(item?.name, "ship hello mdone\\x07");
	assert.equal(item?.task, "stage build\\x07step");
	const [separated] = panelItemsFromSnapshot([
		run("row\u2028next\u2029line", "running", [stage("build\u2028next", "running")]),
	]);
	assert.equal(separated?.name, "row next line");
	assert.equal(separated?.task, "stage build next");
});

test("single-select input requests project option labels as choices while multi-select and ambiguous prompts do not (#5224)", () => {
	const single = run("single-select", "running", [
		stage("ask", "awaiting_input", {
			inputRequest: {
				id: "req-1",
				kind: "ask_user_question",
				createdAt: 1_000,
				questions: [
					{
						question: "Which track?",
						options: [{ label: "stable" }, { label: "canary" }],
					},
				],
			},
		}),
	]);
	const multi = run("multi-select", "running", [
		stage("ask", "awaiting_input", {
			inputRequest: {
				id: "req-2",
				kind: "ask_user_question",
				createdAt: 1_000,
				questions: [
					{
						question: "Which tracks?",
						multiSelect: true,
						options: [{ label: "stable" }, { label: "canary" }],
					},
				],
			},
		}),
	]);
	const items = panelItemsFromSnapshot([single, multi]);
	assert.deepEqual(items[0]?.choices, ["stable", "canary"]);
	assert.equal(items[1]?.choices, undefined);
});

test("shallowly frozen workflow inputs still reflect mutable stage changes (#5239)", () => {
	for (const snapshotInput of [false, true]) {
		const stages = [stage("a", "completed"), stage("b", "completed"), stage("c", "completed")];
		const runs = Object.freeze([Object.freeze(run("shallow-frozen", "running", stages))]);
		const input = snapshotInput ? Object.freeze({ runs, notices: [], version: 1 }) : runs;
		assert.deepEqual(panelItemsFromSnapshot(input)[0]?.progress, { done: 3, total: 3 });
		stages[1]!.status = "running";
		const updated = panelItemsFromSnapshot(input)[0];
		assert.deepEqual(updated?.progress, { done: 2, total: 3 });
		assert.equal(updated?.task, "stage b");
	}
});

test("cached snapshot projection does not rescan stages across frames and reflects middle-stage restarts (#5224)", () => {
	const store = createStore();
	const stages: StageSnapshot[] = Array.from({ length: 200 }, (_, i) =>
		stage(`stage-${i}`, i < 199 ? "completed" : "running"),
	);
	store.recordRunStart(run("large", "running", stages, { startedAt: 1_000 }));
	const snapshot = store.graphSnapshot();
	const runs = snapshot.runs;
	let statusReads = 0;
	const countedStages = (runs[0]!.stages as StageSnapshot[]).map((s) => {
		const currentStatus = s.status;
		return Object.freeze(
			Object.defineProperty({ ...s }, "status", {
				enumerable: true,
				get() {
					statusReads++;
					return currentStatus;
				},
			}),
		);
	});
	(runs[0]!.stages as StageSnapshot[]).splice(0, countedStages.length, ...countedStages);
	const first = panelItemsFromSnapshot(runs, 5_000);
	const readsAfterFirst = statusReads;
	assert.ok(readsAfterFirst > 0);
	assert.equal(first[0]?.elapsedMs, 4_000);
	assert.deepEqual(first[0]?.progress, { done: 199, total: 200 });
	for (let frame = 1; frame <= 20; frame++) {
		const next = panelItemsFromSnapshot(runs, 5_000 + frame * 1_000);
		assert.equal(next[0]?.elapsedMs, 4_000 + frame * 1_000);
		assert.deepEqual(next[0]?.progress, { done: 199, total: 200 });
		assert.equal(next[0]?.progress, first[0]?.progress);
	}
	assert.equal(statusReads, readsAfterFirst);
	assert.equal(panelItemsFromSnapshot(snapshot, 30_000)[0]?.progress, first[0]?.progress);

	const a = stage("a", "completed");
	const b = stage("b", "completed", { parentIds: ["a"] });
	const c = stage("c", "completed", { parentIds: ["b"] });
	const restartStages: StageSnapshot[] = [a, b, c];
	const target = run("middle-restart", "running", restartStages);
	const [beforeRestart] = panelItemsFromSnapshot([target]);
	assert.deepEqual(beforeRestart?.progress, { done: 3, total: 3 });
	assert.equal(beforeRestart?.task, "");

	restartStages[1] = { ...b, status: "running" };
	const [afterRestart] = panelItemsFromSnapshot([target]);
	assert.deepEqual(afterRestart?.progress, { done: 2, total: 3 });
	assert.equal(afterRestart?.task, "stage b");
});
