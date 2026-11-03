import assert from "node:assert/strict";
import { test } from "vitest";
import { workflowBoundarySegments } from "../../packages/workflows/src/shared/pending-stage-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";

/** A small deterministic generator, so a failing sequence replays. */
function sequence(seed: number): () => number {
	let state = seed;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function stage(id: string, name: string, runId?: string): StageSnapshot {
	return {
		id,
		name,
		status: "running",
		parentIds: [],
		toolEvents: [],
		...(runId === undefined ? {} : { workflowChildRun: { alias: name, workflow: name, runId } }),
	};
}

function run(id: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return { id, name: id, inputs: {}, status: "running", stages: [], toolNodes: [], startedAt: 1, ...overrides };
}

test("the store finds the runs under a run or one of its stages through additions, replacements, relinks, removals and clears (#4190)", () => {
	const store = createStore();
	const ids = (parent: string, stageId?: string) => store.childRuns(parent, stageId).map((child) => child.id);
	store.recordRunStart(run("root"));
	store.recordRunStart(run("a", { parentRunId: "root", parentStageId: "s1" }));
	store.recordRunStart(run("b", { parentRunId: "root", parentStageId: "s2" }));
	store.recordRunStart(run("c", { parentRunId: "root", parentStageId: "s1" }));
	assert.deepEqual(ids("root"), ["a", "b", "c"]);
	assert.deepEqual(ids("root", "s1"), ["a", "c"]);
	assert.deepEqual(ids("root", "s3"), []);
	assert.deepEqual(ids("a"), []);

	store.recordRunStart(run("a", { name: "replaced", parentRunId: "root", parentStageId: "s1" }));
	assert.deepEqual(ids("root", "s1"), ["a", "c"], "a replacement keeps its place");
	store.recordRunStart(run("a", { parentRunId: "root", parentStageId: "s2" }));
	assert.deepEqual([ids("root", "s1"), ids("root", "s2")], [["c"], ["a", "b"]], "a replacement under another stage");
	store.recordRunStart(run("a"));
	assert.deepEqual(ids("root"), ["b", "c"], "a replacement without a parent leaves its parent");

	assert.equal(store.reconcileRunParentStage("c", "s1", "s2"), true);
	assert.deepEqual([ids("root", "s1"), ids("root", "s2")], [[], ["b", "c"]]);
	assert.equal(store.removeRun("b"), true);
	assert.deepEqual(ids("root", "s2"), ["c"]);
	store.clear();
	assert.deepEqual(ids("root"), []);
	store.recordRunStart(run("d", { parentRunId: "root", parentStageId: "s1" }));
	assert.deepEqual(ids("root", "s1"), ["d"]);
});

test("a run republished as the same snapshot under another stage or parent is found once, under its new link (#4190)", () => {
	const store = createStore();
	const ids = (parent: string, stageId?: string) => store.childRuns(parent, stageId).map((child) => child.id);
	store.recordRunStart(run("root"));
	store.recordRunStart(run("other"));
	const child = run("child", { parentRunId: "root", parentStageId: "a" });
	store.recordRunStart(child);
	child.parentStageId = "b";
	store.recordRunStart(child);
	assert.deepEqual([ids("root"), ids("root", "a"), ids("root", "b")], [["child"], [], ["child"]]);

	for (let index = 0; index < 1_000; index++) {
		child.parentStageId = `s${index}`;
		store.recordRunStart(child);
	}
	assert.deepEqual(ids("root"), ["child"], "republished under 1,000 stages");
	child.parentRunId = "other";
	store.recordRunStart(child);
	assert.deepEqual([ids("root"), ids("other"), ids("other", "s999")], [[], ["child"], ["child"]]);
});

test("removing a run republished as the same snapshot under other stages leaves none of its links behind (#4190)", () => {
	const store = createStore();
	const ids = (parent: string, stageId?: string) => store.childRuns(parent, stageId).map((child) => child.id);
	store.recordRunStart(run("root"));
	const child = run("child", { parentRunId: "root", parentStageId: "a" });
	store.recordRunStart(child);
	for (const stageId of ["b", "c", "d"]) {
		child.parentStageId = stageId;
		store.recordRunStart(child);
	}
	assert.equal(store.removeRun("child"), true);
	assert.deepEqual(ids("root"), []);
	// A link left behind by any earlier publication hands a new run with the same id back once more per link.
	store.recordRunStart(run("child", { parentRunId: "root", parentStageId: "e" }));
	assert.deepEqual([ids("root"), ids("root", "e")], [["child"], ["child"]]);
});

test("the store's child index always equals a filter of its runs, in store order, over random operations (#4190)", () => {
	const next = sequence(4190);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
	const runIds = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"];
	const stageIds = ["s0", "s1", "s2"];
	const store = createStore();
	for (let step = 0; step < 4_000; step++) {
		const operation = next();
		const id = pick(runIds);
		if (operation < 0.55) {
			const parent = next() < 0.2 ? undefined : pick(runIds);
			store.recordRunStart(
				run(id, parent === undefined ? {} : { parentRunId: parent, parentStageId: pick([...stageIds, "s9"]) }),
			);
		} else if (operation < 0.75) store.removeRun(id);
		else if (operation < 0.97) store.reconcileRunParentStage(id, pick(stageIds), pick(stageIds));
		else store.clear();
		for (const parent of runIds) {
			assert.deepEqual(
				store.childRuns(parent).map((child) => child.id),
				store
					.runs()
					.filter((candidate) => candidate.parentRunId === parent)
					.map((candidate) => candidate.id),
				`children of ${parent} at step ${step}`,
			);
			for (const stageId of [...stageIds, "s9"])
				assert.deepEqual(
					store.childRuns(parent, stageId).map((child) => child.id),
					store
						.runs()
						.filter((candidate) => candidate.parentRunId === parent && candidate.parentStageId === stageId)
						.map((candidate) => candidate.id),
					`children of ${parent}/${stageId} at step ${step}`,
				);
		}
	}
});

test("boundary segments from the store equal those from its run list on random topologies (#4190)", () => {
	const next = sequence(1904);
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
	const names = ["a", "b", "a/b", "x*", "", "r1", "dup"];
	let spelledAsName = 0;
	let spelledAsRunId = 0;
	for (let round = 0; round < 400; round++) {
		const store = createStore();
		const count = 2 + Math.floor(next() * 6);
		const ids = Array.from({ length: count }, (_, index) => `r${index}`);
		const stagesOf = new Map<string, StageSnapshot[]>();
		for (const id of ids) {
			const stages = Array.from({ length: Math.floor(next() * 4) }, (_, index) => {
				const stageId = next() < 0.2 ? "dup" : `${id}-s${index}`;
				const runId = next() < 0.7 ? pick(ids) : undefined;
				return stage(stageId, pick(names), runId);
			});
			stagesOf.set(id, stages);
		}
		for (const [index, id] of ids.entries()) {
			// A parent is recorded before its child: a cycle of parent links never ends in either lookup.
			const parent = index === 0 || next() < 0.15 ? undefined : pick(ids.slice(0, index));
			const parentStage = parent === undefined ? undefined : pick([...(stagesOf.get(parent) ?? []), undefined]);
			store.recordRunStart(
				run(id, {
					stages: stagesOf.get(id) ?? [],
					...(parent === undefined ? {} : { parentRunId: parent, parentStageId: parentStage?.id ?? "missing" }),
				}),
			);
		}
		for (const id of [...ids, "absent"]) {
			const segments = workflowBoundarySegments(store, id);
			assert.deepEqual(segments, workflowBoundarySegments(store.runs(), id), `segments of ${id} in round ${round}`);
			for (const segment of segments ?? []) {
				if (ids.includes(segment)) spelledAsRunId++;
				else spelledAsName++;
			}
		}
	}
	assert.ok(
		spelledAsName > 50 && spelledAsRunId > 50,
		`topologies cover both spellings: ${spelledAsName}/${spelledAsRunId}`,
	);
});
