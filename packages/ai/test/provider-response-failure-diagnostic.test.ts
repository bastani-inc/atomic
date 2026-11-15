import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { stream as streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Api, AssistantMessage, FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

function createModel<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl: "https://upstream.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

function answering(status: number, body: unknown): FetchFunction {
	// Pretty-printed, as Google sends its error bodies.
	return async () =>
		new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });
}

const failingFetch: FetchFunction = async () => {
	throw new TypeError("fetch failed");
};

const CODEX_TOKEN = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.x`;

type Turn = (fetch: FetchFunction) => Promise<AssistantMessage>;

const options = { apiKey: "test-key", maxRetries: 0 };

const TURNS: Readonly<Record<string, Turn>> = {
	"Google Gemini": (fetch) =>
		streamGoogleGenerativeAI(createModel("google-generative-ai"), context, { ...options, fetch }).result(),
	"Google Vertex": (fetch) =>
		streamGoogleVertex(createModel("google-vertex"), context, { ...options, fetch }).result(),
	Anthropic: (fetch) => streamAnthropic(createModel("anthropic-messages"), context, { ...options, fetch }).result(),
	"OpenAI Completions": (fetch) =>
		streamOpenAICompletions(createModel("openai-completions"), context, { ...options, fetch }).result(),
	"OpenAI Responses": (fetch) =>
		streamOpenAIResponses(createModel("openai-responses"), context, { ...options, fetch }).result(),
	"OpenAI Codex": (fetch) =>
		streamOpenAICodexResponses(createModel("openai-codex-responses"), context, {
			...options,
			apiKey: CODEX_TOKEN,
			fetch,
		}).result(),
	"Azure OpenAI Responses": (fetch) =>
		streamAzureOpenAIResponses(createModel("azure-openai-responses"), context, { ...options, fetch }).result(),
	Mistral: (fetch) => streamMistral(createModel("mistral-conversations"), context, { ...options, fetch }).result(),
};

function responseFailureDetails(message: AssistantMessage): unknown[] {
	return (message.diagnostics ?? [])
		.filter((diagnostic) => diagnostic.type === "provider_response_failure")
		.map((diagnostic) => diagnostic.details);
}

describe("provider_response_failure diagnostic", () => {
	it.each(["Google Gemini", "Google Vertex"])(
		"%s records the HTTP status and the provider status of an overloaded 503 (#4994)",
		async (adapter) => {
			const message = await TURNS[adapter](
				answering(503, {
					error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" },
				}),
			);

			assert.equal(message.stopReason, "error");
			assert.deepEqual(responseFailureDetails(message), [{ status: 503, errorCode: "UNAVAILABLE" }]);
		},
	);

	it.each(["Anthropic", "OpenAI Completions", "OpenAI Responses", "OpenAI Codex", "Azure OpenAI Responses", "Mistral"])(
		"%s records the HTTP status of a failed request (#4994)",
		async (adapter) => {
			const message = await TURNS[adapter](answering(503, { error: { message: "The model is overloaded." } }));

			assert.equal(message.stopReason, "error");
			assert.deepEqual(responseFailureDetails(message), [{ status: 503 }]);
		},
	);

	it.each(Object.keys(TURNS))("%s records nothing for a failure with no HTTP response (#4994)", async (adapter) => {
		const message = await TURNS[adapter](failingFetch);

		assert.equal(message.stopReason, "error");
		assert.deepEqual(responseFailureDetails(message), []);
	});
});
