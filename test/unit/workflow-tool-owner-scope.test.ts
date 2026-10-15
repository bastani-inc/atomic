import assert from "node:assert/strict";
import { test } from "vitest";
import { adoptWorkflowSessionRunState } from "../../packages/workflows/src/extension/adopt-session-run-state.js";
import type { ExtensionAPI, PiCommandContext } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { registerWorkflowSlashCommand } from "../../packages/workflows/src/extension/workflow-command-registration.js";
import type { WorkflowCommandHandler } from "../../packages/workflows/src/extension/workflow-command-utils.js";
import { captureWorkflowOwnerResources } from "../../packages/workflows/src/extension/workflow-owner-resources.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { currentWorkflowStore } from "../../packages/workflows/src/shared/store-factory.js";
import { testRunId } from "../helpers/run-id.js";

test("an existing workflow tool retains its owner's runs after a sibling starts and clears", async () => {
	adoptWorkflowSessionRunState({}, true);
	const ownerStore = currentWorkflowStore();
	const execute = makeExecuteWorkflowTool(createExtensionRuntime(), () => undefined);
	const runId = testRunId("tool-owner");
	ownerStore.recordRunStart({
		id: runId,
		name: "owner",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [],
	});
	adoptWorkflowSessionRunState({}, true);
	currentWorkflowStore().clear();
	try {
		const status = await execute({ action: "status" }, {});
		assert.equal(status.action, "status");
		if (status.action !== "status") throw new Error("expected status listing");
		assert.equal(status.runs[0]?.runId, runId);
		const detail = await execute({ action: "status", runId }, {});
		assert.equal(detail.action, "statusDetail");
		if (detail.action !== "statusDetail") throw new Error("expected status detail");
		assert.ok("detail" in detail);
		assert.equal(detail.detail.runId, runId);
	} finally {
		ownerStore.clear();
	}
});

test("inspection and prompt answers use the owner even when a sibling replaces state across an await", async () => {
	adoptWorkflowSessionRunState({}, true);
	const ownerStore = currentWorkflowStore();
	const execute = makeExecuteWorkflowTool(createExtensionRuntime(), () => undefined);
	const runId = testRunId("prompt-owner");
	ownerStore.recordRunStart({
		id: runId,
		name: "owner",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: "review", name: "review", status: "running", parentIds: [], toolEvents: [], attachable: true }],
	});
	ownerStore.recordStagePendingPrompt(runId, "review", {
		id: "question",
		kind: "input",
		message: "Proceed?",
		createdAt: 1,
	});
	const inspection = execute({ action: "stages", runId }, {});
	adoptWorkflowSessionRunState({}, true);
	const siblingStore = currentWorkflowStore();
	try {
		const stages = await inspection;
		assert.equal(stages.action, "stages");
		if (stages.action !== "stages") throw new Error("expected stages");
		assert.equal(stages.stages.length, 1);
		const answer = await execute({ action: "answer", runId, text: "yes" }, {});
		assert.equal(answer.action, "answer");
		if (answer.action !== "answer") throw new Error("expected answer");
		assert.equal(answer.status, "ok");
		assert.equal(siblingStore.runs().length, 0);
	} finally {
		ownerStore.clear();
	}
});

test("registered slash pause keeps its controls and store across a sibling adoption during pause", async () => {
	adoptWorkflowSessionRunState({}, true);
	const owner = captureWorkflowOwnerResources();
	const runtime = createExtensionRuntime();
	const commands = new Map<string, WorkflowCommandHandler>();
	const messages: unknown[] = [];
	const pi = {
		registerCommand() {},
		sendMessage(message: unknown) {
			messages.push(message);
		},
	} as unknown as ExtensionAPI;
	const overlay = { open() {}, close() {} } as unknown as Parameters<
		typeof registerWorkflowSlashCommand
	>[2]["overlay"];
	registerWorkflowSlashCommand(pi, commands, {
		runtimeProxy: runtime,
		runtimeForContext: () => runtime,
		overlay,
		reloadWorkflowResources: () => undefined,
		ensureWorkflowResourcesLoaded() {},
		runWithLifecycleSuppressedForPolicy: (_policy, fn) => fn(),
		runControl: { pi, overlay, runtimeForContext: () => runtime, ensureWorkflowResourcesLoaded() {} },
	});
	const runId = testRunId("slash-owner");
	owner.store.recordRunStart({
		id: runId,
		name: "owner",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [],
	});
	let pauseCount = 0;
	const unregister = owner.toolControlRegistry.registerRun(runId, {
		paused: false,
		async pause() {
			pauseCount++;
			await Promise.resolve();
			adoptWorkflowSessionRunState({}, true);
		},
		async resume() {},
		async quit() {},
	});
	adoptWorkflowSessionRunState({}, true);
	try {
		await commands.get("workflow")!(`pause ${runId}`, { hasUI: false } as PiCommandContext);
		assert.equal(pauseCount, 1);
		assert.equal(owner.store.runs()[0]?.status, "paused");
		assert.equal(currentWorkflowStore().runs().length, 0);
		assert.ok(messages.length > 0);
	} finally {
		unregister();
		owner.store.clear();
	}
});

test("tool transcript and stage pause retain the owner's live stage handle", async () => {
	adoptWorkflowSessionRunState({}, true);
	const owner = captureWorkflowOwnerResources();
	const execute = makeExecuteWorkflowTool(createExtensionRuntime(), () => undefined);
	const runId = testRunId("live-stage-owner");
	owner.store.recordRunStart({
		id: runId,
		name: "owner",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: "review", name: "review", status: "running", parentIds: [], toolEvents: [], attachable: true }],
	});
	let pauseCount = 0;
	const unregister = owner.stageControlRegistry.register({
		runId,
		stageId: "review",
		stageName: "review",
		status: "running",
		isStreaming: false,
		sessionId: "owner-stage",
		sessionFile: undefined,
		messages: [],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {
			pauseCount++;
			await Promise.resolve();
			adoptWorkflowSessionRunState({}, true);
		},
		async resume() {},
		subscribe() {
			return () => {};
		},
	});
	adoptWorkflowSessionRunState({}, true);
	try {
		const transcript = await execute({ action: "transcript", runId, stageId: "review" }, {});
		assert.equal(transcript.action, "transcript");
		if (transcript.action !== "transcript") throw new Error("expected transcript");
		assert.equal(transcript.source, "live");
		assert.equal(transcript.sessionId, "owner-stage");
		const paused = await execute({ action: "pause", runId, stageId: "review" }, {});
		assert.equal(paused.action, "pause");
		if (paused.action !== "pause") throw new Error("expected pause");
		assert.equal(paused.status, "paused");
		assert.equal(pauseCount, 1);
		assert.equal(owner.store.runs()[0]?.stages[0]?.status, "paused");
		assert.equal(currentWorkflowStore().runs().length, 0);
	} finally {
		unregister();
		owner.store.clear();
	}
});
