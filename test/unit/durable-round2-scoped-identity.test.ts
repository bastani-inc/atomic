import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableCheckpoint, DurableStageRunTopology } from "../../packages/workflows/src/durable/types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { WorkflowUIContext } from "../../packages/workflows/src/shared/authoring-contract-ui.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMockSdk, seedMockCheckpoint, seedMockWorkflow } from "./durable-dbos-backend-helpers.js";

const CHILD = "round2-identity-child";
const PARENT = "round2-identity-parent";
const SCOPE = `workflow:workflow:${CHILD}:1`;

type UnsafeRecordFactory = (runId: string) => readonly DurableCheckpoint[];

function boundaryStart(runId: string): DurableCheckpoint {
	const childRunId = `${runId}-child`;
	return {
		kind: "stage",
		workflowId: runId,
		checkpointId: `boundary-start:${SCOPE}`,
		name: `workflow:${CHILD}`,
		replayKey: SCOPE,
		completedAt: 1,
		topology: {
			version: 1,
			stageId: `${runId}-boundary`,
			parentIds: [],
			sourceOrder: 0,
			status: "running",
			run: { runId, runName: PARENT },
			boundary: {
				version: 1,
				event: "start",
				replayScope: SCOPE,
				alias: CHILD,
				workflow: CHILD,
				status: "running",
				child: {
					runId: childRunId,
					runName: CHILD,
					parentRunId: runId,
					parentStageId: `${runId}-boundary`,
					rootRunId: runId,
				},
			},
		},
	};
}

function childRun(runId: string): DurableStageRunTopology {
	return {
		runId: `${runId}-child`,
		runName: CHILD,
		parentRunId: runId,
		parentStageId: `${runId}-boundary`,
		rootRunId: runId,
	};
}

function stageRecord(runId: string, checkpointId: string, replayKey: string, suffix = "unsafe"): DurableCheckpoint {
	return {
		kind: "stage",
		workflowId: runId,
		checkpointId,
		name: `child-stage-${suffix}`,
		replayKey,
		output: "unsafe-cached-stage",
		completedAt: 2,
		topology: {
			version: 1,
			stageId: `child-stage-${suffix}`,
			parentIds: [],
			sourceOrder: 0,
			status: "completed",
			run: childRun(runId),
		},
	};
}

function toolRecord(runId: string, checkpointId: string, argsHash: string, suffix = "unsafe"): DurableCheckpoint {
	return {
		kind: "tool",
		workflowId: runId,
		checkpointId,
		name: `child-tool-${suffix}`,
		argsHash,
		output: "unsafe-cached-tool",
		completedAt: 2,
	};
}

function uiRecord(runId: string, checkpointId: string, promptHash: string, suffix = "unsafe"): DurableCheckpoint {
	return {
		kind: "ui",
		workflowId: runId,
		checkpointId,
		promptKind: "input",
		message: `child-ui-${suffix}`,
		promptHash,
		response: "unsafe-cached-ui",
		completedAt: 2,
	};
}

function testUi(onInput: () => void): WorkflowUIContext {
	return {
		async input() {
			onInput();
			return "live-ui";
		},
		async confirm() {
			throw new Error("unused");
		},
		async select<T extends string>(_message: string, options: readonly T[]) {
			return options[0]!;
		},
		async editor() {
			throw new Error("unused");
		},
		async custom<T>(): Promise<T> {
			throw new Error("unused");
		},
	};
}

async function runUnsafeCase(caseName: string, records: UnsafeRecordFactory) {
	const runId = `round2-identity-${caseName}`;
	const sdk = createMockSdk();
	seedMockWorkflow(sdk, { workflowId: runId, name: PARENT, status: "PENDING", createdAt: 1 });
	seedMockCheckpoint(sdk, runId, boundaryStart(runId));
	for (const checkpoint of records(runId)) seedMockCheckpoint(sdk, runId, checkpoint);
	const backend = new DbosDurableBackend(sdk, { executorId: `round2-${caseName}` });
	await backend.hydrateWorkflow(runId);
	const store = createStore();
	let childCalls = 0;
	let stageCalls = 0;
	let toolCalls = 0;
	let uiCalls = 0;
	let parentReturned = false;
	const child = workflow({
		name: CHILD,
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			childCalls += 1;
			const tool = await ctx.tool("child-tool", {}, async () => {
				toolCalls += 1;
				return "live-tool";
			});
			const ui = await ctx.ui.input("child-ui");
			const stage = await ctx.stage("child-stage").complete("live-stage");
			return { value: `${tool}:${ui}:${stage}` };
		},
	});
	const parent = workflow({
		name: PARENT,
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			const nested = await ctx.workflow(child);
			parentReturned = true;
			return { value: nested.outputs.value ?? "unsafe" };
		},
	});
	const result = await run(
		parent,
		{},
		{
			runId,
			store,
			durableBackend: backend,
			ui: testUi(() => {
				uiCalls += 1;
			}),
			adapters: {
				complete: {
					complete: async (text) => {
						stageCalls += 1;
						return text;
					},
				},
			},
		},
	);
	return { result, store, runId, childCalls, stageCalls, toolCalls, uiCalls, parentReturned };
}

const cases: ReadonlyArray<readonly [string, UnsafeRecordFactory]> = [
	["stage-lookup-only", (runId) => [stageRecord(runId, "unscoped-stage", `${SCOPE}:stage:child-stage:1`)]],
	["stage-checkpoint-only", (runId) => [stageRecord(runId, `${SCOPE}:stage-cp`, "stage:child-stage:1")]],
	["tool-lookup-only", (runId) => [toolRecord(runId, "unscoped-tool", `${SCOPE}:tool-hash`)]],
	["tool-checkpoint-only", (runId) => [toolRecord(runId, `${SCOPE}:tool-cp`, "tool-hash")]],
	["ui-lookup-only", (runId) => [uiRecord(runId, "unscoped-ui", `${SCOPE}:ui-hash`)]],
	["ui-checkpoint-only", (runId) => [uiRecord(runId, `${SCOPE}:ui-cp`, "ui-hash")]],
	[
		"stage-mixed-group",
		(runId) => [
			stageRecord(runId, `${SCOPE}:valid-stage`, `${SCOPE}:stage:mixed:1`, "valid"),
			stageRecord(runId, "unscoped-stage-mixed", `${SCOPE}:stage:mixed:1`, "mixed"),
		],
	],
	[
		"tool-mixed-group",
		(runId) => [
			toolRecord(runId, `${SCOPE}:valid-tool`, `${SCOPE}:mixed-tool`, "valid"),
			toolRecord(runId, "unscoped-tool-mixed", `${SCOPE}:mixed-tool`, "mixed"),
		],
	],
	[
		"ui-mixed-group",
		(runId) => [
			uiRecord(runId, `${SCOPE}:valid-ui`, `${SCOPE}:mixed-ui`, "valid"),
			uiRecord(runId, "unscoped-ui-mixed", `${SCOPE}:mixed-ui`, "mixed"),
		],
	],
];

test("one-sided and mixed scoped stage/tool/UI identities fail closed at the boundary", async () => {
	for (const [caseName, records] of cases) {
		const observed = await runUnsafeCase(caseName, records);
		assert.equal(observed.result.status, "failed", caseName);
		assert.match(observed.result.error ?? "", /scoped checkpoint identity is not reciprocal/, caseName);
		assert.equal(observed.childCalls, 0, caseName);
		assert.equal(observed.stageCalls, 0, caseName);
		assert.equal(observed.toolCalls, 0, caseName);
		assert.equal(observed.uiCalls, 0, caseName);
		assert.equal(observed.parentReturned, false, caseName);
		assert.equal(
			observed.store.runs().some((run) => run.parentRunId === observed.runId),
			false,
			caseName,
		);
	}
});
