import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Api, AssistantMessage, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

async function listen(server: Server): Promise<string> {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return `http://127.0.0.1:${address.port}`;
}

/** An endpoint that answers every request with `status`, `body` and `headers`. */
function answering(status: number, body: string, headers: Record<string, string> = {}): Promise<string> {
	return listen(
		createHttpServer((request, response) => {
			request.resume();
			response.writeHead(status, { "content-type": "application/json", ...headers }).end(body);
		}),
	);
}

/** A proxy that forwards each plain-HTTP request to where its URL says, as an HTTP proxy does. */
function forwardingProxy(): Promise<string> {
	return listen(
		createHttpServer((request, response) => {
			const forwarded = httpRequest(request.url ?? "", { method: request.method, headers: request.headers }, (answer) => {
				response.writeHead(answer.statusCode ?? 502, answer.headers);
				answer.pipe(response);
			});
			forwarded.on("error", () => response.destroy());
			request.pipe(forwarded);
		}),
	);
}

function bedrockTurn(baseUrl: string, env: Record<string, string> = {}): Promise<AssistantMessage> {
	const model = getModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0") as Model<"bedrock-converse-stream">;
	return streamBedrock({ ...model, baseUrl }, context, {
		cacheRetention: "none",
		maxRetries: 0,
		env: { AWS_BEDROCK_FORCE_HTTP1: "1", AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1", ...env },
	}).result();
}

function model<TApi extends Api>(api: TApi, baseUrl: string): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

describe("an Amazon Bedrock answer the SDK has no Bedrock exception for", () => {
	it("names its status and is retried like the other adapters' when it is a 503, 500, 502 or 429", async () => {
		for (const [status, body, headers, expected] of [
			[503, '{"message":"unavailable"}', {}, "Unknown: 503: unavailable"],
			[500, '{"message":"boom"}', {}, "Unknown: 500: boom"],
			[429, '{"message":"slow down"}', {}, "Unknown: 429: slow down"],
			[503, '{"message":"busy","code":"GatewayBusy"}', {}, "GatewayBusy: 503: busy"],
			[502, "bad gateway", { "content-type": "text/plain" }, "502: "],
		] as const) {
			const endpoint = await answering(status, body, headers);
			const bedrock = await bedrockTurn(endpoint);
			const anthropic = await streamAnthropic(model("anthropic-messages", endpoint), context, {
				apiKey: "test-key",
				maxRetries: 0,
			}).result();
			const completions = await streamOpenAICompletions(model("openai-completions", `${endpoint}/v1`), context, {
				apiKey: "test-key",
				maxRetries: 0,
			}).result();

			assert.ok(bedrock.errorMessage?.startsWith(expected), bedrock.errorMessage);
			assert.equal(isRetryableAssistantError(anthropic), true, anthropic.errorMessage);
			assert.equal(isRetryableAssistantError(completions), true, completions.errorMessage);
			assert.equal(isRetryableAssistantError(bedrock), true, bedrock.errorMessage);
		}
	});

	it("is retried when a healthy proxy relays a 503", async () => {
		const endpoint = await answering(503, '{"message":"unavailable"}');
		const proxy = await forwardingProxy();
		const message = await bedrockTurn(endpoint, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: "none.invalid" });

		assert.equal(message.errorMessage, "Unknown: 503: unavailable");
		assert.equal(isRetryableAssistantError(message), true);
	});

	it("names its status but is not retried when it is a 403, and Bedrock's own exceptions read as before", async () => {
		const forbidden = await bedrockTurn(await answering(403, '{"message":"forbidden"}'));
		assert.equal(forbidden.errorMessage, "Unknown: 403: forbidden");
		assert.equal(isRetryableAssistantError(forbidden), false);

		for (const [status, type, expected, retryable] of [
			[400, "ValidationException", "Validation error: bad input", false],
			[403, "AccessDeniedException", "AccessDeniedException: bad input", false],
			[503, "ServiceUnavailableException", "Service unavailable: bad input", true],
		] as const) {
			const message = await bedrockTurn(
				await answering(status, '{"message":"bad input"}', { "x-amzn-errortype": type }),
			);
			assert.equal(message.errorMessage, expected);
			assert.equal(isRetryableAssistantError(message), retryable, expected);
		}
	});
});
