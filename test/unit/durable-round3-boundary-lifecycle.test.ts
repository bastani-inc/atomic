import assert from "node:assert/strict";
import { test } from "vitest";
import {
	completedWorkflowRunSnapshots,
	listOpenableCompletedWorkflows,
	resolveCompletedWorkflow,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type {
	DurableCheckpoint,
	DurableStageRunTopology,
	DurableStageTopology,
} from "../../packages/workflows/src/durable/types.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk, seedMockCheckpoint, seedMockWorkflow } from "./durable-dbos-backend-helpers.js";

const ROOT = testRunId("round3-lifecycle-root");
const CHILD = testRunId("round3-lifecycle-child");
const KEY = "workflow:child:1";
const BOUNDARY_ID = "round3-lifecycle-boundary";

function rootRun(): DurableStageRunTopology {
	return { runId: ROOT, runName: "round3-lifecycle-parent" };
}

function childRun(): DurableStageRunTopology {
	return {
		runId: CHILD,
		runName: "round3-lifecycle-child",
		parentRunId: ROOT,
		parentStageId: BOUNDARY_ID,
		rootRunId: ROOT,
	};
}

function topology(
	event: "start" | "terminal",
	status: "running" | "completed" | "failed" | "skipped",
): DurableStageTopology {
	const identity = {
		version: 1 as const,
		replayScope: KEY,
		alias: "child",
		workflow: "child",
		invocationFingerprint: "round3-fingerprint",
		child: {
			runId: CHILD,
			runName: "round3-lifecycle-child",
			parentRunId: ROOT,
			parentStageId: BOUNDARY_ID,
			rootRunId: ROOT,
		},
	};
	if (event === "start") {
		if (status !== "running") throw new Error("test helper start status");
		return {
			version: 1,
			stageId: BOUNDARY_ID,
			parentIds: [],
			sourceOrder: 0,
			status,
			run: rootRun(),
			boundary: { ...identity, event, status },
		};
	}
	if (status === "running") throw new Error("test helper terminal status");
	return {
		version: 1,
		stageId: BOUNDARY_ID,
		parentIds: [],
		sourceOrder: 0,
		status,
		run: rootRun(),
		boundary: { ...identity, event, status },
	};
}

function childOutput(value = "completed"): WorkflowSerializableValue {
	return { workflow: "child", runId: CHILD, status: "completed", exited: false, outputs: { value } };
}

interface TerminalSeed {
	readonly status: "completed" | "failed" | "skipped";
	readonly at: number;
	readonly output?: WorkflowSerializableValue;
	readonly suffix?: string;
}

function seedLifecycle(terminals: readonly TerminalSeed[]): ReturnType<typeof createMockSdk> {
	const sdk = createMockSdk();
	seedMockWorkflow(sdk, { workflowId: ROOT, name: "round3-lifecycle-parent", status: "SUCCESS", createdAt: 1 });
	seedMockCheckpoint(sdk, ROOT, {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: "boundary-start",
		name: "workflow:child",
		replayKey: KEY,
		completedAt: 1,
		topology: topology("start", "running"),
	});
	seedMockCheckpoint(sdk, ROOT, {
		kind: "stage",
		workflowId: ROOT,
		checkpointId: `${KEY}:child-stage`,
		name: "child-stage",
		replayKey: `${KEY}:stage:child:1`,
		output: "child-stage-output",
		completedAt: 2,
		topology: {
			version: 1,
			stageId: "child-stage",
			parentIds: [],
			sourceOrder: 0,
			status: "completed",
			run: childRun(),
		},
	});
	for (const terminal of terminals) {
		seedMockCheckpoint(sdk, ROOT, {
			kind: "stage",
			workflowId: ROOT,
			checkpointId: `terminal:${terminal.status}:${terminal.suffix ?? terminal.at}`,
			name: "workflow:child",
			replayKey: KEY,
			completedAt: terminal.at,
			endedAt: terminal.at,
			topology: topology("terminal", terminal.status),
			...(terminal.output !== undefined ? { output: terminal.output } : {}),
		});
	}
	return sdk;
}

async function freshSnapshot(sdk: ReturnType<typeof createMockSdk>) {
	const backend = new DbosDurableBackend(sdk, { executorId: "round3-lifecycle-fresh" });
	await backend.hydrateWorkflow(ROOT);
	const handle = backend.getWorkflow(ROOT);
	if (handle === undefined) return { backend, runs: [] };
	const entry = backend.listCompletedWorkflows()[0] ?? {
		workflowId: handle.workflowId,
		name: handle.name,
		status: handle.status,
		completedCheckpoints: handle.completedCheckpoints,
		pendingPrompts: handle.pendingPrompts,
		createdAt: handle.createdAt,
		updatedAt: handle.updatedAt,
	};
	return { backend, runs: completedWorkflowRunSnapshots(backend, entry) };
}

test("fresh DBOS uses the latest legal atomic boundary terminal without hybrid child output or links", async () => {
	for (const [name, terminals, expectedStatus, hasChild] of [
		[
			"completed-to-failed",
			[
				{ status: "completed", at: 3, output: childOutput("old") },
				{ status: "failed", at: 4 },
			],
			"failed",
			false,
		],
		[
			"failed-to-completed",
			[
				{ status: "failed", at: 3 },
				{ status: "completed", at: 4, output: childOutput("new") },
			],
			"completed",
			true,
		],
	] as const) {
		const sdk = seedLifecycle(terminals);
		const writes = sdk.state.steps.size;
		const { backend, runs } = await freshSnapshot(sdk);
		assert.equal(listOpenableCompletedWorkflows(backend).length, 1, name);
		const boundary = runs.find((run) => run.id === ROOT)?.stages.find((stage) => stage.id === BOUNDARY_ID);
		assert.equal(boundary?.status, expectedStatus, name);
		assert.equal(boundary?.workflowChild !== undefined, hasChild, name);
		assert.equal(boundary?.workflowChildRun !== undefined, false, name);
		if (hasChild) assert.equal(boundary?.workflowChild?.outputs.value, "new", name);
		else assert.equal(boundary?.result, undefined, name);
		const store = createStore();
		const opened = openCompletedDurableWorkflow(ROOT, {
			durableBackend: backend,
			store,
			stageControlRegistry: createStageControlRegistry(),
		});
		assert.equal(opened.ok, true, name);
		assert.deepEqual(store.notices(), [], name);
		assert.equal(sdk.state.steps.size, writes, `${name}: inspection writes no repair or duplicate lifecycle`);
	}
});

test("fresh DBOS rejects impossible event/status pairs, malformed outputs, and conflicting repeats", async () => {
	const invalidCases: Array<readonly [string, ReturnType<typeof createMockSdk>]> = [];
	for (const status of ["completed", "failed", "skipped"] as const) {
		const sdk = seedLifecycle([{ status: "completed", at: 3, output: childOutput() }]);
		const encoded = [...sdk.state.steps.entries()].find(([key]) => key.endsWith(":boundary-start"))!;
		const envelope = structuredClone(encoded[1]) as Record<string, WorkflowSerializableValue>;
		const stage = envelope.topology as Record<string, WorkflowSerializableValue>;
		const boundary = stage.boundary as Record<string, WorkflowSerializableValue>;
		boundary.status = status;
		stage.status = status;
		sdk.state.steps.set(encoded[0], envelope);
		invalidCases.push([`start-${status}`, sdk]);
	}
	for (const status of ["running", "blocked", "paused"] as const) {
		const sdk = seedLifecycle([]);
		const raw = topology("terminal", "failed") as unknown as Record<string, WorkflowSerializableValue>;
		raw.status = status;
		(raw.boundary as Record<string, WorkflowSerializableValue>).status = status;
		seedMockCheckpoint(sdk, ROOT, {
			kind: "stage",
			workflowId: ROOT,
			checkpointId: `invalid-terminal-${status}`,
			name: "workflow:child",
			replayKey: KEY,
			completedAt: 3,
			topology: raw,
		} as unknown as DurableCheckpoint);
		invalidCases.push([`terminal-${status}`, sdk]);
	}
	for (const [name, output] of [
		["null-output", null],
		["array-output", []],
	] as const) {
		invalidCases.push([name, seedLifecycle([{ status: "completed", at: 3, output }])]);
	}
	invalidCases.push([
		"conflicting-repeat",
		seedLifecycle([
			{ status: "failed", at: 3, suffix: "one" },
			{ status: "failed", at: 4, suffix: "two" },
		]),
	]);

	for (const [name, sdk] of invalidCases) {
		const writes = sdk.state.steps.size;
		const { backend, runs } = await freshSnapshot(sdk).catch((error: unknown) => {
			throw new Error(`${name}: fresh hydration failed`, { cause: error });
		});
		assert.deepEqual(runs, [], name);
		assert.deepEqual(listOpenableCompletedWorkflows(backend), [], name);
		assert.ok(["stale", "not_found"].includes(resolveCompletedWorkflow(ROOT, backend).kind), name);
		assert.equal(sdk.state.steps.size, writes, `${name}: validation never repairs persisted lifecycle`);
	}
});
