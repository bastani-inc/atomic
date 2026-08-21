import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessageEvent, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

/**
 * End-to-end reproduction of #2553 against a real HTTP server, real `fetch`, and
 * real zlib.
 *
 * The first server lies about `Content-Encoding`, which is what GitHub Copilot's
 * edge did: the runtime rejects the body with "incorrect header check". The
 * second server sends valid headers and then goes silent forever, which is the
 * shape that left the attempt pending with no error at all.
 *
 * Both must settle as retryable transport errors within bounded time.
 */

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsThinkingTokenBudget: false,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: false,
} satisfies Omit<Required<OpenAICompletionsCompat>, "cacheControlFormat" | "deferredToolsMode"> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
};

function buildModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "repro-model",
		name: "Repro Model",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

const servers: http.Server[] = [];

async function startServer(handler: http.RequestListener): Promise<string> {
	const server = http.createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}/v1`;
}

/** Drain the adapter's event stream, returning the terminal event. */
async function settle(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent | undefined> {
	let last: AssistantMessageEvent | undefined;
	for await (const event of events) last = event;
	return last;
}

describe("provider stream decompression and stall recovery (#2553)", () => {
	afterEach(async () => {
		await Promise.all(
			servers.splice(0).map(
				(server) =>
					new Promise<void>((resolve) => {
						server.closeAllConnections?.();
						server.close(() => resolve());
					}),
			),
		);
	});

	it("settles a body whose Content-Encoding lies as a retryable transport error", async () => {
		const baseUrl = await startServer((_request, response) => {
			response.writeHead(200, {
				"content-type": "text/event-stream",
				// The body below is plain text, not gzip. zlib rejects it with
				// "incorrect header check", exactly as reported on Copilot.
				"content-encoding": "gzip",
			});
			response.write("data: {}\n\n");
			response.end();
		});

		const terminal = await settle(
			streamOpenAICompletions(buildModel(baseUrl), context, { apiKey: "test-key", maxRetries: 0 }),
		);

		expect(terminal?.type).toBe("error");
		if (terminal?.type !== "error") throw new Error("expected a terminal error event");
		expect(terminal.error.stopReason).toBe("error");
		expect(terminal.error.errorMessage).toBeTruthy();
		expect(isRetryableAssistantError(terminal.error)).toBe(true);
	});

	it("settles a stream that goes silent forever once the stream deadline elapses", async () => {
		const baseUrl = await startServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			// A valid first event, then nothing — never ended, never errored.
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-stall",
					object: "chat.completion.chunk",
					created: 1,
					model: "repro-model",
					choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }],
				})}\n\n`,
			);
		});

		const started = Date.now();
		const terminal = await settle(
			streamOpenAICompletions(buildModel(baseUrl), context, {
				apiKey: "test-key",
				maxRetries: 0,
				streamDeadlineMs: 1_500,
			}),
		);
		const elapsedMs = Date.now() - started;

		expect(terminal?.type).toBe("error");
		if (terminal?.type !== "error") throw new Error("expected a terminal error event");
		expect(terminal.error.stopReason).toBe("error");
		expect(terminal.error.errorMessage).toContain("stream deadline exceeded");
		expect(isRetryableAssistantError(terminal.error)).toBe(true);
		// Bounded by the deadline, not by the HTTP idle timeout.
		expect(elapsedMs).toBeLessThan(20_000);
	});
});
