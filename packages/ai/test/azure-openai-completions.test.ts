import assert from "node:assert/strict";
import { test } from "vitest";
import { getModel, normalizeContext } from "../src/compat.ts";
import { azureProvider } from "../src/providers/azure.ts";
import type { AssistantMessage, StreamOptions } from "../src/types.ts";

interface Payload {
	model: string;
	messages: Array<{ role: string; content: string; reasoning_content?: string }>;
	reasoning_effort?: string;
	thinking?: object;
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
	temperature?: number;
}

const azure = azureProvider();
const model = getModel("azure", "deepseek-v4-pro");
const context = normalizeContext({ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }] });

function capture() {
	const requests: Array<{ url: string; payload: Payload }> = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		requests.push({ url: String(input), payload: JSON.parse(String(init?.body)) as Payload });
		return new Response(
			'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
			{
				status: 200,
				headers: { "content-type": "text/event-stream" },
			},
		);
	};
	const options: StreamOptions = {
		apiKey: "test-key",
		env: { AZURE_OPENAI_BASE_URL: "https://resource.services.ai.azure.com" },
		fetch,
		maxRetries: 0,
	};
	return { requests, options };
}

test("Azure DeepSeek uses reasoning_effort and omits rejected thinking/cache parameters (#9645)", async () => {
	const { requests, options } = capture();
	for (const reasoning of ["low", "medium", "high", "max"] as const) {
		const result = await azure
			.streamSimple(model, context, { ...options, reasoning, cacheRetention: "long", sessionId: "session" })
			.result();
		assert.equal(result.stopReason, "stop");
		const payload = requests.at(-1)!.payload;
		assert.equal(payload.reasoning_effort, reasoning === "max" ? "high" : reasoning);
		assert.equal(payload.thinking, undefined);
		assert.equal(payload.prompt_cache_key, undefined);
		assert.equal(payload.prompt_cache_retention, undefined);
		assert.deepEqual(payload.messages[0], { role: "system", content: "sys" });
	}
	await azure.streamSimple(model, context, options).result();
	assert.equal(requests.at(-1)!.payload.reasoning_effort, undefined);
});

test("Azure DeepSeek preserves reasoning and mid-conversation system messages (#9645)", async () => {
	const { requests, options } = capture();
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "answer" },
		],
		provider: "azure",
		api: "openai-completions",
		model: model.id,
		timestamp: 2,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
	const resumed = normalizeContext({
		systemPrompt: "first",
		messages: [
			{ role: "user", content: "hi", timestamp: 1 },
			assistant,
			{ role: "system", content: "second", timestamp: 3 },
			{ role: "user", content: "again", timestamp: 4 },
		],
	});
	const result = await azure.stream(model, resumed, options).result();
	assert.equal(result.stopReason, "stop");
	assert.equal(
		requests[0].payload.messages.find((message) => message.role === "assistant")?.reasoning_content,
		"internal reasoning",
	);
	assert.deepEqual(
		requests[0].payload.messages.map((message) => message.role),
		["system", "user", "assistant", "system", "user"],
	);
});

test("Azure completions resolves endpoint and deployment before caller payload hook (#9645)", async () => {
	const { requests, options } = capture();
	let seenModel: string | undefined;
	const result = await azure
		.stream(model, context, {
			...options,
			env: { ...options.env, AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "deepseek-v4-pro=my-deepseek" },
			onPayload: (payload) => {
				seenModel = (payload as Payload).model;
				return { ...(payload as object), temperature: 0.1 };
			},
		})
		.result();
	assert.equal(result.stopReason, "stop");
	assert.equal(requests[0].url, "https://resource.services.ai.azure.com/openai/v1/chat/completions");
	assert.equal(seenModel, "my-deepseek");
	assert.equal(requests[0].payload.model, "my-deepseek");
	assert.equal(requests[0].payload.temperature, 0.1);
	assert.equal(result.model, model.id);
	assert.equal(model.baseUrl, "");
	const simple = await azure
		.streamSimple(model, context, {
			...options,
			env: { AZURE_OPENAI_RESOURCE_NAME: "my-resource", AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "deepseek-v4-pro=mapped" },
		})
		.result();
	assert.equal(simple.stopReason, "stop");
	assert.equal(requests[1].url, "https://my-resource.openai.azure.com/openai/v1/chat/completions");
	assert.equal(requests[1].payload.model, "mapped");
});

test("Azure completions reports an unconfigured endpoint through the stream (#9645)", async () => {
	const { options } = capture();
	const result = await azure.stream(model, context, { ...options, env: {} }).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage!, /Azure OpenAI base URL is required/);
});

test("Azure provider dispatches Responses models to the unchanged Responses API (#9645)", async () => {
	const { requests, options } = capture();
	await azure.stream(getModel("azure", "gpt-4o-mini"), context, options).result();
	assert.match(requests[0].url, /\/responses\?api-version=v1$/);
});
