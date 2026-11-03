import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { endPooledChild } from "../../packages/workflows/src/workers/pooled-run-end.js";
import { holdFinishedRuns } from "../helpers/finished-runs.js";

const ERROR = "child failed";

function stage(id: string, status: StageSnapshot["status"], overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status, parentIds: [], toolEvents: [], startedAt: 1, ...overrides };
}

function run(id: string, parentRunId?: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id,
		name: id,
		inputs: {},
		status: "running",
		stages: [stage(`${id}-stage`, "running")],
		toolNodes: [],
		startedAt: 1,
		...(parentRunId === undefined ? {} : { parentRunId, parentStageId: `${parentRunId}-stage` }),
		...overrides,
	};
}

function finishedRun(id: string, parentRunId: string): RunSnapshot {
	return run(id, parentRunId, {
		status: "completed",
		endedAt: 5,
		stages: [stage(`${id}-stage`, "completed", { endedAt: 5 })],
	});
}

/** The selection this change replaced: every run of the store, kept when a chain of parent links reaches the child. */
function endedByScan(store: Store, childRunId: string): string[] {
	const runs = store.runs();
	const byId = new Map(runs.map((candidate) => [candidate.id, candidate]));
	const inChild = (candidate: RunSnapshot): boolean => {
		for (let current: RunSnapshot | undefined = candidate; current !== undefined; ) {
			if (current.id === childRunId) return true;
			current = current.parentRunId === undefined ? undefined : byId.get(current.parentRunId);
		}
		return false;
	};
	return runs.filter((candidate) => candidate.endedAt === undefined && inChild(candidate)).map(({ id }) => id);
}

function recordEnds(store: Store): { store: Store; ended: string[] } {
	const ended: string[] = [];
	const recording: Store = Object.assign(Object.create(store) as Store, {
		recordRunEnd: (...args: Parameters<Store["recordRunEnd"]>) => {
			ended.push(args[0]);
			return store.recordRunEnd(...args);
		},
	});
	return { store: recording, ended };
}

test("failing a child ends its unfinished runs in store order without reading the finished runs the store holds (#4190)", () => {
	const store = createStore();
	const finished = holdFinishedRuns(store, 5_000);
	// Recorded deepest first, so store order differs from a walk down the parent links.
	store.recordRunStart(run("deep", "mid"));
	store.recordRunStart(run("root"));
	store.recordRunStart(run("child", "root"));
	store.recordRunStart(
		run("mid", "child", { status: "completed", endedAt: 5, stages: [stage("mid-stage", "completed")] }),
	);
	store.recordRunStart(run("branch", "child"));
	store.recordRunStart(finishedRun("done", "child"));
	store.recordRunStart(run("sibling", "root"));
	store.recordRunStart(run("sibling-nested", "sibling"));
	const expected = endedByScan(store, "child");
	assert.deepEqual(expected, ["deep", "child", "branch"]);
	const recording = recordEnds(store);
	finished.reads = 0;

	endPooledChild(recording.store, "child", ERROR);

	assert.equal(finished.reads, 0, `failing one child read finished runs ${finished.reads} times`);
	assert.deepEqual(recording.ended, expected);
	for (const id of expected) {
		const ended = store.run(id)!;
		assert.deepEqual([ended.status, ended.error, ended.endedAt !== undefined], ["failed", ERROR, true], id);
		assert.deepEqual(
			ended.stages.map((entry) => [entry.status, entry.error]),
			[["failed", ERROR]],
			`${id} stages`,
		);
	}
	assert.deepEqual(
		[store.run("mid")?.status, store.run("mid")?.error, store.run("done")?.status],
		["completed", undefined, "completed"],
		"a finished run keeps its outcome, though a run below it is part of the child",
	);
	assert.deepEqual(
		["root", "sibling", "sibling-nested"].map((id) => store.run(id)?.status),
		["running", "running", "running"],
		"runs outside the child's subtree are untouched",
	);
});

test("failing a child that the store does not hold ends nothing (#4190)", () => {
	const store = createStore();
	store.recordRunStart(run("root"));
	store.recordRunStart(run("orphan", "missing-child"));
	const recording = recordEnds(store);
	endPooledChild(recording.store, "missing-child", ERROR);
	assert.deepEqual(recording.ended, []);
	assert.equal(store.run("orphan")?.status, "running");
});

test("failing a child ends the same runs in the same order as the scan it replaced, on random forests (#4190)", () => {
	let state = 4190;
	const next = (): number => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
	let selecting = 0;
	for (let round = 0; round < 300; round++) {
		const store = createStore();
		const ids = Array.from({ length: 2 + Math.floor(next() * 8) }, (_, index) => `r${index}`);
		const order = [...ids].sort(() => next() - 0.5);
		const parents = new Map<string, string | undefined>(
			ids.map((id, index) => [id, index === 0 || next() < 0.2 ? undefined : ids[Math.floor(next() * index)]]),
		);
		const ended = new Set(ids.filter(() => next() < 0.3));
		for (const id of order)
			store.recordRunStart(
				run(
					id,
					parents.get(id),
					ended.has(id) ? { status: "completed", endedAt: 5, stages: [stage(`${id}-stage`, "completed")] } : {},
				),
			);
		const childRunId = ids[Math.floor(next() * ids.length)]!;
		const expected = endedByScan(store, childRunId);
		const recording = recordEnds(store);
		endPooledChild(recording.store, childRunId, ERROR);
		assert.deepEqual(recording.ended, expected, `round ${round}, child ${childRunId}`);
		if (expected.length >= 2) selecting++;
	}
	assert.ok(selecting > 20, `forests cover subtrees of several runs: ${selecting}`);
});
