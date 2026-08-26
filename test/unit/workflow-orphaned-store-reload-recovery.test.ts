import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.ts";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.ts";
import { adoptWorkflowSessionRunState } from "../../packages/workflows/src/extension/adopt-session-run-state.ts";
import workflowFactory from "../../packages/workflows/src/extension/extension-factory.ts";
import { cancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.ts";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.ts";
import {
	type StageControlHandle,
	stageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.ts";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.ts";
import { stageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.ts";
import { store } from "../../packages/workflows/src/shared/store.ts";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.ts";
import { installStoreWidget } from "../../packages/workflows/src/tui/store-widget-installer.ts";

function stageHandle(runId: string, stageId: string): StageControlHandle {
	return {
		runId,
		stageId,
		stageName: stageId,
		status: "running",
		sessionId: "stage-session",
		sessionFile: "/tmp/stage-session.jsonl",
		isStreaming: true,
		messages: [],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {},
		async resume() {
			return undefined;
		},
		subscribe() {
			return () => {};
		},
	};
}

test("reload reclaims a live workflow displaced into an auxiliary session scope", () => {
	const parentScope = createEventBus();
	const childScope = createEventBus();
	const runId = "orphaned-live-run";
	const stageId = "worker";
	const nodeId = "tool:probe";

	adoptWorkflowSessionRunState(parentScope);
	store.clear();
	stageControlRegistry.clear();
	toolControlRegistry.clear();
	store.recordRunStart({
		id: "retained-parent-run",
		name: "retained-history",
		inputs: {},
		status: "completed",
		stages: [],
		toolNodes: [],
		startedAt: 0,
		endedAt: 1,
	} satisfies RunSnapshot);

	// Reproduce the old bug: an auxiliary AgentSession adopts every workflow
	// singleton, then the parent launches through the displaced facades.
	adoptWorkflowSessionRunState(childScope);
	store.recordRunStart({
		id: runId,
		name: "orphan-recovery",
		inputs: {},
		status: "running",
		stages: [],
		toolNodes: [],
		startedAt: 1,
	} satisfies RunSnapshot);
	store.recordStageStart(runId, {
		id: stageId,
		name: stageId,
		status: "running",
		parentIds: [],
		toolEvents: [],
	});
	assert.equal(
		store.recordStagePromptAnswer(
			runId,
			stageId,
			{ id: "prompt", kind: "input", message: "Value?", createdAt: 2 },
			"retained-answer",
		),
		true,
	);
	const promptAdapter = buildStagePromptAdapter(
		"broker-prompt",
		"ask_user_question",
		{ questions: [{ question: "Keep going?", options: [{ label: "Yes" }, { label: "No" }] }] },
		1,
	);
	assert.ok(promptAdapter);
	stageUiBroker.provideStagePrompt(runId, stageId, promptAdapter);
	void stageUiBroker.requestCustomUi(runId, stageId, () => ({
		render: () => [],
		invalidate: () => {},
	}));
	const handle = stageHandle(runId, stageId);
	stageControlRegistry.register(handle);
	const runController = new AbortController();
	cancellationRegistry.register(runId, runController);
	const job = { runId, controller: new AbortController(), promise: new Promise<void>(() => {}) };
	jobTracker.register(job);
	const disposeTool = toolControlRegistry.register({
		runId,
		nodeId,
		name: "probe",
		controller: new AbortController(),
		settled: new Promise<void>(() => {}),
	});

	// A full reload returns to the already-known parent EventBus. The parent
	// scope must reclaim the live store and controls without losing its history.
	adoptWorkflowSessionRunState(parentScope);
	assert.equal(store.runs().find((run) => run.id === runId)?.status, "running");
	assert.equal(store.runs().find((run) => run.id === "retained-parent-run")?.status, "completed");
	assert.equal(store.getStagePromptAnswer(runId, stageId)?.value, "retained-answer");
	assert.equal(stageControlRegistry.get(runId, stageId), handle);
	assert.equal(cancellationRegistry.isAborted(runId), false);
	assert.equal(jobTracker.get(runId), job);
	assert.equal(toolControlRegistry.get(runId, nodeId)?.name, "probe");
	assert.equal(stageUiBroker.answerStagePrompt(runId, stageId, { optionLabels: ["Yes"] }), true);

	const widgetCalls: Array<{ key: string; mounted: boolean; placement?: string }> = [];
	const disposeWidget = installStoreWidget(
		{
			ui: {
				setWidget(key, factory, options) {
					widgetCalls.push({ key, mounted: factory !== undefined, placement: options?.placement });
				},
				requestRender() {},
			},
		},
		store,
	);
	assert.deepEqual(widgetCalls[0], { key: "workflow.run", mounted: true, placement: "belowEditor" });

	disposeWidget();
	disposeTool();
	jobTracker.unregister(runId, job);
	cancellationRegistry.unregister(runId, runController);
	stageControlRegistry.clear();
	store.clear();
});

test("the workflows extension refuses every admitted subagent child session", () => {
	const parentScope = createEventBus();
	const childScope = createEventBus();
	adoptWorkflowSessionRunState(parentScope);
	store.clear();
	store.recordRunStart({
		id: "parent-owned-run",
		name: "parent-owner",
		inputs: {},
		status: "running",
		stages: [],
		toolNodes: [],
		startedAt: 1,
	} satisfies RunSnapshot);

	let registrations = 0;
	workflowFactory({
		events: childScope,
		subagentPolicy: {
			managementActions: "restricted",
			fanoutAuthorized: false,
			inheritProjectContext: false,
			inheritSkills: false,
			depth: 1,
		},
		registerTool: () => {
			registrations += 1;
		},
		registerCommand: () => {
			registrations += 1;
		},
	});

	assert.equal(registrations, 0);
	assert.equal(store.runs()[0]?.id, "parent-owned-run", "the child must not rebind the parent store facade");
	store.clear();
});
