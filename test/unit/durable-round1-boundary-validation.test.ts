import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableStageRunTopology, DurableStageTopology } from "../../packages/workflows/src/durable/types.js";
import { parseWorkflowChildResult } from "../../packages/workflows/src/durable/workflow-child-result.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { createMockSdk, seedMockCheckpoint, seedMockWorkflow } from "./durable-dbos-backend-helpers.js";

const CHILD_NAME = "round1-validation-child";
const PARENT_NAME = "round1-validation-parent";
const REPLAY_KEY = `workflow:workflow:${CHILD_NAME}:1`;

interface SeededBoundaryOptions {
	readonly output?: WorkflowSerializableValue;
	readonly terminalTopology?: (topology: DurableStageTopology) => DurableStageTopology;
	readonly terminalName?: string;
	readonly terminalReplayKey?: string;
	readonly duplicateTerminal?: boolean;
	readonly childRuns?: readonly DurableStageRunTopology[];
}

function rootTopology(runId: string): DurableStageRunTopology {
	return { runId, runName: PARENT_NAME };
}

function childTopology(runId: string, childRunId: string): DurableStageRunTopology {
	return {
		runId: childRunId,
		runName: CHILD_NAME,
		parentRunId: runId,
		parentStageId: "boundary-id",
		rootRunId: runId,
	};
}

function boundaryTopology(runId: string, childRunId: string, event: "start" | "terminal"): DurableStageTopology {
	const child = {
		runId: childRunId,
		runName: CHILD_NAME,
		parentRunId: runId,
		parentStageId: "boundary-id",
		rootRunId: runId,
	};
	const identity = {
		version: 1 as const,
		replayScope: REPLAY_KEY,
		alias: CHILD_NAME,
		workflow: CHILD_NAME,
		child,
	};
	return event === "start"
		? {
				version: 1,
				stageId: "boundary-id",
				parentIds: ["source-id"],
				sourceOrder: 1,
				status: "running",
				run: rootTopology(runId),
				boundary: { ...identity, event: "start", status: "running" },
			}
		: {
				version: 1,
				stageId: "boundary-id",
				parentIds: ["source-id"],
				sourceOrder: 1,
				status: "completed",
				run: rootTopology(runId),
				boundary: { ...identity, event: "terminal", status: "completed" },
			};
}

async function runSeededBoundary(caseName: string, options: SeededBoundaryOptions = {}) {
	const runId = `round1-${caseName}`;
	const childRunId = `${runId}-child`;
	const sdk = createMockSdk();
	seedMockWorkflow(sdk, { workflowId: runId, name: PARENT_NAME, status: "PENDING", createdAt: 1 });
	seedMockCheckpoint(sdk, runId, {
		kind: "stage",
		workflowId: runId,
		checkpointId: "stage:source",
		name: "source",
		replayKey: "stage:source:1",
		output: "source",
		completedAt: 1,
		topology: {
			version: 1,
			stageId: "source-id",
			parentIds: [],
			sourceOrder: 0,
			status: "completed",
			run: rootTopology(runId),
		},
	});
	seedMockCheckpoint(sdk, runId, {
		kind: "stage",
		workflowId: runId,
		checkpointId: `boundary-start:${REPLAY_KEY}`,
		name: `workflow:${CHILD_NAME}`,
		replayKey: REPLAY_KEY,
		completedAt: 2,
		topology: boundaryTopology(runId, childRunId, "start"),
	});
	const childRuns = options.childRuns ?? [childTopology(runId, childRunId)];
	for (const [index, childRun] of childRuns.entries()) {
		seedMockCheckpoint(sdk, runId, {
			kind: "stage",
			workflowId: runId,
			checkpointId: `${REPLAY_KEY}:child-stage:${index}`,
			name: "child-stage",
			replayKey: `${REPLAY_KEY}:stage:child-stage:1`,
			output: index === 0 ? "cached-child-output" : "conflicting-child-output",
			completedAt: 3 + index,
			topology: {
				version: 1,
				stageId: "child-stage-id",
				parentIds: [],
				sourceOrder: 0,
				status: "completed",
				run: childRun,
			},
		});
	}
	const validOutput = {
		workflow: CHILD_NAME,
		runId: childRunId,
		status: "completed",
		exited: false,
		outputs: { value: "cached-boundary" },
	} as const;
	const terminalTopology =
		options.terminalTopology?.(boundaryTopology(runId, childRunId, "terminal")) ??
		boundaryTopology(runId, childRunId, "terminal");
	seedMockCheckpoint(sdk, runId, {
		kind: "stage",
		workflowId: runId,
		checkpointId: `boundary-terminal:${REPLAY_KEY}:completed`,
		name: options.terminalName ?? `workflow:${CHILD_NAME}`,
		replayKey: options.terminalReplayKey ?? REPLAY_KEY,
		output: options.output ?? validOutput,
		result: "completed",
		startedAt: 1,
		endedAt: 5,
		completedAt: 5,
		topology: terminalTopology,
	});
	if (options.duplicateTerminal === true) {
		seedMockCheckpoint(sdk, runId, {
			kind: "stage",
			workflowId: runId,
			checkpointId: `boundary-terminal:${REPLAY_KEY}:duplicate`,
			name: options.terminalName ?? `workflow:${CHILD_NAME}`,
			replayKey: options.terminalReplayKey ?? REPLAY_KEY,
			output: options.output ?? validOutput,
			result: "completed",
			startedAt: 1,
			endedAt: 6,
			completedAt: 6,
			topology: terminalTopology,
		});
	}

	const backend = new DbosDurableBackend(sdk, { executorId: `fresh-${caseName}` });
	await backend.hydrateWorkflow(runId);
	const store = createStore();
	let childCalls = 0;
	let parentReceivedCachedResult = false;
	const child = workflow({
		name: CHILD_NAME,
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			childCalls += 1;
			return { value: await ctx.stage("child-stage").complete("live-child-output") };
		},
	});
	const parent = workflow({
		name: PARENT_NAME,
		description: "",
		inputs: {},
		outputs: { value: Type.String() },
		run: async (ctx) => {
			await ctx.stage("source").complete("live-source");
			await ctx.workflow(child);
			parentReceivedCachedResult = true;
			return { value: "received" };
		},
	});
	const result = await run(
		parent,
		{},
		{
			runId,
			store,
			durableBackend: backend,
			adapters: { complete: { complete: async (text) => text } },
		},
	);
	return { result, store, childCalls, parentReceivedCachedResult };
}

test("WorkflowChildResult parser accepts only the exact completed/exited discriminated union", () => {
	const identity = { workflow: "child", runId: "child-run", outputs: {} } as const;
	assert.ok(parseWorkflowChildResult({ ...identity, status: "completed", exited: false }));
	for (const status of ["completed", "skipped", "cancelled", "blocked"] as const) {
		assert.ok(parseWorkflowChildResult({ ...identity, status, exited: true, exitReason: "reason" }), status);
	}
	for (const malformed of [
		{ ...identity, status: "failed", exited: true },
		{ ...identity, status: "skipped", exited: false },
		{ ...identity, status: "completed", exited: false, exitReason: "not-allowed" },
	] as const)
		assert.equal(parseWorkflowChildResult(malformed), undefined);
	for (const [workflow, runId] of [
		["", ""],
		["  workflow:\nverbatim  ", "run::id/with spaces"],
		["工作流", "🧵"],
	] as const) {
		const value = { workflow, runId, outputs: {}, status: "completed", exited: false } as const;
		assert.equal(parseWorkflowChildResult(value), value, `${JSON.stringify(workflow)} / ${JSON.stringify(runId)}`);
	}
	const exoticOutputs = Object.create({ inherited: true }) as Record<string, WorkflowSerializableValue>;
	assert.equal(
		parseWorkflowChildResult({ ...identity, status: "completed", exited: false, outputs: exoticOutputs }),
		undefined,
	);
});

test("malformed cached WorkflowChildResult records fail closed before attach or execution", async () => {
	const malformed: readonly WorkflowSerializableValue[] = [
		{ workflow: CHILD_NAME, runId: "ignored", status: "completed", outputs: { value: "bad" } },
		{ workflow: CHILD_NAME, runId: "ignored", status: "failed", exited: false, outputs: { value: "bad" } },
		{ workflow: CHILD_NAME, runId: "ignored", status: "failed", exited: true, outputs: { value: "bad" } },
		{ workflow: CHILD_NAME, runId: "ignored", status: "completed", exited: false, outputs: null },
		{ workflow: CHILD_NAME, runId: "ignored", status: "completed", exited: false, outputs: [] },
		{ workflow: CHILD_NAME, runId: "ignored", status: "completed", exited: true, outputs: {}, exitReason: 42 },
	];
	for (const [index, value] of malformed.entries()) {
		const caseName = `malformed-${index}`;
		const runId = `round1-${caseName}`;
		const output =
			typeof value === "object" && value !== null && !Array.isArray(value)
				? { ...value, runId: `${runId}-child` }
				: value;
		const observed = await runSeededBoundary(caseName, { output });
		assert.equal(observed.result.status, "failed", caseName);
		assert.equal(observed.childCalls, 0, caseName);
		assert.equal(observed.parentReceivedCachedResult, false, caseName);
		assert.equal(
			observed.store.runs().some((candidate) => candidate.parentRunId === runId),
			false,
			caseName,
		);
	}
});

test("every reciprocal child ownership field and mixed replay-key group is validated", async () => {
	const caseNames = [
		"missing-parent",
		"missing-stage",
		"missing-root",
		"wrong-parent",
		"wrong-stage",
		"wrong-root",
		"mixed",
	] as const;
	for (const caseName of caseNames) {
		const runId = `round1-ownership-${caseName}`;
		const childRunId = `${runId}-child`;
		const valid = childTopology(runId, childRunId);
		let childRuns: readonly DurableStageRunTopology[];
		if (caseName === "missing-parent") {
			const { parentRunId: _parentRunId, ...missing } = valid;
			childRuns = [missing];
		} else if (caseName === "missing-stage") {
			const { parentStageId: _parentStageId, ...missing } = valid;
			childRuns = [missing];
		} else if (caseName === "missing-root") {
			const { rootRunId: _rootRunId, ...missing } = valid;
			childRuns = [missing];
		} else if (caseName === "wrong-parent") childRuns = [{ ...valid, parentRunId: "wrong-parent" }];
		else if (caseName === "wrong-stage") childRuns = [{ ...valid, parentStageId: "wrong-stage" }];
		else if (caseName === "wrong-root") childRuns = [{ ...valid, rootRunId: "wrong-root" }];
		else childRuns = [valid, { ...valid, parentRunId: "wrong-parent" }];
		const observed = await runSeededBoundary(`ownership-${caseName}`, { childRuns });
		assert.equal(observed.result.status, "failed", caseName);
		assert.equal(observed.childCalls, 0, caseName);
		assert.equal(observed.parentReceivedCachedResult, false, caseName);
	}
});

test("conflicting repeated boundary terminals fail closed instead of latest-wins merge", async () => {
	const observed = await runSeededBoundary("duplicate-terminal", { duplicateTerminal: true });
	assert.equal(observed.result.status, "failed");
	assert.equal(observed.childCalls, 0);
	assert.equal(observed.parentReceivedCachedResult, false);
});

test("immutable boundary terminal drift fails before cached output reaches the parent", async () => {
	const drifts: ReadonlyArray<readonly [string, (topology: DurableStageTopology) => DurableStageTopology]> = [
		["parents", (topology) => ({ ...topology, parentIds: [] })],
		["order", (topology) => ({ ...topology, sourceOrder: 99 })],
		["run-id", (topology) => ({ ...topology, run: { ...topology.run!, runId: "drifted" } })],
		["run-name", (topology) => ({ ...topology, run: { ...topology.run!, runName: "drifted" } })],
		["run-parent", (topology) => ({ ...topology, run: { ...topology.run!, parentRunId: "drifted" } })],
		["run-parent-stage", (topology) => ({ ...topology, run: { ...topology.run!, parentStageId: "drifted" } })],
		["run-root", (topology) => ({ ...topology, run: { ...topology.run!, rootRunId: "drifted" } })],
		["scope", (topology) => ({ ...topology, boundary: { ...topology.boundary!, replayScope: "drifted" } })],
		["boundary-id", (topology) => ({ ...topology, stageId: "drifted" })],
		["alias", (topology) => ({ ...topology, boundary: { ...topology.boundary!, alias: "drifted" } })],
		["workflow", (topology) => ({ ...topology, boundary: { ...topology.boundary!, workflow: "drifted" } })],
		[
			"child-id",
			(topology) => ({
				...topology,
				boundary: { ...topology.boundary!, child: { ...topology.boundary!.child, runId: "drifted" } },
			}),
		],
		[
			"child-name",
			(topology) => ({
				...topology,
				boundary: { ...topology.boundary!, child: { ...topology.boundary!.child, runName: "drifted" } },
			}),
		],
		[
			"child-parent-run",
			(topology) => ({
				...topology,
				boundary: { ...topology.boundary!, child: { ...topology.boundary!.child, parentRunId: "drifted" } },
			}),
		],
		[
			"child-parent-stage",
			(topology) => ({
				...topology,
				boundary: { ...topology.boundary!, child: { ...topology.boundary!.child, parentStageId: "drifted" } },
			}),
		],
		[
			"child-root",
			(topology) => ({
				...topology,
				boundary: { ...topology.boundary!, child: { ...topology.boundary!.child, rootRunId: "drifted" } },
			}),
		],
	];
	for (const [name, terminalTopology] of drifts) {
		const observed = await runSeededBoundary(`drift-${name}`, { terminalTopology });
		assert.equal(observed.result.status, "failed", name);
		assert.equal(observed.childCalls, 0, name);
		assert.equal(observed.parentReceivedCachedResult, false, name);
	}
	for (const [name, options] of [
		["boundary-name", { terminalName: "workflow:drifted" }],
		["replay-key", { terminalReplayKey: "workflow:drifted:1" }],
	] as const) {
		const observed = await runSeededBoundary(`drift-${name}`, options);
		assert.equal(observed.result.status, "failed", name);
		assert.equal(observed.childCalls, 0, name);
		assert.equal(observed.parentReceivedCachedResult, false, name);
	}
});
