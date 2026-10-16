import assert from "node:assert/strict";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	DurableNestedTopologyError,
	validateDurableCompletedBoundary,
} from "../../packages/workflows/src/durable/boundary-topology.js";
import { createDurableChildWorkflowPrimitive } from "../../packages/workflows/src/durable/child-primitive.js";
import { recordCachedStageIntoStore } from "../../packages/workflows/src/durable/stage-primitive.js";
import { groupByDurableStageKey } from "../../packages/workflows/src/durable/stage-topology-validation.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { queueStageMessage } from "../../packages/workflows/src/shared/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingStageMessageInput } from "../../packages/workflows/src/shared/store-types.js";
import { MemoryJournalBackend as InMemoryDurableBackend } from "../helpers/workflow-journal.js";

const runId = "current-replay-root";
const childResult = { workflow: "child", runId: "child-run", status: "completed", exited: false, outputs: {} } as const;

function checkpoint(replayKey: string): DurableStageCheckpoint {
	return {
		kind: "stage",
		workflowId: runId,
		checkpointId: replayKey,
		name: "workflow:child",
		replayKey,
		output: childResult,
		completedAt: 2,
		topology: { version: 1, stageId: "boundary", parentIds: [], run: { runId, runName: "root" } },
	};
}

test("child invocation always uses the supplied current replay key despite an old scope", async () => {
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: runId, name: "root", inputs: {}, status: "running", createdAt: 1 });
	const child = workflow({ name: "child", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
	backend.recordCheckpoint(checkpoint(`workflow:workflow:${child.normalizedName}:1`));
	let scope: string | undefined;
	const invoke = createDurableChildWorkflowPrimitive({
		workflowId: runId,
		rootWorkflowId: runId,
		backend,
		nextReplayKey: () => "workflow:child:fingerprint:1",
		recordCachedStage: () => assert.fail("must not replay another scope"),
		runTopology: { runId, runName: "root" },
		setChildDurableInvocation: (invocation) => {
			scope = invocation.scope.scopePrefix;
		},
		workflow: async () => childResult as never,
	});
	assert.equal(await invoke(child), childResult);
	assert.equal(scope, "workflow:child:fingerprint:1");
});

test("cached child projection requires the current completed result discriminator", () => {
	const store = createStore();
	store.recordRunStart({
		id: runId,
		name: "root",
		inputs: {},
		status: "running",
		stages: [],
		toolNodes: [],
		startedAt: 1,
	});
	const { exited: _exited, ...oldOutput } = childResult;
	recordCachedStageIntoStore(store, runId, "old", "old", oldOutput, new Map());
	recordCachedStageIntoStore(store, runId, "current", "current", childResult, new Map());
	const stages = store.runs()[0]!.stages;
	assert.equal(stages[0]!.workflowChild, undefined);
	assert.deepEqual(stages[1]!.workflowChild, { alias: "child", ...childResult });
});

test("completed boundaries without lifecycle topology are not replayable", () => {
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: runId, name: "root", inputs: {}, status: "running", createdAt: 1 });
	const replayKey = "workflow:child:fingerprint:1";
	const cached = { ...checkpoint(replayKey), output: childResult };
	backend.recordCheckpoint(cached);
	backend.recordCheckpoint({
		...checkpoint(`${replayKey}:stage:leaf:1`),
		checkpointId: `${replayKey}:leaf`,
		topology: {
			version: 1,
			stageId: "leaf",
			parentIds: [],
			run: {
				runId: childResult.runId,
				runName: "child",
				parentRunId: runId,
				parentStageId: "boundary",
				rootRunId: runId,
			},
		},
	});
	assert.throws(
		() =>
			validateDurableCompletedBoundary({
				workflowId: runId,
				rootWorkflowId: runId,
				backend,
				replayKey,
				boundaryName: "workflow:child",
				alias: "child",
				workflow: "child",
				childRunName: "child",
				invocationFingerprint: "fingerprint",
				runTopology: { runId, runName: "root" },
				checkpoint: cached,
				output: childResult,
			}),
		(error: Error) => {
			assert.ok(error instanceof DurableNestedTopologyError);
			assert.equal(error.reason, `completed boundary lacks boundary topology at ${replayKey}`);
			return true;
		},
	);
});

test("prompt groups use only their own persisted occurrence identity", () => {
	const base = checkpoint("prompt:select:1");
	const current = { ...base, checkpointId: "current", topology: { ...base.topology!, occurrenceKey: "prompt-1" } };
	const groups = [...groupByDurableStageKey([base, current]).values()];
	assert.deepEqual(groups, [[base], [current]]);
});

test("delivery admission follows persisted order rather than collection position or sender time", () => {
	const input = (id: string): PendingStageMessageInput => ({
		runId,
		stageKey: "stage",
		from: { id: "sender", name: " sender " },
		queuedAt: " raw queued time ",
		message: { id, timestamp: -1, content: { text: "  raw\ntext  " } },
	});
	const first = queueStageMessage([], input("first"), undefined, undefined);
	assert.ok(first.ok);
	const prior = { ...first.entry, admissionOrder: 20 };
	const nextInput = input("next");
	const next = queueStageMessage([prior], nextInput, undefined, undefined);
	assert.ok(next.ok);
	assert.equal(next.entry.admissionOrder, 21);
	assert.equal(next.entry.message, nextInput.message);
	assert.deepEqual(next.messages, [prior, next.entry]);
	const duplicate = queueStageMessage(next.messages, nextInput, undefined, undefined);
	assert.ok(duplicate.ok);
	assert.equal(duplicate.entry, next.entry);
	assert.equal(duplicate.messages, next.messages);
});
