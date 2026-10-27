import assert from "node:assert/strict";
import type { WorkflowRootActivity } from "@bastani/atomic";
import { describe, test } from "vitest";
import { createWorkflowObservation } from "../../packages/workflows/src/extension/workflow-observation.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createGraphStoreSnapshot } from "../../packages/workflows/src/shared/graph-store-snapshot.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflowObservationRuntime } from "../../packages/workflows/src/shared/store-factory.js";
import type { Store } from "../../packages/workflows/src/shared/store-public-types.js";
import type { RunSnapshot, StageSnapshot, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { projectWorkflowActivity } from "../../packages/workflows/src/shared/workflow-activity.js";

function stage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id, name: id, status: "pending", parentIds: [], toolEvents: [], ...overrides };
}

function run(id: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return { id, name: id, inputs: {}, status: "running", stages: [], toolNodes: [], startedAt: 1, ...overrides };
}

/** A root with `children` pooled child runs of three stages each, as a pooled fan-out records them. */
function seedFanOut(store: Store, children: number): void {
	store.recordRunStart(run("root"));
	for (let index = 0; index < children; index++) {
		const boundary = `boundary-${index}`;
		store.recordStageStart("root", stage(boundary, { status: "running" }));
		store.recordRunStart(run(`child-${index}`, { parentRunId: "root", parentStageId: boundary, rootRunId: "root" }));
		store.recordStageWorkflowChildRun("root", boundary, {
			runId: `child-${index}`,
			alias: `child ${index}`,
			workflow: "child",
		});
		for (const name of ["plan", "work", "review"])
			store.recordStageStart(`child-${index}`, stage(name, { status: name === "plan" ? "running" : "pending" }));
	}
}

/** The previous full derivation: every run projected and frozen anew. */
function fullDerivation(store: Store): StoreSnapshot {
	const current = store.graphSnapshot();
	return createGraphStoreSnapshot(store.runs(), store.notices(), current.version);
}

function reusedRuns(before: StoreSnapshot, after: StoreSnapshot): number {
	const previous = new Set(before.runs);
	return after.runs.filter((candidate) => previous.has(candidate)).length;
}

describe("incremental graph store snapshot (#4009)", () => {
	test("a single stage change re-projects only the run that owns it (#4009)", () => {
		const store = createStore();
		seedFanOut(store, 50);
		const before = store.graphSnapshot();
		store.recordStageEnd("child-7", { ...stage("plan"), status: "completed", endedAt: 2 });
		const after = store.graphSnapshot();

		assert.notEqual(after, before);
		assert.equal(reusedRuns(before, after), before.runs.length - 1);
		const changed = after.runs.find((candidate) => candidate.id === "child-7");
		const previous = before.runs.find((candidate) => candidate.id === "child-7");
		assert.equal(changed?.stages[0]?.status, "completed");
		assert.notEqual(changed, previous);
		// Within the changed run, the untouched stages keep their frozen projections.
		assert.equal(changed?.stages[1], previous?.stages[1]);
		assert.equal(changed?.stages[2], previous?.stages[2]);
		assert.deepEqual(after, fullDerivation(store));
	});
});

describe("incremental graph expansion (#4009)", () => {
	test("a single stage change re-expands only the child run that owns it (#4009)", () => {
		const store = createStore();
		seedFanOut(store, 50);
		const before = expandWorkflowGraph(store.graphSnapshot(), "root");
		store.recordStageEnd("child-7", { ...stage("plan"), status: "completed", endedAt: 2 });
		const after = expandWorkflowGraph(store.graphSnapshot(), "root");

		assert.equal(after.stages.length, 150);
		const previous = new Set(before.stages);
		const reExpanded = after.stages.filter((node) => !previous.has(node));
		assert.deepEqual(
			reExpanded.map((node) => node.id),
			["child-7:plan", "child-7:work", "child-7:review"],
		);
		assert.equal(reExpanded[0]?.status, "completed");
		// Every target of the unchanged children is still resolvable.
		assert.equal(after.targets.size, 150);
		assert.deepEqual(after, expandWorkflowGraph(createGraphStoreSnapshot(store.runs(), [], 0), "root"));
	});
});

/** Deterministic PRNG, so a failing sequence replays from its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

type Mutation = (store: Store, pick: <T>(items: readonly T[]) => T | undefined, step: number) => void;

const MUTATIONS: readonly Mutation[] = [
	(store, pick, step) => {
		const target = pick(store.runs());
		if (target) store.recordStageStart(target.id, stage(`s-${step}`, { status: "running", startedAt: step }));
	},
	(store, pick, step) => {
		const target = pick(store.runs());
		const node = target && pick(target.stages);
		if (target && node) store.recordStageEnd(target.id, { ...node, status: "completed", endedAt: step });
	},
	(store, pick, step) => {
		const target = pick(store.runs());
		const node = target && pick(target.stages);
		if (target && node) store.recordToolStart(target.id, node.id, { name: `tool-${step}`, startedAt: step });
	},
	(store, pick, step) => {
		const target = pick(store.runs());
		const node = target && pick(target.stages);
		if (target && node)
			store.recordStageNotice(target.id, node.id, { id: `n-${step}`, ts: step, kind: "model", to: `model-${step}` });
	},
	(store, pick, step) => {
		const target = pick(store.runs());
		if (target) store.recordRunExecutionState(target.id, { lastProgressAt: step });
	},
	(store, pick, step) => {
		const target = pick(store.runs());
		if (target)
			store.recordRunEnd(target.id, "completed", { summary: `done ${step}`, result: "x".repeat(step * 40) });
	},
	(store, pick) => {
		const target = pick(store.runs());
		if (target) store.removeRun(target.id);
	},
	(store, _pick, step) => {
		store.recordRunStart(run(`run-${step}`, { stages: [stage("a"), stage("b", { parentIds: ["a"] })] }));
	},
	(store, pick, step) => {
		const target = pick(store.runs());
		if (target)
			store.recordToolNodeStart(target.id, {
				kind: "tool",
				id: `tool:${step}`,
				name: "t",
				status: "pending",
				parentIds: [],
				ordinal: step,
				argsHash: `${step}`,
				attachable: false,
			});
	},
	(store, pick, step) => {
		const target = pick(store.runs());
		const node = target && pick(target.toolNodes);
		if (target && node) store.recordToolNodeRunning(target.id, node.id, step);
	},
	(store, pick, step) => {
		const target = pick(store.runs());
		const node = target && pick(target.stages);
		if (target && node)
			store.recordStagePendingPrompt(target.id, node.id, {
				id: `p-${step}`,
				kind: "select",
				message: "pick",
				choices: ["a", "b"],
				createdAt: step,
			});
	},
	(store, _pick, step) => {
		store.recordNotice({ id: `notice-${step}`, runId: "root", level: "info", message: "n", createdAt: step });
	},
	// Executor-style edits: a live stage object changed directly, then a store change scoped elsewhere.
	(store, pick, step) => {
		const target = pick(store.runs());
		const node = target && pick(target.stages);
		const other = pick(store.runs());
		if (!node || !other) return;
		node.status = "failed";
		node.error = `failed at ${step}`;
		store.recordStageStart(other.id, stage(`bump-${step}`));
	},
	(store, pick, step) => {
		const target = pick(store.runs());
		const node = target && pick(target.stages);
		const other = pick(store.runs());
		if (!node || !other) return;
		node.toolEvents.push({ name: `pushed-${step}`, startedAt: step });
		(node.parentIds as string[]).push(`parent-${step}`);
		store.recordStageStart(other.id, stage(`bump-${step}`));
	},
	(store, pick, step) => {
		const target = pick(store.runs());
		const other = pick(store.runs());
		if (!target || !other) return;
		delete target.error;
		Object.assign(target, { summary: `summary ${step}` });
		store.recordStageStart(other.id, stage(`bump-${step}`));
	},
	(store, pick) => {
		store.batch(() => {
			for (const target of store.runs().slice(0, 3)) {
				const node = pick(target.stages);
				if (node) store.recordStageAwaitingInput(target.id, node.id, true, 5);
			}
		});
	},
];

describe("incremental graph store snapshot and expansion equivalence (#4009)", () => {
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
		test(`matches the full derivation after every step of random mutation sequence ${seed} (#4009)`, () => {
			const next = random(seed);
			const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)];
			const store = createStore();
			seedFanOut(store, 6);
			for (let step = 1; step <= 300; step++) {
				pick(MUTATIONS)?.(store, pick, step);
				// A reader of one run sometimes comes first, as a stage chat does on every change.
				const single = pick(store.runs());
				if (single !== undefined && next() < 0.5) {
					const projected = store.graphRun(single.id);
					assert.deepStrictEqual(
						projected,
						fullDerivation(store).runs.find((entry) => entry.id === single.id),
						`seed ${seed} step ${step} run ${single.id}`,
					);
					assert.ok(Object.isFrozen(projected?.stages), `seed ${seed} step ${step}`);
				}
				// Sometimes several changes land between two reads, as in one publication batch.
				if (next() < 0.4) continue;
				const incremental = store.graphSnapshot();
				const full = fullDerivation(store);
				assert.deepStrictEqual(incremental, full, `seed ${seed} step ${step}`);
				assert.equal(JSON.stringify(incremental), JSON.stringify(full), `seed ${seed} step ${step}`);
				for (const root of incremental.runs.filter((entry) => entry.parentRunId === undefined))
					assert.deepStrictEqual(
						expandWorkflowGraph(incremental, root.id),
						expandWorkflowGraph(full, root.id),
						`seed ${seed} step ${step} root ${root.id}`,
					);
				assert.ok(
					incremental.runs.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.stages)),
					`seed ${seed} step ${step}`,
				);
			}
		});
	}
});

function recordingPublisher(published: string[]) {
	return {
		publishSnapshot: () => {},
		publishChanged: (root: WorkflowRootActivity) => published.push(JSON.stringify(root)),
		publishRemoved: (id: string) => published.push(`removed ${id}`),
		publishLifecycle: () => {},
		publishHeartbeat: () => {},
		dispose: () => {},
	};
}

/** Lets the bridge publish what the current turn of the event loop coalesced. */
function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("workflow activity bridge coalescing (#4009)", () => {
	for (const seed of [11, 12, 13, 14]) {
		test(`publishes the final root activity of every burst, as whole-serialization comparison would, over random bursts ${seed} (#4009)`, async () => {
			const next = random(seed);
			const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)];
			const store = createStore();
			seedFanOut(store, 6);
			const runtime = workflowObservationRuntime(store);
			const published: string[] = [];
			const bridge = createWorkflowObservation(store, recordingPublisher(published), "owner");
			// The comparison as it shipped before #4009, over a fresh full derivation, at the end of each burst.
			const reference = (): Map<string, string> =>
				new Map(
					projectWorkflowActivity({
						snapshot: createGraphStoreSnapshot(store.runs(), store.notices(), 0),
						ownership: { ...runtime, ownerSessionId: "owner" },
					}).map((root) => [root.rootRunId, JSON.stringify(root)]),
				);
			let roots = reference();
			try {
				let changes = 0;
				for (let burst = 1; burst <= 60; burst++) {
					const size = 1 + Math.floor(next() * 8);
					for (let index = 0; index < size; index++) pick(MUTATIONS)?.(store, pick, burst * 10 + index);
					published.length = 0;
					await nextTurn();
					const current = reference();
					const expected: string[] = [];
					for (const [id, root] of current) if (roots.get(id) !== root) expected.push(root);
					for (const id of roots.keys()) if (!current.has(id)) expected.push(`removed ${id}`);
					assert.deepEqual(published, expected, `seed ${seed} burst ${burst}`);
					changes += expected.length;
					roots = current;
				}
				assert.ok(changes > 20, `only ${changes} changes were published`);
			} finally {
				bridge.dispose();
			}
		});
	}

	test("a burst of store changes projects the root activity once (#4009)", async () => {
		const store = createStore();
		seedFanOut(store, 20);
		const published: string[] = [];
		const bridge = createWorkflowObservation(store, recordingPublisher(published), "owner");
		let projections = 0;
		const graphSnapshot = store.graphSnapshot.bind(store);
		store.graphSnapshot = () => {
			projections++;
			return graphSnapshot();
		};
		try {
			for (let index = 0; index < 20; index++)
				store.recordStageEnd(`child-${index}`, { ...stage("plan"), status: "completed", endedAt: 2 });
			assert.equal(projections, 0, "nothing is projected inside the burst");
			await nextTurn();
			assert.equal(projections, 1);
			assert.equal(published.length, 1);
			const root = JSON.parse(published[0]!) as WorkflowRootActivity;
			assert.equal(root.graph?.nodes.filter((node) => node.status === "completed").length, 20);
		} finally {
			bridge.dispose();
		}
	});
});
