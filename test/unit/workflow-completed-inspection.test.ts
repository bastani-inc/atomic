import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import {
	createWorkflowLifecycleNotificationState,
	installWorkflowLifecycleNotifications,
	seedWorkflowLifecycleNotificationState,
} from "../../packages/workflows/src/extension/lifecycle-notifications.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { computeLayout, NODE_H, NODE_W } from "../../packages/workflows/src/tui/layout.js";
import { testRunId } from "../helpers/run-id.js";
import { mockSession, type StageSessionRuntime } from "./executor-shared.js";
import { defaultTheme, visibleText } from "./overlay-graph-helpers.js";

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "atomic-completed-inspection-"));
});
afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function retainedSession(name: string, internal = false): string {
	const path = join(tempDir, `${name}.jsonl`);
	writeFileSync(
		path,
		`${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: `${name}-session`,
				timestamp: new Date().toISOString(),
				cwd: tempDir,
				...(internal ? { internal: true, workflow: { runId: name, stageId: "final", stageName: "final" } } : {}),
			}),
			JSON.stringify({
				type: "message",
				id: `${name}-message`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "Original workflow request", timestamp: Date.now() },
			}),
		].join("\n")}\n`,
	);
	return path;
}
function completedTopology(stageId: string, sourceOrder = 0) {
	return {
		version: 1 as const,
		stageId,
		parentIds: [] as readonly string[],
		sourceOrder,
		status: "completed" as const,
	};
}

function clickForSingleNode(stage: RunSnapshot["stages"][number], width = 96, rows = 32): string {
	const [node] = computeLayout([stage], { orientation: "vertical" });
	const bodyRows = rows - 2 - 6;
	const totalGraphRows = node.y + NODE_H;
	const topPad =
		totalGraphRows <= bodyRows ? Math.min(3, Math.max(0, Math.floor((bodyRows - totalGraphRows) / 2))) : 0;
	const graphInner = Math.max(1, Math.max(40, width) - 4);
	const leftMargin = Math.max(2, node.x + NODE_W <= graphInner ? Math.floor((graphInner - node.x - NODE_W) / 2) : 2);
	return `\x1b[<0;${leftMargin + node.x + 3};${1 + 3 + topPad + node.y + 3}M`;
}
function lifecycleRestoration(store: ReturnType<typeof createStore>) {
	const state = createWorkflowLifecycleNotificationState();
	const sent: Array<{ readonly options?: { readonly deliverAs?: string } }> = [];
	const unsubscribe = installWorkflowLifecycleNotifications({
		store,
		state,
		config: { enabled: true, notifyOn: ["completed", "failed"] },
		sendMessage(_message, options) {
			sent.push({ options });
		},
	});
	return {
		sent,
		unsubscribe,
		beforeRestore(snapshots: readonly RunSnapshot[]) {
			seedWorkflowLifecycleNotificationState(state, { ...store.snapshot(), runs: snapshots });
		},
	};
}

describe("completed workflow inspection", () => {
	test("opens immutable detail and appends follow-up chat without durable re-dispatch", async () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const lifecycle = lifecycleRestoration(store);
		const registry = createStageControlRegistry();
		const sessionFile = retainedSession(testRunId("completed-inspection"));
		const promptCalls: string[] = [];
		const session: StageSessionRuntime = {
			...mockSession(),
			sessionFile,
			async prompt(text: string) {
				promptCalls.push(text);
			},
		};
		backend.registerWorkflow({
			workflowId: testRunId("completed-inspection"),
			name: "completed-flow",
			inputs: { topic: "done" },
			createdAt: 1,
			updatedAt: 3,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("completed-inspection"),
			checkpointId: "stage:1",
			name: "final",
			replayKey: "stage:final:1",
			output: "done",
			sessionFile,
			completedAt: 2,
			topology: completedTopology("final-source"),
		});

		let sessionCreates = 0;
		let restoredMessageCount = 0;
		const opened = openCompletedDurableWorkflow(testRunId("completed-inspection"), {
			durableBackend: backend,
			store,
			beforeRestore: lifecycle.beforeRestore,
			stageControlRegistry: registry,
			adapters: {
				agentSession: {
					async create(options) {
						restoredMessageCount = options.sessionManager?.getEntries().length ?? 0;
						sessionCreates += 1;
						return session;
					},
				},
			},
			cwd: tempDir,
		});

		assert.equal(opened.ok, true);
		assert.equal(store.runs()[0]?.status, "completed");
		assert.equal(store.runs()[0]?.stages[0]?.attachable, false);
		assert.equal(backend.getWorkflow(testRunId("completed-inspection"))?.status, "completed");
		const handle = registry.get(testRunId("completed-inspection"), "final-source");
		assert.ok(handle);
		assert.deepEqual(registry.run(testRunId("completed-inspection")).stages(), []);

		const attached: string[] = [];
		const graph = expandWorkflowGraph(store.snapshot(), testRunId("completed-inspection"));
		const view = new GraphView({
			mode: "overlay",
			runId: testRunId("completed-inspection"),
			store,
			graphTheme: defaultTheme,
			getViewportRows: () => 32,
			onStageAttach: (runId, stageId) => {
				attached.push(`${runId}/${stageId}`);
			},
		});
		assert.match(visibleText(view.render(96)), /↵ open stage chat/);
		view.handleInput("\r");
		view.handleInput(clickForSingleNode(graph.renderStages[0]!));
		view.handleInput("/");
		assert.match(visibleText(view.render(96)), /↵ open stage chat/);
		for (const char of "final") view.handleInput(char);
		view.handleInput("\r");
		assert.deepEqual(attached, [
			`${testRunId("completed-inspection")}/final-source`,
			`${testRunId("completed-inspection")}/final-source`,
			`${testRunId("completed-inspection")}/final-source`,
		]);
		view.dispose();
		await handle.prompt("What should I do next?");
		assert.equal(sessionCreates, 1);
		assert.equal(restoredMessageCount, 1);
		assert.deepEqual(promptCalls, ["What should I do next?"]);
		assert.equal(store.runs()[0]?.status, "completed");
		assert.equal(backend.getWorkflow(testRunId("completed-inspection"))?.status, "completed");
		assert.deepEqual(lifecycle.sent, []);
		lifecycle.unsubscribe();
	});
	test("includes the full workflow id in a completed inspection message", () => {
		const workflowId = testRunId("full-workflow-id");
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		backend.registerWorkflow({
			workflowId,
			name: "completed-flow",
			inputs: {},
			createdAt: 1,
			updatedAt: 3,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId,
			checkpointId: "stage:1",
			name: "final",
			replayKey: "stage:final:1",
			output: "done",
			completedAt: 2,
			topology: completedTopology("final-source"),
		});

		const opened = openCompletedDurableWorkflow(workflowId, { durableBackend: backend, store });
		assert.equal(opened.ok, true);
		if (opened.ok) assert.ok(opened.message.includes(workflowId));
	});

	test("refuses to replace an active run with the same id", () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const sessionFile = retainedSession(testRunId("same-id"));
		backend.registerWorkflow({
			workflowId: testRunId("same-id"),
			name: "completed-flow",
			inputs: {},
			createdAt: 1,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("same-id"),
			checkpointId: "stage:1",
			name: "final",
			replayKey: "stage:final:1",
			sessionFile,
			completedAt: 2,
			topology: completedTopology("final-source"),
		});
		store.recordRunStart({
			id: testRunId("same-id"),
			name: "active",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});

		const opened = openCompletedDurableWorkflow(testRunId("same-id"), { durableBackend: backend, store });
		assert.equal(opened.ok, false);
		if (!opened.ok) assert.equal(opened.reason, "active");
		assert.equal(store.runs()[0]?.status, "running");
	});

	test("replaces a retained completed snapshot with authoritative durable detail", () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const sessionFile = retainedSession(testRunId("authoritative"));
		backend.registerWorkflow({
			workflowId: testRunId("authoritative"),
			name: "durable-name",
			inputs: {},
			createdAt: 1,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("authoritative"),
			checkpointId: "stage:1",
			name: "durable-stage",
			replayKey: "stage:durable:1",
			output: "durable result",
			sessionFile,
			completedAt: 2,
			topology: completedTopology("durable-source"),
		});
		store.recordRunStart({
			id: testRunId("authoritative"),
			name: "stale-local-name",
			inputs: {},
			status: "completed",
			stages: [],
			startedAt: 1,
			endedAt: 2,
			resumable: false,
		});

		const opened = openCompletedDurableWorkflow(testRunId("authoritative"), { durableBackend: backend, store });

		assert.equal(opened.ok, true);
		assert.equal(store.runs()[0]?.name, "durable-name");
		assert.equal(store.runs()[0]?.stages[0]?.name, "durable-stage");
		assert.equal(store.runs()[0]?.stages[0]?.sessionFile, sessionFile);
	});

	test("refreshes a retained chat handle when authoritative transcript detail changes", () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const lifecycle = lifecycleRestoration(store);
		const registry = createStageControlRegistry();
		const firstSessionFile = retainedSession("first-authoritative");
		const secondSessionFile = retainedSession("second-authoritative");
		backend.registerWorkflow({
			workflowId: testRunId("refresh-chat"),
			name: "completed-flow",
			inputs: {},
			createdAt: 1,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("refresh-chat"),
			checkpointId: "stage:1",
			name: "final",
			replayKey: "stage:final:1",
			sessionFile: firstSessionFile,
			completedAt: 2,
			topology: completedTopology("final-source"),
		});
		const deps = {
			durableBackend: backend,
			store,
			stageControlRegistry: registry,
			beforeRestore: lifecycle.beforeRestore,
			adapters: {
				agentSession: {
					async create() {
						return mockSession();
					},
				},
			},
		};

		assert.equal(openCompletedDurableWorkflow(testRunId("refresh-chat"), deps).ok, true);
		const firstHandle = registry.get(testRunId("refresh-chat"), "final-source");
		assert.equal(firstHandle?.sessionFile, firstSessionFile);
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("refresh-chat"),
			checkpointId: "stage:2",
			name: "final",
			replayKey: "stage:final:1",
			sessionFile: secondSessionFile,
			completedAt: 3,
			topology: completedTopology("final-source"),
		});

		assert.equal(openCompletedDurableWorkflow(testRunId("refresh-chat"), deps).ok, true);
		assert.equal(firstHandle?.isDisposed, true);
		assert.equal(registry.get(testRunId("refresh-chat"), "final-source")?.sessionFile, secondSessionFile);
		assert.deepEqual(lifecycle.sent, []);
		lifecycle.unsubscribe();
	});

	test("removes a retained chat handle when its transcript becomes invalid", () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const registry = createStageControlRegistry();
		const invalidatedSessionFile = retainedSession("invalidated-stage");
		const retainedSessionFile = retainedSession("still-retained-stage");
		backend.registerWorkflow({
			workflowId: testRunId("invalidate-chat"),
			name: "completed-flow",
			inputs: {},
			createdAt: 1,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("invalidate-chat"),
			checkpointId: "stage:1",
			name: "first",
			replayKey: "stage:first:1",
			sessionFile: invalidatedSessionFile,
			completedAt: 2,
			topology: completedTopology("first-source", 0),
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("invalidate-chat"),
			checkpointId: "stage:2",
			name: "second",
			replayKey: "stage:second:1",
			sessionFile: retainedSessionFile,
			completedAt: 3,
			topology: completedTopology("second-source", 1),
		});
		const deps = {
			durableBackend: backend,
			store,
			stageControlRegistry: registry,
			adapters: {
				agentSession: {
					async create() {
						return mockSession();
					},
				},
			},
		};

		assert.equal(openCompletedDurableWorkflow(testRunId("invalidate-chat"), deps).ok, true);
		const invalidatedHandle = registry.get(testRunId("invalidate-chat"), "first-source");
		assert.ok(invalidatedHandle);
		rmSync(invalidatedSessionFile);

		assert.equal(openCompletedDurableWorkflow(testRunId("invalidate-chat"), deps).ok, true);
		assert.equal(invalidatedHandle.isDisposed, true);
		assert.equal(registry.get(testRunId("invalidate-chat"), "first-source"), undefined);
		assert.equal(registry.get(testRunId("invalidate-chat"), "second-source")?.sessionFile, retainedSessionFile);
	});

	test("opens a retained internal stage transcript without exposing it in ordinary history", async () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const internalSessionFile = retainedSession(testRunId("internal-completed"), true);
		retainedSession("regular-history");
		backend.registerWorkflow({
			workflowId: testRunId("internal-completed"),
			name: "completed-flow",
			inputs: {},
			createdAt: 1,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: testRunId("internal-completed"),
			checkpointId: "stage:1",
			name: "final",
			replayKey: "stage:final:1",
			sessionFile: internalSessionFile,
			completedAt: 2,
			topology: completedTopology("final-source"),
		});

		assert.equal(
			openCompletedDurableWorkflow(testRunId("internal-completed"), { durableBackend: backend, store }).ok,
			true,
		);
		assert.equal(store.runs()[0]?.stages[0]?.sessionFile, internalSessionFile);
		assert.deepEqual(
			(await SessionManager.list(tempDir, tempDir)).map((session) => session.id),
			["regular-history-session"],
		);
	});

	test("opens a tool-only run as a read-only graph without promising chat", () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const registry = createStageControlRegistry();
		backend.registerWorkflow({
			workflowId: testRunId("completed-tool-only"),
			name: "tool-only",
			inputs: {},
			createdAt: 1,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: testRunId("completed-tool-only"),
			checkpointId: "tool:publish",
			name: "publish",
			argsHash: "publish-hash",
			output: "done",
			completedAt: 2,
		});

		const opened = openCompletedDurableWorkflow(testRunId("completed-tool-only"), {
			durableBackend: backend,
			store,
			stageControlRegistry: registry,
			adapters: {
				agentSession: {
					async create() {
						return mockSession();
					},
				},
			},
		});

		assert.equal(opened.ok, true);
		if (!opened.ok) return;
		assert.match(opened.message, /read-only inspection/);
		assert.doesNotMatch(opened.message, /follow-up chat/);
		assert.deepEqual(registry.forRun(testRunId("completed-tool-only")), []);
		assert.deepEqual(
			store.runs()[0]?.toolNodes?.map((tool) => tool.name),
			["publish"],
		);
	});

	test("restores nested completed snapshots without lifecycle delivery", () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const lifecycle = lifecycleRestoration(store);
		const runId = testRunId("silent-nested-root");
		const childRunId = testRunId("silent-nested-child");
		backend.registerWorkflow({
			workflowId: runId,
			name: "nested root",
			inputs: {},
			createdAt: 1,
			updatedAt: 4,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: "boundary",
			name: "workflow:nested child",
			replayKey: "boundary",
			output: { workflow: "nested child", runId: childRunId, status: "completed", exited: false, outputs: {} },
			completedAt: 3,
			topology: {
				version: 1,
				stageId: "boundary",
				parentIds: [],
				run: { runId, runName: "nested root" },
			},
		});
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: runId,
			checkpointId: "child-tool",
			name: "nested publish",
			argsHash: "nested-publish",
			output: "done",
			completedAt: 2,
			topology: {
				version: 1,
				nodeId: "nested-tool-node",
				ordinal: 1,
				order: 1,
				parentIds: [],
				endedAt: 2,
				run: {
					runId: childRunId,
					runName: "nested child",
					parentRunId: runId,
					parentStageId: "boundary",
					rootRunId: runId,
				},
			},
		});

		const opened = openCompletedDurableWorkflow(testRunId("silent-nested-root"), {
			durableBackend: backend,
			store,
			beforeRestore: lifecycle.beforeRestore,
		});
		lifecycle.unsubscribe();

		assert.equal(opened.ok, true);
		assert.deepEqual(
			store
				.runs()
				.map((run) => run.id)
				.sort(),
			[childRunId, runId].sort(),
		);
		assert.equal(store.runs().find((run) => run.id === childRunId)?.toolNodes?.[0]?.name, "nested publish");
		assert.deepEqual(lifecycle.sent, []);
	});
	test("historical tool-only restoration is lifecycle-silent", () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const state = createWorkflowLifecycleNotificationState();
		const sent: unknown[] = [];
		const unsubscribe = installWorkflowLifecycleNotifications({
			store,
			state,
			config: { enabled: true, notifyOn: ["completed", "failed"] },
			sendMessage(message, options) {
				sent.push({ message, options });
			},
		});
		backend.registerWorkflow({
			workflowId: testRunId("silent-tool-only"),
			name: "silent tool",
			inputs: {},
			createdAt: 1,
			updatedAt: 3,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: testRunId("silent-tool-only"),
			checkpointId: "tool:publish",
			name: "publish",
			argsHash: "publish-hash",
			output: "done",
			completedAt: 2,
		});

		const opened = openCompletedDurableWorkflow(testRunId("silent-tool-only"), {
			durableBackend: backend,
			store,
			beforeRestore(snapshots) {
				seedWorkflowLifecycleNotificationState(state, { ...store.snapshot(), runs: snapshots });
			},
		});
		unsubscribe();

		assert.equal(opened.ok, true);
		assert.deepEqual(
			store.runs()[0]?.toolNodes?.map((node) => node.name),
			["publish"],
		);
		assert.deepEqual(sent, []);
	});

	test("completed inspection does not duplicate an already delivered live notice", () => {
		const backend = new InMemoryDurableBackend();
		const store = createStore();
		const state = createWorkflowLifecycleNotificationState();
		const sent: unknown[] = [];
		const unsubscribe = installWorkflowLifecycleNotifications({
			store,
			state,
			seedExisting: false,
			config: { enabled: true, notifyOn: ["completed"] },
			sendMessage(message, options) {
				sent.push({ message, options });
			},
		});
		store.recordRunStart({
			id: testRunId("live-then-inspect"),
			name: "live tool",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		store.recordRunEnd(testRunId("live-then-inspect"), "completed", {});
		assert.equal(sent.length, 1);
		backend.registerWorkflow({
			workflowId: testRunId("live-then-inspect"),
			name: "live tool",
			inputs: {},
			createdAt: 1,
			updatedAt: 3,
			status: "completed",
		});
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: testRunId("live-then-inspect"),
			checkpointId: "tool:done",
			name: "done",
			argsHash: "done-hash",
			output: true,
			completedAt: 2,
		});

		const opened = openCompletedDurableWorkflow(testRunId("live-then-inspect"), {
			durableBackend: backend,
			store,
			beforeRestore(snapshots) {
				seedWorkflowLifecycleNotificationState(state, { ...store.snapshot(), runs: snapshots });
			},
		});
		unsubscribe();

		assert.equal(opened.ok, true);
		assert.equal(sent.length, 1);
	});
});
