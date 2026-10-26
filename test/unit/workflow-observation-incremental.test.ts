import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { workflowObservationRuntime } from "../../packages/workflows/src/shared/store-factory.js";
import type { Store } from "../../packages/workflows/src/shared/store-public-types.js";
import type {
	PendingPrompt,
	RunSnapshot,
	RunStatus,
	StageSnapshot,
	StageStatus,
	ToolNodeStatus,
} from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { workflowActivityNodeKey } from "../../packages/workflows/src/shared/workflow-activity.js";
import {
	type WorkflowObservationChange,
	WorkflowObservationRuntime,
	type WorkflowRuntimeEvent,
} from "../../packages/workflows/src/shared/workflow-observation-runtime.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";

afterEach(closeMemoryTestBackends);

type LifecycleTarget = Parameters<WorkflowObservationRuntime["lifecycle"]>[0];

/** The full-walk capture as it shipped before observation became run-scoped, kept verbatim as the oracle. */
class FullWalkObservationRuntime extends WorkflowObservationRuntime {
	private referencePrevious = new Map<string, LifecycleTarget>();
	constructor(private readonly source: () => readonly RunSnapshot[]) {
		super(source, () => {});
	}

	override capture(): void {
		const next = new Map<string, LifecycleTarget>();
		const visit = (key: string, target: LifecycleTarget, historical = false): void => {
			next.set(key, target);
			const previous = this.referencePrevious.get(key);
			if (!historical && this.liveRunIds.has(target.runId) && previous?.status !== target.status) {
				this.lifecycle(
					previous && previous.kind !== "prompt" && target.kind !== "prompt"
						? ({ ...target, previousStatus: previous.status } as LifecycleTarget)
						: target,
					this.source().find((run) => run.id === target.runId)?.origin,
				);
			}
		};
		for (const run of this.source()) {
			const existing = this.referencePrevious.has(`run:${run.id}`);
			visit(`run:${run.id}`, { kind: "run", runId: run.id, status: run.status });
			for (const stage of run.stages) {
				visit(
					`stage:${workflowActivityNodeKey(run.id, stage.id)}`,
					{ kind: "stage", runId: run.id, stageId: stage.id, stageName: stage.name, status: stage.status },
					!existing,
				);
				if (stage.pendingPrompt)
					visit(
						`prompt:${stage.pendingPrompt.id}`,
						{
							kind: "prompt",
							runId: run.id,
							stageId: stage.id,
							promptId: stage.pendingPrompt.id,
							status: "opened",
						},
						!existing,
					);
			}
			for (const tool of run.toolNodes)
				visit(
					`tool:${workflowActivityNodeKey(run.id, tool.id)}`,
					{ kind: "tool", runId: run.id, toolNodeId: tool.id, toolName: tool.name, status: tool.status },
					!existing,
				);
			if (run.pendingPrompt)
				visit(
					`prompt:${run.pendingPrompt.id}`,
					{ kind: "prompt", runId: run.id, promptId: run.pendingPrompt.id, status: "opened" },
					!existing,
				);
		}
		this.referencePrevious = next;
	}
}

type ObservedEvent = Pick<
	Extract<WorkflowRuntimeEvent, { kind: "lifecycle" }>["event"],
	"target" | "attribution" | "delivery" | "rootRunId"
>;

function recordLifecycle(
	runtime: WorkflowObservationRuntime,
	into: ObservedEvent[],
	recording: () => boolean = () => true,
): void {
	runtime.listeners.add((event: WorkflowRuntimeEvent) => {
		if (event.kind !== "lifecycle" || !recording()) return;
		const { target, attribution, delivery, rootRunId } = event.event;
		into.push({ target, attribution, delivery, rootRunId });
	});
}

function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled", "killed", "blocked"];
const STAGE_STATUSES: readonly StageStatus[] = ["pending", "running", "completed", "failed", "skipped"];
const TOOL_END_STATUSES: readonly ToolNodeStatus[] = ["completed", "failed", "cached", "cancelled"];

/** Prompt ids are unique per run and stage but recur within them, as a reopened prompt does after a resume. */
function prompt(id: string): PendingPrompt {
	return { id, kind: "input", message: id, createdAt: 1 };
}

/** Applies one random store mutation of the kinds a workflow run produces. */
function mutate(
	store: Store,
	live: WorkflowObservationRuntime,
	oracle: WorkflowObservationRuntime,
	next: () => number,
) {
	const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(next() * items.length)];
	const runs = store.runs();
	const target = pick(runs);
	const stage = target === undefined ? undefined : pick(target.stages);
	const tool = target === undefined ? undefined : pick(target.toolNodes);
	const op = Math.floor(next() * 22);
	const id = `n${Math.floor(next() * 1e9)}`;
	switch (op) {
		case 0:
		case 1: {
			const parent = pick(runs);
			const runId = runs.length < 6 || next() < 0.3 ? `r${Math.floor(next() * 8)}` : id;
			if (next() < 0.8) {
				live.startRun(runId);
				oracle.startRun(runId);
			}
			store.recordRunStart({
				id: runId,
				name: "w",
				inputs: {},
				stages: [],
				toolNodes: [],
				status: next() < 0.7 ? "running" : "pending",
				startedAt: 1,
				// Only fresh runs get a parent, so replacing a run never creates a parent cycle.
				...(parent !== undefined && runId === id && next() < 0.6 ? { parentRunId: parent.id } : {}),
				...(next() < 0.2 ? { origin: "user" as const } : {}),
			});
			return;
		}
		case 2:
		case 3:
			if (target !== undefined)
				store.recordStageStart(target.id, {
					// Shared ids reappear in runs that were replaced, as resumed stages do.
					id: next() < 0.5 ? `s${Math.floor(next() * 4)}` : id,
					name: `stage-${id}`,
					status: pick(STAGE_STATUSES) ?? "running",
					parentIds: [],
					toolEvents: [],
				});
			return;
		case 4:
			if (target !== undefined && stage !== undefined) {
				// Executors mutate the stage they registered, then republish it through the store.
				stage.status = pick(STAGE_STATUSES) ?? "running";
				store.recordStageStart(target.id, stage);
			}
			return;
		case 5:
			if (target !== undefined && stage !== undefined)
				store.recordStageEnd(target.id, { ...stage, status: pick(STAGE_STATUSES) ?? "completed", endedAt: 2 });
			return;
		case 6:
			if (target !== undefined && stage !== undefined) {
				const control = Math.floor(next() * 5);
				if (control === 0) store.recordStagePaused(target.id, stage.id);
				else if (control === 1) store.recordStageResumed(target.id, stage.id);
				else if (control === 2) store.recordStageBlocked(target.id, stage.id, "other");
				else if (control === 3) store.recordStageUnblocked(target.id, stage.id);
				else store.recordStageAwaitingInput(target.id, stage.id, next() < 0.5);
			}
			return;
		case 7:
			if (target !== undefined)
				store.recordToolNodeStart(target.id, {
					kind: "tool",
					attachable: false,
					id,
					name: "read",
					status: "pending",
					parentIds: [],
					ordinal: 0,
					argsHash: id,
				});
			return;
		case 8:
			if (target !== undefined && tool !== undefined)
				if (next() < 0.5) store.recordToolNodeRunning(target.id, tool.id, 2);
				else store.recordToolNodeEnd(target.id, tool.id, { status: pick(TOOL_END_STATUSES) ?? "completed" });
			return;
		case 9:
			if (target !== undefined) store.recordRunEnd(target.id, pick(RUN_STATUSES) ?? "completed");
			return;
		case 10:
			if (target !== undefined) store.recordRunExecutionState(target.id, { phase: "executing" });
			return;
		case 11:
			if (target !== undefined)
				if (next() < 0.5) store.recordRunPaused(target.id);
				else store.recordRunResumed(target.id);
			return;
		case 12:
			if (target !== undefined) store.removeRun(target.id);
			return;
		case 13:
			if (target !== undefined) {
				// The oracle is invalidated by the live runtime's notification, so it must see the same liveness first.
				oracle.finishRun(target.id);
				live.finishRun(target.id);
			}
			return;
		case 14:
			if (target !== undefined && stage !== undefined) {
				store.recordStageWorkflowChildRun(target.id, stage.id, { runId: id, alias: "child", workflow: "w" });
				store.recordStageAttachable(target.id, stage.id, next() < 0.5);
			}
			return;
		case 15:
			store.batch(() => {
				for (let index = 0; index < 3; index++) mutate(store, live, oracle, next);
			});
			return;
		case 16:
			if (target !== undefined && stage !== undefined && stage.pendingPrompt === undefined) {
				// Executors open a stage prompt on the stage they registered, then republish it.
				stage.pendingPrompt = prompt(`p-${target.id}-${stage.id}-${Math.floor(next() * 2)}`);
				store.recordStageStart(target.id, stage);
			}
			return;
		case 17:
			if (target !== undefined && stage?.pendingPrompt !== undefined) {
				stage.pendingPrompt = undefined;
				store.recordStageStart(target.id, stage);
			}
			return;
		case 18:
			if (target !== undefined) {
				const promptOp = Math.floor(next() * 4);
				if (promptOp === 0 && stage !== undefined)
					store.recordStagePendingPrompt(
						target.id,
						stage.id,
						prompt(`p-${target.id}-${stage.id}-${Math.floor(next() * 2)}`),
					);
				else if (promptOp === 1 && stage?.pendingPrompt !== undefined)
					store.resolveStagePendingPrompt(target.id, stage.id, stage.pendingPrompt.id, "answer");
				else if (promptOp === 2)
					store.recordPendingPrompt(target.id, prompt(`q-${target.id}-${Math.floor(next() * 2)}`));
				else if (target.pendingPrompt !== undefined)
					store.resolvePendingPrompt(target.id, target.pendingPrompt.id, "answer");
			}
			return;
		case 19:
			// recordRunExecutionState ignores an ended run, which would leave the in-place change unpublished.
			if (target !== undefined && target.endedAt === undefined) {
				// A run-level prompt changed in place, published by a run-scoped store change.
				target.pendingPrompt =
					target.pendingPrompt === undefined ? prompt(`q-${target.id}-${Math.floor(next() * 2)}`) : undefined;
				store.recordRunExecutionState(target.id, { phase: "executing" });
			}
			return;
		case 20:
		case 21:
			if (target !== undefined) {
				// Resume replaces the run with a rebuilt snapshot: fewer stages, some prompts kept, some reopened.
				const keep = (): boolean => next() < 0.6;
				const reopen = (current: PendingPrompt | undefined, id: string): PendingPrompt | undefined => {
					const choice = next();
					if (choice < 0.4) return current === undefined ? undefined : { ...current };
					if (choice < 0.7) return prompt(id);
					return undefined;
				};
				live.startRun(target.id);
				oracle.startRun(target.id);
				store.recordRunStart({
					...target,
					status: next() < 0.5 ? target.status : "running",
					stages: target.stages.filter(keep).map((kept) => {
						const { pendingPrompt, ...rest } = kept;
						const reopened = reopen(pendingPrompt, `p-${target.id}-${kept.id}-${Math.floor(next() * 2)}`);
						return {
							...rest,
							toolEvents: [],
							...(next() < 0.3 ? { status: "pending" as const } : {}),
							...(reopened !== undefined ? { pendingPrompt: reopened } : {}),
						};
					}),
					toolNodes: target.toolNodes.filter(keep).map((node) => ({ ...node })),
					pendingPrompt: reopen(target.pendingPrompt, `q-${target.id}-${Math.floor(next() * 2)}`),
				});
			}
			return;
	}
}

test("run-scoped observation emits exactly what a full walk of every run emits", () => {
	let compared = 0;
	let promptsOpened = 0;
	for (let seed = 1; seed <= 200; seed++) {
		const store = createStore();
		const live = workflowObservationRuntime(store);
		const oracle = new FullWalkObservationRuntime(() => store.runs());
		const observed: ObservedEvent[] = [];
		const expected: ObservedEvent[] = [];
		// Prompt answers and cancellations are emitted directly by the store, not by capture, so only capture is compared.
		let capturing = false;
		const capture = live.capture.bind(live);
		live.capture = (changes?: readonly WorkflowObservationChange[]) => {
			capturing = true;
			try {
				capture(changes);
			} finally {
				capturing = false;
			}
		};
		recordLifecycle(live, observed, () => capturing);
		recordLifecycle(oracle, expected);
		store.subscribeInvalidation(() => oracle.capture());
		const next = random(seed);
		for (let step = 0; step < 80; step++) mutate(store, live, oracle, next);
		assert.deepEqual(observed, expected, `seed ${seed}`);
		compared += expected.length;
		promptsOpened += expected.filter((event) => event.target.kind === "prompt").length;
	}
	assert.ok(compared > 2_000, `only ${compared} lifecycle events compared`);
	assert.ok(promptsOpened > 500, `only ${promptsOpened} prompt openings compared`);
});

const CHILDREN = 150;
/**
 * Status reads of runs and stages allowed per child for the whole fan-out. Each child and its boundary stage in the
 * root change a constant number of times; a walk of every run on every store change reads each node once per change
 * anywhere in the tree.
 */
const STATUS_READS_PER_CHILD = 60;
/** Structural: runs a 150-child workflow fan-out through the real engine. */
const FAN_OUT_TIMEOUT_MS = 60_000;

/** Counts reads of `node.status`, keeping it writable as executors and the store write it in place. */
function countStatusReads(node: { status: string }, count: () => void): void {
	let status = node.status;
	Object.defineProperty(node, "status", {
		configurable: true,
		enumerable: true,
		get() {
			count();
			return status;
		},
		set(value: string) {
			status = value;
		},
	});
}

test(
	"observing a 150-child workflow fan-out reads each run and stage a bounded number of times",
	async () => {
		const child = workflow({
			name: "fan-out-child",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("work").complete("done");
				return {};
			},
		}) as WorkflowDefinition;
		const root = workflow({
			name: "fan-out-root",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await Promise.all(Array.from({ length: CHILDREN }, () => ctx.workflow(child, {})));
				return {};
			},
		}) as WorkflowDefinition;
		const store = createStore();
		let statusReads = 0;
		const count = () => {
			statusReads++;
		};
		const counted = new WeakSet<object>();
		const recordRunStart = store.recordRunStart.bind(store);
		store.recordRunStart = (snapshot: RunSnapshot) => {
			if (!counted.has(snapshot)) countStatusReads(snapshot, count);
			counted.add(snapshot);
			recordRunStart(snapshot);
		};
		const recordStageStart = store.recordStageStart.bind(store);
		store.recordStageStart = (runId: string, stage: StageSnapshot) => {
			if (!counted.has(stage)) countStatusReads(stage, count);
			counted.add(stage);
			recordStageStart(runId, stage);
		};
		const result = await run(
			root,
			{},
			{
				runId: "fan-out-root",
				registry: createRegistry([root, child]),
				store,
				durableBackend: await createMemoryTestBackend(),
				adapters: { complete: { complete: async (text: string) => text } },
			},
		);
		assert.equal(result.status, "completed", result.error);
		assert.equal(store.runs().length, CHILDREN + 1);
		assert.ok(
			statusReads <= STATUS_READS_PER_CHILD * CHILDREN,
			`${statusReads} run and stage status reads for ${CHILDREN} children exceeds ${STATUS_READS_PER_CHILD} per child`,
		);
	},
	FAN_OUT_TIMEOUT_MS,
);
