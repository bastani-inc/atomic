import { describe, expect, it } from "vitest";
import { convertMessages, stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, FetchFunction, Model, OpenAICompletionsCompat, Usage } from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const baseCompat: Omit<Required<OpenAICompletionsCompat>, "thinkingTokenBudgetField" | "vllmPriority"> & {
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
} = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsTemperature: true,
	supportsForcedToolChoice: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresNonNullAssistantContent: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsThinkingTokenBudget: false,
	thinkingTokenBudgetField: undefined,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
};

function buildModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return { ...baseModel, api: "openai-completions", input: ["text", "image"] };
}

function buildContext(model: Model<"openai-completions">) {
	const now = Date.now();
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "true" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: now,
	};
	return normalizeContext({
		messages: [
			{ role: "user", content: "Run the command", timestamp: now - 1 },
			assistantMessage,
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: now + 1,
			},
			{ role: "user", content: "Thanks", timestamp: now + 2 },
		],
	});
}

async function sentAssistantContent(compat?: OpenAICompletionsCompat): Promise<unknown> {
	let body: { messages?: { role: string; content: unknown }[] } | undefined;
	const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(String(init?.body));
		return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}) as FetchFunction;
	const model = compat ? { ...buildModel(), compat } : buildModel();
	const result = await streamOpenAICompletions(model, buildContext(model), { apiKey: "test-key", fetch }).result();
	if (!body) throw new Error(`Expected a request: ${result.errorMessage}`);
	return body.messages?.find((message) => message.role === "assistant")?.content;
}

describe("requiresNonNullAssistantContent", () => {
	it("is off unless the model's compat turns it on", async () => {
		expect(await sentAssistantContent()).toBe(null);
		expect(await sentAssistantContent({ requiresNonNullAssistantContent: true })).toBe("");
	});

	it("sends null content for tool-call-only assistant messages by default", () => {
		const model = buildModel();
		const messages = convertMessages(model, buildContext(model), baseCompat);
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		expect(assistantMessages.length).toBe(1);
		expect(assistantMessages[0].content).toBe(null);
	});

	it("sends empty string content without inserting an assistant message after tool results", () => {
		const model = buildModel();
		const messages = convertMessages(model, buildContext(model), {
			...baseCompat,
			requiresNonNullAssistantContent: true,
		});
		const roles = messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "user"]);
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		expect(assistantMessages.length).toBe(1);
		expect(assistantMessages[0].content).toBe("");
	});

	it("still inserts an assistant message when requiresAssistantAfterToolResult is enabled", () => {
		const model = buildModel();
		const messages = convertMessages(model, buildContext(model), {
			...baseCompat,
			requiresAssistantAfterToolResult: true,
		});
		const roles = messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "assistant", "user"]);
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		expect(assistantMessages[0].content).toBe("");
		expect(assistantMessages[1].content).toBe("I have processed the tool results.");
	});
});
