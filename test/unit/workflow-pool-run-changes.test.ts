import assert from "node:assert/strict";
import { test } from "vitest";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	isRunChanges,
	type PublishedRun,
	type RunChanges,
	RunChangesEncoder,
} from "../../packages/workflows/src/workers/run-changes.js";

const work = { id: "work-1", generation: 1 };

function stage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status: "completed", parentIds: [], toolEvents: [], ...overrides };
}

function tool(id: string, overrides: Partial<ToolNodeSnapshot> = {}): ToolNodeSnapshot {
	return { id, name: id, status: "completed", parentIds: [], ...overrides } as ToolNodeSnapshot;
}

function run(id: string, stages: StageSnapshot[], overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id,
		name: id,
		inputs: {},
		status: "running",
		stages,
		toolNodes: [],
		startedAt: 0,
		parentRunId: "root",
		parentStageId: "boundary",
		rootRunId: "root",
		...overrides,
	};
}

function changes(published: readonly PublishedRun[]): RunChanges[] {
	assert.ok(published.every(isRunChanges), "every run is published as changes");
	return published as RunChanges[];
}

function full(published: readonly PublishedRun[], runs: readonly RunSnapshot[]): void {
	assert.equal(published, runs, "the publication goes in full");
}

test("an attempt's first publication goes in full and the next carries only changed and added stages (#4317)", () => {
	const encoder = new RunChangesEncoder();
	const first = [run("child", [stage("a"), stage("b", { status: "running" }), stage("c")])];
	full(encoder.encode(work, first), first);
	const next = [
		run("child", [
			stage("a"),
			stage("b", { status: "running", toolEvents: [{ name: "read" } as StageSnapshot["toolEvents"][number]] }),
			stage("c"),
			stage("d", { status: "running" }),
		]),
	];
	const [child] = changes(encoder.encode(work, next));
	assert.deepEqual(
		child?.stages.map((entry) => entry.id),
		["b", "d"],
	);
	assert.equal(child?.stages[0], next[0]!.stages[1], "a changed stage is sent as the worker published it");
	assert.equal(child?.header, undefined, "unchanged own fields are not sent");
	assert.deepEqual(child?.toolNodes, []);
	assert.equal(child?.kind, "changes");
	assert.equal(child?.id, "child");
});

test("an unchanged run is still named, with nothing changed, so the root relabels its open stages (#4317)", () => {
	const encoder = new RunChangesEncoder();
	encoder.encode(work, [run("child", [stage("a")])]);
	assert.deepEqual(encoder.encode({ ...work }, [run("child", [stage("a")])]), [
		{ kind: "changes", id: "child", stages: [], toolNodes: [] },
	]);
});

test("a run's own fields are sent whole when one of them changed, without the root-owned message queue (#4317)", () => {
	const encoder = new RunChangesEncoder();
	encoder.encode(work, [run("child", [stage("a")], { pendingStageMessages: [] })]);
	const queuedOnly = changes(
		encoder.encode(work, [run("child", [stage("a")], { pendingStageMessages: [{} as never] })]),
	);
	assert.equal(queuedOnly[0]?.header, undefined, "the worker's message queue is not the root's");
	const [child] = changes(encoder.encode(work, [run("child", [stage("a")], { status: "completed", endedAt: 5 })]));
	assert.deepEqual(child?.header, {
		id: "child",
		name: "child",
		inputs: {},
		status: "completed",
		startedAt: 0,
		parentRunId: "root",
		parentStageId: "boundary",
		rootRunId: "root",
		endedAt: 5,
	});
	assert.deepEqual(child?.stages, []);
});

test("tool nodes travel as changes the same way stages do (#4317)", () => {
	const encoder = new RunChangesEncoder();
	encoder.encode(work, [run("child", [], { toolNodes: [tool("t1"), tool("t2", { status: "running" })] })]);
	const [child] = changes(
		encoder.encode(work, [
			run("child", [], { toolNodes: [tool("t1"), tool("t2"), tool("t3", { status: "running" })] }),
		]),
	);
	assert.deepEqual(
		child?.toolNodes.map((node) => node.id),
		["t2", "t3"],
	);
	const reordered = [run("child", [], { toolNodes: [tool("t2"), tool("t1"), tool("t3", { status: "running" })] })];
	full(encoder.encode(work, reordered), reordered);
});

test("a publication goes in full when its shape changed: generation, runs, links, removals, order, duplicates (#4317)", () => {
	const nested = (stages: StageSnapshot[] = []) =>
		run("nested", stages, { parentRunId: "child", parentStageId: "host" });
	const base = () => [run("child", [stage("a"), stage("host", { status: "running" })]), nested()];
	const shapes: readonly { readonly name: string; readonly runs: () => RunSnapshot[]; readonly next?: typeof work }[] =
		[
			{ name: "a new generation", runs: base, next: { id: work.id, generation: 2 } },
			{
				name: "an added run",
				runs: () => [...base(), run("other", [], { parentRunId: "child", parentStageId: "a" })],
			},
			{ name: "a removed run", runs: () => base().slice(0, 1) },
			{ name: "reordered runs", runs: () => base().reverse() },
			{ name: "a duplicated run", runs: () => [...base(), nested()] },
			{ name: "a moved parent stage", runs: () => [base()[0]!, { ...nested(), parentStageId: "a" }] },
			{ name: "a moved parent run", runs: () => [base()[0]!, { ...nested(), parentRunId: "elsewhere" }] },
			{ name: "another root", runs: () => [{ ...base()[0]!, rootRunId: "other-root" }, nested()] },
			{ name: "a removed stage", runs: () => [run("child", [stage("host", { status: "running" })]), nested()] },
			{ name: "a removed last stage", runs: () => [run("child", [stage("a")]), nested()] },
			{
				name: "reordered stages",
				runs: () => [run("child", [stage("host", { status: "running" }), stage("a")]), nested()],
			},
			{
				name: "a duplicated stage",
				runs: () => [run("child", [stage("a"), stage("host", { status: "running" }), stage("a")]), nested()],
			},
			{
				name: "a changed stage a published run hangs from",
				runs: () => [run("child", [stage("a"), stage("host", { status: "completed" })]), nested()],
			},
		];
	for (const shape of shapes) {
		const encoder = new RunChangesEncoder();
		encoder.encode(work, base());
		const runs = shape.runs();
		assert.equal(encoder.encode(shape.next ?? work, runs), runs, shape.name);
	}
});

test("a stage another run hangs from may gain siblings, and a changed sibling still goes as a change (#4317)", () => {
	const encoder = new RunChangesEncoder();
	const nested = run("nested", [], { parentRunId: "child", parentStageId: "host" });
	encoder.encode(work, [
		run("child", [stage("host", { status: "running" }), stage("a", { status: "running" })]),
		nested,
	]);
	const published = changes(
		encoder.encode(work, [run("child", [stage("host", { status: "running" }), stage("a"), stage("b")]), nested]),
	);
	assert.deepEqual(
		published.map((entry) => [entry.id, entry.stages.map((changed) => changed.id)]),
		[["child", ["a", "b"]]],
	);
});

test("runs that did not change are left out, except the first, which names the publication as changes (#4317)", () => {
	const encoder = new RunChangesEncoder();
	const nested = (index: number, stages: StageSnapshot[], overrides: Partial<RunSnapshot> = {}) =>
		run(`nested-${index}`, stages, { parentRunId: "child", parentStageId: `host-${index}`, ...overrides });
	const runs = (last: StageSnapshot[], first: Partial<RunSnapshot> = {}, second: Partial<RunSnapshot> = {}) => [
		run(
			"child",
			Array.from({ length: 3 }, (_, index) => stage(`host-${index}`, { status: "running" })),
		),
		nested(0, [stage("a")], first),
		nested(1, [stage("b")], second),
		nested(2, last),
	];
	encoder.encode(work, runs([stage("c", { status: "running" })]));
	const named = (published: readonly PublishedRun[]) =>
		changes(published).map((entry) => [entry.id, entry.stages.length, entry.toolNodes.length, entry.header?.label]);
	assert.deepEqual(named(encoder.encode(work, runs([stage("c")]))), [
		["child", 0, 0, undefined],
		["nested-2", 1, 0, undefined],
	]);
	assert.deepEqual(named(encoder.encode(work, runs([stage("c")]))), [["child", 0, 0, undefined]]);
	assert.deepEqual(named(encoder.encode(work, runs([stage("c")], { toolNodes: [tool("t")] }, { label: "renamed" }))), [
		["child", 0, 0, undefined],
		["nested-0", 0, 1, undefined],
		["nested-1", 0, 0, "renamed"],
	]);
});

test("a forgotten attempt publishes in full again (#4317)", () => {
	const encoder = new RunChangesEncoder();
	const runs = [run("child", [stage("a")])];
	encoder.encode(work, runs);
	encoder.forget("other-work");
	assert.equal(isRunChanges(encoder.encode(work, runs)[0]!), true);
	encoder.forget(work.id);
	full(encoder.encode(work, runs), runs);
});

test("a full publication and a change are told apart by kind alone (#4317)", () => {
	const snapshot = run("child", []);
	assert.equal(isRunChanges(snapshot), false);
	assert.equal(isRunChanges({ kind: "changes", id: "child", stages: [], toolNodes: [] }), true);
	assert.equal(isRunChanges({ ...snapshot, kind: "other" } as RunSnapshot), false);
});
