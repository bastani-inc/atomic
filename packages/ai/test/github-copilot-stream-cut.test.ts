import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { parseGitHubCopilotDiscoveredModels } from "../src/providers/github-copilot.ts";
import {
	GitHubCopilotStreamEndedEarlyError,
	getGitHubCopilotError,
	isGitHubCopilotStreamEndedEarlyError,
} from "../src/providers/github-copilot-errors.ts";
import type { Api, AssistantMessage, Context, Model } from "../src/types.ts";
import {
	CHAT_TRUNCATED_TURN,
	RESPONSES_TRUNCATED_TURN,
	sseBody,
	type WireEvent,
} from "./fixtures/github-copilot-wire.ts";

const REQUEST_ID = "req-cut-4626";
const CUT_AFTER_MS = 6 * 60_000;
const CLOCK_OFFSET_MS = 10 * 60_000;
const API_KEY = "test-key";

const userTurn: Context = {
	systemPrompt: "Answer briefly.",
	messages: [{ role: "user", content: "Write a very long answer.", timestamp: 0 }],
};

const recordedModels: unknown = JSON.parse(
	readFileSync(new URL("./fixtures/github-copilot-models.json", import.meta.url), "utf8"),
);

function discovered(id: string, baseUrl: string): Model<Api> {
	const model = parseGitHubCopilotDiscoveredModels(recordedModels, []).find((candidate) => candidate.id === id);
	if (!model) throw new Error(`Expected ${id} to be discovered`);
	return { ...model, baseUrl };
}

function messagesEvent(event: string, data: WireEvent): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const MESSAGES_START = messagesEvent("message_start", {
	type: "message_start",
	message: { id: "msg_cut_fixture", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 0 } },
});
const MESSAGES_PING = messagesEvent("ping", { type: "ping" });
const COMMENT = ": no event yet\n\n";

interface ApiCase {
	readonly api: string;
	readonly modelId: string;
	readonly someEvents: string;
}

const API_CASES: readonly ApiCase[] = [
	{ api: "anthropic-messages", modelId: "example-messages-model", someEvents: MESSAGES_START + MESSAGES_PING },
	{
		api: "openai-completions",
		modelId: "example-chat-model",
		someEvents: sseBody(CHAT_TRUNCATED_TURN, { done: false }),
	},
	{
		api: "openai-responses",
		modelId: "example-model",
		someEvents: sseBody(RESPONSES_TRUNCATED_TURN, { done: false }),
	},
];

const servers: Server[] = [];

/** Answers 200 with a request ID, streams `body`, lets the clock run for `cutAfterMs`, then destroys the socket. */
async function startCuttingServer(body: string, cutAfterMs: number): Promise<string> {
	const server = createServer((request, response) => {
		request.resume();
		response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": REQUEST_ID });
		response.write(body, () => {
			vi.advanceTimersByTime(cutAfterMs);
			request.socket.destroy();
		});
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function streamAgainst(baseUrl: string, testCase: ApiCase): Promise<AssistantMessage> {
	return streamSimple(discovered(testCase.modelId, baseUrl), userTurn, {
		apiKey: API_KEY,
		maxRetries: 0,
		reasoning: "low",
	}).result();
}

/** A fake monotonic clock that is already well past zero, so a duration measured from the wrong moment shows. */
function useFakeClock(): void {
	vi.useFakeTimers({ toFake: ["performance"] });
	vi.advanceTimersByTime(CLOCK_OFFSET_MS);
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});

describe("a Copilot stream cut by the remote side after HTTP 200 (#4626)", () => {
	it.each(API_CASES)("$api: types the cut with its request ID, duration and progress (#4626)", async (testCase) => {
		useFakeClock();
		const baseUrl = await startCuttingServer(testCase.someEvents, CUT_AFTER_MS);

		const message = await streamAgainst(baseUrl, testCase);

		assert.equal(message.stopReason, "error");
		const error = getGitHubCopilotError(message);
		assert.ok(error instanceof GitHubCopilotStreamEndedEarlyError, message.errorMessage);
		assert.equal(error.code, "stream-ended-early");
		assert.equal(error.retryable, true);
		assert.equal(error.api, testCase.api);
		assert.equal(error.requestId, REQUEST_ID);
		assert.equal(error.durationMs, CUT_AFTER_MS);
		assert.equal(error.startedContent, true);
		assert.equal(isGitHubCopilotStreamEndedEarlyError(message), true);
	});

	it.each(API_CASES)("$api: a cut before any stream event reports that nothing arrived (#4626)", async (testCase) => {
		useFakeClock();
		const baseUrl = await startCuttingServer(COMMENT, 1_500);

		const message = await streamAgainst(baseUrl, testCase);

		const error = getGitHubCopilotError(message);
		assert.ok(error instanceof GitHubCopilotStreamEndedEarlyError, message.errorMessage);
		assert.equal(error.requestId, REQUEST_ID);
		assert.equal(error.durationMs, 1_500);
		assert.equal(error.startedContent, false);
	});

	it("Messages: pings are activity, not a response that started (#4626)", async () => {
		useFakeClock();
		const baseUrl = await startCuttingServer(MESSAGES_PING + MESSAGES_PING, 2_000);

		const message = await streamAgainst(baseUrl, API_CASES[0] as ApiCase);

		const error = getGitHubCopilotError(message);
		assert.ok(error instanceof GitHubCopilotStreamEndedEarlyError, message.errorMessage);
		assert.equal(error.startedContent, false);
	});

	it.each(API_CASES)(
		"$api: reports the request that streamed, not the requests the provider retried before it (#4626)",
		async (testCase) => {
			useFakeClock();
			const encoder = new TextEncoder();
			let requests = 0;
			const fetchRetrying: typeof globalThis.fetch = async () => {
				requests += 1;
				if (requests === 1) {
					vi.advanceTimersByTime(CUT_AFTER_MS);
					return new Response("overloaded", {
						status: 503,
						headers: { "retry-after-ms": "1", "x-request-id": "req-retried-4626" },
					});
				}
				vi.advanceTimersByTime(2_000);
				let pulls = 0;
				const body = new ReadableStream<Uint8Array>({
					pull(controller) {
						if (pulls++ === 0) controller.enqueue(encoder.encode(testCase.someEvents));
						else controller.error(new TypeError("terminated"));
					},
				});
				return new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream", "x-request-id": REQUEST_ID },
				});
			};

			const message = await streamSimple(discovered(testCase.modelId, "http://127.0.0.1:9"), userTurn, {
				apiKey: API_KEY,
				maxRetries: 1,
				reasoning: "low",
				fetch: fetchRetrying,
			}).result();

			assert.equal(requests, 2);
			const error = getGitHubCopilotError(message);
			assert.ok(error instanceof GitHubCopilotStreamEndedEarlyError, message.errorMessage);
			assert.equal(error.requestId, REQUEST_ID);
			assert.equal(error.durationMs, 2_000);
			assert.equal(error.startedContent, true);
		},
	);

	it("shows the request ID, duration and progress in the message the user reads (#4626)", async () => {
		useFakeClock();
		const baseUrl = await startCuttingServer(MESSAGES_START, CUT_AFTER_MS);

		const message = await streamAgainst(baseUrl, API_CASES[0] as ApiCase);

		const error = getGitHubCopilotError(message);
		assert.ok(error);
		assert.ok(
			message.errorMessage?.startsWith(
				"GitHub Copilot response stream ended early: example-messages-model (stream-ended-early). " +
					`Attempt ran 360.0 s, response started, request ID ${REQUEST_ID}. ` +
					"If the stream keeps ending early, split the work into smaller steps, lower the thinking effort, or add a fallback model with the fallbackModels setting.",
			),
			message.errorMessage,
		);
	});
});
