import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { panelItemsFromSnapshot } from "../../packages/workflows/src/tui/panel-runs.js";

const stage = (id: string, status: StageSnapshot["status"], extra: Partial<StageSnapshot> = {}): StageSnapshot => ({
	id,
	name: id,
	status,
	parentIds: [],
	toolEvents: [],
	...extra,
});
const run = (id: string, stages: StageSnapshot[], extra: Partial<RunSnapshot> = {}): RunSnapshot => ({
	id,
	name: id,
	inputs: {},
	status: "running",
	startedAt: 1_000,
	toolNodes: [],
	stages,
	...extra,
});
const tool = (id: string, status: ToolNodeSnapshot["status"]): ToolNodeSnapshot => ({
	id,
	name: id,
	kind: "tool",
	argsHash: id,
	ordinal: 0,
	parentIds: [],
	status,
	attachable: false,
});

test("a quit workflow is a dismissible stopped row without changing its resumability (#5224)", () => {
	const store = createStore();
	store.recordRunStart(run("quit", [stage("work", "running")]));
	store.recordRunPaused("quit", 2_000, { exitReason: "quit", resumable: true });
	const [item] = panelItemsFromSnapshot(store.graphSnapshot(), 50_000, store);
	assert.equal(item?.state, "stopped");
	assert.equal(item?.endedAt, store.run("quit")?.quitAt);
	assert.equal(item?.question, undefined);
	assert.equal(store.run("quit")?.resumable, true);
	assert.equal(store.run("quit")?.status, "paused");
	store.recordRunResumed("quit", 51_000);
	assert.equal(panelItemsFromSnapshot(store.graphSnapshot(), 52_000, store)[0]?.state, "running");
});

test("a tool-only child keeps its running parent from showing completed stage progress (#5224)", () => {
	for (const completedStage of [false, true]) {
		const runs = [
			run("root", [
				...(completedStage ? [stage("plan", "completed")] : []),
				stage("delegate", "running", {
					workflowChildRun: { runId: "child", workflow: "child", alias: "child" },
				}),
			]),
			run("child", [], {
				parentRunId: "root",
				parentStageId: "delegate",
				rootRunId: "root",
				toolNodes: [tool("fetch", "running")],
			}),
		];
		const [item] = panelItemsFromSnapshot(runs, 2_000);
		assert.equal(item?.state, "running");
		assert.equal(item?.task, "tool fetch");
		assert.deepEqual(item?.progress, { done: completedStage ? 1 : 0, total: completedStage ? 2 : 1 });
	}
});

test("displayed choices stay index-aligned with their answer values for root, stage and structured prompts (#5224)", () => {
	const choices = ["2", "1", "a  b", "yes\tplease", "👩‍💻", "✈️", "x".repeat(300), "\u202eyes\x1b[31m"];
	const pendingPrompt = { id: "p", kind: "select" as const, message: "Pick?", choices, createdAt: 1_000 };
	const items = panelItemsFromSnapshot([
		run("root", [], { pendingPrompt }),
		run("stage", [stage("ask", "awaiting_input", { pendingPrompt })]),
		run("structured", [
			stage("ask", "awaiting_input", {
				inputRequest: {
					id: "form",
					kind: "ask_user_question",
					createdAt: 1_000,
					questions: [{ question: "Pick?", options: choices.map((label) => ({ label })) }],
				},
			}),
		]),
	]);
	assert.equal(items.length, 3);
	for (const item of items) {
		assert.equal(item.choices?.length, choices.length, item.id);
		assert.deepEqual(item.choices?.slice(0, 2), ["2", "1"], item.id);
		for (const label of item.choices ?? []) assert.doesNotMatch(label, /[\u0000-\u001f\u007f\u202e]/u, item.id);
	}
});

test("a bounded workflow failure reason does not split an emoji at its limit (#5224)", () => {
	const [item] = panelItemsFromSnapshot([
		run("failed", [stage("build", "failed")], {
			status: "failed",
			error: `${"x".repeat(118)}🚀 tail`,
			endedAt: 2_000,
		}),
	]);
	assert.equal(item?.reason, `${"x".repeat(118)}…`);
	assert.equal(item?.reason?.isWellFormed(), true);
});

test("a blocked workflow names its failed stage and reason instead of showing a complete bar (#5224)", () => {
	const [item] = panelItemsFromSnapshot([
		run("blocked", [stage("plan", "completed"), stage("build", "failed", { error: "cannot compile\nstack trace" })], {
			status: "blocked",
			endedAt: 2_000,
			resumable: true,
		}),
	]);
	assert.equal(item?.state, "paused", "a resumable block is not a dismissed stop");
	assert.equal(item?.task, "stage build · cannot compile");
	assert.equal(item?.reason, "cannot compile");
	assert.equal(item?.progress, undefined);
});
