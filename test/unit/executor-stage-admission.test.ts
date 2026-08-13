import { randomUUID } from "node:crypto";
import type { AgentSession } from "@bastani/atomic";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import {
	closeWorkflowStageGeneration,
	sendCustomMessage,
} from "../../packages/coding-agent/src/core/agent-session-message-queue.js";
import { WorkflowStageAdmissionBoundary } from "../../packages/coding-agent/src/core/workflow-stage-admission.js";
import { admitWorkflowStageInbound } from "../../packages/intercom/workflow-stage-admission.js";
import type { StageSessionCreateOptions } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { workflowArtifactRunPath } from "../../packages/workflows/src/shared/workflow-artifacts.js";
import { makeTempDirectory, readText, removeTempDirectory, sleep } from "../helpers/runtime.js";
import {
	assert,
	createStore,
	join,
	mockSession,
	run,
	type StageSessionRuntime,
	Type,
	workflow,
} from "./executor-shared.js";

function assistantMessageWithContent(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

test("admitted queued delivery drains before stage finalization while preserving the stage's own result", async () => {
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
	const execution = run(
		definition,
		{},
		{
			store,
			adapters: {
				agentSession: {
					async create() {
						return session;
					},
				},
			},
			onStageEnd: () => {
				stageEnded = true;
			},
		},
	);
	await closeStarted.promise;
	await sleep(0);
	assert.equal(stageEnded, false, "terminal stage publication must wait for admitted delivery");
	drain.resolve();
	const result = await execution;

	assert.equal(result.status, "completed");
	assert.equal(stageEnded, true);
	assert.equal(closeCalls >= 1, true);
	assert.equal(store.runs()[0]?.stages[0]?.result, "initial structured output");
});

test("Intercom received inside structured_output remains admitted but does not replace the structured result", async () => {
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
		sendMessage(
			message: { customType: string; content: string; display: boolean; details: object | undefined },
			options?: { triggerTurn?: boolean; stageAdmissionKey?: string },
		) {
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
			const admitted = admitWorkflowStageInbound({ orchestrationContext }, () => {
				void pi.sendMessage(
					{ customType: "intercom_message", content: "reviewer arrived", display: true, details: undefined },
					{ triggerTurn: true, stageAdmissionKey: "intercom:message-1" },
				);
			});
			assert.ok(admitted);
			await admitted;
		},
		getLastAssistantText: () => lastAssistantText,
		async closeWorkflowStageGeneration() {
			await closeWorkflowStageGeneration.call(surface as never);
		},
	};
	const definition = workflow({
		name: "structured-intercom-admission",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx
				.stage("structured", {
					schema: Type.Object({ approved: Type.Boolean() }, { additionalProperties: false }),
				})
				.prompt("review and call structured_output");
			return {};
		},
	});
	const execution = run(
		definition,
		{},
		{
			store,
			adapters: {
				agentSession: {
					async create(options) {
						createOptions = options;
						return session;
					},
				},
			},
			onStageEnd: () => {
				stageEnded = true;
			},
		},
	);

	await closeStarted.promise;
	assert.deepEqual(queued, ["reviewer arrived"]);
	assert.equal(stageEnded, false);
	drain.resolve();
	assert.equal((await execution).status, "completed");
	assert.equal(store.runs()[0]?.stages[0]?.result, '{\n  "approved": true\n}');
});

test("a real late admitted assistant turn cannot replace the successful structured artifact pairing", async () => {
	const outputDirectory = makeTempDirectory("structured-admission-output-");
	const outputPath = join(outputDirectory, "review.md");
	const runId = randomUUID();
	const store = createStore();
	const drain = Promise.withResolvers<void>();
	const closeStarted = Promise.withResolvers<void>();
	let createOptions: StageSessionCreateOptions | undefined;
	let lastAssistantText = "# Review\n\nReady to merge.";
	const queued: string[] = [];
	const messages = [] as AgentSession["messages"];
	const surface = {
		_workflowStageAdmission: new WorkflowStageAdmissionBoundary(async () => {
			closeStarted.resolve();
			await drain.promise;
			lastAssistantText = "late admitted acknowledgement";
			messages.push(assistantMessageWithContent([{ type: "text", text: lastAssistantText }]));
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
		sendMessage(
			message: { customType: string; content: string; display: boolean; details: object | undefined },
			options?: { triggerTurn?: boolean; stageAdmissionKey?: string },
		) {
			return sendCustomMessage.call(surface as never, message, options);
		},
	};
	const session: StageSessionRuntime = {
		...mockSession(),
		messages,
		async prompt() {
			const tool = createOptions?.customTools?.find((candidate) => candidate.name === "structured_output");
			assert.ok(tool);
			messages.push(
				assistantMessageWithContent([
					{ type: "text", text: "# Review" },
					{ type: "text", text: "\n\nReady to merge." },
					{
						type: "toolCall",
						id: "structured-call-admitted",
						name: "structured_output",
						arguments: { approved: true },
					},
				]),
			);
			await tool.execute("structured-call-admitted", { approved: true }, undefined, undefined, undefined as never);
			const orchestrationContext = createOptions?.orchestrationContext;
			assert.ok(orchestrationContext);
			surface._orchestrationContext = orchestrationContext;
			const admitted = admitWorkflowStageInbound({ orchestrationContext }, () => {
				void pi.sendMessage(
					{ customType: "intercom_message", content: "reviewer arrived", display: true, details: undefined },
					{ triggerTurn: true, stageAdmissionKey: "intercom:structured-artifact" },
				);
			});
			assert.ok(admitted);
			await admitted;
		},
		getLastAssistantText: () => lastAssistantText,
		async closeWorkflowStageGeneration() {
			await closeWorkflowStageGeneration.call(surface as never);
		},
	};
	const definition = workflow({
		name: "structured-artifact-admission",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx
				.stage("structured", {
					schema: Type.Object({ approved: Type.Boolean() }, { additionalProperties: false }),
				})
				.prompt("review and call structured_output", { output: outputPath, outputMode: "file-only" });
			return {};
		},
	});

	try {
		const execution = run(
			definition,
			{},
			{
				runId,
				store,
				adapters: {
					agentSession: {
						async create(options) {
							createOptions = options;
							return session;
						},
					},
				},
			},
		);

		await closeStarted.promise;
		assert.deepEqual(queued, ["reviewer arrived"]);
		drain.resolve();
		assert.equal((await execution).status, "completed");
		assert.equal(await readText(outputPath), "# Review\n\nReady to merge.");
		const stageResult = store.runs()[0]?.stages[0]?.result;
		assert.ok(stageResult);
		assert.match(stageResult, /Output saved to:/);
		assert.doesNotMatch(stageResult, /late admitted acknowledgement/);
	} finally {
		removeTempDirectory(outputDirectory);
		removeTempDirectory(workflowArtifactRunPath(runId));
	}
});

test("stage close waits for a busy Intercom admission barrier before draining its queued message", async () => {
	const firstRefusal = Promise.withResolvers<void>();
	const queued: string[] = [];
	const boundary = new WorkflowStageAdmissionBoundary();
	const surface = {
		_workflowStageAdmission: boundary,
		_orchestrationContext: undefined,
		isStreaming: true,
		_pendingNextTurnMessages: [],
		_queueAgentMessage(message: { content: string | object[] }) {
			if (typeof message.content === "string") queued.push(message.content);
		},
		_appendCustomMessage() {},
		async _enqueueInterruptCustomMessage() {},
		async _runAgentPrompt() {},
		agent: { async waitForIdle() {} },
		_agentEventQueue: Promise.resolve(),
	};
	const delivery = sendCustomMessage.call(
		surface as never,
		{ customType: "intercom_message", content: "mid-turn ask", display: true, details: undefined },
		{
			triggerTurn: true,
			stageAdmissionKey: "intercom:mid-turn-ask",
			stageAdmissionBarrier: () => firstRefusal.promise,
		},
	);
	let closed = false;
	const close = closeWorkflowStageGeneration.call(surface as never).then(() => {
		closed = true;
	});

	await sleep(0);
	assert.equal(closed, false, "terminal close must wait for the admitted handoff");
	assert.deepEqual(queued, []);
	firstRefusal.resolve();
	await delivery;
	await close;
	assert.deepEqual(queued, ["mid-turn ask"]);
});
