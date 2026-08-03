import assert from "node:assert/strict";
import { test } from "vitest";
import {
	completedWorkflowRunSnapshots,
	listOpenableCompletedWorkflows,
	resolveCompletedWorkflow,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import type { DurableStageRunTopology, DurableStageTopology } from "../../packages/workflows/src/durable/types.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { testRunId } from "../helpers/run-id.js";
import { createMockSdk, seedMockCheckpoint, seedMockWorkflow } from "./durable-dbos-backend-helpers.js";

function rootRun(rootId: string): DurableStageRunTopology {
	return { runId: rootId, runName: "catalog-root" };
}

function childRun(rootId: string, childId: string, boundaryId: string): DurableStageRunTopology {
	return {
		runId: childId,
		runName: "catalog-child",
		parentRunId: rootId,
		parentStageId: boundaryId,
		rootRunId: rootId,
	};
}

function boundaryTopology(input: {
	readonly rootId: string;
	readonly childId: string;
	readonly boundaryId: string;
	readonly key: string;
	readonly order: number;
	readonly event: "start" | "terminal";
}): DurableStageTopology {
	const identity = {
		version: 1 as const,
		replayScope: input.key,
		alias: "catalog-child",
		workflow: "catalog-child",
		invocationFingerprint: `fingerprint-${input.key}`,
		child: {
			runId: input.childId,
			runName: "catalog-child",
			parentRunId: input.rootId,
			parentStageId: input.boundaryId,
			rootRunId: input.rootId,
		},
	};
	return input.event === "start"
		? {
				version: 1,
				stageId: input.boundaryId,
				parentIds: [],
				sourceOrder: input.order,
				status: "running",
				run: rootRun(input.rootId),
				boundary: { ...identity, event: "start", status: "running" },
			}
		: {
				version: 1,
				stageId: input.boundaryId,
				parentIds: [],
				sourceOrder: input.order,
				status: "completed",
				run: rootRun(input.rootId),
				boundary: { ...identity, event: "terminal", status: "completed" },
			};
}

function seedBoundary(input: {
	readonly sdk: ReturnType<typeof createMockSdk>;
	readonly rootId: string;
	readonly key: string;
	readonly boundaryId: string;
	readonly childId: string;
	readonly order: number;
}): void {
	const { sdk, rootId, key, boundaryId, childId, order } = input;
	seedMockCheckpoint(sdk, rootId, {
		kind: "stage",
		workflowId: rootId,
		checkpointId: `start:${key}`,
		name: "workflow:catalog-child",
		replayKey: key,
		completedAt: 2 + order,
		topology: boundaryTopology({ rootId, childId, boundaryId, key, order, event: "start" }),
	});
	seedMockCheckpoint(sdk, rootId, {
		kind: "stage",
		workflowId: rootId,
		checkpointId: `${key}:child-stage`,
		name: "child-stage",
		replayKey: `${key}:stage:work:1`,
		output: "child-output",
		completedAt: 3 + order,
		topology: {
			version: 1,
			stageId: `child-stage-${order}`,
			parentIds: [],
			sourceOrder: 0,
			status: "completed",
			run: childRun(rootId, childId, boundaryId),
		},
	});
	seedMockCheckpoint(sdk, rootId, {
		kind: "stage",
		workflowId: rootId,
		checkpointId: `terminal:${key}`,
		name: "workflow:catalog-child",
		replayKey: key,
		completedAt: 4 + order,
		endedAt: 4 + order,
		output: {
			workflow: "catalog-child",
			runId: childId,
			status: "completed",
			exited: false,
			outputs: { value: `child-${order}` },
		},
		topology: boundaryTopology({ rootId, childId, boundaryId, key, order, event: "terminal" }),
	});
}

function completedSdk(rootId: string): ReturnType<typeof createMockSdk> {
	const sdk = createMockSdk();
	seedMockWorkflow(sdk, { workflowId: rootId, name: "catalog-root", status: "SUCCESS", createdAt: 1 });
	return sdk;
}

async function assertHidden(name: string, rootId: string, sdk: ReturnType<typeof createMockSdk>): Promise<void> {
	const writes = sdk.state.steps.size;
	const backend = new DbosDurableBackend(sdk, { executorId: `round3-catalog-${name}` });
	await backend.hydrateWorkflow(rootId);
	assert.deepEqual(listOpenableCompletedWorkflows(backend), [], name);
	const resolution = resolveCompletedWorkflow(rootId, backend);
	assert.ok(resolution.kind === "stale" || resolution.kind === "not_found", name);
	const entry = backend.listCompletedWorkflows()[0];
	if (entry !== undefined) assert.deepEqual(completedWorkflowRunSnapshots(backend, entry), [], name);
	const store = createStore();
	const registry = createStageControlRegistry();
	const opened = openCompletedDurableWorkflow(rootId, {
		durableBackend: backend,
		store,
		stageControlRegistry: registry,
	});
	assert.equal(opened.ok, false, name);
	assert.deepEqual(store.runs(), [], name);
	assert.equal(registry.run(rootId).stages().length, 0, name);
	assert.equal(sdk.state.steps.size, writes, `${name}: catalog validation performs no repair writes`);
}

test("fresh DBOS completed catalog rejects same-key output poisoning before merge", async () => {
	const rootId = testRunId("round3-catalog-poison");
	const sdk = completedSdk(rootId);
	const key = "workflow:catalog-child:1";
	seedBoundary({ sdk, rootId, key, boundaryId: "boundary", childId: testRunId("owned-child"), order: 0 });
	seedMockCheckpoint(sdk, rootId, {
		kind: "stage",
		workflowId: rootId,
		checkpointId: "poison",
		name: "ordinary",
		replayKey: key,
		completedAt: 9,
		output: {
			workflow: "catalog-child",
			runId: testRunId("poison-child"),
			status: "completed",
			exited: false,
			outputs: { value: "poison" },
		},
		topology: {
			version: 1,
			stageId: "poison-stage",
			parentIds: [],
			sourceOrder: 9,
			status: "completed",
			run: rootRun(rootId),
		},
	});
	await assertHidden("poison", rootId, sdk);
});

test("fresh DBOS completed catalog hides legacy child output without a reciprocal child group", async () => {
	const rootId = testRunId("round3-catalog-missing-legacy-child");
	const sdk = completedSdk(rootId);
	seedMockCheckpoint(sdk, rootId, {
		kind: "stage",
		workflowId: rootId,
		checkpointId: "legacy-boundary",
		name: "workflow:catalog-child",
		replayKey: "workflow:catalog-child:1",
		completedAt: 2,
		output: {
			workflow: "catalog-child",
			runId: testRunId("missing-child"),
			status: "completed",
			exited: false,
			outputs: { value: "verbatim" },
		},
		topology: {
			version: 1,
			stageId: "legacy-boundary",
			parentIds: [],
			sourceOrder: 0,
			status: "completed",
			run: rootRun(rootId),
		},
	});
	await assertHidden("missing-legacy-child", rootId, sdk);
});

test("fresh DBOS completed catalog rejects one prompt occurrence bound to different replay keys", async () => {
	const rootId = testRunId("round3-catalog-prompt-occurrence-poison");
	const sdk = completedSdk(rootId);
	for (const [index, replayKey] of ["prompt:input:first", "prompt:input:SECOND-DIFFERENT"].entries()) {
		seedMockCheckpoint(sdk, rootId, {
			kind: "stage",
			workflowId: rootId,
			checkpointId: `prompt-${index}`,
			name: "input",
			replayKey,
			completedAt: 2 + index,
			startedAt: 1,
			endedAt: 2 + index,
			topology: {
				version: 1,
				stageId: "same-prompt-stage",
				parentIds: [],
				sourceOrder: 0,
				occurrenceKey: "shared-prompt-occurrence",
				status: "completed",
				run: rootRun(rootId),
			},
		});
	}
	await assertHidden("prompt-occurrence-poison", rootId, sdk);
});

test("fresh DBOS completed catalog rejects replay-key stage identity drift", async () => {
	const rootId = testRunId("round3-catalog-stage-alias");
	const sdk = completedSdk(rootId);
	const replayKey = "stage:work:1";
	seedMockCheckpoint(sdk, rootId, {
		kind: "stage",
		workflowId: rootId,
		checkpointId: "session",
		name: "work",
		replayKey,
		sessionId: "session",
		sessionFile: "/missing",
		startedAt: 1,
		completedAt: 2,
		topology: {
			version: 1,
			stageId: "original-id",
			parentIds: [],
			sourceOrder: 0,
			status: "running",
			run: rootRun(rootId),
		},
	});
	seedMockCheckpoint(sdk, rootId, {
		kind: "stage",
		workflowId: rootId,
		checkpointId: "output",
		name: "renamed-work",
		replayKey,
		output: "verbatim",
		endedAt: 3,
		completedAt: 3,
		topology: {
			version: 1,
			stageId: "drifted-id",
			parentIds: [],
			sourceOrder: 9,
			status: "completed",
			run: rootRun(rootId),
		},
	});
	await assertHidden("stage-alias", rootId, sdk);
});

test("fresh DBOS completed catalog rejects empty and aliased owning-run boundary ids", async () => {
	const emptyRoot = testRunId("round3-catalog-empty-boundary");
	const emptySdk = completedSdk(emptyRoot);
	seedBoundary({
		sdk: emptySdk,
		rootId: emptyRoot,
		key: "workflow:catalog-child:1",
		boundaryId: "",
		childId: testRunId("empty-child"),
		order: 0,
	});
	await assertHidden("empty-boundary", emptyRoot, emptySdk);

	const duplicateRoot = testRunId("round3-catalog-duplicate-boundary");
	const duplicateSdk = completedSdk(duplicateRoot);
	seedBoundary({
		sdk: duplicateSdk,
		rootId: duplicateRoot,
		key: "workflow:catalog-child:1",
		boundaryId: "aliased-boundary",
		childId: testRunId("child-one"),
		order: 0,
	});
	seedBoundary({
		sdk: duplicateSdk,
		rootId: duplicateRoot,
		key: "workflow:catalog-child:2",
		boundaryId: "aliased-boundary",
		childId: testRunId("child-two"),
		order: 1,
	});
	await assertHidden("duplicate-boundary", duplicateRoot, duplicateSdk);
});
