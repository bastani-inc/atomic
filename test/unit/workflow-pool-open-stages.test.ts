import assert from "node:assert/strict";
import { test } from "vitest";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { OpenStages } from "../../packages/workflows/src/workers/open-stages.js";
import type { RunChanges } from "../../packages/workflows/src/workers/run-changes.js";

function stage(id: string, status: StageSnapshot["status"] = "running"): StageSnapshot {
	return { id, name: id, status, parentIds: [], toolEvents: [] };
}

function changes(id: string, stages: StageSnapshot[]): RunChanges {
	return { kind: "changes", id, stages, toolNodes: [] };
}

function full(id: string, stages: StageSnapshot[]) {
	return { id, name: id, inputs: {}, status: "running" as const, stages, toolNodes: [], startedAt: 0 };
}

const ids = (visited: readonly { readonly id: string; readonly stages: readonly StageSnapshot[] }[]) =>
	visited.map((run) => [run.id, run.stages.map((entry) => `${entry.id}:${entry.status}`)]);

test("a full publication hands over every stage, and changes their own plus the stages still open (#4317)", () => {
	const open = new OpenStages();
	const work = { id: "work", generation: 1 };
	const published = [stage("done", "completed"), stage("a"), stage("b", "awaiting_input")];
	assert.deepEqual(ids(open.visit(work, [full("run", published)])), [
		["run", ["done:completed", "a:running", "b:awaiting_input"]],
	]);
	assert.deepEqual(ids(open.visit(work, [changes("run", [stage("a", "completed"), stage("c")])])), [
		["run", ["a:completed", "c:running", "b:awaiting_input"]],
	]);
	const [visited] = open.visit(work, [changes("run", [])]);
	assert.deepEqual(ids([visited!]), [["run", ["b:awaiting_input", "c:running"]]]);
	assert.equal(visited?.stages[0], published[2], "an open stage is handed over as its worker last published it");
});

test("runs a publication of changes leaves out still hand over their open stages, until those end (#4317)", () => {
	const open = new OpenStages();
	const work = { id: "work", generation: 1 };
	open.visit(work, [
		full("child", [stage("host", "completed"), stage("live")]),
		full("nested-1", [stage("n1", "completed")]),
		full("nested-2", [stage("n2")]),
	]);
	assert.deepEqual(ids(open.visit(work, [changes("child", [stage("next")])])), [
		["child", ["next:running", "live:running"]],
		["nested-2", ["n2:running"]],
	]);
	assert.deepEqual(ids(open.visit(work, [changes("child", []), changes("nested-2", [stage("n2", "completed")])])), [
		["child", ["live:running", "next:running"]],
		["nested-2", ["n2:completed"]],
	]);
	assert.deepEqual(ids(open.visit(work, [changes("child", [])])), [["child", ["live:running", "next:running"]]]);
});

test("a full publication replaces what was open, and changes to a run never published in full are kept (#4317)", () => {
	const open = new OpenStages();
	const work = { id: "work", generation: 1 };
	open.visit(work, [full("run", [stage("a"), stage("b")]), full("other", [stage("o")])]);
	open.visit(work, [full("run", [stage("a")])]);
	assert.deepEqual(ids(open.visit(work, [changes("run", [])])), [["run", ["a:running"]]]);
	open.visit(work, [changes("fresh", [stage("x")])]);
	assert.deepEqual(ids(open.visit(work, [changes("fresh", [])])), [
		["fresh", ["x:running"]],
		["run", ["a:running"]],
	]);
});

test("an empty publication holds no runs, so nothing of the attempt stays open (#4317)", () => {
	const open = new OpenStages();
	const work = { id: "work", generation: 1 };
	open.visit(work, [full("run", [stage("a")])]);
	assert.deepEqual(ids(open.visit(work, [])), []);
	assert.deepEqual(ids(open.visit(work, [changes("run", [])])), [["run", []]]);
});

test("a new attempt or a forgotten work starts from its next publication alone (#4317)", () => {
	const open = new OpenStages();
	open.visit({ id: "work", generation: 1 }, [full("run", [stage("old")])]);
	assert.deepEqual(ids(open.visit({ id: "work", generation: 2 }, [changes("run", [stage("new")])])), [
		["run", ["new:running"]],
	]);
	open.visit({ id: "other", generation: 1 }, [full("run-2", [stage("kept")])]);
	open.forget("work");
	assert.deepEqual(ids(open.visit({ id: "work", generation: 2 }, [changes("run", [])])), [["run", []]]);
	assert.deepEqual(ids(open.visit({ id: "other", generation: 1 }, [changes("run-2", [])])), [
		["run-2", ["kept:running"]],
	]);
});
