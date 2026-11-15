import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model, ToolCall } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const context = normalizeContext({
	messages: [{ role: "user", content: "read two files", timestamp: Date.now() }],
});

interface ToolCallDelta {
	index: number;
	id?: string;
	function: { name?: string; arguments: string };
}

function toolCallChunk(toolCall: ToolCallDelta) {
	return { id: "chatcmpl-1", choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }] };
}

const finishChunk = { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };

async function streamToolCalls(chunks: unknown[]): Promise<Array<Pick<ToolCall, "id" | "name" | "arguments">>> {
	mockState.chunks = chunks;
	const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();
	assert.equal(message.stopReason, "toolUse", message.errorMessage);
	return message.content
		.filter((block): block is ToolCall => block.type === "toolCall")
		.map(({ id, name, arguments: args }) => ({ id, name, arguments: args }));
}

describe("OpenAI completions streamed tool calls", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("keeps parallel tool calls apart when a server sends index 0 for every call", async () => {
		const toolCalls = await streamToolCalls([
			toolCallChunk({ index: 0, id: "call_a", function: { name: "read", arguments: '{"path":' } }),
			toolCallChunk({ index: 0, function: { arguments: '"a.txt"}' } }),
			toolCallChunk({ index: 0, id: "call_b", function: { name: "read", arguments: '{"path":' } }),
			toolCallChunk({ index: 0, function: { arguments: '"b.txt"}' } }),
			finishChunk,
		]);

		assert.deepEqual(toolCalls, [
			{ id: "call_a", name: "read", arguments: { path: "a.txt" } },
			{ id: "call_b", name: "read", arguments: { path: "b.txt" } },
		]);
	});

	it("routes a fragment that repeats its call id to that call while another call shares its index", async () => {
		const toolCalls = await streamToolCalls([
			toolCallChunk({ index: 0, id: "call_a", function: { name: "read", arguments: '{"path":' } }),
			toolCallChunk({ index: 0, id: "call_b", function: { name: "read", arguments: '{"path":' } }),
			toolCallChunk({ index: 0, id: "call_a", function: { arguments: '"a.txt"}' } }),
			toolCallChunk({ index: 0, id: "call_b", function: { arguments: '"b.txt"}' } }),
			finishChunk,
		]);

		assert.deepEqual(toolCalls, [
			{ id: "call_a", name: "read", arguments: { path: "a.txt" } },
			{ id: "call_b", name: "read", arguments: { path: "b.txt" } },
		]);
	});

	it("assembles the standard OpenAI shape: distinct indexes with the id only on each call's first delta", async () => {
		const toolCalls = await streamToolCalls([
			toolCallChunk({ index: 0, id: "call_a", function: { name: "read", arguments: "" } }),
			toolCallChunk({ index: 1, id: "call_b", function: { name: "read", arguments: "" } }),
			toolCallChunk({ index: 0, function: { arguments: '{"path":"a.txt"}' } }),
			toolCallChunk({ index: 1, function: { arguments: '{"path":"b.txt"}' } }),
			finishChunk,
		]);

		assert.deepEqual(toolCalls, [
			{ id: "call_a", name: "read", arguments: { path: "a.txt" } },
			{ id: "call_b", name: "read", arguments: { path: "b.txt" } },
		]);
	});
});
