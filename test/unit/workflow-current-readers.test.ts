import assert from "node:assert/strict";
import { test } from "vitest";
import { DurableNestedTopologyError } from "../../packages/workflows/src/durable/boundary-topology.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { createWorkflowBoundaryFactory } from "../../packages/workflows/src/runs/foreground/executor-child-boundary.js";
import { createContinuationReplayIndex } from "../../packages/workflows/src/runs/foreground/executor-continuation.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import {
	expandWorkflowGraph,
	MissingWorkflowToolNodesError,
	refreshExpandedWorkflowGraph,
	sameExpandedWorkflowTopology,
} from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import {
	PendingStageMessageOrderError,
	pendingStageMessagesFor,
} from "../../packages/workflows/src/shared/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	PendingStageMessage,
	RunSnapshot,
	StageSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

function message(id: string, admissionOrder: number): PendingStageMessage {
	return {
		id,
		runId: "run",
		stageKey: "stage",
		from: { id: "sender" },
		message: { id, timestamp: 1, content: { text: "  raw\ntext  " } },
		queuedAt: "raw-time",
		admissionOrder,
		status: "queued",
	};
}

test("delivery requires persisted admission order instead of inferring collection position", () => {
	const current = message("current", 3);
	const missing = message("missing", 1);
	Reflect.deleteProperty(missing, "admissionOrder");
	assert.throws(
		() => pendingStageMessagesFor([current, missing], "run", "stage"),
		(error: Error) => {
			assert.ok(error instanceof PendingStageMessageOrderError);
			assert.equal(error.runId, "run");
			assert.equal(error.messageId, "missing");
			return true;
		},
	);
	const zero = message("zero", 0);
	assert.deepEqual(pendingStageMessagesFor([current, zero, zero], "run", "stage"), [zero, zero, current]);
	assert.equal(pendingStageMessagesFor([current], "run", "stage")[0], current);
	assert.equal(current.message.content.text, "  raw\ntext  ");
});

test("foreground sticky delivery rejects a missing order before admission", async () => {
	const rootId = "00000000-0000-4000-8000-000000000001";
	const target = `workflow:${rootId}/*`;
	const missing = {
		...message("missing-sticky", 1),
		runId: rootId,
		stageKey: target,
		sticky: true as const,
		targetPath: target,
	};
	Reflect.deleteProperty(missing, "admissionOrder");
	const activeStore = createStore();
	activeStore.recordRunStart({ ...run(), id: rootId, status: "running", pendingStageMessages: [missing] });
	const backend = await createMemoryTestBackend();
	await backend.commitWorkflowRegistration({
		workflowId: rootId,
		name: "reader",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	setDurableBackend(backend);
	try {
		const delivery = createWorkflowPendingStageDelivery(activeStore, rootId, "stage", "stage");
		await assert.rejects(
			delivery.deliverPending(() => {}),
			(error: Error) => {
				assert.ok(error instanceof PendingStageMessageOrderError);
				assert.equal(error.runId, rootId);
				assert.equal(error.messageId, missing.id);
				return true;
			},
		);
	} finally {
		setDurableBackend(undefined);
	}
});

function stage(id: string, replayKey?: string): StageSnapshot {
	return { id, name: "same display name", replayKey, status: "completed", parentIds: [], toolEvents: [] };
}

function run(stages: StageSnapshot[] = []): RunSnapshot {
	return { id: "run", name: "reader", inputs: {}, status: "failed", startedAt: 1, stages, toolNodes: [] };
}

test("continuation only replays exact persisted keys, never a source display name", () => {
	const current = stage("current", "current-key");
	const missing = stage("missing");
	const makeIndex = (sourceStage: StageSnapshot) =>
		createContinuationReplayIndex({ source: run([sourceStage]), resumeFromStageId: sourceStage.id }, new Map());
	const input = {
		displayName: current.name,
		replayKey: "different-key",
		parentIds: [],
		stageId: "new",
		kind: "stage" as const,
	};
	assert.equal(makeIndex(missing).decide(input).kind, "execute");
	assert.equal(makeIndex(current).decide(input).kind, "execute");
	const exact = makeIndex(current).decide({ ...input, replayKey: "current-key" });
	assert.equal(exact.kind, "replay");
	assert.equal(exact.source, current);
});

test("continuation child replay requires an explicit exit discriminant", () => {
	const child = {
		alias: "child",
		workflow: "child-flow",
		runId: "child-run",
		status: "completed" as const,
		outputs: { text: " raw " },
	};
	const completed = { ...stage("boundary", "child-key"), workflowChild: child };
	const makeBoundary = (sourceStage: StageSnapshot) => {
		const source = run([sourceStage]);
		const activeStore = createStore();
		const active = { ...run(), id: "active", status: "running" as const };
		activeStore.recordRunStart(active);
		return createWorkflowBoundaryFactory({
			runId: active.id,
			runSnapshot: active,
			activeStore,
			opts: {},
			tracker: new GraphFrontierTracker(),
			replayIndex: createContinuationReplayIndex({ source, resumeFromStageId: sourceStage.id }, new Map()),
			registerWorkflowExitCleanup: () => () => {},
			workflowExitSkippedReason: () => "exit",
			classifyExecutorFailure: () => {
				throw new Error("unexpected failure classification");
			},
		})(sourceStage.name, "child-key");
	};
	assert.throws(
		() => makeBoundary(completed),
		(error: Error) => {
			assert.ok(error instanceof DurableNestedTopologyError);
			assert.equal(error.reason, "continuation child result has an invalid exited/status/output discriminant");
			return true;
		},
	);
	const boundary = makeBoundary({ ...completed, workflowChild: { ...child, exited: false } });
	assert.equal(boundary.replayedChild?.exited, false);
	assert.deepEqual(boundary.replayedChild?.outputs, child.outputs);
	boundary.finalizeReplay();
});

test("graph readers distinguish explicit empty tool collections from missing collections", () => {
	const current = { runs: [run()], notices: [], version: 1 };
	const missing = structuredClone(current);
	Reflect.deleteProperty(missing.runs[0]!, "toolNodes");
	const graph = expandWorkflowGraph(current, "run");
	assert.deepEqual(graph.nodes, []);
	assert.equal(sameExpandedWorkflowTopology(current, structuredClone(current)), true);
	assert.deepEqual(refreshExpandedWorkflowGraph(graph, current)?.nodes, []);
	for (const read of [
		() => expandWorkflowGraph(missing, "run"),
		() => sameExpandedWorkflowTopology(missing, current),
		() => refreshExpandedWorkflowGraph(graph, missing),
	])
		assert.throws(read, (error: Error) => {
			assert.ok(error instanceof MissingWorkflowToolNodesError);
			assert.equal(error.runId, "run");
			return true;
		});
});
