import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { stream as streamBedrock } from "@bastani/pi-ai/api/bedrock-converse-stream";
import { type AssistantMessage, getModel, normalizeContext } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { _isRetryableError } from "../../packages/coding-agent/src/core/agent-session-retry.js";
import {
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	normalizeModelFailureSignal,
} from "../../packages/coding-agent/src/core/model-fallback-failures.js";

const bedrockModel = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });

let server: Server | undefined;

afterEach(async () => {
	const running = server;
	server = undefined;
	if (running === undefined) return;
	await new Promise<void>((resolve, reject) => running.close((error) => (error ? reject(error) : resolve())));
});

interface BedrockFailureResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/** The real Bedrock Converse stream adapter, sent to a local endpoint that answers with `response`. */
async function bedrockTurnAgainst(response: BedrockFailureResponse): Promise<AssistantMessage> {
	const listening = createServer((_request, reply) => {
		reply.writeHead(response.status, response.headers);
		reply.end(response.body);
	});
	server = listening;
	await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
	const address = listening.address();
	if (address === null || typeof address === "string") throw new Error("Expected a TCP test server address");
	const message = await streamBedrock({ ...bedrockModel, baseUrl: `http://127.0.0.1:${address.port}` }, context, {
		cacheRetention: "none",
		maxRetries: 0,
		env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1" },
	}).result();
	assert.equal(message.stopReason, "error");
	return message;
}

function modeledError(status: number, errorType: string, body: string): BedrockFailureResponse {
	return { status, headers: { "content-type": "application/json", "x-amzn-errortype": errorType }, body };
}

/** The main chat's retry decision for this message, with a configured fallback chain. */
function mainChatRetries(message: AssistantMessage): boolean {
	const session = { model: bedrockModel, _fallbackModels: [{ provider: "anthropic", id: "claude-opus-4-8" }] };
	return _isRetryableError.call(session as never, message);
}

const TRANSIENT_BEDROCK_FAILURES: readonly {
	readonly label: string;
	readonly response: BedrockFailureResponse;
	readonly kind: "provider_unavailable" | "rate_limit";
}[] = [
	{
		label: "HTTP 503 ServiceUnavailableException with no message",
		response: modeledError(
			503,
			"ServiceUnavailableException:http://internal.amazon.com/coral/com.amazon.bedrock/",
			"{}",
		),
		kind: "provider_unavailable",
	},
	{
		label: "HTTP 503 ServiceUnavailableException",
		response: modeledError(
			503,
			"ServiceUnavailableException",
			'{"message":"Bedrock is unable to process your request."}',
		),
		kind: "provider_unavailable",
	},
	{
		label: "HTTP 502 with an HTML gateway body",
		response: {
			status: 502,
			headers: { "content-type": "text/html" },
			body: "<html><body><h1>502 Bad Gateway</h1></body></html>",
		},
		kind: "provider_unavailable",
	},
	{
		label: "HTTP 500 InternalServerException",
		response: modeledError(
			500,
			"InternalServerException",
			'{"message":"The server encountered an error processing your request."}',
		),
		kind: "provider_unavailable",
	},
	{
		label: "HTTP 429 ThrottlingException",
		response: modeledError(
			429,
			"ThrottlingException",
			'{"message":"Too many requests, please wait before trying again."}',
		),
		kind: "rate_limit",
	},
];

for (const { label, response, kind } of TRANSIENT_BEDROCK_FAILURES) {
	test(`a Bedrock ${label} is retried on the same model, then falls back (#4918)`, async () => {
		const message = await bedrockTurnAgainst(response);

		assert.equal(normalizeModelFailureSignal(message).kind, kind);
		assert.equal(normalizeModelFailureSignal(message).status, response.status);
		assert.equal(isRetryableSameModelFailure(message), true);
		assert.equal(isRetryableModelFailure(message), true);
		assert.equal(mainChatRetries(message), true);
	});
}

test("a provider error code alone never reads as an unavailable model (#4918)", () => {
	const failure = {
		role: "assistant",
		stopReason: "error",
		diagnostics: [{ type: "bedrock_response_failure", details: { errorCode: "ServiceUnavailableException" } }],
	};

	assert.equal(normalizeModelFailureSignal(failure).kind, "provider_unavailable");
	assert.equal(isRetryableSameModelFailure(failure), true);
});

test("message text does not condemn the model over a transient HTTP status (#4918)", () => {
	const failure = { status: 503, message: "The model is currently unavailable, try later" };

	assert.equal(normalizeModelFailureSignal(failure).kind, "provider_unavailable");
	assert.equal(isRetryableSameModelFailure(failure), true);
});

test.each([
	"Stream closed with error code NGHTTP2_CANCEL",
	"[ERR_HTTP2_STREAM_ERROR]: Stream closed with error code NGHTTP2_CANCEL",
])("an HTTP/2 stream reset is a retryable transport failure, not a user cancel (#4918): %s", (text) => {
	const message = { role: "assistant", stopReason: "error", errorMessage: text };

	assert.notEqual(normalizeModelFailureSignal(message).kind, "cancelled");
	assert.equal(isRetryableSameModelFailure(message), true);
	assert.equal(isRetryableModelFailure(message), true);
});

test("a structured HTTP/2 stream error code is a retryable transport failure (#4918)", () => {
	const failure = { code: "ERR_HTTP2_STREAM_ERROR", message: "Stream closed" };

	assert.equal(normalizeModelFailureSignal(failure).kind, "transport_error");
	assert.equal(isRetryableSameModelFailure(failure), true);
});

test("a user abort is still a cancellation (#4918)", () => {
	const abort = new Error("This operation was aborted");
	abort.name = "AbortError";

	assert.equal(normalizeModelFailureSignal(abort).kind, "cancelled");
	assert.equal(
		normalizeModelFailureSignal({ stopReason: "aborted", errorMessage: "Request was aborted" }).kind,
		"cancelled",
	);
	assert.equal(normalizeModelFailureSignal(new Error("request was cancelled")).kind, "cancelled");
	assert.equal(isRetryableModelFailure(abort), false);
});
