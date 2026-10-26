import "../helpers/provider-rate-limit-isolation.js";
import assert from "node:assert/strict";
import type { Model } from "@bastani/pi-ai";
import { stream as streamAnthropicMessages } from "@bastani/pi-ai/api/anthropic-messages";
import { stream as streamAzureOpenAIResponses } from "@bastani/pi-ai/api/azure-openai-responses";
import { stream as streamMistral } from "@bastani/pi-ai/api/mistral-conversations";
import { stream as streamOpenAICodexResponses } from "@bastani/pi-ai/api/openai-codex-responses";
import { stream as streamOpenAICompletions } from "@bastani/pi-ai/api/openai-completions";
import { stream as streamOpenAIResponses } from "@bastani/pi-ai/api/openai-responses";
import { stream as streamPiMessages } from "@bastani/pi-ai/api/pi-messages";
import { normalizeContext } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { normalizeModelFailureSignal } from "../../packages/coding-agent/src/core/model-fallback-failures.js";

const context = normalizeContext({ systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const base = {
	name: "Test Model",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
	id: "test-model",
} satisfies Pick<
	Model<"openai-responses">,
	"name" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens" | "id"
>;

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

/** A failing response whose body says nothing about rate limits or quotas, so only the status can classify it. */
function respond(status: number): typeof globalThis.fetch {
	const failing = async () =>
		new Response(JSON.stringify({ error: { message: "request refused", type: "error" } }), {
			status,
			headers: { "content-type": "application/json" },
		});
	return Object.assign(failing, { preconnect: globalThis.fetch.preconnect });
}

const providers = {
	"anthropic-messages": (fetch: typeof globalThis.fetch) =>
		streamAnthropicMessages(
			{
				...base,
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.test",
			} satisfies Model<"anthropic-messages">,
			context,
			{ apiKey: "k", maxRetries: 0, fetch },
		),
	"openai-completions": (fetch: typeof globalThis.fetch) =>
		streamOpenAICompletions(
			{
				...base,
				api: "openai-completions",
				provider: "openai",
				baseUrl: "https://api.openai.test/v1",
			} satisfies Model<"openai-completions">,
			context,
			{ apiKey: "k", maxRetries: 0, fetch },
		),
	"openai-responses": (fetch: typeof globalThis.fetch) =>
		streamOpenAIResponses(
			{
				...base,
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.test/v1",
			} satisfies Model<"openai-responses">,
			context,
			{ apiKey: "k", maxRetries: 0, fetch },
		),
	"azure-openai-responses": (fetch: typeof globalThis.fetch) =>
		streamAzureOpenAIResponses(
			{
				...base,
				api: "azure-openai-responses",
				provider: "azure-openai-responses",
				baseUrl: "https://example.openai.azure.com/openai/v1",
			} satisfies Model<"azure-openai-responses">,
			context,
			{ apiKey: "k", maxRetries: 0, fetch },
		),
	"openai-codex-responses": (fetch: typeof globalThis.fetch) =>
		streamOpenAICodexResponses(
			{
				...base,
				id: "gpt-5.6-sol",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
			} satisfies Model<"openai-codex-responses">,
			context,
			{ apiKey: codexToken(), transport: "sse", maxRetries: 0, fetch },
		),
	"mistral-conversations": (fetch: typeof globalThis.fetch) =>
		streamMistral(
			{
				...base,
				api: "mistral-conversations",
				provider: "mistral",
				baseUrl: "https://api.mistral.test",
			} satisfies Model<"mistral-conversations">,
			context,
			{ apiKey: "k", maxRetries: 0, fetch },
		),
	"pi-messages": (fetch: typeof globalThis.fetch) =>
		streamPiMessages(
			{
				...base,
				api: "pi-messages",
				provider: "pi-test",
				baseUrl: "https://api.pi.test/v1",
			} satisfies Model<"pi-messages">,
			context,
			{ apiKey: "k", maxRetries: 0, fetch },
		),
};

for (const [api, run] of Object.entries(providers)) {
	test.each([
		[429, "rate_limit"],
		[402, "quota_exhausted"],
	] as const)(`${api}: a %i failure classifies as %s from the returned message`, async (status, kind) => {
		const message = await run(respond(status)).result();
		assert.equal(message.stopReason, "error");
		assert.equal(normalizeModelFailureSignal(message).kind, kind, message.errorMessage);
	});
}
