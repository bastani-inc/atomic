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
	type PooledStageTransport,
} from "../../packages/workflows/src/workers/pooled-stage-handle.js";
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
function fakeTransport() {
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
