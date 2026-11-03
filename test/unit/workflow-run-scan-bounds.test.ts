import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { bindRunDurableBackend } from "../../packages/workflows/src/durable/run-owner-backend.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { createToolNodeLifecycle } from "../../packages/workflows/src/engine/run-tool-node-lifecycle.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { countRunListScans, holdFinishedRuns } from "../helpers/finished-runs.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const ROOT = "4ac72924-c452-4e5f-9e63-2435722109f7";
const CHILD = "5bd82a35-c563-4f60-9a74-3546832210a8";
const GROUP = `workflow:${ROOT}`;
const EVENT = "atomic:workflow-pending-stage-message";
const SENDER = { id: "sender", name: "sender", group: GROUP };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function stage(id: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return {
		id,
		name: id,
		status: "pending",
		parentIds: [],
		toolEvents: [],
		replayKey: `stage:${id}:1`,
		pendingStageDeliveryAvailable: true,
		...overrides,
	};
}

function run(id: string, overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return { id, name: id, inputs: {}, status: "running", stages: [], toolNodes: [], startedAt: 1, ...overrides };
}

type Completion = Promise<{ readonly outcome: string; readonly position?: number }>;

/** A store holding thousands of finished runs, with the root and a nested child recorded after them. */
async function bridgeHost() {
	const backend = await createMemoryTestBackend();
	cleanups.push(() => backend.close());
	await backend.commitWorkflowRegistration({
		workflowId: ROOT,
		name: ROOT,
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const real = createStore();
	// Without store observers the bridge's own invalidation-driven route announcements cannot run mid-measurement.
	const store: Store = Object.assign(Object.create(real) as Store, { subscribeInvalidation: () => () => {} });
	bindStoreDurableBackend(store, backend);
	const finished = holdFinishedRuns(real, 5_000);
	const root = run(ROOT, {
		rootRunId: ROOT,
		possibleStages: [],
		stages: [
			stage("reviewer"),
			stage("live", { status: "running", sessionId: "session-live" }),
			stage("child-boundary", {
				status: "running",
				pendingStageDeliveryAvailable: false,
				workflowChildRun: { alias: "child", workflow: "child", runId: CHILD },
			}),
		],
	});
	bindRunDurableBackend(root, backend);
	real.recordRunStart(root);
	real.recordRunStart(
		run(CHILD, {
			parentRunId: ROOT,
			parentStageId: "child-boundary",
			rootRunId: ROOT,
			stages: [stage("nested-reviewer")],
		}),
	);
	const listeners: Array<(payload: unknown) => void> = [];
	const pi = {
		events: {
			emit() {},
			on(name: string, listener: (payload: unknown) => void) {
				if (name === EVENT) listeners.push(listener);
				return () => {};
			},
		},
	};
	cleanups.push(registerPendingStageIntercomBridge(pi, store));
	finished.reads = 0;
	const send = async (target: string, runId: string, id: string) => {
		const payload: { handled: boolean; completion?: Completion; [key: string]: unknown } = {
			handled: false,
			runId,
			target,
			from: SENDER,
			message: { id, timestamp: 1, content: { text: id } },
		};
		for (const listener of listeners) listener(payload);
		return { handled: payload.handled, outcome: await payload.completion };
	};
	return { real, finished, send };
}

test("routing a message to a pending, a nested or a live stage reads none of the finished runs the store holds (#4190)", async () => {
	const host = await bridgeHost();
	const pending = await host.send(`${GROUP}/reviewer`, ROOT, "pending-4190");
	assert.deepEqual([pending.handled, pending.outcome], [true, { outcome: "queued", position: 1 }]);
	const nested = await host.send(`${GROUP}/${CHILD}/nested-reviewer`, CHILD, "nested-4190");
	assert.deepEqual([nested.handled, nested.outcome], [true, { outcome: "queued", position: 1 }]);
	const live = await host.send(`${GROUP}/live`, ROOT, "live-4190");
	assert.deepEqual([live.handled, live.outcome?.outcome], [true, "forward"]);
	assert.equal(host.finished.reads, 0, `routing three messages read finished runs ${host.finished.reads} times`);
	assert.equal(host.real.pendingStageMessagesFor(ROOT, "reviewer")[0]?.message.id, "pending-4190");
	assert.equal(host.real.pendingStageMessagesFor(CHILD, "nested-reviewer")[0]?.message.id, "nested-4190");
});

function toolNode(id: string): ToolNodeSnapshot {
	return {
		kind: "tool",
		id,
		name: "preflight",
		argsHash: "preflight-hash",
		ordinal: 1,
		parentIds: [],
		status: "running",
		attachable: false,
	};
}

test("tool node events find their run without scanning the run list, and only the run the store holds records them (#4190)", () => {
	const real = createStore();
	holdFinishedRuns(real, 5_000);
	const owned = run("owned");
	real.recordRunStart(owned);
	const { store, scans } = countRunListScans(real);
	const lifecycle = createToolNodeLifecycle({
		store,
		tracker: new GraphFrontierTracker(),
		run: owned,
		sourceToContinuationNodeIds: new Map(),
	});
	lifecycle.onNodeStart?.(toolNode("tool-1"));
	lifecycle.onNodeRunning?.("tool-1", 5);
	lifecycle.onNodeEnd?.("tool-1", { status: "completed", endedAt: 9 });
	assert.equal(scans.reads, 0, `three tool node events scanned the run list ${scans.reads} times`);
	assert.deepEqual(
		real.run("owned")?.toolNodes.map((node) => [node.id, node.status]),
		[["tool-1", "completed"]],
	);

	real.recordRunStart(run("owned", { name: "replacement" }));
	lifecycle.onNodeStart?.(toolNode("tool-2"));
	assert.deepEqual(
		real.run("owned")?.toolNodes.map((node) => node.id),
		[],
		"a run replaced under the same id no longer takes the stale executor's tool nodes",
	);
});
