import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import { parseGitHubCopilotDiscoveredModels } from "../src/providers/github-copilot.ts";
import {
	GitHubCopilotAuthenticationError,
	GitHubCopilotContentFilterError,
	GitHubCopilotEmptyResponseError,
	type GitHubCopilotError,
	GitHubCopilotInvalidRequestError,
	GitHubCopilotModelUnavailableError,
	GitHubCopilotPromptTooLargeError,
	GitHubCopilotQuotaExhaustedError,
	GitHubCopilotRateLimitError,
	GitHubCopilotServiceUnavailableError,
	GitHubCopilotStreamEndedEarlyError,
	GitHubCopilotUnrecognizedResponseError,
	getGitHubCopilotError,
} from "../src/providers/github-copilot-errors.ts";
import type { Api, AssistantMessage, Context, Model, Tool, ToolCall, Usage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import {
	CHAT_CONTENT_FILTER_TURN,
	CHAT_TRUNCATED_TURN,
	chatChunk,
	chatErrorChunk,
	GEMINI_EMPTY_TURN,
	GEMINI_OPAQUE_REASONING,
	GEMINI_PARALLEL_TOOL_TURN,
	GEMINI_TEXT_TURN,
	GROK_ENCRYPTED_REASONING,
	GROK_PARALLEL_TOOL_TURN,
	GROK_TEXT_TURN,
	KIMI_SPLIT_ARGUMENTS_TOOL_TURN,
	KIMI_TEXT_TURN,
	VENDOR_PARALLEL_TOOL_TURN,
	VENDOR_TEXT_TURN,
	RESPONSES_CONTENT_FILTER_TURN,
	RESPONSES_EMPTY_TURN,
	RESPONSES_TRUNCATED_TURN,
	responsesErrorEvents,
	responsesFailedEvents,
	sseBody,
	type WireEvent,
} from "./fixtures/github-copilot-wire.ts";

const API_KEY = "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com";

const tools: Tool[] = [
	{
		name: "get_weather",
		description: "Weather for a city",
		parameters: {
			type: "object",
			properties: { city: { type: "string" } },
			required: ["city"],
		} as Tool["parameters"],
	},
	{ name: "ping", description: "Ping", parameters: { type: "object", properties: {} } as Tool["parameters"] },
];

const userTurn: Context = {
	systemPrompt: "Use tools.",
	messages: [{ role: "user", content: "Weather in Paris, and ping.", timestamp: 0 }],
	tools,
};

const recordedModels: unknown = JSON.parse(
	readFileSync(new URL("./fixtures/github-copilot-models.json", import.meta.url), "utf8"),
);

function discovered(id: string): Model<Api> {
	const model = parseGitHubCopilotDiscoveredModels(recordedModels, []).find((candidate) => candidate.id === id);
	if (!model) throw new Error(`Expected ${id} to be discovered`);
	return model;
}

function catalogModel(id: string): Model<Api> {
	const model = getModel("github-copilot", id as never) as Model<Api> | undefined;
	if (!model) throw new Error(`Expected github-copilot/${id} in the built-in catalog`);
	return model;
}

interface UsageExpectation {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly reasoning: number;
	readonly totalTokens: number;
}

interface Family {
	readonly family: string;
	readonly model: () => Model<Api>;
	readonly api: "openai-completions" | "openai-responses";
	readonly textTurn: readonly WireEvent[];
	readonly textUsage: UsageExpectation;
	readonly toolTurn: readonly WireEvent[];
	readonly toolUsage: UsageExpectation;
	readonly toolCallIds: readonly string[];
	readonly toolCity: string;
	/** What the next request carries back from the tool turn's reasoning. */
	readonly replay: "reasoning_opaque" | "reasoning_text" | "encrypted-reasoning-item" | "none";
}

const GEMINI_USAGE = {
	text: { input: 61, output: 30, cacheRead: 0, reasoning: 22, totalTokens: 91 },
	tool: { input: 38, output: 64, cacheRead: 0, reasoning: 40, totalTokens: 102 },
};
const GEMINI_CALL_IDS = ["call_Rml4dHVyZUNhbGxPbmU", "call_Rml4dHVyZUNhbGxUd28"];
const GROK_CALL_IDS = [
	"call-0f1e2d3c-4b5a-4968-8776-655443322110-0|R3Jva0l0ZW1GaXh0dXJlT25l+/aGVsbG8vd29ybGQ+cGx1cw==",
	"call-0f1e2d3c-4b5a-4968-8776-655443322110-1|R3Jva0l0ZW1GaXh0dXJlVHdv+/c2Vjb25kL2l0ZW0+cGx1cw==",
];
const VENDOR_USAGE = {
	text: { input: 950, output: 6, cacheRead: 0, reasoning: 0, totalTokens: 956 },
	tool: { input: 900, output: 40, cacheRead: 0, reasoning: 0, totalTokens: 940 },
};
const VENDOR_CALL_IDS = ["call_vendor_fixture_0|fc_vendor_fixture_0", "call_vendor_fixture_1|fc_vendor_fixture_1"];

const FAMILIES: readonly Family[] = [
	{
		family: "Gemini (gemini-4-argon)",
		model: () => catalogModel("gemini-4-argon"),
		api: "openai-completions",
		textTurn: GEMINI_TEXT_TURN,
		textUsage: GEMINI_USAGE.text,
		toolTurn: GEMINI_PARALLEL_TOOL_TURN,
		toolUsage: GEMINI_USAGE.tool,
		toolCallIds: GEMINI_CALL_IDS,
		toolCity: "Paris",
		replay: "reasoning_opaque",
	},
	{
		family: "Gemini (gemini-3.8-flash)",
		model: () => catalogModel("gemini-3.8-flash"),
		api: "openai-completions",
		textTurn: GEMINI_TEXT_TURN,
		textUsage: GEMINI_USAGE.text,
		toolTurn: GEMINI_PARALLEL_TOOL_TURN,
		toolUsage: GEMINI_USAGE.tool,
		toolCallIds: GEMINI_CALL_IDS,
		toolCity: "Paris",
		replay: "reasoning_opaque",
	},
	{
		family: "Kimi (kimi-k3)",
		model: () => catalogModel("kimi-k3"),
		api: "openai-completions",
		textTurn: KIMI_TEXT_TURN,
		textUsage: { input: 70, output: 5, cacheRead: 0, reasoning: 0, totalTokens: 75 },
		toolTurn: KIMI_SPLIT_ARGUMENTS_TOOL_TURN,
		toolUsage: { input: 40, output: 30, cacheRead: 10, reasoning: 12, totalTokens: 80 },
		toolCallIds: ["call_kimi_fixture_0", "call_kimi_fixture_1"],
		toolCity: "Rome",
		replay: "reasoning_text",
	},
	{
		family: "Grok (grok-4.7)",
		model: () => catalogModel("grok-4.7"),
		api: "openai-responses",
		textTurn: GROK_TEXT_TURN,
		textUsage: { input: 1800, output: 30, cacheRead: 0, reasoning: 12, totalTokens: 1830 },
		toolTurn: GROK_PARALLEL_TOOL_TURN,
		toolUsage: { input: 220, output: 44, cacheRead: 1536, reasoning: 28, totalTokens: 1800 },
		toolCallIds: GROK_CALL_IDS,
		toolCity: "Paris",
		replay: "encrypted-reasoning-item",
	},
	{
		family: "synthetic Responses model",
		model: () => ({ ...catalogModel("grok-4.5"), id: "vendor-model-a", name: "Vendor model A" }),
		api: "openai-responses",
		textTurn: VENDOR_TEXT_TURN,
		textUsage: VENDOR_USAGE.text,
		toolTurn: VENDOR_PARALLEL_TOOL_TURN,
		toolUsage: VENDOR_USAGE.tool,
		toolCallIds: VENDOR_CALL_IDS,
		toolCity: "Rome",
		replay: "none",
	},
	{
		family: "discovered Chat Completions model",
		model: () => discovered("example-chat-model"),
		api: "openai-completions",
		textTurn: GEMINI_TEXT_TURN,
		textUsage: GEMINI_USAGE.text,
		toolTurn: GEMINI_PARALLEL_TOOL_TURN,
		toolUsage: GEMINI_USAGE.tool,
		toolCallIds: GEMINI_CALL_IDS,
		toolCity: "Paris",
		replay: "reasoning_opaque",
	},
	{
		family: "discovered Responses model",
		model: () => discovered("example-model"),
		api: "openai-responses",
		textTurn: VENDOR_TEXT_TURN,
		textUsage: VENDOR_USAGE.text,
		toolTurn: VENDOR_PARALLEL_TOOL_TURN,
		toolUsage: VENDOR_USAGE.tool,
		toolCallIds: VENDOR_CALL_IDS,
		toolCity: "Rome",
		replay: "none",
	},
];

interface RecordedRequest {
	readonly url: string;
	readonly body: Record<string, unknown>;
}

/** A fetch that answers each request with the next response and records what was sent. */
function scriptedFetch(responses: readonly (() => Response)[]): {
	fetch: typeof globalThis.fetch;
	requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	let next = 0;
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		requests.push({ url: request.url, body: JSON.parse(await request.text()) as Record<string, unknown> });
		const respond = responses[next++];
		if (!respond) throw new Error("No scripted response left");
		return respond();
	};
	return { fetch, requests };
}

function streamResponse(family: Family, events: readonly WireEvent[]): () => Response {
	return () =>
		new Response(sseBody(events, { done: family.api === "openai-completions" }), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
}

async function run(
	model: Model<Api>,
	context: Context,
	responses: readonly (() => Response)[],
	signal?: AbortSignal,
): Promise<{ message: AssistantMessage; requests: RecordedRequest[] }> {
	const scripted = scriptedFetch(responses);
	const message = await streamSimple(model, context, {
		apiKey: API_KEY,
		fetch: scripted.fetch,
		maxRetries: 0,
		reasoning: "low",
		...(signal ? { signal } : {}),
	}).result();
	return { message, requests: scripted.requests };
}

function usageOf(usage: Usage): UsageExpectation {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		reasoning: usage.reasoning ?? -1,
		totalTokens: usage.totalTokens,
	};
}

function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function followUp(first: AssistantMessage): Context {
	return {
		...userTurn,
		messages: [
			...userTurn.messages,
			first,
			...toolCalls(first).map((call) => ({
				role: "toolResult" as const,
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text" as const, text: `ok:${call.name}` }],
				isError: false,
				timestamp: 0,
			})),
		],
	};
}

function emptyTurn(family: Family): readonly WireEvent[] {
	return family.api === "openai-completions" ? GEMINI_EMPTY_TURN : RESPONSES_EMPTY_TURN;
}

describe.each(FAMILIES)("GitHub Copilot $family recorded fixtures (#4324)", (family) => {
	it("routes to its API and streams text with the final usage", async () => {
		const model = family.model();
		assert.equal(model.api, family.api);
		const { message, requests } = await run(model, userTurn, [streamResponse(family, family.textTurn)]);

		assert.equal(message.stopReason, "stop");
		assert.equal(message.errorMessage, undefined);
		assert.match(message.content.find((block) => block.type === "text")?.text ?? "", /\w+ is \w+/);
		assert.deepEqual(usageOf(message.usage), family.textUsage);
		assert.equal(requests.length, 1);
		assert.ok(
			requests[0]?.url.endsWith(family.api === "openai-completions" ? "/chat/completions" : "/responses"),
			requests[0]?.url,
		);
		assert.equal(requests[0]?.body.model, model.id);
	});

	it("runs a parallel tool loop with a no-argument call and streamed argument deltas", async () => {
		const model = family.model();
		const first = await run(model, userTurn, [streamResponse(family, family.toolTurn)]);
		const calls = toolCalls(first.message);

		assert.equal(first.message.stopReason, "toolUse");
		assert.deepEqual(
			calls.map((call) => [call.id, call.name, call.arguments]),
			[
				[family.toolCallIds[0], "get_weather", { city: family.toolCity }],
				[family.toolCallIds[1], "ping", {}],
			],
		);
		assert.deepEqual(usageOf(first.message.usage), family.toolUsage);

		const second = await run(model, followUp(first.message), [streamResponse(family, family.textTurn)]);
		assert.equal(second.message.stopReason, "stop");
		const body = second.requests[0]?.body;
		if (family.api === "openai-completions") {
			const messages = body?.messages as Array<Record<string, unknown>>;
			const assistant = messages.find((entry) => entry.role === "assistant");
			assert.deepEqual(
				((assistant?.tool_calls ?? []) as Array<{ id: string; function: { arguments: string } }>).map((call) => [
					call.id,
					call.function.arguments,
				]),
				[
					[family.toolCallIds[0], JSON.stringify(calls[0]?.arguments)],
					[family.toolCallIds[1], "{}"],
				],
			);
			assert.deepEqual(
				messages.filter((entry) => entry.role === "tool").map((entry) => entry.tool_call_id),
				family.toolCallIds,
			);
		} else {
			const input = body?.input as Array<Record<string, unknown>>;
			const callIds = input.filter((item) => item.type === "function_call").map((item) => item.call_id);
			const outputIds = input.filter((item) => item.type === "function_call_output").map((item) => item.call_id);
			assert.equal(callIds.length, 2);
			assert.deepEqual(outputIds, callIds);
			for (const callId of callIds) assert.match(String(callId), /^[A-Za-z0-9_-]{1,64}$/);
			assert.equal(new Set(callIds).size, 2);
		}
	});

	it("round-trips its reasoning to the same model on the next turn", async () => {
		const model = family.model();
		const first = await run(model, userTurn, [streamResponse(family, family.toolTurn)]);
		const second = await run(model, followUp(first.message), [streamResponse(family, family.textTurn)]);
		const body = second.requests[0]?.body ?? {};
		const assistant = (body.messages as Array<Record<string, unknown>> | undefined)?.find(
			(entry) => entry.role === "assistant",
		);
		const reasoningItems = ((body.input as Array<Record<string, unknown>> | undefined) ?? []).filter(
			(item) => item.type === "reasoning",
		);

		switch (family.replay) {
			case "reasoning_opaque": {
				const thinking = first.message.content.find((block) => block.type === "thinking");
				assert.deepEqual(thinking, {
					type: "thinking",
					thinking: "",
					redacted: true,
					thinkingSignature: `reasoning_opaque:${GEMINI_OPAQUE_REASONING}`,
				});
				assert.equal(assistant?.reasoning_opaque, GEMINI_OPAQUE_REASONING);
				break;
			}
			case "reasoning_text":
				assert.equal(assistant?.reasoning_text, "Two lookups are needed.");
				assert.equal(assistant?.reasoning_opaque, undefined);
				break;
			case "encrypted-reasoning-item":
				assert.deepEqual(
					reasoningItems.map((item) => item.encrypted_content),
					[GROK_ENCRYPTED_REASONING],
				);
				break;
			case "none":
				assert.equal(
					first.message.content.some((block) => block.type === "thinking"),
					false,
				);
				assert.equal(reasoningItems.length, 0);
				assert.equal(assistant?.reasoning_opaque, undefined);
				break;
		}

		// Another model never receives this model's reasoning.
		const other: Model<Api> = { ...model, id: `${model.id}-other` };
		const crossModel = await run(other, followUp(first.message), [streamResponse(family, family.textTurn)]);
		const crossBody = crossModel.requests[0]?.body ?? {};
		const crossAssistant = (crossBody.messages as Array<Record<string, unknown>> | undefined)?.find(
			(entry) => entry.role === "assistant",
		);
		assert.equal(crossAssistant?.reasoning_opaque, undefined);
		assert.equal(
			((crossBody.input as Array<Record<string, unknown>> | undefined) ?? []).some(
				(item) => item.type === "reasoning",
			),
			false,
		);
	});

	it("fails an empty turn as a retryable empty-response error", async () => {
		const { message } = await run(family.model(), userTurn, [streamResponse(family, emptyTurn(family))]);
		const error = getGitHubCopilotError(message);

		assert.equal(message.stopReason, "error");
		assert.ok(error instanceof GitHubCopilotEmptyResponseError);
		assert.equal(error.code, "empty-response");
		assert.equal(error.retryable, true);
		assert.equal(isRetryableAssistantError(message), true);
		assert.equal(isContextOverflow(message, family.model().contextWindow), false);
	});

	it.each(errorCases(family))("types $name", async (errorCase) => {
		const model = family.model();
		const { message } = await run(model, userTurn, [errorCase.respond]);
		const error = getGitHubCopilotError(message);

		assert.equal(message.stopReason, "error");
		assert.ok(error instanceof errorCase.type, `${error?.name}: ${message.errorMessage}`);
		assert.equal(error.code, errorCase.code);
		assert.equal(error.retryable, errorCase.retryable);
		assert.equal(error.modelId, model.id);
		assert.equal(error.api, family.api);
		assert.deepEqual(pick(error.fields(), Object.keys(errorCase.fields)), errorCase.fields);
		assert.equal(isRetryableAssistantError(message), errorCase.retryable);
		assert.equal(isContextOverflow(message, model.contextWindow), errorCase.code === "prompt-too-large");
		assert.ok(message.errorMessage?.startsWith(error.message), message.errorMessage);
	});

	it("never types a cancelled request", async () => {
		const controller = new AbortController();
		const responses = [
			() => {
				controller.abort();
				return streamResponse(family, family.textTurn)();
			},
		];
		const { message } = await run(family.model(), userTurn, responses, controller.signal);

		assert.equal(message.stopReason, "aborted");
		assert.equal(getGitHubCopilotError(message), undefined);
		assert.equal(message.diagnostics, undefined);
	});
});

function pick(fields: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(keys.map((key) => [key, fields[key]]));
}

interface ErrorCase {
	readonly name: string;
	readonly respond: () => Response;
	readonly type: abstract new (...args: never[]) => GitHubCopilotError;
	readonly code: GitHubCopilotError["code"];
	readonly retryable: boolean;
	readonly fields: Readonly<Record<string, string | number | null>>;
}

function jsonError(status: number, error: Record<string, unknown>, headers?: Record<string, string>): () => Response {
	return () =>
		new Response(JSON.stringify({ error }), {
			status,
			// Copilot labels JSON error bodies as plain text.
			headers: { "content-type": "text/plain; charset=utf-8", "x-request-id": "req-fixture-1", ...headers },
		});
}

function plainError(status: number, text: string): () => Response {
	return () => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function errorCases(family: Family): ErrorCase[] {
	const chat = family.api === "openai-completions";
	const stream = (events: readonly WireEvent[]) => streamResponse(family, events);
	const malformed = () =>
		new Response(`data: {"choices": [\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	return [
		{
			name: "a model unavailable to the integration (HTTP 400 code)",
			respond: jsonError(400, {
				message: 'The requested model is not available for integrator "vscode-chat".',
				code: "model_not_available_for_integrator",
				param: "model",
				type: "invalid_request_error",
			}),
			type: GitHubCopilotModelUnavailableError,
			code: "model-unavailable",
			retryable: false,
			fields: {
				reason: "integration",
				status: 400,
				providerCode: "model_not_available_for_integrator",
				requestId: "req-fixture-1",
			},
		},
		{
			name: "an unknown model ID",
			respond: jsonError(400, {
				message: "The requested model is not supported.",
				code: "model_not_supported",
				type: "invalid_request_error",
			}),
			type: GitHubCopilotModelUnavailableError,
			code: "model-unavailable",
			retryable: false,
			fields: { reason: "not-supported", detail: "The requested model is not supported." },
		},
		{
			name: "a model called on the wrong API",
			respond: jsonError(400, { message: "model is not supported via this API", code: "unsupported_api_for_model" }),
			type: GitHubCopilotModelUnavailableError,
			code: "model-unavailable",
			retryable: false,
			fields: { reason: "wrong-api" },
		},
		{
			name: "a model with no endpoint for the account (plain text)",
			respond: plainError(400, "no model endpoints available given user constraints\n"),
			type: GitHubCopilotModelUnavailableError,
			code: "model-unavailable",
			retryable: false,
			fields: { reason: "no-endpoint", providerCode: null },
		},
		{
			name: "an unknown integration ID (plain text)",
			respond: plainError(400, "bad request: unknown Copilot-Integration-Id"),
			type: GitHubCopilotInvalidRequestError,
			code: "invalid-request",
			retryable: false,
			fields: { reason: "integration-id" },
		},
		{
			name: "a malformed plain-text rejection",
			respond: plainError(400, "Bad Request"),
			type: GitHubCopilotInvalidRequestError,
			code: "invalid-request",
			retryable: false,
			fields: { reason: "rejected", detail: "Bad Request" },
		},
		{
			name: "an unsupported reasoning effort",
			respond: jsonError(400, {
				message: "invalid reasoning effort: supported values are [low medium high]",
				code: "invalid_reasoning_effort",
			}),
			type: GitHubCopilotInvalidRequestError,
			code: "invalid-request",
			retryable: false,
			fields: { reason: "reasoning-effort" },
		},
		{
			name: "a prompt over the model's prompt-token limit",
			respond: jsonError(400, {
				message: "prompt token count of 209736 exceeds the limit of 128000",
				code: "model_max_prompt_tokens_exceeded",
			}),
			type: GitHubCopilotPromptTooLargeError,
			code: "prompt-too-large",
			retryable: false,
			fields: { promptTokens: 209_736, limitTokens: 128_000 },
		},
		{
			name: "a request too large to parse (HTTP 413)",
			respond: jsonError(413, { message: "failed to parse request", code: "" }),
			type: GitHubCopilotPromptTooLargeError,
			code: "prompt-too-large",
			retryable: false,
			fields: { status: 413, promptTokens: null, limitTokens: null },
		},
		{
			name: "a policy refusal (HTTP 422 cyber_policy)",
			respond: jsonError(422, { message: "This content was flagged.", code: "cyber_policy" }),
			type: GitHubCopilotContentFilterError,
			code: "content-filtered",
			retryable: false,
			fields: { status: 422, providerCode: "cyber_policy" },
		},
		{
			name: "a rate limit with Retry-After",
			respond: jsonError(429, { message: "Rate limit exceeded", code: "rate_limited" }, { "retry-after": "7" }),
			type: GitHubCopilotRateLimitError,
			code: "rate-limited",
			retryable: true,
			fields: { status: 429, retryAfterMs: 7000 },
		},
		{
			name: "an exhausted quota (HTTP 429 insufficient_quota)",
			respond: jsonError(429, { message: "You exceeded your quota.", code: "insufficient_quota" }),
			type: GitHubCopilotQuotaExhaustedError,
			code: "quota-exhausted",
			retryable: false,
			fields: { providerCode: "insufficient_quota" },
		},
		{
			name: "a used-up monthly quota (HTTP 429, plain text)",
			respond: () =>
				new Response("quota exceeded", {
					status: 429,
					headers: {
						"content-type": "text/plain; charset=utf-8",
						"x-ratelimit-exceeded": "quota_exceeded",
						"retry-after": "228711",
					},
				}),
			type: GitHubCopilotQuotaExhaustedError,
			code: "quota-exhausted",
			retryable: false,
			fields: { status: 429, detail: "quota exceeded", providerCode: null },
		},
		{
			name: "Copilot's prompt-token overflow text without a code",
			respond: jsonError(400, { message: "prompt token count of 130000 exceeds the limit of 128000" }),
			type: GitHubCopilotPromptTooLargeError,
			code: "prompt-too-large",
			retryable: false,
			fields: { status: 400, providerCode: null, promptTokens: 130_000, limitTokens: 128_000 },
		},
		{
			name: "an exhausted quota (HTTP 402)",
			respond: jsonError(402, { message: "Payment required" }),
			type: GitHubCopilotQuotaExhaustedError,
			code: "quota-exhausted",
			retryable: false,
			fields: { status: 402 },
		},
		{
			name: "a refused credential (HTTP 401)",
			respond: plainError(401, "unauthorized: token expired"),
			type: GitHubCopilotAuthenticationError,
			code: "authentication-failed",
			retryable: false,
			fields: { status: 401 },
		},
		{
			name: "an overloaded service (HTTP 529)",
			respond: plainError(529, "overloaded"),
			type: GitHubCopilotServiceUnavailableError,
			code: "service-unavailable",
			retryable: true,
			fields: { status: 529 },
		},
		{
			name: "an unknown HTTP status",
			respond: plainError(302, "moved"),
			type: GitHubCopilotUnrecognizedResponseError,
			code: "unrecognized-response",
			retryable: true,
			fields: { reason: "unknown-status", status: 302 },
		},
		{
			name: "an in-stream error event with a known code",
			respond: chat
				? stream([chatErrorChunk("rate_limit_exceeded", "Slow down")])
				: stream(responsesErrorEvents("rate_limit_exceeded", "Slow down")),
			type: GitHubCopilotRateLimitError,
			code: "rate-limited",
			retryable: true,
			fields: { status: null, providerCode: "rate_limit_exceeded" },
		},
		{
			name: "an in-stream error event with an unknown code",
			respond: chat
				? stream([chatErrorChunk("fixture_unknown", "Something odd")])
				: stream(responsesFailedEvents("fixture_unknown", "Something odd")),
			type: GitHubCopilotUnrecognizedResponseError,
			code: "unrecognized-response",
			retryable: true,
			fields: { reason: "unknown-error-event", providerCode: "fixture_unknown" },
		},
		{
			name: "a content-filter stop",
			respond: stream(chat ? CHAT_CONTENT_FILTER_TURN : RESPONSES_CONTENT_FILTER_TURN),
			type: GitHubCopilotContentFilterError,
			code: "content-filtered",
			retryable: false,
			fields: { status: null, providerCode: null },
		},
		{
			name: "a stream that ends before its finish reason",
			respond: stream(chat ? CHAT_TRUNCATED_TURN : RESPONSES_TRUNCATED_TURN),
			type: GitHubCopilotStreamEndedEarlyError,
			code: "stream-ended-early",
			retryable: true,
			fields: { status: null },
		},
		{
			name: "a malformed stream event",
			respond: malformed,
			type: GitHubCopilotUnrecognizedResponseError,
			code: "unrecognized-response",
			retryable: true,
			fields: { reason: "malformed-body" },
		},
	];
}

describe("GitHub Copilot failures on every API surface (#4324)", () => {
	const claude = () => discovered("example-messages-model");
	const messagesStart = () =>
		new Response(
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_fixture",
					role: "assistant",
					content: [],
					usage: { input_tokens: 5, output_tokens: 0 },
				},
			})}\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);

	it("types a Claude model unavailable to the integration on Messages (#3998)", async () => {
		const { message } = await run(claude(), userTurn, [
			jsonError(400, {
				message: 'The requested model is not available for integrator "vscode-chat".',
				code: "model_not_available_for_integrator",
				type: "invalid_request_error",
			}),
		]);
		const error = getGitHubCopilotError(message);
		assert.ok(error instanceof GitHubCopilotModelUnavailableError, message.errorMessage);
		assert.equal(error.reason, "integration");
		assert.equal(error.api, "anthropic-messages");
		assert.equal(error.requestId, "req-fixture-1");
	});

	const messagesStop = (stopReason: string, explanation?: string) => () =>
		new Response(
			[
				`event: message_start\ndata: ${JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_fixture",
						role: "assistant",
						content: [],
						usage: { input_tokens: 5, output_tokens: 0 },
					},
				})}`,
				`event: message_delta\ndata: ${JSON.stringify({
					type: "message_delta",
					delta: {
						stop_reason: stopReason,
						...(explanation === undefined ? {} : { stop_details: { type: "refusal", explanation } }),
					},
					usage: { output_tokens: 0 },
				})}`,
				`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
			].join("\n\n") + "\n\n",
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);

	it.each([
		["refusal", undefined, "The model refused to complete the request"],
		["refusal", "This request violates the usage policy.", "This request violates the usage policy."],
		["sensitive", undefined, "Provider stopped with: sensitive"],
	])("types a Claude %s stop on Messages as a content-filter refusal", async (stopReason, explanation, detail) => {
		const { message } = await run(claude(), userTurn, [messagesStop(stopReason, explanation)]);
		const error = getGitHubCopilotError(message);
		assert.equal(message.stopReason, "error");
		assert.equal(message.rawStopReason, stopReason);
		assert.ok(error instanceof GitHubCopilotContentFilterError, message.errorMessage);
		assert.equal(error.retryable, false);
		assert.equal(error.detail, detail);
		assert.equal(isRetryableAssistantError(message), false);
	});

	it.each([
		["Messages", () => discovered("example-messages-model"), "prompt is too long: 213462 tokens > 200000 maximum"],
		["Messages", () => discovered("example-messages-model"), "Input is too long for requested model."],
		["Responses", () => discovered("example-model"), "Your input exceeds the context window of this model."],
		[
			"Chat Completions",
			() => discovered("example-chat-model"),
			"Your input exceeds the context window of this model.",
		],
	])("still detects an uncoded %s overflow text as context overflow: %s", async (_api, model, text) => {
		const target = model();
		const { message } = await run(target, userTurn, [jsonError(400, { message: text })]);
		const error = getGitHubCopilotError(message);
		assert.ok(error instanceof GitHubCopilotInvalidRequestError, message.errorMessage);
		assert.equal(error.reason, "rejected");
		assert.equal(isContextOverflow(message, target.contextWindow), true);
	});

	it("types a Messages stream cut off after it started", async () => {
		const { message } = await run(claude(), userTurn, [messagesStart]);
		assert.ok(getGitHubCopilotError(message) instanceof GitHubCopilotStreamEndedEarlyError, message.errorMessage);
	});

	it.each([
		["Chat Completions", () => discovered("example-chat-model")],
		["Responses", () => discovered("example-model")],
		["Messages", () => discovered("example-messages-model")],
	])("leaves a %s connection failure before Copilot answers to the generic network handling", async (_api, model) => {
		const scripted = scriptedFetch([
			() => {
				throw new TypeError("fetch failed");
			},
		]);
		const message = await streamSimple(model(), userTurn, {
			apiKey: API_KEY,
			fetch: scripted.fetch,
			maxRetries: 0,
		}).result();
		assert.equal(message.stopReason, "error");
		assert.equal(getGitHubCopilotError(message), undefined);
		assert.equal(
			message.diagnostics?.some((diagnostic) => diagnostic.type === "github_copilot_error") ?? false,
			false,
		);
	});

	it.each([
		["Chat Completions", () => discovered("example-chat-model")],
		["Responses", () => discovered("example-model")],
		["Messages", () => discovered("example-messages-model")],
	])("never types another provider's %s failure", async (_api, model) => {
		const { message } = await run({ ...model(), provider: "fixture-provider" }, userTurn, [
			jsonError(400, { message: "Rejected", code: "model_not_supported" }),
		]);
		assert.equal(message.stopReason, "error");
		assert.equal(getGitHubCopilotError(message), undefined);
		assert.ok(message.errorMessage?.includes("Rejected"), message.errorMessage);
	});

	it.each([
		["Chat Completions", () => discovered("example-chat-model"), GEMINI_EMPTY_TURN, true],
		["Responses", () => discovered("example-model"), RESPONSES_EMPTY_TURN, false],
	] as const)("finishes another provider's empty %s turn normally", async (_api, model, events, done) => {
		const { message } = await run({ ...model(), provider: "fixture-provider" }, userTurn, [
			() =>
				new Response(sseBody(events, { done }), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		]);
		assert.equal(message.stopReason, "stop");
		assert.equal(getGitHubCopilotError(message), undefined);
	});
});

describe("GitHub Copilot Chat Completions reasoning and usage details (#4324)", () => {
	const gemini = () => discovered("example-chat-model");
	const chatStream = (events: readonly WireEvent[]) => () =>
		new Response(sseBody(events), { status: 200, headers: { "content-type": "text/event-stream" } });

	async function streamEvents(events: readonly WireEvent[]) {
		const scripted = scriptedFetch([chatStream(events)]);
		const stream = streamSimple(gemini(), userTurn, { apiKey: API_KEY, fetch: scripted.fetch, maxRetries: 0 });
		const seen: string[] = [];
		for await (const event of stream) {
			if ("contentIndex" in event) seen.push(`${event.type}:${event.contentIndex}`);
		}
		return { message: await stream.result(), seen };
	}

	it("joins opaque reasoning streamed in pieces into one redacted block and ignores empty pieces", async () => {
		const { message, seen } = await streamEvents([
			chatChunk({ content: "Hi", reasoning_opaque: "part-one/" }),
			chatChunk({ content: null, reasoning_opaque: "" }),
			chatChunk({ content: null, reasoning_opaque: "part-two" }, { finish: "stop" }),
		]);
		assert.equal(message.stopReason, "stop");
		assert.deepEqual(message.content, [
			{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "reasoning_opaque:part-one/part-two" },
			{ type: "text", text: "Hi" },
		]);
		assert.deepEqual(
			seen.filter((entry) => entry.startsWith("thinking")),
			["thinking_start:0", "thinking_end:0"],
		);
	});

	it("adds no reasoning block for an empty opaque value", async () => {
		const { message } = await streamEvents([chatChunk({ content: "ok", reasoning_opaque: "" }, { finish: "stop" })]);
		assert.deepEqual(message.content, [{ type: "text", text: "ok" }]);
	});

	it("keeps the opaque value apart from reasoning details in the same stream", async () => {
		const detail = { type: "reasoning.text", text: "why", format: "fixture-format", index: 0 };
		const { message } = await streamEvents([
			chatChunk({ content: null, reasoning_details: [detail], reasoning_opaque: "blob" }),
			chatChunk({ content: "Done" }, { finish: "stop" }),
		]);
		const thinking = message.content.filter((block) => block.type === "thinking");
		assert.deepEqual(
			thinking.map((block) => block.thinkingSignature),
			["reasoning_opaque:blob", JSON.stringify([detail])],
		);
	});

	it("sends the opaque value back even after readable reasoning, and only when there is one", async () => {
		const model = gemini();
		const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "first", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "readable plan" },
					{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "reasoning_opaque:blob-1" },
					{ type: "text", text: "first answer" },
				]),
				{ role: "user", content: "second", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "plain plan" },
					{ type: "text", text: "second answer" },
				]),
				{ role: "user", content: "third", timestamp: 0 },
			],
		};
		const { requests } = await run(model, context, [chatStream(GEMINI_TEXT_TURN)]);
		const assistants = ((requests[0]?.body.messages ?? []) as Array<Record<string, unknown>>).filter(
			(entry) => entry.role === "assistant",
		);
		assert.equal(assistants.length, 2);
		assert.equal(assistants[0]?.reasoning_opaque, "blob-1");
		assert.equal("reasoning_opaque" in (assistants[1] ?? {}), false);
	});

	it.each([
		{
			name: "nested reasoning tokens are already inside completion_tokens",
			usage: {
				prompt_tokens: 10,
				completion_tokens: 20,
				total_tokens: 37,
				reasoning_tokens: 7,
				completion_tokens_details: { reasoning_tokens: 5 },
			},
			output: 20,
			reasoning: 5,
		},
		{
			name: "a top-level count the total does not add separately is inside completion_tokens",
			usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, reasoning_tokens: 5 },
			output: 20,
			reasoning: 5,
		},
		{
			name: "a top-level count the total adds separately is extra output",
			usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 35, reasoning_tokens: 5 },
			output: 25,
			reasoning: 5,
		},
		{
			name: "no total is no evidence of separate reasoning",
			usage: { prompt_tokens: 10, completion_tokens: 20, reasoning_tokens: 5 },
			output: 20,
			reasoning: 5,
		},
	])("reads usage when $name", async ({ usage, output, reasoning }) => {
		const { message } = await streamEvents([chatChunk({ content: "ok" }, { finish: "stop", usage })]);
		assert.equal(message.usage.output, output);
		assert.equal(message.usage.reasoning, reasoning);
		assert.equal(message.usage.totalTokens, 10 + output);
	});
});

describe("Responses stream errors keep their provider text for every provider (#4324)", () => {
	const other = () => ({ ...discovered("example-model"), provider: "fixture-provider" });
	const responsesStream = (events: readonly WireEvent[]) => () =>
		new Response(sseBody(events, { done: false }), { status: 200, headers: { "content-type": "text/event-stream" } });

	it("reports an error event's code and message", async () => {
		const { message } = await run(other(), userTurn, [
			responsesStream(responsesErrorEvents("server_error", "Upstream exploded")),
		]);
		assert.equal(message.stopReason, "error");
		assert.ok(message.errorMessage?.includes("Error Code server_error: Upstream exploded"), message.errorMessage);
	});

	it("reports a failed response that carries only an incomplete reason", async () => {
		const { message } = await run(other(), userTurn, [
			responsesStream([
				{
					type: "response.created",
					response: { id: "resp_f", object: "response", status: "in_progress", output: [] },
				},
				{
					type: "response.failed",
					response: {
						id: "resp_f",
						object: "response",
						status: "failed",
						output: [],
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
		]);
		assert.equal(message.stopReason, "error");
		assert.ok(message.errorMessage?.includes("incomplete: max_output_tokens"), message.errorMessage);
	});
});

describe("Copilot failures when provider retries are enabled (#4324)", () => {
	// A server hint above the retry cap makes the retry helper give up with a wrapper around the response error.
	const hint = { "retry-after": "3600" };
	const apis = [
		["Chat Completions", () => discovered("example-chat-model")],
		["Responses", () => discovered("example-model")],
		["Messages", () => discovered("example-messages-model")],
	] as const;
	const rows = [
		{
			name: "a coded quota 429",
			respond: () => jsonError(429, { message: "You exceeded your quota.", code: "insufficient_quota" }, hint),
			type: GitHubCopilotQuotaExhaustedError,
			retryable: false,
			fields: { providerCode: "insufficient_quota", requestId: "req-fixture-1", status: 429 },
		},
		{
			name: "a coded rate limit",
			respond: () => jsonError(429, { message: "Slow down", code: "rate_limit_exceeded" }, hint),
			type: GitHubCopilotRateLimitError,
			retryable: true,
			fields: { providerCode: "rate_limit_exceeded", requestId: "req-fixture-1", retryAfterMs: 3_600_000 },
		},
		{
			name: "a plain quota 429 with the quota header",
			respond: () => () =>
				new Response("quota exceeded", {
					status: 429,
					headers: {
						"content-type": "text/plain; charset=utf-8",
						"x-ratelimit-exceeded": "quota_exceeded",
						"x-request-id": "req-fixture-1",
						...hint,
					},
				}),
			type: GitHubCopilotQuotaExhaustedError,
			retryable: false,
			fields: { providerCode: null, requestId: "req-fixture-1", detail: "quota exceeded" },
		},
		{
			name: "a coded server error",
			respond: () => jsonError(503, { message: "Upstream down", code: "server_error" }, hint),
			type: GitHubCopilotServiceUnavailableError,
			retryable: true,
			fields: { providerCode: "server_error", requestId: "req-fixture-1", status: 503 },
		},
		{
			name: "a coded model rejection the SDK was told to retry",
			respond: () =>
				jsonError(
					400,
					{ message: "Model not supported", code: "model_not_supported" },
					{
						...hint,
						"x-should-retry": "true",
					},
				),
			type: GitHubCopilotModelUnavailableError,
			retryable: false,
			fields: { providerCode: "model_not_supported", requestId: "req-fixture-1", reason: "not-supported" },
		},
	] as const;

	async function runWithRetries(model: Model<Api>, respond: () => Response, maxRetries: number) {
		const scripted = scriptedFetch([respond, respond]);
		const message = await streamSimple(model, userTurn, {
			apiKey: API_KEY,
			fetch: scripted.fetch,
			maxRetries,
			maxRetryDelayMs: 60_000,
		}).result();
		return { message, calls: scripted.requests.length };
	}

	it.each(apis.flatMap(([api, model]) => rows.map((row) => ({ api, model, row }))))(
		"types $row.name on $api as it does without retries",
		async ({ model, row }) => {
			const target = model();
			const respond = row.respond();
			const retried = await runWithRetries(target, respond, 1);
			const direct = await runWithRetries(target, respond, 0);
			const typed = getGitHubCopilotError(retried.message);

			assert.equal(retried.calls, 1);
			assert.ok(typed instanceof row.type, retried.message.errorMessage);
			assert.equal(typed.retryable, row.retryable);
			assert.deepEqual(pick(typed.fields(), Object.keys(row.fields)), row.fields);
			const baseline = getGitHubCopilotError(direct.message);
			assert.ok(baseline instanceof row.type);
			assert.equal(typed.code, baseline.code);
			assert.equal(typed.providerCode, baseline.providerCode);
			assert.equal(typed.requestId, baseline.requestId);
			assert.equal(typed.status, baseline.status);
			assert.equal(isRetryableAssistantError(retried.message), row.retryable);
			assert.equal(isContextOverflow(retried.message, target.contextWindow), false);
		},
	);
});
