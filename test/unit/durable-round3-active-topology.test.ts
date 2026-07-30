import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableChildInvocationFingerprint } from "../../packages/workflows/src/durable/child-invocation.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableStageRunTopology, DurableStageTopology } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { createMockSdk, seedMockCheckpoint, seedMockWorkflow } from "./durable-dbos-backend-helpers.js";

const CHILD = "round3-active-child";
const PARENT = "round3-active-parent";
const SCOPE = `workflow:workflow:${CHILD}:1`;
const BOUNDARY_ID = "round3-boundary";

function fingerprint(): string {
	return durableChildInvocationFingerprint({ name: CHILD, normalizedName: CHILD } as never, {});
}

function rootRun(runId: string): DurableStageRunTopology {
	return { runId, runName: PARENT };
}

function childRun(runId: string, overrides: Partial<DurableStageRunTopology> = {}): DurableStageRunTopology {
	return {
		runId: `${runId}-child`,
		runName: CHILD,
		parentRunId: runId,
		parentStageId: BOUNDARY_ID,
		rootRunId: runId,
		...overrides,
	};
}

function startTopology(
	runId: string,
	replayScope = SCOPE,
	stageId = BOUNDARY_ID,
	ownedChild = childRun(runId),
): DurableStageTopology {
	return {
		version: 1,
		stageId,
		parentIds: [],
		sourceOrder: 0,
		status: "running",
		run: rootRun(runId),
		boundary: {
			version: 1,
			event: "start",
			replayScope,
			alias: CHILD,
			workflow: CHILD,
			invocationFingerprint: fingerprint(),
			status: "running",
			child: {
				runId: ownedChild.runId,
				runName: ownedChild.runName,
				parentRunId: runId,
				parentStageId: stageId,
				rootRunId: runId,
			},
		},
	};
}

interface ChildStageSeed {
	readonly key: string;
	readonly id: string;
	readonly order: number;
	readonly parents?: readonly string[];
	readonly run?: DurableStageRunTopology;
	readonly name?: string;
	readonly occurrenceKey?: string;
}

function seedStage(sdk: ReturnType<typeof createMockSdk>, runId: string, stage: ChildStageSeed): void {
	seedMockCheckpoint(sdk, runId, {
		kind: "stage",
		workflowId: runId,
		checkpointId: `${stage.key}:checkpoint`,
		name: stage.name ?? stage.key,
		replayKey: stage.key,
		output: `cached:${stage.key}`,
		completedAt: stage.order + 2,
		topology: {
			version: 1,
			stageId: stage.id,
			parentIds: [...(stage.parents ?? [])],
			sourceOrder: stage.order,
			...(stage.occurrenceKey !== undefined ? { occurrenceKey: stage.occurrenceKey } : {}),
			status: "completed",
			run: stage.run ?? childRun(runId),
		},
	});
}

function seedTerminal(
	sdk: ReturnType<typeof createMockSdk>,
	runId: string,
	status: "running" | "completed" | "failed" | "skipped" | "blocked" | "paused",
	output?: WorkflowSerializableValue,
	suffix = status,
): void {
	const raw = startTopology(runId) as unknown as Record<string, WorkflowSerializableValue>;
	raw.status = status;
	const boundary = raw.boundary as Record<string, WorkflowSerializableValue>;
	boundary.event = "terminal";
	boundary.status = status;
	seedMockCheckpoint(sdk, runId, {
		kind: "stage",
		workflowId: runId,
		checkpointId: `terminal:${suffix}`,
		name: `workflow:${CHILD}`,
		replayKey: SCOPE,
		completedAt: suffix === "completed" ? 9 : 10,
		...(output !== undefined ? { output } : {}),
		topology: raw,
	} as never);
}

function completedChildOutput(runId: string, outputs: WorkflowSerializableValue): WorkflowSerializableValue {
	return {
		workflow: CHILD,
		runId: `${runId}-child`,
		status: "completed",
		exited: false,
		outputs,
	};
}

async function runCase(caseName: string, seed: (sdk: ReturnType<typeof createMockSdk>, runId: string) => void) {
	const runId = `round3-active-${caseName}`;
	const sdk = createMockSdk();
	seedMockWorkflow(sdk, { workflowId: runId, name: PARENT, status: "PENDING", createdAt: 1 });
	seedMockCheckpoint(sdk, runId, {
		kind: "stage",
		workflowId: runId,
		checkpointId: `boundary-start:${SCOPE}`,
		name: `workflow:${CHILD}`,
		replayKey: SCOPE,
		completedAt: 1,
		topology: startTopology(runId),
	});
	seed(sdk, runId);
	const backend = new DbosDurableBackend(sdk, { executorId: `round3-active-${caseName}` });
	await backend.hydrateWorkflow(runId);
	const store = createStore();
	let childCalls = 0;
	let adapterCalls = 0;
	let lifecycleCalls = 0;
	const child = workflow({
		name: CHILD,
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			childCalls += 1;
			return { value: await ctx.stage("live-child").complete("live") };
		},
	});
	const parent = workflow({
		name: PARENT,
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const result = await ctx.workflow(child);
			return { value: result.outputs.value ?? "missing" };
		},
	});
	const result = await run(
		parent,
		{},
		{
			runId,
			store,
			durableBackend: backend,
			adapters: {
				complete: {
					complete: async (text) => {
						adapterCalls += 1;
						return text;
					},
				},
			},
			onStageStart: () => {
				lifecycleCalls += 1;
			},
			onStageEnd: () => {
				lifecycleCalls += 1;
			},
		},
	);
	return { result, store, runId, childCalls, adapterCalls, lifecycleCalls };
}

const malformedCases: ReadonlyArray<readonly [string, (sdk: ReturnType<typeof createMockSdk>, runId: string) => void]> =
	[
		[
			"wrong-parent-outside-scope",
			(sdk, runId) =>
				seedStage(sdk, runId, {
					key: "workflow:unrelated:stage:wrong:1",
					id: "wrong",
					order: 0,
					run: childRun(runId, { parentRunId: "wrong-parent" }),
				}),
		],
		[
			"duplicate-id",
			(sdk, runId) => {
				seedStage(sdk, runId, { key: `${SCOPE}:stage:a:1`, id: "same", order: 0 });
				seedStage(sdk, runId, { key: `${SCOPE}:stage:b:1`, id: "same", order: 1 });
			},
		],
		[
			"prompt-occurrence-replay-poison",
			(sdk, runId) => {
				seedStage(sdk, runId, {
					key: `${SCOPE}:prompt:input:first`,
					name: "input",
					id: "same-prompt",
					order: 0,
					occurrenceKey: "shared-occurrence",
				});
				seedStage(sdk, runId, {
					key: `${SCOPE}:prompt:input:SECOND-DIFFERENT`,
					name: "input",
					id: "same-prompt",
					order: 0,
					occurrenceKey: "shared-occurrence",
				});
			},
		],
		[
			"duplicate-order",
			(sdk, runId) => {
				seedStage(sdk, runId, { key: `${SCOPE}:stage:a:1`, id: "a", order: 0 });
				seedStage(sdk, runId, { key: `${SCOPE}:stage:b:1`, id: "b", order: 0 });
			},
		],
		[
			"cycle",
			(sdk, runId) => {
				seedStage(sdk, runId, { key: `${SCOPE}:stage:a:1`, id: "a", order: 0, parents: ["b"] });
				seedStage(sdk, runId, { key: `${SCOPE}:stage:b:1`, id: "b", order: 1, parents: ["a"] });
			},
		],
		[
			"empty-id",
			(sdk, runId) =>
				seedStage(sdk, runId, {
					key: `${SCOPE}:stage:empty:1`,
					id: "",
					order: 0,
				}),
		],
		[
			"aliased-boundary-id",
			(sdk, runId) => {
				const otherScope = "workflow:workflow:other-child:1";
				seedMockCheckpoint(sdk, runId, {
					kind: "stage",
					workflowId: runId,
					checkpointId: `boundary-start:${otherScope}`,
					name: "workflow:other-child",
					replayKey: otherScope,
					completedAt: 2,
					topology: startTopology(runId, otherScope, BOUNDARY_ID, {
						runId: `${runId}-other`,
						runName: CHILD,
						parentRunId: runId,
						parentStageId: BOUNDARY_ID,
						rootRunId: runId,
					}),
				});
			},
		],
		[
			"start-non-running",
			(sdk) => {
				const encoded = [...sdk.state.steps.entries()].find(([key]) => key.endsWith(`:boundary-start:${SCOPE}`))!;
				const envelope = structuredClone(encoded[1]) as Record<string, WorkflowSerializableValue>;
				const topology = envelope.topology as Record<string, WorkflowSerializableValue>;
				topology.status = "completed";
				(topology.boundary as Record<string, WorkflowSerializableValue>).status = "completed";
				sdk.state.steps.set(encoded[0], envelope);
			},
		],
		["terminal-running", (sdk, runId) => seedTerminal(sdk, runId, "running")],
		["terminal-blocked", (sdk, runId) => seedTerminal(sdk, runId, "blocked")],
		["terminal-paused", (sdk, runId) => seedTerminal(sdk, runId, "paused")],
		["completed-null-output", (sdk, runId) => seedTerminal(sdk, runId, "completed", null)],
		["completed-array-output", (sdk, runId) => seedTerminal(sdk, runId, "completed", [])],
		[
			"completed-to-failed",
			(sdk, runId) => {
				seedTerminal(sdk, runId, "completed", completedChildOutput(runId, { value: "cached" }), "completed");
				seedTerminal(sdk, runId, "failed", undefined, "failed");
			},
		],
	];

test("fresh DBOS active child topology fails closed before cache, boundary dispatch, targets, or side effects", async () => {
	for (const [caseName, seed] of malformedCases) {
		const observed = await runCase(caseName, seed);
		assert.equal(observed.result.status, "failed", caseName);
		assert.match(
			observed.result.error ?? "",
			/DurableNestedTopologyError|durable nested topology is non-resumable/,
			caseName,
		);
		assert.equal(observed.childCalls, 0, caseName);
		assert.equal(observed.adapterCalls, 0, caseName);
		assert.equal(observed.lifecycleCalls, 0, caseName);
		assert.equal(
			observed.store.runs().some((candidate) => candidate.parentRunId === observed.runId),
			false,
			caseName,
		);
		assert.deepEqual(
			observed.store.runs().find((candidate) => candidate.id === observed.runId)?.stages,
			[],
			caseName,
		);
	}
});

test("the boundary-start crash window with no direct child stage records remains resumable", async () => {
	const observed = await runCase("empty-window", () => {});
	assert.equal(observed.result.status, "completed");
	assert.equal(observed.childCalls, 1);
	assert.equal(observed.adapterCalls, 1);
});
