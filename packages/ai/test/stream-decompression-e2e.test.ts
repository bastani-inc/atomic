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
 * Both must settle as retryable transport errors within bounded time, and the
 * stalled one must also tear the abandoned request down server-side: settling
 * the attempt alone would leak one provider connection per stall.
 */

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: false,
	supportsTemperature: true,
	supportsForcedToolChoice: true,
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
	thinkingTokenBudgetField: undefined,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: false,
} satisfies Omit<
	Required<OpenAICompletionsCompat>,
	"cacheControlFormat" | "deferredToolsMode" | "thinkingTokenBudgetField" | "vllmPriority"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
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

interface TrackedServer {
	url: string;
	/** Server-side sockets, removed once the peer closes them. */
	connections: Set<import("node:net").Socket>;
}

async function startServer(handler: http.RequestListener): Promise<TrackedServer> {
	const server = http.createServer(handler);
	servers.push(server);
	const connections = new Set<import("node:net").Socket>();
	server.on("connection", (socket) => {
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}/v1`, connections };
}

/** Drain the adapter's event stream, returning the terminal event. */
async function settle(events: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent | undefined> {
	let last: AssistantMessageEvent | undefined;
	for await (const event of events) last = event;
	return last;
}

/** Poll until `predicate` holds, failing with `message` once the budget is spent. */
async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error(`${message} (waited ${timeoutMs}ms)`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
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
		const { url } = await startServer((_request, response) => {
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
			streamOpenAICompletions(buildModel(url), context, { apiKey: "test-key", maxRetries: 0 }),
		);

		expect(terminal?.type).toBe("error");
		if (terminal?.type !== "error") throw new Error("expected a terminal error event");
		expect(terminal.error.stopReason).toBe("error");
		expect(terminal.error.errorMessage).toBeTruthy();
		expect(isRetryableAssistantError(terminal.error)).toBe(true);
	});

	it("settles a stream that goes silent forever once the stream deadline elapses", async () => {
		const { url, connections } = await startServer((_request, response) => {
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
			streamOpenAICompletions(buildModel(url), context, {
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

		// The deadline must abort the stalled request, not merely settle the
		// attempt: an abandoned body keeps its socket alive, so a repeated stall
		// would accumulate open provider connections. The abort destroys the
		// socket instead of returning it to the pool, so the server must observe
		// every connection close.
		await waitFor(() => connections.size === 0, 10_000, "the stalled request's socket stayed open server-side");
	});
});
