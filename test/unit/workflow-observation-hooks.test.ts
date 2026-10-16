import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import type { ExtensionAPI } from "../../packages/coding-agent/src/core/extensions/index.js";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../packages/coding-agent/src/core/extensions/loader.js";
import { ExtensionRunner } from "../../packages/coding-agent/src/core/extensions/runner.js";
import type {
	WorkflowEvent,
	WorkflowRootActivity,
} from "../../packages/coding-agent/src/core/extensions/workflow-events.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createWorkflowObservation } from "../../packages/workflows/src/extension/workflow-observation.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// #2891: executable workflows deliver typed host hooks, not notification cards.
test("nested execution delivers run stage tool and prompt hooks through the host runner", async () => {
	const runtime = createExtensionRuntime();
	const events: WorkflowEvent[] = [];
	let api!: ExtensionAPI;
	const extension = await loadExtensionFromFactory(
		(pi) => {
			api = pi;
			pi.on("workflow_lifecycle", (event) => {
				events.push(event);
			});
			pi.on("workflow_stage_completed", (event) => {
				events.push(event);
			});
		},
		process.cwd(),
		createEventBus(),
		runtime,
		"<observation-test>",
	);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), {} as never, {} as never);
	const store = createStore();
	const observation = createWorkflowObservation(store, api.registerWorkflowActivityPublisher(), "owner");
	let current: WorkflowRootActivity | undefined;
	runner.createContext().observeWorkflowActivity((frame) => {
		if (frame.kind === "changed") current = frame.root;
		else if (frame.kind === "snapshot" && frame.availability === "ready") current = frame.roots[0];
	});
	const waiting = Promise.withResolvers<void>();
	const unsubscribe = store.subscribe(() => {
		if (store.runs().some((item) => item.stages.some((stage) => stage.pendingPrompt))) waiting.resolve();
	});
	const child = workflow({
		name: "child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.ui.confirm("Continue?");
			await ctx.tool("child-tool", {}, async () => "done");
			await ctx.stage("successful").complete("done");
			return {};
		},
	});
	const parent = workflow({
		name: "parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.workflow(child, { stageName: "nested" });
			return {};
		},
	});
	const execution = run(
		parent,
		{},
		{
			store,
			durableBackend: await createMemoryTestBackend(),
			usePromptNodesForUi: true,
			adapters: { complete: { complete: async (text) => text } },
		},
	);
	await waiting.promise;
	const waitingRun = store.runs().find((item) => item.stages.some((stage) => stage.pendingPrompt))!;
	const promptStage = waitingRun.stages.find((item) => item.pendingPrompt)!;
	await flush();
	const parked = current;
	store.resolveStagePendingPrompt(waitingRun.id, promptStage.id, promptStage.pendingPrompt!.id, true);
	assert.equal((await execution).status, "completed");
	assert.equal(parked?.state, "blocked");
	assert.equal(parked?.activeExecutionCount, 0);
	await flush();
	const lifecycle = events.filter((event) => event.type === "workflow_lifecycle");
	assert.deepEqual([...new Set(lifecycle.map((event) => event.target.kind))].sort(), [
		"prompt",
		"run",
		"stage",
		"tool",
	]);
	const root = store.runs().find((item) => item.parentRunId === undefined)!;
	assert.ok(
		lifecycle.every(
			(event) => event.rootRunId === root.id && event.ownerSessionId === "owner" && event.delivery === "live",
		),
	);
	const completed = events.filter((event) => event.type === "workflow_stage_completed");
	assert.ok(completed.length > 0);
	for (const event of completed) {
		const stage = store
			.runs()
			.find((item) => item.id === event.runId)
			?.stages.find(
				(item) => (event.runId === root.id ? item.id : `${event.runId}:${item.id}`) === event.target.stageId,
			);
		assert.equal(stage?.status, "completed");
		assert.equal(stage?.name, event.target.stageName);
		assert.ok(lifecycle.some((item) => item.eventId === event.eventId));
	}
	assert.ok(lifecycle.some((event) => event.target.kind === "prompt" && event.target.status === "answered"));
	const nestedTool = lifecycle.find((event) => event.target.kind === "tool" && event.runId !== root.id);
	assert.ok(nestedTool?.target.kind === "tool");
	assert.equal(
		nestedTool.target.toolNodeId,
		`${nestedTool.runId}:${store.runs().find((item) => item.id === nestedTool.runId)!.toolNodes![0]!.id}`,
	);
	const prompt = lifecycle.find((event) => event.target.kind === "prompt");
	assert.ok(prompt?.target.kind === "prompt");
	assert.equal(prompt.target.stageId, `${waitingRun.id}:${promptStage.id}`);
	events.length = 0;
	const failure = await run(
		workflow({
			name: "unsuccessful",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("failed").complete("fail");
				return {};
			},
		}),
		{},
		{
			store,
			durableBackend: await createMemoryTestBackend(),
			adapters: {
				complete: {
					complete: async () => {
						throw new Error("failure");
					},
				},
			},
		},
	);
	assert.equal(failure.status, "failed");
	await flush();
	assert.equal(
		events.some((event) => event.type === "workflow_stage_completed"),
		false,
	);
	assert.ok(
		events.some(
			(event) =>
				event.type === "workflow_lifecycle" && event.target.kind === "stage" && event.target.status === "failed",
		),
	);
	const entered = Promise.withResolvers<void>();
	const skipped = await run(
		workflow({
			name: "skipped",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await Promise.all([
					ctx.stage("skipped").prompt("wait"),
					entered.promise.then(() => ctx.exit({ status: "skipped", reason: "done" })),
				]);
				return {};
			},
		}),
		{},
		{
			store,
			durableBackend: await createMemoryTestBackend(),
			adapters: {
				prompt: {
					prompt: async () => {
						entered.resolve();
						return new Promise<string>(() => {});
					},
				},
			},
		},
	);
	assert.equal(skipped.status, "skipped");
	await flush();
	assert.equal(
		events.some((event) => event.type === "workflow_stage_completed"),
		false,
	);
	assert.ok(
		events.some(
			(event) =>
				event.type === "workflow_lifecycle" && event.target.kind === "stage" && event.target.status === "skipped",
		),
	);
	unsubscribe();
	observation.dispose();
	runner.invalidate();
});
