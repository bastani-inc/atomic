import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const cloudflare520Body = JSON.stringify({
	type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-520/",
	title: "Error 520: Web server returned an unknown error",
	status: 520,
	detail: "The origin web server returned an empty, unknown, or unexpected response to Cloudflare.",
	error_code: 520,
	error_name: "web_server_unknown_error",
	retryable: true,
	retry_after: 45,
	ray_id: "8f4c3a2b1e0d9c8b",
});

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
});

const modelBase = {
	name: "Test Model",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} as const;

const responsesModel: Model<"openai-responses"> = {
	...modelBase,
	id: "test-model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.test/v1",
};

const completionsModel: Model<"openai-completions"> = {
	...modelBase,
	id: "test-model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.test/v1",
};

const codexModel: Model<"openai-codex-responses"> = {
	...modelBase,
	id: "gpt-5.6-sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
};

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function cloudflare520(headers: Record<string, string> = {}): typeof globalThis.fetch {
	return vi.fn(
		async () =>
			new Response(cloudflare520Body, { status: 520, headers: { "content-type": "application/json", ...headers } }),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test.each([
	[
		"openai-responses",
		() => streamOpenAIResponses(responsesModel, context, { apiKey: "k", maxRetries: 0, fetch: cloudflare520() }),
	],
	[
		"openai-completions",
		() => streamOpenAICompletions(completionsModel, context, { apiKey: "k", maxRetries: 0, fetch: cloudflare520() }),
	],
	[
		"openai-codex-responses",
		() =>
			streamOpenAICodexResponses(codexModel, context, {
				apiKey: codexToken(),
				transport: "sse",
				maxRetries: 0,
				fetch: cloudflare520(),
			}),
	],
] as const)("%s reports the Cloudflare 520 body retry_after as retryAfterMs (#3623)", async (_api, run) => {
	const result = await run().result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /520/);
	assert.equal(result.retryAfterMs, 45_000);
});

test("openai-responses takes the larger of Retry-After and the body retry_after (#3623)", async () => {
	const fetch = cloudflare520({ "retry-after": "90" });
	const result = await streamOpenAIResponses(responsesModel, context, { apiKey: "k", maxRetries: 0, fetch }).result();
	assert.equal(result.retryAfterMs, 90_000);
});

test("openai-responses keeps a top-level retry_after next to a body error object (#3623)", async () => {
	const fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ error: { message: "upstream unavailable" }, retry_after: 30 }), {
				status: 503,
				headers: { "content-type": "application/json" },
			}),
	);
	const result = await streamOpenAIResponses(responsesModel, context, { apiKey: "k", maxRetries: 0, fetch }).result();
	assert.equal(result.retryAfterMs, 30_000);
});

test("openai-completions reads Retry-After-Ms and Retry-After headers from a 503 without a body hint (#3623)", async () => {
	const respond = (headers: Record<string, string>) =>
		vi.fn(async () => new Response("upstream unavailable", { status: 503, headers }));
	const fromMs = await streamOpenAICompletions(completionsModel, context, {
		apiKey: "k",
		maxRetries: 0,
		fetch: respond({ "retry-after-ms": "2500" }),
	}).result();
	assert.equal(fromMs.retryAfterMs, 2500);
	const fromSeconds = await streamOpenAICompletions(completionsModel, context, {
		apiKey: "k",
		maxRetries: 0,
		fetch: respond({ "retry-after": "12" }),
	}).result();
	assert.equal(fromSeconds.retryAfterMs, 12_000);
});

test("openai-codex-responses ignores a non-JSON 520 page without a hint (#3623)", async () => {
	const fetch = vi.fn(
		async () => new Response("<html><title>520: Web server is returning an unknown error</title></html>", { status: 520 }),
	);
	const result = await streamOpenAICodexResponses(codexModel, context, {
		apiKey: codexToken(),
		transport: "sse",
		maxRetries: 0,
		fetch,
	}).result();
	assert.equal(result.stopReason, "error");
	assert.equal(result.retryAfterMs, undefined);
});
