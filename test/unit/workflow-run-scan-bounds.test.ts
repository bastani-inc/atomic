import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { bindRunDurableBackend } from "../../packages/workflows/src/durable/run-owner-backend.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { GraphFrontierTracker } from "../../packages/workflows/src/engine/graph-inference.js";
import { createToolNodeLifecycle } from "../../packages/workflows/src/engine/run-tool-node-lifecycle.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { registerReleasedStageIntercomRoutes } from "../../packages/workflows/src/extension/released-stage-intercom-route.js";
import { run as runWorkflow } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot, ToolNodeSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { countRunListScans, holdFinishedRuns } from "../helpers/finished-runs.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import {
	type AgentSession,
	type AgentSessionAdapter,
	assistantMessageWithUsage,
	makeMockSession,
} from "./stage-runner-helpers.js";

const ROOT = "4ac72924-c452-4e5f-9e63-2435722109f7";
const CHILD = "5bd82a35-c563-4f60-9a74-3546832210a8";
const GRAND = "6ce93b46-d674-4071-8b85-4657943321b9";
const OTHER = "7df04c57-e785-4182-9c96-5768a54432ca";
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

/**
 * A store holding thousands of finished runs, with the root and its nested runs recorded after them. The nested runs
 * are recorded child, grandchild, other so that store order differs from a walk down the parent links.
 */
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
	const boundary = (id: string, name: string, runId: string) =>
		stage(id, {
			name,
			status: "running",
			pendingStageDeliveryAvailable: false,
			workflowChildRun: { alias: name, workflow: name, runId },
		});
	const live = (id: string) => stage(id, { status: "running", sessionId: `session-${id}` });
	const root = run(ROOT, {
		rootRunId: ROOT,
		possibleStages: [],
		stages: [
			stage("reviewer"),
			live("live"),
			boundary("child-boundary", "child", CHILD),
			boundary("other-boundary", "other", OTHER),
		],
	});
	bindRunDurableBackend(root, backend);
	real.recordRunStart(root);
	const nested = (id: string, parentRunId: string, parentStageId: string, stages: StageSnapshot[]) =>
		run(id, { parentRunId, parentStageId, rootRunId: ROOT, stages });
	real.recordRunStart(
		nested(CHILD, ROOT, "child-boundary", [
			stage("nested-reviewer"),
			live("nested-live"),
			boundary("grand-boundary", "grand", GRAND),
		]),
	);
	real.recordRunStart(nested(GRAND, CHILD, "grand-boundary", [live("grand-live")]));
	real.recordRunStart(nested(OTHER, ROOT, "other-boundary", [live("other-live")]));
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

test("routing a message to a pending, nested or live stage reads none of the finished runs the store holds (#4190)", async () => {
	const host = await bridgeHost();
	const sent = {
		pending: await host.send(`${GROUP}/reviewer`, ROOT, "pending-4190"),
		nestedById: await host.send(`${GROUP}/${CHILD}/nested-reviewer`, CHILD, "nested-id-4190"),
		nestedByName: await host.send(`${GROUP}/child/nested-reviewer`, CHILD, "nested-name-4190"),
		live: await host.send(`${GROUP}/live`, ROOT, "live-4190"),
		nestedLiveById: await host.send(`${GROUP}/${CHILD}/nested-live`, CHILD, "live-id-4190"),
		nestedLiveByName: await host.send(`${GROUP}/child/nested-live`, CHILD, "live-name-4190"),
		grandLive: await host.send(`${GROUP}/child/grand/grand-live`, GRAND, "grand-4190"),
	};
	assert.deepEqual(
		Object.entries(sent).map(([name, { handled, outcome }]) => [name, handled, outcome]),
		[
			["pending", true, { outcome: "queued", position: 1 }],
			["nestedById", true, { outcome: "queued", position: 1 }],
			["nestedByName", true, { outcome: "queued", position: 2 }],
			["live", true, { outcome: "forward", target: `${GROUP}/live` }],
			["nestedLiveById", true, { outcome: "forward", target: `${GROUP}/child/nested-live` }],
			["nestedLiveByName", true, { outcome: "forward", target: `${GROUP}/child/nested-live` }],
			["grandLive", true, { outcome: "forward", target: `${GROUP}/child/grand/grand-live` }],
		],
	);
	assert.equal(host.finished.reads, 0, `routing seven messages read finished runs ${host.finished.reads} times`);
});

test("a message for a stage that has not started, and a broadcast, queue and forward in store order without reading the finished runs (#4190)", async () => {
	const host = await bridgeHost();
	const future = await host.send(`${GROUP}/future`, ROOT, "future-4190");
	const broadcast = await host.send(`${GROUP}/**`, ROOT, "broadcast-4190");
	assert.deepEqual(
		[future.handled, future.outcome, broadcast.handled, broadcast.outcome],
		[
			true,
			{ outcome: "queued", position: 1, notInKnownSet: true },
			true,
			{
				outcome: "queued",
				position: 1,
				forwardTargets: [
					`${GROUP}/live`,
					`${GROUP}/child/nested-live`,
					`${GROUP}/child/grand/grand-live`,
					`${GROUP}/other/other-live`,
				],
			},
		],
	);
	assert.deepEqual(
		host.real.run(ROOT)?.pendingStageMessages?.map((entry) => [entry.message.id, entry.sticky]),
		[
			["future-4190", true],
			["broadcast-4190", true],
		],
	);
	assert.equal(host.finished.reads, 0, `queueing two sticky messages read finished runs ${host.finished.reads} times`);
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

test("announcing a released stage to Intercom reads none of the finished runs the store holds (#4190)", () => {
	const store = createStore();
	const finished = holdFinishedRuns(store, 5_000);
	store.recordRunStart(run("released-run", { stages: [stage("released-stage", { status: "completed" })] }));
	let release: Parameters<Parameters<typeof registerReleasedStageIntercomRoutes>[1]["onStageReleased"]>[0] = () => {};
	const registry = {
		onStageReleased: (listener: typeof release) => {
			release = listener;
			return () => {};
		},
	};
	const announced: Array<{ readonly runId?: string; readonly stageId?: string; readonly group?: string }> = [];
	cleanups.push(
		registerReleasedStageIntercomRoutes(
			{ events: { emit: (_event, payload) => announced.push(payload) } },
			registry as never,
			store,
			(() => undefined) as never,
		),
	);
	finished.reads = 0;
	release({ runId: "released-run", stageId: "released-stage", stageName: "released-stage", sessionId: "session" });
	assert.deepEqual(
		announced.map(({ runId, stageId, group }) => [runId, stageId, group]),
		[["released-run", "released-stage", "workflow:released-run"]],
	);
	assert.equal(finished.reads, 0, `announcing one released stage read finished runs ${finished.reads} times`);
});

test("a run under a token budget meters its usage without reading the finished runs the store holds (#4190)", async () => {
	const messages: AgentSession["messages"] = [];
	let text = "";
	const agentSession: AgentSessionAdapter = {
		async create() {
			return makeMockSession({
				messages,
				async prompt() {
					text = "metered";
					messages.push(
						assistantMessageWithUsage(text, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }),
					);
				},
				getLastAssistantText: () => text,
			}).session;
		},
	};
	const definition = workflow({
		name: "metered-4190",
		description: "",
		budget: { maxTokens: 1_000_000 },
		inputs: {},
		outputs: { result: Type.String() },
		run: async (ctx) => ({ result: await ctx.stage("one").prompt("go") }),
	});
	const store = createStore();
	const finished = holdFinishedRuns(store, 5_000);
	const result = await runWorkflow(definition, {}, { store, adapters: { agentSession } });
	assert.deepEqual(result.result, { result: "metered" });
	assert.equal(finished.reads, 0, `metering one run read finished runs ${finished.reads} times`);
});
