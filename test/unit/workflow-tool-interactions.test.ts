// @ts-nocheck -- intentional white-box GraphView input coverage

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { handleRunControlCommand } from "../../packages/workflows/src/extension/workflow-run-control-command.js";
import { resolveStageTarget } from "../../packages/workflows/src/extension/workflow-targets.js";
import {
	workflowInterruptAction,
	workflowPauseAction,
	workflowResumeAction,
} from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { workflowSendAction } from "../../packages/workflows/src/extension/workflow-tool-send.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { expandWorkflowGraph } from "../../packages/workflows/src/shared/expanded-workflow-graph.js";
import { createStore, store } from "../../packages/workflows/src/shared/store.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { computeLayout, NODE_H, NODE_W } from "../../packages/workflows/src/tui/layout.js";
import { testRunId } from "../helpers/run-id.js";
import { defaultTheme } from "./overlay-graph-helpers.js";

function recordToolOnly(target = createStore(), status: "running" | "completed" = "running") {
	target.recordRunStart({
		id: testRunId("tool-interaction-run"),
		name: "tool interaction",
		inputs: {},
		status,
		stages: [],
		toolNodes: [
			{
				kind: "tool",
				id: "tool:publish",
				name: "publish-api",
				argsHash: "hash",
				ordinal: 1,
				parentIds: [],
				status: status === "running" ? "running" : "completed",
				attachable: false,
			},
		],
		startedAt: 1,
		...(status === "completed" ? { endedAt: 2 } : {}),
	});
	return target;
}

function clickForSingleNode(stage, width = 96, rows = 32): string {
	const [node] = computeLayout([stage], { orientation: "vertical" });
	const marginRows = 1;
	const panelRows = rows - marginRows * 2;
	const bodyRows = panelRows - 6;
	const totalGraphRows = node.y + NODE_H;
	const topPad =
		totalGraphRows <= bodyRows ? Math.min(3, Math.max(0, Math.floor((bodyRows - totalGraphRows) / 2))) : 0;
	const graphInner = Math.max(1, Math.max(40, width) - 4);
	const canvasWidth = node.x + NODE_W;
	const leftMargin = Math.max(2, canvasWidth <= graphInner ? Math.floor((graphInner - canvasWidth) / 2) : 2);
	const col = leftMargin + node.x + 2;
	const row = marginRows + 3 + topPad + node.y + 2;
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

beforeEach(() => {
	store.clear();
	stageControlRegistry.clear();
});
afterEach(() => {
	setDurableBackend(undefined);
	store.clear();
	stageControlRegistry.clear();
});

describe("non-attachable tool interactions", () => {
	test("keyboard, direct mouse, and switcher activation never attach a tool", () => {
		const localStore = recordToolOnly();
		const graph = expandWorkflowGraph(localStore.snapshot(), testRunId("tool-interaction-run"));
		const attached: string[] = [];
		const view = new GraphView({
			mode: "overlay",
			runId: testRunId("tool-interaction-run"),
			store: localStore,
			graphTheme: defaultTheme,
			piTui: { terminal: { rows: 32 } },
			onStageAttach: (_runId, stageId) => attached.push(stageId),
		});

		view.render(96);
		assert.equal(view.handleInput("\r"), true, "keyboard activation");
		assert.equal(view.handleInput(clickForSingleNode(graph.renderStages[0]!)), true, "direct mouse activation");
		assert.equal(view.handleInput("/"), true);
		for (const char of "publish-api") view.handleInput(char);
		assert.equal(view.handleInput("\r"), true, "switcher activation");
		assert.deepEqual(attached, []);
		view.dispose();
	});

	test("keyboard, mouse, and switcher activation open a retained completed stage", () => {
		const localStore = createStore();
		localStore.recordRunStart({
			id: testRunId("postmortem-run"),
			name: "postmortem",
			inputs: {},
			status: "completed",
			startedAt: 1,
			endedAt: 2,
			stages: [
				{
					id: "retained-stage",
					name: "retained-stage",
					status: "completed",
					parentIds: [],
					toolEvents: [],
					attachable: false,
					sessionFile: "/tmp/retained-session.jsonl",
				},
			],
		});
		const graph = expandWorkflowGraph(localStore.snapshot(), testRunId("postmortem-run"));
		const attached: string[] = [];
		const view = new GraphView({
			mode: "overlay",
			runId: testRunId("postmortem-run"),
			store: localStore,
			graphTheme: defaultTheme,
			piTui: { terminal: { rows: 32 } },
			onStageAttach: (runId, stageId) => attached.push(`${runId}/${stageId}`),
		});

		view.render(96);
		view.handleInput("\r");
		view.handleInput(clickForSingleNode(graph.renderStages[0]!));
		view.handleInput("/");
		for (const char of "retained-stage") view.handleInput(char);
		view.handleInput("\r");
		assert.deepEqual(attached, [
			`${testRunId("postmortem-run")}/retained-stage`,
			`${testRunId("postmortem-run")}/retained-stage`,
			`${testRunId("postmortem-run")}/retained-stage`,
		]);
		view.dispose();
	});

	test("terminal sends reject before textual tool targeting can create a handle", async () => {
		recordToolOnly(store, "completed");
		for (const target of ["tool:publish", "publish-api"]) {
			const resolved = resolveStageTarget(testRunId("tool-interaction-run"), target);
			assert.equal(resolved.ok, false, `${target} must not resolve as a stage`);
		}

		let postMortemCreates = 0;
		const sent = await workflowSendAction(
			{ action: "send", runId: testRunId("tool-interaction-run"), stageId: "tool:publish", text: "chat" },
			{
				resolvePostMortemDeps: () => {
					postMortemCreates += 1;
					throw new Error("must not create");
				},
			},
		);
		const paused = await workflowPauseAction({
			action: "pause",
			runId: testRunId("tool-interaction-run"),
			stageId: "tool:publish",
		});
		let overlayOpens = 0;
		const commandErrors: string[] = [];
		await handleRunControlCommand(
			"attach",
			[testRunId("tool-interaction-run"), "tool:publish"],
			{},
			{
				info() {},
				error(message) {
					commandErrors.push(message);
				},
			},
			{
				pi: {},
				overlay: {
					open() {
						overlayOpens += 1;
					},
				},
				runtimeForContext: () => ({ prepareDurableResumable: async () => [] }),
				ensureWorkflowResourcesLoaded() {},
			},
		);
		const interrupted = await workflowInterruptAction({
			action: "interrupt",
			runId: testRunId("tool-interaction-run"),
			stageId: "tool:publish",
		});

		assert.equal(sent.status, "failed");
		if (sent.status === "failed") {
			assert.equal(sent.code, "WORKFLOW_TERMINAL");
			assert.equal(sent.workflowStatus, "completed");
		}
		assert.equal(sent.delivery, "rejected");
		assert.equal(paused.status, "noop");
		assert.equal(interrupted.status, "noop");
		assert.match(
			sent.message,
			new RegExp(`workflow ${testRunId("tool-interaction-run")} has terminated with status completed`),
		);
		// Tool nodes are abort-only control targets: pause rejects them explicitly and
		// interrupt reports that this settled node has nothing in flight to abort.
		assert.match(paused.message, /Tool nodes cannot be paused/);
		assert.match(interrupted.message, /Tool node tool:publish is not running/);
		assert.equal(postMortemCreates, 0);
		const resumed = await workflowResumeAction(
			{ action: "resume", runId: testRunId("tool-interaction-run"), stageId: "tool:publish" },
			{
				getRuntime: () => ({ prepareDurableResumable: async () => [] }),
				policy: {},
				ensureWorkflowResourcesLoaded() {},
			},
		);
		assert.equal(resumed.status, "noop");
		assert.match(commandErrors.join("\n"), /Stage not found/);
		assert.equal(overlayOpens, 0);
		assert.deepEqual(stageControlRegistry.forRun(testRunId("tool-interaction-run")), []);
	});

	test("tool resumes a failed author exit through the durable backend", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const id = testRunId("failed-author-exit-tool");
		backend.registerWorkflow({
			workflowId: id,
			name: "failed-author-exit-tool-flow",
			inputs: {},
			createdAt: 1,
			status: "failed",
			resumable: true,
		});
		store.recordRunStart({
			id,
			name: "failed-author-exit-tool-flow",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		store.recordRunEnd(id, "failed", undefined, undefined, { exited: true, resumable: true });

		const entry = backend.listResumableWorkflows()[0]!;
		let resumeCalls = 0;
		const result = await workflowResumeAction(
			{ action: "resume", runId: id },
			{
				getRuntime: () => ({
					prepareDurableResumable: async () => [entry],
					resumeDurableWorkflow: () => {
						resumeCalls += 1;
						return Promise.resolve({
							ok: true as const,
							runId: id,
							workflowId: id,
							name: entry.name,
							message: "resumed failed author exit from tool",
						});
					},
				}),
				policy: {},
				ensureWorkflowResourcesLoaded() {},
			},
		);

		assert.equal(resumeCalls, 1);
		assert.equal(result.status, "running");
		assert.match(result.message, /resumed failed author exit from tool/);
	});

	test("tool does not snapshot-resume an exited failure without a durable registration", async () => {
		const backend = new InMemoryDurableBackend();
		setDurableBackend(backend);
		const id = testRunId("missing-author-exit-tool");
		store.recordRunStart({
			id,
			name: "missing-author-exit-tool-flow",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: 1,
		});
		store.recordRunEnd(id, "failed", undefined, undefined, { exited: true, resumable: true });
		await backend.deleteWorkflow(id);
		let resumeCalls = 0;

		const result = await workflowResumeAction(
			{ action: "resume", runId: id },
			{
				getRuntime: () => ({
					prepareDurableResumable: async () => [],
					resumeDurableWorkflow: () => {
						resumeCalls += 1;
						throw new Error("must not dispatch without durable state");
					},
				}),
				policy: {},
				ensureWorkflowResourcesLoaded() {},
			},
		);

		assert.equal(resumeCalls, 0);
		assert.equal(result.status, "noop");
		assert.match(result.message, /Run not found/);
	});
});
