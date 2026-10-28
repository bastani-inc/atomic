import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentSession } from "../../packages/coding-agent/src/core/agent-session.ts";
import { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import type { ExtensionToolContext } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { createAskUserQuestionToolDefinition } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import type { QuestionParams } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.js";
import type { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import { createRpcCommandHandler } from "../../packages/coding-agent/src/modes/rpc/rpc-command-handler.ts";
import {
	createRpcExtensionUIContext,
	type RpcExtensionUICapabilities,
	type RpcPendingExtensionRequests,
} from "../../packages/coding-agent/src/modes/rpc/rpc-extension-ui.ts";
import type { RpcExtensionUIRequest } from "../../packages/coding-agent/src/modes/rpc/rpc-types.ts";

const params: QuestionParams = {
	questions: [
		{
			question: "Which storage should runs use?",
			header: "Storage",
			options: [
				{ label: "SQLite", description: "A local file" },
				{ label: "libSQL", description: "A shared database" },
			],
		},
		{
			question: "Which checks should run?",
			header: "Checks",
			multiSelect: true,
			options: [
				{ label: "Unit", description: "Fast tests" },
				{ label: "Integration", description: "Real processes" },
			],
		},
	],
};

function rpcUi(capabilities: RpcExtensionUICapabilities) {
	const requests: RpcExtensionUIRequest[] = [];
	const pending: RpcPendingExtensionRequests = new Map();
	const ui = createRpcExtensionUIContext({
		output: (frame) => requests.push(frame as RpcExtensionUIRequest),
		pendingExtensionRequests: pending,
		capabilities,
	});
	return { ui, requests, pending };
}

test("an RPC client that didn't opt in never gets a questionnaire request", async () => {
	const { ui, requests } = rpcUi({ questionnaire: false });
	assert.equal(await ui.hostQuestionnaire!(params), undefined);
	assert.deepEqual(requests, []);
});

test("an RPC client that opted in gets the whole questionnaire as one request and answers it", async () => {
	const { ui, requests, pending } = rpcUi({ questionnaire: true });
	const asked = ui.hostQuestionnaire!(params);
	const [request] = requests;
	assert.ok(request?.method === "questionnaire");
	assert.deepEqual(request.questions, params.questions);
	const answers = [
		{ questionIndex: 0, question: params.questions[0]!.question, kind: "option" as const, answer: "libSQL" },
		{
			questionIndex: 1,
			question: params.questions[1]!.question,
			kind: "multi" as const,
			answer: null,
			selected: ["Unit", "Integration"],
		},
	];
	pending.get(request.id)!.resolve({ type: "extension_ui_response", id: request.id, answers });
	assert.deepEqual(await asked, { answers, cancelled: false });
	assert.equal(pending.size, 0);
});

test("a cancelled or aborted RPC questionnaire resolves as cancelled and forgets the request", async () => {
	const { ui, requests, pending } = rpcUi({ questionnaire: true });
	const cancelled = ui.hostQuestionnaire!(params);
	pending.get(requests[0]!.id)!.resolve({ type: "extension_ui_response", id: requests[0]!.id, cancelled: true });
	assert.deepEqual(await cancelled, { answers: [], cancelled: true });

	const controller = new AbortController();
	const aborted = ui.hostQuestionnaire!(params, controller.signal);
	controller.abort();
	assert.deepEqual(await aborted, { answers: [], cancelled: true });
	assert.equal(pending.size, 0);
});

test("the interactive engine keeps rendering ask_user_question itself instead of asking the RPC client", () => {
	const ui = createRpcExtensionUIContext({
		output: () => {},
		pendingExtensionRequests: new Map(),
		customUi: { requestRender() {} } as unknown as EngineCustomUiService,
		capabilities: { questionnaire: true },
	});
	assert.equal(ui.hostQuestionnaire, undefined);
});

test("set_extension_ui_capabilities turns the questionnaire on and off for the RPC session", async () => {
	const capabilities: RpcExtensionUICapabilities = { questionnaire: false };
	const handle = createRpcCommandHandler({
		runtimeHost: Object.create(AgentSessionRuntime.prototype, {
			services: { value: { agentDir: "/fixture" } },
		}) as AgentSessionRuntime,
		getSession: () => Object.create(AgentSession.prototype) as AgentSession,
		rebindSession: async () => {},
		output: () => {},
		extensionUICapabilities: capabilities,
		waitForResources: () => assert.fail("capabilities don't wait for optional resources"),
	});
	const on = await handle({ id: "1", type: "set_extension_ui_capabilities", questionnaire: true });
	assert.deepEqual(on, {
		id: "1",
		type: "response",
		command: "set_extension_ui_capabilities",
		success: true,
	});
	assert.equal(capabilities.questionnaire, true);
	await handle({ type: "set_extension_ui_capabilities" });
	assert.equal(capabilities.questionnaire, true, "an omitted capability keeps its value");
	await handle({ type: "set_extension_ui_capabilities", questionnaire: false });
	assert.equal(capabilities.questionnaire, false);
});

test("ask_user_question returns the RPC client's answers as its tool result", async () => {
	const { ui, requests, pending } = rpcUi({ questionnaire: true });
	const tool = createAskUserQuestionToolDefinition();
	const ctx = {
		ui,
		hasUI: true,
		hasHumanInput: true,
		sessionManager: { getSessionId: () => "session" },
	} as unknown as ExtensionToolContext;
	const running = tool.execute("call", params, undefined, undefined, ctx);
	for (let i = 0; i < 50 && requests.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 1));
	const [request] = requests;
	assert.ok(request?.method === "questionnaire");
	pending.get(request.id)!.resolve({
		type: "extension_ui_response",
		id: request.id,
		answers: [
			{ questionIndex: 0, question: params.questions[0]!.question, kind: "option", answer: "libSQL" },
			{
				questionIndex: 1,
				question: params.questions[1]!.question,
				kind: "multi",
				answer: null,
				selected: ["Unit"],
			},
		],
	});
	const result = await running;
	const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
	assert.match(text, /libSQL/);
	assert.match(text, /Unit/);
	assert.equal((result.details as { cancelled: boolean }).cancelled, false);
});
