import { test } from "bun:test";
import { closeWorkflowStageGeneration, sendCustomMessage } from "../../packages/coding-agent/src/core/agent-session-message-queue.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { admitWorkflowStageInbound } from "../../packages/intercom/workflow-stage-admission.js";
import type { StageSessionCreateOptions } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import {
	assert,
	createStore,
	mockSession,
	run,
	workflow,
	type StageSessionRuntime,
	Type,
} from "./executor-shared.js";

test("admitted queued delivery drains before stage finalization and supplies the terminal result", async () => {
	const store = createStore();
	const closeStarted = Promise.withResolvers<void>();
	const drain = Promise.withResolvers<void>();
	let lastAssistantText = "initial structured output";
	let stageEnded = false;
	let closeCalls = 0;
	const session: StageSessionRuntime = {
		...mockSession(),
		async prompt() {},
		getLastAssistantText: () => lastAssistantText,
		async closeWorkflowStageGeneration() {
			closeStarted.resolve();
			closeCalls += 1;
			await drain.promise;
			lastAssistantText = "queued Intercom continuation";
		},
	};
	const definition = workflow({
		name: "stage-admission-drain",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("structured").prompt("produce structured output");
			return {};
		},
	});
	const execution = run(definition, {}, {
		store,
		adapters: { agentSession: { async create() { return session; } } },
		onStageEnd: () => { stageEnded = true; },
	});
	await closeStarted.promise;
	await Bun.sleep(0);
	assert.equal(stageEnded, false, "terminal stage publication must wait for admitted delivery");
	drain.resolve();
	const result = await execution;

	assert.equal(result.status, "completed");
	assert.equal(stageEnded, true);
	assert.equal(closeCalls >= 1, true);
	assert.equal(store.runs()[0]?.stages[0]?.result, "queued Intercom continuation");
});

test("Intercom received inside structured_output crosses AgentSession admission and drains before terminal publication", async () => {
	const store = createStore();
	const drain = Promise.withResolvers<void>();
	const closeStarted = Promise.withResolvers<void>();
	let createOptions: StageSessionCreateOptions | undefined;
	let lastAssistantText = "structured output";
	let stageEnded = false;
	const queued: string[] = [];
	const surface = {
		_workflowStageAdmission: new WorkflowStageAdmissionBoundary(async () => {
			closeStarted.resolve();
			await drain.promise;
			lastAssistantText = "processed Intercom continuation";
		}),
		_orchestrationContext: undefined as StageSessionCreateOptions["orchestrationContext"],
		isStreaming: true,
		_pendingNextTurnMessages: [],
		_queueAgentMessage(message: { content: string | object[] }) {
			if (typeof message.content === "string") queued.push(message.content);
		},
		_appendCustomMessage() {},
		async _enqueueInterruptCustomMessage() {},
		async _runAgentPrompt() {},
	};
	const pi = {
		sendMessage(message: { customType: string; content: string; display: boolean; details: object | undefined }, options?: { triggerTurn?: boolean; stageAdmissionKey?: string }) {
			return sendCustomMessage.call(surface as never, message, options);
		},
	};
	const session: StageSessionRuntime = {
		...mockSession(),
		async prompt() {
			const tool = createOptions?.customTools?.find((candidate) => candidate.name === "structured_output");
			assert.ok(tool);
			await tool.execute("structured-call", { approved: true }, undefined, undefined, undefined as never);
			const orchestrationContext = createOptions?.orchestrationContext;
			assert.ok(orchestrationContext);
			surface._orchestrationContext = orchestrationContext;
			assert.equal(admitWorkflowStageInbound({ orchestrationContext }, () => {
				void pi.sendMessage(
					{ customType: "intercom_message", content: "reviewer arrived", display: true, details: undefined },
					{ triggerTurn: true, stageAdmissionKey: "intercom:message-1" },
				);
			}), true);
		},
		getLastAssistantText: () => lastAssistantText,
		async closeWorkflowStageGeneration() { await closeWorkflowStageGeneration.call(surface as never); },
	};
	const definition = workflow({
		name: "structured-intercom-admission",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("structured", {
				schema: Type.Object({ approved: Type.Boolean() }, { additionalProperties: false }),
			}).prompt("review and call structured_output");
			return {};
		},
	});
	const execution = run(definition, {}, {
		store,
		adapters: { agentSession: { async create(options) { createOptions = options; return session; } } },
		onStageEnd: () => { stageEnded = true; },
	});

	await closeStarted.promise;
	assert.deepEqual(queued, ["reviewer arrived"]);
	assert.equal(stageEnded, false);
	drain.resolve();
	assert.equal((await execution).status, "completed");
	assert.equal(store.runs()[0]?.stages[0]?.result, "processed Intercom continuation");
});
