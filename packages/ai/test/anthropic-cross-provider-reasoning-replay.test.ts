import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, FetchFunction, Message, Model } from "../src/types.ts";

interface AnthropicPayloadBlock {
	type: string;
	thinking?: string;
	signature?: string;
	data?: string;
	text?: string;
	id?: string;
	tool_use_id?: string;
}

interface AnthropicPayloadMessage {
	role: string;
	content: string | AnthropicPayloadBlock[];
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function copilotGptTurn(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "github-copilot",
		model: "gpt-6.1-sol",
		usage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function claudeTurn(model: Model<"anthropic-messages">, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(toolCallId: string): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "a.ts b.ts" }],
		isError: false,
		timestamp: 3,
	};
}

const gptReasoningItem = JSON.stringify({
	type: "reasoning",
	id: "rs_gpt",
	summary: [{ type: "summary_text", text: "GPT plan: list the files" }],
	encrypted_content: "gAAAAB-gpt-encrypted-reasoning",
});

function gptTurnWithReasoningAndToolCall(): AssistantMessage {
	return copilotGptTurn([
		{ type: "thinking", thinking: "GPT plan: list the files", thinkingSignature: gptReasoningItem },
		{ type: "text", text: "Listing the files." },
		{ type: "toolCall", id: "call_gpt|fc_gpt", name: "bash", arguments: { command: "ls" } },
	]);
}

async function captureAnthropicMessages(
	model: Model<"anthropic-messages">,
	context: Context,
): Promise<AnthropicPayloadMessage[]> {
	let payload: { messages: AnthropicPayloadMessage[] } | undefined;
	await streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey: "credential-free-test-key",
		reasoning: "xhigh",
		fetch: (async () => {
			throw new Error("payload captured");
		}) as FetchFunction,
		onPayload: (body) => {
			payload = body as { messages: AnthropicPayloadMessage[] };
		},
	}).result();
	if (!payload) throw new Error("no Anthropic payload was built");
	return payload.messages;
}

function assistantBlocks(messages: AnthropicPayloadMessage[]): AnthropicPayloadBlock[][] {
	return messages
		.filter((message) => message.role === "assistant")
		.map((message) => (Array.isArray(message.content) ? message.content : []));
}

function reasoningBlocks(blocks: AnthropicPayloadBlock[]): AnthropicPayloadBlock[] {
	return blocks.filter((block) => block.type === "thinking" || block.type === "redacted_thinking");
}

const fallbackTargets: Model<"anthropic-messages">[] = [
	getModel("github-copilot", "claude-opus-5.5") as Model<"anthropic-messages">,
	getModel("anthropic", "claude-opus-5-5") as Model<"anthropic-messages">,
];

describe("cross-provider fallback replay to Anthropic (#4185)", () => {
	for (const model of fallbackTargets) {
		it(`drops a Copilot GPT turn's reasoning but keeps its tool call after a fallback to ${model.provider}/${model.id} (#4185)`, async () => {
			const messages = await captureAnthropicMessages(model, {
				messages: [
					{ role: "user", content: "list the files", timestamp: 0 },
					gptTurnWithReasoningAndToolCall(),
					toolResult("call_gpt|fc_gpt"),
				],
			});

			const [gptTurn] = assistantBlocks(messages);
			expect(reasoningBlocks(gptTurn)).toEqual([]);
			expect(gptTurn).toEqual([
				{ type: "text", text: "Listing the files." },
				{ type: "tool_use", id: "call_gpt_fc_gpt", name: "bash", input: { command: "ls" } },
			]);
			const wire = JSON.stringify(messages);
			expect(wire).not.toContain("gAAAAB-gpt-encrypted-reasoning");
			expect(wire).not.toContain("GPT plan");
		});
	}

	it("replays the latest Claude turn's reasoning byte-identical, signatures intact, after a GPT fallback (#4185)", async () => {
		const model = getModel("github-copilot", "claude-opus-5.5") as Model<"anthropic-messages">;
		const exactThinking = "Claude plan, with an unpaired surrogate \ud83d left exactly as returned";
		const latestClaudeTurn = claudeTurn(model, [
			{ type: "thinking", thinking: exactThinking, thinkingSignature: "sig-claude-1" },
			{ type: "text", text: "Reading both files." },
			{ type: "thinking", thinking: "", thinkingSignature: "sig-claude-omitted" },
			{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque-redacted", redacted: true },
			{ type: "toolCall", id: "toolu_claude", name: "bash", arguments: { command: "cat a.ts b.ts" } },
		]);

		const messages = await captureAnthropicMessages(model, {
			messages: [
				{ role: "user", content: "list the files", timestamp: 0 },
				gptTurnWithReasoningAndToolCall(),
				toolResult("call_gpt|fc_gpt"),
				latestClaudeTurn,
				toolResult("toolu_claude"),
			],
		});

		const latest = assistantBlocks(messages).at(-1) ?? [];
		expect(latest).toEqual([
			{ type: "thinking", thinking: exactThinking, signature: "sig-claude-1" },
			{ type: "text", text: "Reading both files." },
			{ type: "thinking", thinking: "", signature: "sig-claude-omitted" },
			{ type: "redacted_thinking", data: "opaque-redacted" },
			{ type: "tool_use", id: "toolu_claude", name: "bash", input: { command: "cat a.ts b.ts" } },
		]);
		expect(JSON.stringify(messages)).not.toContain("gAAAAB-gpt-encrypted-reasoning");
	});

	it("keeps a same-model replay's signed and redacted thinking unchanged (#4185)", async () => {
		const model = getModel("github-copilot", "claude-opus-5.5") as Model<"anthropic-messages">;
		const turn = claudeTurn(model, [
			{ type: "thinking", thinking: "plain signed plan", thinkingSignature: "sig-same" },
			{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque-same", redacted: true },
			{ type: "toolCall", id: "toolu_same", name: "bash", arguments: { command: "pwd" } },
		]);

		const messages = await captureAnthropicMessages(model, {
			messages: [{ role: "user", content: "where am I", timestamp: 0 }, turn, toolResult("toolu_same")],
		});

		expect(assistantBlocks(messages)).toEqual([
			[
				{ type: "thinking", thinking: "plain signed plan", signature: "sig-same" },
				{ type: "redacted_thinking", data: "opaque-same" },
				{ type: "tool_use", id: "toolu_same", name: "bash", input: { command: "pwd" } },
			],
		]);
	});

	it("does not replay one Claude model's reasoning to a different Claude model on the same provider (#4185)", async () => {
		const opus = getModel("github-copilot", "claude-opus-5.5") as Model<"anthropic-messages">;
		const sonnet = getModel("github-copilot", "claude-sonnet-5.5") as Model<"anthropic-messages">;
		const opusTurn = claudeTurn(opus, [
			{ type: "thinking", thinking: "opus plan", thinkingSignature: "sig-opus" },
			{ type: "toolCall", id: "toolu_opus", name: "bash", arguments: { command: "ls" } },
		]);

		const messages = await captureAnthropicMessages(sonnet, {
			messages: [{ role: "user", content: "list", timestamp: 0 }, opusTurn, toolResult("toolu_opus")],
		});

		expect(assistantBlocks(messages)).toEqual([
			[{ type: "tool_use", id: "toolu_opus", name: "bash", input: { command: "ls" } }],
		]);
	});
});
