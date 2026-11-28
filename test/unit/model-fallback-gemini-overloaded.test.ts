import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { stream as streamAnthropic } from "@bastani/atomic-ai/api/anthropic-messages";
import { stream as streamGoogle } from "@bastani/atomic-ai/api/google-generative-ai";
import { stream as streamVertex } from "@bastani/atomic-ai/api/google-vertex";
import { stream as streamMistral } from "@bastani/atomic-ai/api/mistral-conversations";
import { stream as streamCompletions } from "@bastani/atomic-ai/api/openai-completions";
import { stream as streamResponses } from "@bastani/atomic-ai/api/openai-responses";
import { stream as streamPiMessages } from "@bastani/atomic-ai/api/pi-messages";
import { type AssistantMessage, type Model, normalizeContext } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import {
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	normalizeModelFailureSignal,
} from "../../packages/coding-agent/src/core/model-fallback-failures.js";
import { getFixtureModel } from "../helpers/catalog-model-fixtures.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

let server: Server | undefined;

afterEach(async () => {
	const running = server;
	server = undefined;
	if (running === undefined) return;
	await new Promise<void>((resolve, reject) => running.close((error) => (error ? reject(error) : resolve())));
});

/** A local endpoint that answers every request with `status` and the JSON `body`. */
async function serverAnswering(
	status: number,
	body: unknown,
	contentType = "application/json",
	onRequest?: () => void,
	retryAfter = status === 429 ? "0.001" : undefined,
): Promise<string> {
	const listening = createServer((_request, reply) => {
		onRequest?.();
		reply.writeHead(status, { "content-type": contentType, ...(retryAfter && { "retry-after": retryAfter }) });
		const payload =
			contentType === "text/event-stream"
				? typeof body === "string"
					? body
					: `data: ${JSON.stringify(body)}\n\n`
				: JSON.stringify(body);
		reply.end(payload);
	});
	server = listening;
	await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
	const address = listening.address();
	if (address === null || typeof address === "string") throw new Error("Expected a TCP test server address");
	return `http://127.0.0.1:${address.port}`;
}

type Adapter = "google" | "google-vertex" | "openai-completions" | "openai-responses" | "anthropic" | "mistral";

/** One turn through the real `adapter`, sent to a local endpoint that answers with `status` and `body`. */
async function failedTurn(adapter: Adapter, status: number, body: unknown): Promise<AssistantMessage> {
	const baseUrl = await serverAnswering(status, body);
	const options = { apiKey: "test-key", maxRetries: 0 };
	let message: AssistantMessage;
	switch (adapter) {
		case "google":
			message = await streamGoogle(
				{ ...getFixtureModel("google", "gemini-2.5-pro"), baseUrl },
				context,
				options,
			).result();
			break;
		case "google-vertex":
			message = await streamVertex(
				{ ...getFixtureModel("google-vertex", "gemini-2.5-pro"), baseUrl },
				context,
				options,
			).result();
			break;
		case "openai-completions": {
			const model: Model<"openai-completions"> = {
				...getFixtureModel("openai", "gpt-4o"),
				api: "openai-completions",
				baseUrl: `${baseUrl}/v1`,
			};
			message = await streamCompletions(model, context, options).result();
			break;
		}
		case "openai-responses":
			message = await streamResponses(
				{ ...getFixtureModel("openai", "gpt-4o"), baseUrl: `${baseUrl}/v1` },
				context,
				options,
			).result();
			break;
		case "anthropic":
			message = await streamAnthropic({ ...getFixtureModel("anthropic", "claude-sonnet-4-5"), baseUrl }, context, {
				...options,
				apiKey: "sk-ant-api03-test",
			}).result();
			break;
		case "mistral":
			message = await streamMistral(
				{ ...getFixtureModel("mistral", "mistral-large-latest"), baseUrl },
				context,
				options,
			).result();
			break;
	}
	assert.equal(message.stopReason, "error");
	return message;
}

function googleError(code: number, message: string, status: string): unknown {
	return { error: { code, message, status } };
}

const TRANSIENT_FAILURES: readonly {
	readonly adapter: Adapter;
	readonly label: string;
	readonly status: number;
	readonly body: unknown;
	readonly kind: "provider_unavailable" | "rate_limit";
}[] = [
	...(["google", "google-vertex"] as const).flatMap((adapter) => [
		{
			adapter,
			label: "503 'The model is overloaded'",
			status: 503,
			body: googleError(503, "The model is overloaded. Please try again later.", "UNAVAILABLE"),
			kind: "provider_unavailable" as const,
		},
		{
			adapter,
			label: "503 'The service is currently unavailable'",
			status: 503,
			body: googleError(503, "The service is currently unavailable.", "UNAVAILABLE"),
			kind: "provider_unavailable" as const,
		},
		{
			adapter,
			label: "429 RESOURCE_EXHAUSTED",
			status: 429,
			body: googleError(429, "Resource has been exhausted (e.g. check quota).", "RESOURCE_EXHAUSTED"),
			kind: "rate_limit" as const,
		},
	]),
	{
		adapter: "openai-completions",
		label: "503 'The model is currently unavailable'",
		status: 503,
		body: { error: { message: "The model is currently unavailable. Please try again later.", type: "server_error" } },
		kind: "provider_unavailable",
	},
	{
		adapter: "openai-responses",
		label: "503 'The model is overloaded'",
		status: 503,
		body: { error: { message: "The model is overloaded. Please try again later.", type: "server_error" } },
		kind: "provider_unavailable",
	},
	{
		adapter: "anthropic",
		label: "529 overloaded_error",
		status: 529,
		body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
		kind: "provider_unavailable",
	},
	{
		adapter: "mistral",
		label: "503 'The model is currently unavailable'",
		status: 503,
		body: { object: "error", message: "The model is currently unavailable.", type: "service_unavailable" },
		kind: "provider_unavailable",
	},
];

for (const { adapter, label, status, body, kind } of TRANSIENT_FAILURES) {
	test(`a ${adapter} ${label} is retried on the same model and carries its HTTP status (#4994)`, async () => {
		const message = await failedTurn(adapter, status, body);
		const signal = normalizeModelFailureSignal(message);

		assert.equal(signal.kind, kind);
		assert.equal(signal.status, status);
		assert.equal(isRetryableSameModelFailure(message), true);
		assert.equal(isRetryableModelFailure(message), true);
	});
}

test.each([
	{ provider: "opencode", error: { type: "FreeUsageLimitError", message: "Cannot serve." } },
	{ provider: "opencode-go", error: { type: "GoUsageLimitError", message: "Cannot serve." } },
	{ provider: "zai", error: { code: "1308", message: "Cannot serve." } },
	{ provider: "zai-coding-cn", error: { code: 1308, message: "Cannot serve." } },
] as const)("$provider Chat does not retry an exhausted plan quota", async ({ provider, error }) => {
	let requests = 0;
	const baseUrl = await serverAnswering(429, { error }, "application/json", () => requests++);
	const model: Model<"openai-completions"> = {
		...getFixtureModel("openai", "gpt-4o"),
		api: "openai-completions",
		baseUrl,
		provider,
	};
	const message = await streamCompletions(model, context, { apiKey: "test-key", maxRetries: 1 }).result();
	assert.equal(message.stopReason, "error");
	assert.equal(normalizeModelFailureSignal(message).kind, "quota_exhausted");
	assert.equal(isRetryableSameModelFailure(message), false);
	assert.equal(requests, 1);
});

test.each(
	(["google", "google-vertex"] as const).flatMap((provider) => [
		{ provider, label: "candidate finish", body: { candidates: [{ finishReason: "SAFETY", index: 0 }] } },
		{ provider, label: "prompt block", body: { promptFeedback: { blockReason: "SAFETY" } } },
	]),
)("$provider SAFETY $label is a content filter, not a transient failure", async ({ provider, body }) => {
	const baseUrl = await serverAnswering(200, body, "text/event-stream");
	const options = { apiKey: "test-key", maxRetries: 0 };
	const message = await (provider === "google-vertex"
		? streamVertex({ ...getFixtureModel("google-vertex", "gemini-2.5-pro"), baseUrl }, context, options)
		: streamGoogle({ ...getFixtureModel("google", "gemini-2.5-pro"), baseUrl }, context, options)
	).result();
	assert.equal(message.stopReason, "error");
	assert.equal(message.rawStopReason, "SAFETY");
	assert.equal(normalizeModelFailureSignal(message).kind, "content_filter");
	assert.equal(isRetryableSameModelFailure(message), false);
});

test.each(["google", "google-vertex"] as const)("%s does not retry an over-cap HTTP 503 header", async (provider) => {
	let requests = 0;
	const baseUrl = await serverAnswering(
		503,
		googleError(503, "Backend down.", "UNAVAILABLE"),
		"application/json",
		() => requests++,
		"360",
	);
	const options = { apiKey: "test-key", maxRetries: 1, maxRetryDelayMs: 60_000 };
	const message = await (provider === "google-vertex"
		? streamVertex({ ...getFixtureModel("google-vertex", "gemini-2.5-pro"), baseUrl }, context, options)
		: streamGoogle({ ...getFixtureModel("google", "gemini-2.5-pro"), baseUrl }, context, options)
	).result();
	assert.equal(message.stopReason, "error");
	assert.equal(requests, 1);
	assert.equal(message.retryAfterMs, 360_000);
});

test.each([
	{ status: 404, kind: "model_unavailable" },
	{ status: 400, kind: "request_incompatible" },
])("pi-messages classifies HTTP $status without needing a provider code", async ({ status, kind }) => {
	const baseUrl = await serverAnswering(status, { error: { message: "Cannot serve." } });
	const model: Model<"pi-messages"> = {
		...getFixtureModel("openai", "gpt-4o"),
		api: "pi-messages",
		baseUrl,
		compat: undefined,
	};
	const message = await streamPiMessages(model, context, { apiKey: "test-key" }).result();
	assert.equal(message.stopReason, "error");
	const signal = normalizeModelFailureSignal(message);
	assert.equal(signal.kind, kind);
	assert.equal(signal.status, status);
	assert.equal(isRetryableSameModelFailure(message), false);
	assert.equal(isRetryableModelFailure(message), true);
});

test("a Google 404 for a missing model still blocks the model (#4994)", async () => {
	const message = await failedTurn(
		"google",
		404,
		googleError(
			404,
			"models/gemini-9 is not found for API version v1beta, or is not supported for generateContent.",
			"NOT_FOUND",
		),
	);

	assert.equal(normalizeModelFailureSignal(message).kind, "model_unavailable");
	assert.equal(isRetryableSameModelFailure(message), false);
	assert.equal(isRetryableModelFailure(message), true);
});

test.each([
	{ name: "API key", id: "claude-opus-5-5", apiKey: "sk-ant-api03-test" },
	{ name: "OAuth fast mode", id: "claude-opus-5-5-fast", apiKey: "sk-ant-oat-test" },
])("Anthropic low credit on $name is an account quota, not an incompatible request", async ({ id, apiKey }) => {
	const baseUrl = await serverAnswering(400, {
		type: "error",
		error: {
			type: "invalid_request_error",
			message: "Your credit balance is too low to access the Anthropic API.",
		},
	});
	const message = await streamAnthropic({ ...getFixtureModel("anthropic", "claude-opus-5-5"), id, baseUrl }, context, {
		apiKey,
		maxRetries: 1,
	}).result();
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /Your credit balance is too low/);
	assert.equal(normalizeModelFailureSignal(message).kind, "quota_exhausted");
	assert.equal(isRetryableSameModelFailure(message), false);
});

test.each(
	(["refusal", "sensitive"] as const).flatMap((reason) => [
		{ reason, auth: "API key", id: "claude-opus-5-5", apiKey: "sk-ant-api03-test" },
		{ reason, auth: "OAuth fast mode", id: "claude-opus-5-5-fast", apiKey: "sk-ant-oat-test" },
	]),
)("Anthropic $reason on $auth is a content filter even without refusal wording", async ({ reason, id, apiKey }) => {
	const frames = [
		{ type: "message_start", message: { id: "msg_test", model: id, usage: { input_tokens: 1, output_tokens: 0 } } },
		{
			type: "message_delta",
			delta: { stop_reason: reason, stop_details: { explanation: "Cannot serve." } },
			usage: { output_tokens: 0 },
		},
		{ type: "message_stop" },
	];
	const baseUrl = await serverAnswering(
		200,
		frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
		"text/event-stream",
	);
	const message = await streamAnthropic({ ...getFixtureModel("anthropic", "claude-opus-5-5"), id, baseUrl }, context, {
		apiKey,
	}).result();
	assert.equal(message.stopReason, "error");
	assert.equal(message.rawStopReason, reason);
	assert.equal(normalizeModelFailureSignal(message).kind, "content_filter");
	assert.equal(isRetryableSameModelFailure(message), false);
});

test("an Anthropic 404 not_found_error blocks the model on its HTTP status (#4994)", async () => {
	const message = await failedTurn("anthropic", 404, {
		type: "error",
		error: { type: "not_found_error", message: "model: claude-x" },
	});

	assert.equal(normalizeModelFailureSignal(message).kind, "model_unavailable");
	assert.equal(isRetryableSameModelFailure(message), false);
});

test.each([
	["a leading status", "503: The model is currently unavailable. Please try again later."],
	["a prefixed status", "OpenAI API error (503): The model is currently unavailable."],
	["a JSON error code", '{"error":{"code":503,"message":"The model is unavailable."}}'],
	["a gRPC UNAVAILABLE status", '{"error":{"message":"The model is unavailable.","status":"UNAVAILABLE"}}'],
	[
		"a JSON error code in a pretty-printed body",
		'{\n  "error": {\n    "code": 503,\n    "message": "The model is unavailable."\n  }\n}',
	],
	[
		"a provider status in a pretty-printed body",
		'{\n  "error": {\n    "message": "The model is unavailable.",\n    "status": "UNAVAILABLE"\n  }\n}',
	],
	["an overloaded model", "The model is overloaded and unavailable. Please try again later."],
])("message text never condemns the model over %s (#4994)", (_label, errorMessage) => {
	const message = { role: "assistant", stopReason: "error", errorMessage };

	assert.equal(normalizeModelFailureSignal(message).kind, "provider_unavailable");
	assert.equal(isRetryableSameModelFailure(message), true);
});

test("message text still names a missing model behind a permanent status (#4994)", () => {
	for (const errorMessage of ["404: The model `gpt-9` was not found", "model not found", "Model is disabled"]) {
		const message = { role: "assistant", stopReason: "error", errorMessage };
		assert.equal(normalizeModelFailureSignal(message).kind, "model_unavailable", errorMessage);
	}
});

test("message text never reads a transient status as an auth failure (#4994)", () => {
	assert.equal(
		normalizeModelFailureSignal(new Error("503: authentication backend unavailable")).kind,
		"provider_unavailable",
	);
});

test("a provider status alone in the text is a transient failure (#4994)", () => {
	const failure = new Error('{"error":{"status":"UNAVAILABLE","message":"Try again later."}}');

	assert.equal(normalizeModelFailureSignal(failure).kind, "provider_unavailable");
	assert.equal(isRetryableSameModelFailure(failure), true);
});

test.each([
	["UNAVAILABLE", "provider_unavailable"],
	["RESOURCE_EXHAUSTED", "rate_limit"],
])("Google's %s provider status is a %s (#4994)", (code, kind) => {
	assert.equal(normalizeModelFailureSignal({ code }).kind, kind);
});

test("a transient HTTP status in a failure diagnostic outranks model-condemning text (#4994)", () => {
	const message = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "The model is unavailable",
		diagnostics: [{ type: "provider_response_failure", details: { status: 503 } }],
	};

	assert.equal(normalizeModelFailureSignal(message).kind, "provider_unavailable");
	assert.equal(isRetryableSameModelFailure(message), true);
});

test.each([
	["a status that is not where the message starts", "The model gpt-9 was not found after 500 ms"],
	["a status not followed by a separator", "503Service: the model is unavailable"],
	["a permanent leading status", "400: The model gpt-9 was not found"],
])("message text still names a missing model over %s (#4994)", (_label, errorMessage) => {
	const message = { role: "assistant", stopReason: "error", errorMessage };

	assert.equal(normalizeModelFailureSignal(message).kind, "model_unavailable");
});
