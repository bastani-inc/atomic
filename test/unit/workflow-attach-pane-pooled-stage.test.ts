/**
 * Attaching to a stage that runs on a local worker shows its live chat (#3996).
 *
 * The pane resolves a running pooled stage through the pool's live view, a
 * `PooledStageHandle` over the watch doors, instead of the post-mortem fallback that
 * reports such a stage as unavailable until it finishes.
 */
import assert from "node:assert/strict";
import { type AgentSessionEvent, initTheme } from "@bastani/atomic";
import { beforeAll, test } from "vitest";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { WorkflowAttachPane } from "../../packages/workflows/src/tui/workflow-attach-pane.js";
import {
	openPooledStageHandle,
	type PooledStageHandle,
	type PooledStageTransport,
	reconnectPooledStageHandle,
} from "../../packages/workflows/src/workers/pooled-stage-handle.js";
import { RegisteredPooledStageHandle } from "../../packages/workflows/src/workers/pooled-stage-registry.js";
import { registerPooledStageSource } from "../../packages/workflows/src/workers/pooled-stage-sources.js";
import type {
	PooledStageChatSnapshot,
	PooledStageDelivery,
	PooledStageWatchMessage,
	WatchId,
} from "../../packages/workflows/src/workers/stage-watch-types.js";

beforeAll(() => {
	initTheme("dark", false);
});

const FIRST = "Streaming from the worker";
const SECOND = " and still going";

function assistant(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as const;
}

/** The watch doors of a pool, answered in memory: one open watch whose events the test sends. */
function fakeTransport(overrides: Partial<PooledStageChatSnapshot> = {}) {
	const unwatched: WatchId[] = [];
	const deliveries: PooledStageDelivery[] = [];
	let listener: ((message: PooledStageWatchMessage) => void) | undefined;
	const snapshot: PooledStageChatSnapshot = {
		sessionId: "pooled-session",
		status: "running",
		isStreaming: true,
		messages: [{ role: "user", content: "Stream a reply", timestamp: 1 }],
		streamingMessage: assistant(FIRST) as never,
		pendingToolExecutionEvents: [],
		queued: { steering: [], followUp: [] },
		seq: 7,
		...overrides,
	};
	const transport: PooledStageTransport = {
		async watch(_ref, receive) {
			listener = receive;
			return { ok: true, watch: { id: "watch-1" as WatchId, attempt: { workId: "work", generation: 1 }, snapshot } };
		},
		async unwatch(watch) {
			unwatched.push(watch);
		},
		async deliver(delivery) {
			deliveries.push(delivery);
			return { ok: true, action: delivery.intent === "followUp" ? "followUp" : "steer" };
		},
		async pause() {
			return { ok: true };
		},
		async resume() {
			return { ok: true };
		},
	};
	return {
		transport,
		unwatched,
		deliveries,
		send(seq: number, event: AgentSessionEvent) {
			listener?.({ kind: "events", events: [{ seq, event }] });
		},
	};
}

async function until(condition: () => boolean): Promise<void> {
	while (!condition()) await new Promise((resolve) => setImmediate(resolve));
}

function visible(lines: readonly string[]): string {
	return lines
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\s+/g, " ");
}

test("attaching to a running pooled stage renders its streaming text, not SESSION UNAVAILABLE, and Enter steers it (#3996)", async () => {
	const store = createStore();
	store.recordRunStart({
		id: "child",
		name: "pooled-child",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	store.recordStageStart("child", {
		id: "agent",
		name: "agent",
		status: "running",
		parentIds: [],
		toolEvents: [],
		sessionId: "pooled-session",
		workerExecution: { worker: "worker-1", generation: 1, renewedAt: 1, expiresAt: 2 },
	});
	const pool = fakeTransport();
	let postMortemCalls = 0;
	const unregister = registerPooledStageSource(store, {
		async acquire(runId, stageId) {
			const opened = await openPooledStageHandle(pool.transport, { runId, stageId }, "agent");
			assert.ok(opened.ok);
			return { handle: opened.handle, release: () => opened.handle.dispose() };
		},
	});
	const pane = new WorkflowAttachPane({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "child",
		stageControlRegistry: createStageControlRegistry(),
		resolvePostMortemHandle: () => {
			postMortemCalls += 1;
			return { ok: false, reason: "not_terminal" };
		},
		onClose: () => {},
		initialAttachStageId: "agent",
	});
	try {
		await until(() => visible(pane.render(100)).includes(FIRST));
		const opened = visible(pane.render(100));
		assert.doesNotMatch(opened, /SESSION UNAVAILABLE/);
		assert.match(opened, /on local worker/);
		assert.equal(postMortemCalls, 0, "a running pooled stage never falls back to post-mortem");

		pool.send(8, {
			type: "message_update",
			message: assistant(FIRST + SECOND),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: SECOND,
				partial: assistant(FIRST + SECOND),
			},
		} as never as AgentSessionEvent);
		await until(() => visible(pane.render(100)).includes(FIRST + SECOND));

		for (const character of "look at the tests") pane.handleInput(character);
		pane.handleInput("\r");
		await until(() => pool.deliveries.length === 1);
		assert.deepEqual(
			pool.deliveries.map(({ watch, text, intent }) => ({ watch, text, intent })),
			[{ watch: "watch-1", text: "look at the tests", intent: "steer" }],
			"Enter in a pooled stage's chat steers it through the delivery door",
		);

		pane.handleInput("\x18");
		assert.equal(pane._mode, "graph");
		assert.deepEqual(pool.unwatched, ["watch-1"], "leaving the chat closes the watch");
	} finally {
		pane.dispose();
		unregister();
	}
});

test("the graph shows a pooled stage's queued messages with no chat open (#3996)", () => {
	const store = createStore();
	store.recordRunStart({
		id: "child",
		name: "pooled-child",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	store.recordStageStart("child", {
		id: "agent",
		name: "agent",
		status: "running",
		parentIds: [],
		toolEvents: [],
		sessionId: "pooled-session",
		workerExecution: { worker: "worker-1", generation: 1, renewedAt: 1, expiresAt: 2 },
		queuedUserMessageCount: 1,
	});
	const pane = new WorkflowAttachPane({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "child",
		stageControlRegistry: createStageControlRegistry(),
		onClose: () => {},
	});
	try {
		assert.equal(pane._mode, "graph");
		assert.match(visible(pane.render(100)), /✉ 1 queued/);
	} finally {
		pane.dispose();
	}
});

test("a stage registered in an SDK registry attaches with its transcript, reply in flight and running tool, and keeps its published queue (#3996)", async () => {
	const store = createStore();
	store.recordRunStart({
		id: "child",
		name: "pooled-child",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	const stage = {
		id: "agent",
		name: "agent",
		status: "running" as const,
		parentIds: [],
		toolEvents: [],
		sessionId: "pooled-session",
		workerExecution: { worker: "worker-1", generation: 1, renewedAt: 1, expiresAt: 2 },
		queuedUserMessageCount: 3,
	};
	store.recordStageStart("child", stage);
	const pool = fakeTransport({
		messages: [{ role: "user", content: "Earlier question from the transcript", timestamp: 1 }],
		pendingToolExecutionEvents: [
			{
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "echo running-tool-marker" },
			} as never as AgentSessionEvent,
		],
	});
	const registry = createStageControlRegistry();
	// What an SDK caller's registry holds for a pooled stage: a proxy that has not opened a watch.
	registry.register(
		new RegisteredPooledStageHandle(
			"child",
			stage,
			{ kind: "local-worker", workId: "work", generation: 1 },
			async () => undefined,
		),
	);
	const unregister = registerPooledStageSource(store, {
		async acquire(runId, stageId) {
			const opened = await openPooledStageHandle(pool.transport, { runId, stageId }, "agent");
			assert.ok(opened.ok);
			return { handle: opened.handle, release: () => opened.handle.dispose() };
		},
	});
	const pane = new WorkflowAttachPane({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "child",
		stageControlRegistry: registry,
		onClose: () => {},
	});
	try {
		assert.match(visible(pane.render(100)), /✉ 3 queued/, "the published queue shows with no chat open");
		pane.retarget("child", "agent", "child");
		await until(() => visible(pane.render(100)).includes(FIRST));
		const opened = visible(pane.render(100));
		assert.match(opened, /Earlier question from the transcript/);
		assert.match(opened, /running-tool-marker/);
		pool.send(8, {
			type: "message_update",
			message: assistant(FIRST + SECOND),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: SECOND,
				partial: assistant(FIRST + SECOND),
			},
		} as never as AgentSessionEvent);
		await until(() => visible(pane.render(100)).includes(FIRST + SECOND));
		pane.handleInput("\x18");
		assert.equal(pane._mode, "graph");
		assert.match(visible(pane.render(100)), /✉ 3 queued/, "and again after the chat closes");
	} finally {
		pane.dispose();
		unregister();
	}
});

test("after the pane is hidden and shown, a reconnect still remounts the chat on the replacement's transcript (#3996)", async () => {
	const store = createStore();
	store.recordRunStart({
		id: "child",
		name: "pooled-child",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	});
	store.recordStageStart("child", {
		id: "agent",
		name: "agent",
		status: "running",
		parentIds: [],
		toolEvents: [],
		sessionId: "pooled-session",
		workerExecution: { worker: "worker-1", generation: 1, renewedAt: 1, expiresAt: 2 },
	});
	const listeners: ((message: PooledStageWatchMessage) => void)[] = [];
	const transport: PooledStageTransport = {
		async watch(_ref, receive) {
			listeners.push(receive);
			const replacement = listeners.length > 1;
			return {
				ok: true,
				watch: {
					id: `watch-${listeners.length}` as WatchId,
					attempt: { workId: "work", generation: listeners.length },
					snapshot: {
						sessionId: "pooled-session",
						status: "running",
						isStreaming: true,
						messages: [
							{
								role: "user",
								content: replacement ? "From the replacement attempt" : "From the first attempt",
								timestamp: 1,
							},
						],
						pendingToolExecutionEvents: [],
						queued: { steering: [], followUp: [] },
						seq: 0,
					},
				},
			};
		},
		async unwatch() {},
		async deliver() {
			return { ok: true, action: "steer" };
		},
		async pause() {
			return { ok: true };
		},
		async resume() {
			return { ok: true };
		},
	};
	let handle: PooledStageHandle | undefined;
	const unregister = registerPooledStageSource(store, {
		async acquire(runId, stageId) {
			const opened = await openPooledStageHandle(transport, { runId, stageId }, "agent");
			assert.ok(opened.ok);
			handle = opened.handle;
			return {
				handle: opened.handle,
				release: () => opened.handle.dispose(),
				onReconnected: (listener) => opened.handle.onRebind(listener),
			};
		},
	});
	const pane = new WorkflowAttachPane({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "child",
		stageControlRegistry: createStageControlRegistry(),
		onClose: () => {},
		initialAttachStageId: "agent",
	});
	try {
		await until(() => visible(pane.render(100)).includes("From the first attempt"));
		pane.setVisible(false);
		pane.setVisible(true);
		listeners[0]?.({ kind: "ended", reason: "worker_exited" });
		assert.ok(handle !== undefined);
		assert.equal(await reconnectPooledStageHandle(handle, transport), true);
		await until(() => visible(pane.render(100)).includes("From the replacement attempt"));
	} finally {
		pane.dispose();
		unregister();
	}
});
