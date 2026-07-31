/**
 * Unit tests for the detached queued-message badge (issue #2074).
 *
 * Verifies:
 *  - the graph asks for a queued count per rendered stage node and paints it;
 *  - tool nodes own no session and are never asked;
 *  - a nested child-workflow stage is asked with its real `{runId, stageId}`,
 *    not the virtual expanded graph id;
 *  - `WorkflowAttachPane` sources the count from the live stage-control
 *    registry, so a stage the user has detached from still shows its queue.
 *
 * cross-ref:
 *   - src/tui/graph-view-state.ts, src/tui/graph-view-graph-render.ts
 *   - src/tui/node-card.ts, src/tui/workflow-attach-pane.ts
 */

import assert from "node:assert/strict";
import type { AgentSession, AgentSessionEvent } from "@bastani/atomic";
import { describe, test } from "vitest";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { StageQueuedUserMessageBuffer } from "../../packages/workflows/src/runs/foreground/stage-queued-user-messages.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

interface QueueRequest {
	runId: string;
	stageId: string;
}

function makeRunWithStage(store: ReturnType<typeof createStore>, runId: string, stageId: string): void {
	store.recordRunStart({
		id: runId,
		name: "test-wf",
		inputs: {},
		status: "running",
		stages: [],
		toolNodes: [],
		startedAt: 1,
	});
	store.recordStageStart(runId, {
		id: stageId,
		name: stageId,
		status: "running",
		parentIds: [],
		toolEvents: [],
		startedAt: 1,
	});
}

/**
 * Deliberately without an `agentSession`: the queue projection belongs to the
 * handle, so an adapter-backed stage that only publishes `queue_update` must
 * still be counted.
 */
function makeHandle(
	runId: string,
	stageId: string,
): { handle: StageControlHandle; emit: (event: AgentSessionEvent) => void } {
	const queuedUserMessages = new StageQueuedUserMessageBuffer();
	const handle: StageControlHandle = {
		runId,
		stageId,
		stageName: stageId,
		status: "running",
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [] as AgentSession["messages"],
		queuedUserMessages() {
			return queuedUserMessages.snapshot();
		},
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {},
		async resume() {},
		subscribe() {
			return () => {};
		},
	};
	return {
		handle,
		emit: (event: AgentSessionEvent) => queuedUserMessages.record(event),
	};
}

describe("graph queued-message badge", () => {
	test("paints the queued count for a stage the user is not attached to", () => {
		const store = createStore();
		makeRunWithStage(store, "run-1", "stage-a");
		const requests: QueueRequest[] = [];
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: deriveGraphTheme({}),
			getStageQueuedMessageCount: (runId, stageId) => {
				requests.push({ runId, stageId });
				return 2;
			},
		});
		const rendered = stripAnsi(view.render(120).join("\n"));
		assert.match(rendered, /2 queued/);
		assert.deepEqual(requests, [{ runId: "run-1", stageId: "stage-a" }]);
		view.dispose();
	});

	test("omits the badge when the live queue is empty", () => {
		const store = createStore();
		makeRunWithStage(store, "run-1", "stage-a");
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: deriveGraphTheme({}),
			getStageQueuedMessageCount: () => 0,
		});
		assert.doesNotMatch(stripAnsi(view.render(120).join("\n")), /queued/);
		view.dispose();
	});

	test("never asks for a queue count on a tool node", () => {
		const store = createStore();
		makeRunWithStage(store, "run-1", "stage-a");
		store.recordToolNodeStart("run-1", {
			kind: "tool",
			id: "tool:publish",
			name: "publish-api",
			argsHash: "hash",
			ordinal: 1,
			parentIds: [],
			status: "running",
			attachable: false,
		});
		const requests: QueueRequest[] = [];
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: deriveGraphTheme({}),
			getStageQueuedMessageCount: (runId, stageId) => {
				requests.push({ runId, stageId });
				return 0;
			},
		});
		view.render(120);
		assert.deepEqual(requests, [{ runId: "run-1", stageId: "stage-a" }]);
		view.dispose();
	});

	test("asks for a nested child stage with its real run and stage ids", () => {
		const store = createStore();
		makeRunWithStage(store, "run-1", "boundary");
		store.recordRunStart({
			id: "child-run",
			name: "child-wf",
			inputs: {},
			status: "running",
			stages: [],
			toolNodes: [],
			startedAt: 1,
			parentRunId: "run-1",
			parentStageId: "boundary",
			rootRunId: "run-1",
		});
		store.recordStageStart("child-run", {
			id: "child-stage",
			name: "child-stage",
			status: "running",
			parentIds: [],
			toolEvents: [],
			startedAt: 1,
		});
		assert.equal(
			store.recordStageWorkflowChildRun("run-1", "boundary", {
				alias: "child",
				workflow: "child-wf",
				runId: "child-run",
			}),
			true,
		);
		const requests: QueueRequest[] = [];
		const view = new GraphView({
			mode: "overlay",
			runId: "run-1",
			store,
			graphTheme: deriveGraphTheme({}),
			getStageQueuedMessageCount: (runId, stageId) => {
				requests.push({ runId, stageId });
				return 0;
			},
		});
		view.render(120);
		assert.ok(
			requests.some((request) => request.runId === "child-run" && request.stageId === "child-stage"),
			`expected the real child target, got ${JSON.stringify(requests)}`,
		);
		assert.equal(
			requests.some((request) => request.stageId.includes(":")),
			false,
			`virtual expanded ids must not be used as registry keys: ${JSON.stringify(requests)}`,
		);
		view.dispose();
	});
});

describe("WorkflowAttachPane queued-message badge", () => {
	test("reads the queued count from the handle snapshot while detached", () => {
		const store = createStore();
		makeRunWithStage(store, "run-1", "stage-a");
		const registry = createStageControlRegistry();
		const { handle, emit } = makeHandle("run-1", "stage-a");
		assert.equal(handle.agentSession, undefined);
		registry.register(handle);
		const pane = new WorkflowAttachPane({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageControlRegistry: registry,
			onClose: () => {},
		});
		assert.doesNotMatch(stripAnsi(pane.render(120).join("\n")), /queued/);

		emit({ type: "queue_update", steering: ["redirect"], followUp: [] } as unknown as AgentSessionEvent);
		assert.match(stripAnsi(pane.render(120).join("\n")), /1 queued/);

		emit({
			type: "queue_update",
			steering: ["redirect"],
			followUp: ["afterwards"],
		} as unknown as AgentSessionEvent);
		assert.match(stripAnsi(pane.render(120).join("\n")), /2 queued/);

		// Consumption publishes a reduced snapshot before the user message starts.
		emit({ type: "queue_update", steering: [], followUp: ["afterwards"] } as unknown as AgentSessionEvent);
		assert.match(stripAnsi(pane.render(120).join("\n")), /1 queued/);

		emit({ type: "queue_update", steering: [], followUp: [] } as unknown as AgentSessionEvent);
		assert.doesNotMatch(stripAnsi(pane.render(120).join("\n")), /queued/);
		pane.dispose();
	});

	test("reports no queued messages for a handle that never published a queue", () => {
		const store = createStore();
		makeRunWithStage(store, "run-1", "stage-a");
		const registry = createStageControlRegistry();
		registry.register(makeHandle("run-1", "stage-a").handle);
		const pane = new WorkflowAttachPane({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageControlRegistry: registry,
			onClose: () => {},
		});
		assert.doesNotMatch(stripAnsi(pane.render(120).join("\n")), /queued/);
		pane.dispose();
	});
});
