import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { WorkflowActivityHub } from "../../packages/coding-agent/src/core/extensions/workflow-activity-hub.js";
import type {
	WorkflowActivityFrame,
	WorkflowGraphNode,
	WorkflowRootActivity,
} from "../../packages/coding-agent/src/core/extensions/workflow-events.js";
import { createWorkflowObservation } from "../../packages/workflows/src/extension/workflow-observation.js";
import { announceSettledStageEdit } from "../../packages/workflows/src/runs/foreground/executor-lifecycle.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import {
	createGraphStoreSnapshot,
	isPublishedSnapshotArray,
} from "../../packages/workflows/src/shared/graph-store-snapshot.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflowObservationRuntime } from "../../packages/workflows/src/shared/store-factory.js";
import type { Store } from "../../packages/workflows/src/shared/store-public-types.js";
import type { StageSnapshot, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	projectWorkflowActivity,
	type WorkflowActivityOwnership,
	WorkflowActivityProjector,
	workflowActivityNodeKey,
} from "../../packages/workflows/src/shared/workflow-activity.js";

const RUN_ID = "run-4642";
const LANES = 3;

/** The id of the stage a lane runs at `step`, as the benchmark's lanes name theirs. */
function stageId(lane: number, step: number): string {
	return `lane-${lane}-step-${step}`;
}

/**
 * A run of three sequential lanes, as the long-run benchmark drives one: `finished` completed stages, then one running
 * stage per lane. Every stage is handed to the store as `wrap` returns it, which the store keeps by reference.
 */
function seedLongRun(
	store: Store,
	finished: number,
	wrap: (stage: StageSnapshot) => StageSnapshot = (stage) => stage,
): StageSnapshot[] {
	const stages: StageSnapshot[] = [];
	for (let index = 0; index < finished + LANES; index++) {
		const lane = index % LANES;
		const step = Math.floor(index / LANES);
		const running = index >= finished;
		stages.push(
			wrap({
				id: stageId(lane, step),
				name: stageId(lane, step),
				status: running ? "running" : "completed",
				parentIds: step === 0 ? [] : [stageId(lane, step - 1)],
				toolEvents: [],
				executionOrder: index + 1,
				startedAt: index,
				...(running ? {} : { endedAt: index + 1, result: `result of stage ${index}` }),
			}),
		);
	}
	store.recordRunStart({
		id: RUN_ID,
		name: "long run",
		inputs: {},
		status: "running",
		stages,
		toolNodes: [],
		startedAt: 0,
	});
	return stages;
}

function liveStage(stages: readonly StageSnapshot[]): StageSnapshot {
	const stage = stages.at(-1);
	if (stage === undefined) throw new Error("the run has no stages");
	return stage;
}

/** Store changes a running stage makes between two reads: it calls a tool. */
function changeLiveStage(store: Store, stages: readonly StageSnapshot[]): void {
	store.recordToolStart(RUN_ID, liveStage(stages).id, { name: "run_command", startedAt: 1 });
}

function freshNodes<T>(before: readonly T[], after: readonly T[]): number {
	const previous = new Set(before);
	return after.filter((node) => !previous.has(node)).length;
}

describe("store-change work does not grow with the stages a run finished (#4642)", () => {
	afterEach(() => vi.restoreAllMocks());

	test("a graph snapshot after a change scoped to one stage reads no field of the run's settled stages (#4642)", () => {
		const readsOfSettledStages = (finished: number): number => {
			let reads = 0;
			let counting = false;
			const count = <T>(value: T): T => {
				if (counting) reads++;
				return value;
			};
			const store = createStore();
			const stages = seedLongRun(store, finished, (stage) =>
				stage.status === "completed"
					? new Proxy(stage, {
							get: (target, key, receiver) => count(Reflect.get(target, key, receiver)),
							ownKeys: (target) => count(Reflect.ownKeys(target)),
							getOwnPropertyDescriptor: (target, key) => count(Reflect.getOwnPropertyDescriptor(target, key)),
							has: (target, key) => count(Reflect.has(target, key)),
						})
					: stage,
			);
			store.graphSnapshot();
			changeLiveStage(store, stages);
			counting = true;
			const snapshot = store.graphSnapshot();
			counting = false;
			assert.deepStrictEqual(snapshot, createGraphStoreSnapshot(store.runs(), store.notices(), snapshot.version));
			return reads;
		};
		assert.equal(readsOfSettledStages(600), readsOfSettledStages(10));
		assert.equal(readsOfSettledStages(600), 0);
	});

	test("expanding the next version re-expands only the stage that changed, or the one that started (#4642)", () => {
		const fresh = (finished: number): { changed: number; started: number } => {
			const store = createStore();
			const stages = seedLongRun(store, finished);
			const first = expandWorkflowGraph(store.graphSnapshot(), RUN_ID);
			changeLiveStage(store, stages);
			const second = expandWorkflowGraph(store.graphSnapshot(), RUN_ID);
			store.recordStageStart(RUN_ID, {
				id: "lane-0-next",
				name: "lane-0-next",
				status: "running",
				parentIds: [liveStage(stages).id],
				toolEvents: [],
			});
			const third = expandWorkflowGraph(store.graphSnapshot(), RUN_ID);
			assert.deepStrictEqual(
				third,
				expandWorkflowGraph(createGraphStoreSnapshot(store.runs(), store.notices(), 0), RUN_ID),
			);
			return { changed: freshNodes(first.nodes, second.nodes), started: freshNodes(second.nodes, third.nodes) };
		};
		assert.deepEqual(fresh(600), { changed: 1, started: 1 });
		assert.deepEqual(fresh(10), { changed: 1, started: 1 });
	});

	test("root activity after a stage change re-projects one node and looks no stage up in the ownership sets (#4642)", async () => {
		const measure = async (finished: number): Promise<{ fresh: number; lookups: number }> => {
			const store = createStore();
			const stages = seedLongRun(store, finished);
			const runtime = workflowObservationRuntime(store);
			const published: WorkflowRootActivity[] = [];
			const bridge = createWorkflowObservation(
				store,
				{
					publishSnapshot: () => {},
					publishChanged: (root) => published.push(root),
					publishRemoved: () => {},
					publishLifecycle: () => {},
					publishHeartbeat: () => {},
					dispose: () => {},
				},
				"owner",
			);
			const end = (stage: StageSnapshot): void =>
				store.recordStageEnd(RUN_ID, { ...stage, status: "completed", endedAt: 2 });
			try {
				end(stages.at(-3)!);
				await new Promise((resolve) => setImmediate(resolve));
				const has = vi.spyOn(Set.prototype, "has");
				end(stages.at(-2)!);
				await new Promise((resolve) => setImmediate(resolve));
				const lookups = has.mock.contexts.filter(
					(set) => set === runtime.executingStageIds || set === runtime.retryingStageIds,
				).length;
				has.mockRestore();
				const [before, after] = published.slice(-2);
				assert.equal(published.length, 2);
				return { fresh: freshNodes(before?.graph?.nodes ?? [], after?.graph?.nodes ?? []), lookups };
			} finally {
				bridge.dispose();
			}
		};
		const long = await measure(600);
		const short = await measure(10);
		assert.equal(long.fresh, 1);
		assert.deepEqual(long, short);
	});

	test("the activity hub shares frozen graph nodes with observers instead of copying them (#4642)", async () => {
		const clonedNodes = async (finished: number): Promise<number> => {
			const nodes = (count: number, status: "completed" | "running"): WorkflowGraphNode[] =>
				Array.from({ length: count }, (_, index) =>
					Object.freeze({
						kind: "stage" as const,
						id: `stage-${index}`,
						runId: RUN_ID,
						nodeId: `stage-${index}`,
						name: `stage-${index}`,
						status,
						parentIds: Object.freeze(index === 0 ? [] : [`stage-${index - 1}`]),
						depth: 0,
					}),
				);
			const settled = nodes(finished, "completed");
			const root = (live: WorkflowGraphNode): WorkflowRootActivity => ({
				rootRunId: RUN_ID,
				ownerSessionId: "owner",
				state: "working",
				reason: "executing",
				activeExecutionCount: 1,
				actionableBlockCount: 0,
				needsAttention: false,
				graph: { nodes: [...settled, live] },
			});
			const hub = new WorkflowActivityHub();
			const handled: WorkflowRootActivity[] = [];
			hub.bindDispatcher(async (event) => {
				if (event.type === "workflow_activity_changed") handled.push(event.root);
			});
			const frames: WorkflowActivityFrame[] = [];
			hub.observeWorkflowActivity((frame) => {
				frames.push(frame);
			});
			const publisher = hub.registerWorkflowActivityPublisher();
			publisher.publishSnapshot({ availability: "ready", roots: [] });
			const [live] = nodes(1, "running");
			publisher.publishChanged(root(live!));
			await new Promise((resolve) => setImmediate(resolve));
			const clone = vi.spyOn(globalThis, "structuredClone");
			const ended = Object.freeze({ ...live!, status: "completed" as const });
			publisher.publishChanged(root(ended));
			await new Promise((resolve) => setImmediate(resolve));
			const counted = clone.mock.calls.reduce(
				(total, [value]) => total + JSON.stringify(value).split('"kind":"stage"').length - 1,
				0,
			);
			clone.mockRestore();
			const delivered = frames.at(-1);
			assert.equal(delivered?.kind, "changed");
			if (delivered?.kind !== "changed") throw new Error("no changed frame was delivered");
			assert.deepEqual(delivered.root, root(ended));
			assert.deepEqual(handled.at(-1), delivered.root);
			assert.equal(delivered.root.graph?.nodes[0], settled[0]);
			return counted;
		};
		assert.equal(await clonedNodes(600), 0);
		assert.equal(await clonedNodes(10), 0);
	});

	test("a settled stage edited in place is read again once a store change names it (#4642)", () => {
		const store = createStore();
		const stages = seedLongRun(store, 30);
		const settled = stages[4]!;
		const modelOf = (snapshot: StoreSnapshot) =>
			snapshot.runs[0]?.stages.find((stage) => stage.id === settled.id)?.model;
		assert.equal(modelOf(store.graphSnapshot()), undefined);
		settled.model = "fallback-model";
		changeLiveStage(store, stages);
		assert.equal(modelOf(store.graphSnapshot()), undefined, "an edit no change names is not read");
		announceSettledStageEdit(store, RUN_ID, settled);
		const snapshot = store.graphSnapshot();
		assert.equal(modelOf(snapshot), "fallback-model");
		assert.deepStrictEqual(snapshot, createGraphStoreSnapshot(store.runs(), store.notices(), snapshot.version));
	});

	test("a running stage edited in place is read on the next snapshot, and announcing it changes nothing (#4642)", () => {
		const store = createStore();
		const stages = seedLongRun(store, 30);
		const running = stages.at(-2)!;
		store.graphSnapshot();
		running.model = "fallback-model";
		changeLiveStage(store, stages);
		const snapshot = store.graphSnapshot();
		assert.equal(snapshot.runs[0]?.stages.find((stage) => stage.id === running.id)?.model, "fallback-model");
		announceSettledStageEdit(store, RUN_ID, running);
		assert.equal(store.graphSnapshot(), snapshot, "a running stage needs no announcement");
	});

	test("a published snapshot's stage array never changes, and its runs and stages stay frozen (#4642)", () => {
		const store = createStore();
		const stages = seedLongRun(store, 30);
		const first = store.graphSnapshot();
		const published = first.runs[0]!.stages;
		const contents = [...published];
		for (let change = 0; change < 5; change++) changeLiveStage(store, stages);
		store.recordStageStart(RUN_ID, {
			id: "appended",
			name: "appended",
			status: "running",
			parentIds: [],
			toolEvents: [],
		});
		const later = store.graphSnapshot();
		assert.notEqual(later.runs[0]!.stages, published);
		assert.deepEqual(published, contents);
		assert.ok(isPublishedSnapshotArray(published) && isPublishedSnapshotArray(later.runs[0]!.stages));
		assert.ok(Object.isFrozen(first) && Object.isFrozen(first.runs) && Object.isFrozen(first.runs[0]));
		assert.ok(published.every((stage) => Object.isFrozen(stage) && Object.isFrozen(stage.parentIds)));
	});

	test("projecting version after version equals projecting each version afresh, whatever the ownership sets hold (#4642)", () => {
		for (const seed of [21, 22, 23, 24]) {
			let state = seed;
			const next = (): number => {
				state = (Math.imul(state, 1103515245) + 12345) >>> 0;
				return state / 4294967296;
			};
			const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)];
			const store = createStore();
			const stages = seedLongRun(store, 12);
			store.recordToolNodeStart(RUN_ID, {
				kind: "tool",
				id: "tool:1",
				name: "tool",
				status: "pending",
				parentIds: [stages[0]!.id],
				ordinal: 1,
				argsHash: "1",
				attachable: false,
			});
			const projector = new WorkflowActivityProjector();
			const statuses: StageSnapshot["status"][] = [
				"pending",
				"running",
				"completed",
				"failed",
				"skipped",
				"paused",
				"suspended",
				"awaiting_input",
			];
			for (let step = 0; step < 200; step++) {
				const run = store.run(RUN_ID)!;
				const target = pick(run.stages)!;
				if (next() < 0.15)
					store.recordStageStart(RUN_ID, {
						id: `added-${step}`,
						name: `added-${step}`,
						status: pick(statuses)!,
						parentIds: next() < 0.5 ? [target.id] : ["tool:1"],
						toolEvents: [],
					});
				else {
					target.status = pick(statuses)!;
					if (next() < 0.2)
						target.pendingPrompt = { id: `prompt-${step}`, kind: "confirm", message: "go?", createdAt: step };
					else delete target.pendingPrompt;
					store.recordStageStart(RUN_ID, target);
				}
				const owned = (): Set<string> =>
					new Set(
						run.stages
							.filter(() => next() < 0.1)
							.map((stage) => workflowActivityNodeKey(RUN_ID, stage.id))
							.concat(next() < 0.3 ? [workflowActivityNodeKey(RUN_ID, "tool:1")] : []),
					);
				const ownership: WorkflowActivityOwnership = {
					ownerSessionId: "owner",
					liveRunIds: new Set(next() < 0.7 ? [RUN_ID] : []),
					executingStageIds: owned(),
					executingToolNodeIds: owned(),
					stoppingRunIds: new Set(next() < 0.1 ? [RUN_ID] : []),
					retryingStageIds: owned(),
					acknowledgedFailureRunIds: new Set(),
				};
				const snapshot = store.graphSnapshot();
				assert.deepStrictEqual(
					projector.project({ snapshot, ownership }),
					projectWorkflowActivity({ snapshot, ownership }),
					`seed ${seed} step ${step}`,
				);
			}
		}
	});
});
