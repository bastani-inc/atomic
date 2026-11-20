import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import {
	GitHubCopilotEmptyResponseError,
	GitHubCopilotStreamEndedEarlyError,
	getGitHubCopilotError,
} from "../src/providers/github-copilot-errors.ts";
import { GITHUB_COPILOT_INFERRED_STOP_REASON_DIAGNOSTIC } from "../src/providers/github-copilot-stop-reason.ts";
import type { Api, AssistantMessage, Context, Model, Tool, ToolCall } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { DoneEventWatch } from "../src/utils/sse.ts";
import { chatChunk, GEMINI_OPAQUE_REASONING, sseBody, type WireEvent } from "./fixtures/github-copilot-wire.ts";

// GitHub Copilot sometimes ends a response stream normally, with its terminal `data: [DONE]` event, without reporting a
// finish reason; it has been seen with Gemini models. A stream that is cut off never sends `[DONE]`.

const API_KEY = "test-key";
const REQUEST_ID = "req-missing-finish";

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

const FINAL_USAGE = {
	completion_tokens: 24,
	prompt_tokens: 38,
	prompt_tokens_details: { cached_tokens: 0 },
	total_tokens: 102,
	reasoning_tokens: 40,
};

function toolCallChunk(index: number, id: string, name: string, args: string | undefined): WireEvent {
	return chatChunk({
		content: null,
		tool_calls: [
			{ index, id, type: "function", function: { name, ...(args === undefined ? {} : { arguments: args }) } },
		],
		...(index === 0 ? { reasoning_opaque: GEMINI_OPAQUE_REASONING } : {}),
	});
}

/** The last chunk of a Gemini turn as Copilot sometimes sends it: final usage, but `finish_reason: null`. */
const UNFINISHED_LAST_CHUNK = chatChunk({ content: null }, { usage: FINAL_USAGE });

const PARALLEL_TOOL_CALLS: readonly WireEvent[] = [
	toolCallChunk(0, "call_weather", "get_weather", '{"city":"Paris"}'),
	toolCallChunk(1, "call_ping", "ping", "{}"),
	UNFINISHED_LAST_CHUNK,
];

const TEXT_ANSWER: readonly WireEvent[] = [
	chatChunk({ content: "Paris is " }),
	chatChunk({ content: "sunny." }),
	chatChunk({ content: null, reasoning_opaque: GEMINI_OPAQUE_REASONING }, { usage: FINAL_USAGE }),
];

const REASONING_ONLY: readonly WireEvent[] = [
	chatChunk({ content: null, reasoning_opaque: GEMINI_OPAQUE_REASONING }, { usage: FINAL_USAGE }),
];

type Ending = "close" | "cut";

const servers: Server[] = [];

/** Answers 200, streams `body`, then closes the response normally or destroys the socket. */
async function startServer(body: string, ending: Ending = "close"): Promise<string> {
	const server = createServer((request, response) => {
		request.resume();
		response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": REQUEST_ID });
		response.write(body, () => {
			if (ending === "close") response.end();
			else request.socket.destroy();
		});
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
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

function gemini(baseUrl: string): Model<Api> {
	const model = getModel("github-copilot", "gemini-4-argon" as never) as Model<Api> | undefined;
	if (!model) throw new Error("Expected github-copilot/gemini-4-argon in the built-in catalog");
	assert.equal(model.api, "openai-completions");
	return { ...model, baseUrl };
}

async function streamFrom(
	model: Model<Api>,
	options?: { readonly fetch?: typeof globalThis.fetch },
): Promise<AssistantMessage> {
	return streamSimple(model, userTurn, { apiKey: API_KEY, maxRetries: 0, reasoning: "low", ...options }).result();
}

async function streamBody(body: string, ending?: Ending): Promise<AssistantMessage> {
	return streamFrom(gemini(await startServer(body, ending)));
}

function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

function inferredStopReasonNotes(message: AssistantMessage) {
	return (message.diagnostics ?? []).filter(
		(diagnostic) => diagnostic.type === GITHUB_COPILOT_INFERRED_STOP_REASON_DIAGNOSTIC,
	);
}

function assertEndedEarly(message: AssistantMessage): void {
	assert.equal(message.stopReason, "error");
	const error = getGitHubCopilotError(message);
	assert.ok(error instanceof GitHubCopilotStreamEndedEarlyError, message.errorMessage);
	assert.equal(error.retryable, true);
	assert.equal(error.requestId, REQUEST_ID);
	assert.equal(isRetryableAssistantError(message), true);
	assert.deepEqual(inferredStopReasonNotes(message), []);
}

describe("a GitHub Copilot Chat Completions stream that ends with [DONE] but no finish reason", () => {
	it("accepts complete parallel tool calls as a tool-use turn and notes the inferred stop reason", async () => {
		const message = await streamBody(sseBody(PARALLEL_TOOL_CALLS));

		assert.equal(message.stopReason, "toolUse", message.errorMessage);
		assert.equal(message.errorMessage, undefined);
		assert.equal(message.rawStopReason, undefined);
		assert.equal(getGitHubCopilotError(message), undefined);
		assert.deepEqual(
			toolCalls(message).map((call) => [call.id, call.name, call.arguments, call.argumentsError]),
			[
				["call_weather", "get_weather", { city: "Paris" }, undefined],
				["call_ping", "ping", {}, undefined],
			],
		);
		assert.equal(message.usage.output, 64);
		const notes = inferredStopReasonNotes(message);
		assert.equal(notes.length, 1);
		assert.equal(notes[0]?.details?.stopReason, "toolUse");
		assert.equal(typeof notes[0]?.details?.message, "string");
	});

	it.each([
		["the connection closes", "close"],
		["the connection drops", "cut"],
	] as const)("accepts a text answer as a stop when %s after [DONE]", async (_name, ending) => {
		const message = await streamBody(sseBody(TEXT_ANSWER), ending);

		assert.equal(message.stopReason, "stop", message.errorMessage);
		assert.equal(message.errorMessage, undefined);
		assert.equal(message.content.find((block) => block.type === "text")?.text, "Paris is sunny.");
		assert.deepEqual(
			inferredStopReasonNotes(message).map((note) => note.details?.stopReason),
			["stop"],
		);
	});

	it.each([
		["arguments cut off mid-object", [toolCallChunk(0, "call_weather", "get_weather", '{"city":"Pa')]],
		["no arguments at all", [toolCallChunk(0, "call_weather", "get_weather", undefined)]],
		["arguments that are not an object", [toolCallChunk(0, "call_weather", "get_weather", '["Paris"]')]],
		["no name", [toolCallChunk(0, "call_weather", "", '{"city":"Paris"}')]],
		[
			"custom input, which has no end of its own",
			[
				chatChunk({
					content: null,
					tool_calls: [
						{ index: 0, id: "call_patch", type: "custom", custom: { name: "apply_patch", input: "*** Begin" } },
					],
				}),
			],
		],
		[
			"one complete call followed by an incomplete one",
			[
				toolCallChunk(0, "call_weather", "get_weather", '{"city":"Paris"}'),
				toolCallChunk(1, "call_ping", "ping", "{"),
			],
		],
		[
			"text and an incomplete call",
			[chatChunk({ content: "Checking." }), toolCallChunk(0, "call_weather", "get_weather", '{"city"')],
		],
	] as const)("keeps a tool call with %s a stream that ended early", async (_name, events) => {
		const message = await streamBody(sseBody([...events, UNFINISHED_LAST_CHUNK]));

		assertEndedEarly(message);
	});

	it("reports a turn with no text and no tool call as an empty response", async () => {
		const message = await streamBody(sseBody(REASONING_ONLY));

		assert.equal(message.stopReason, "error");
		const error = getGitHubCopilotError(message);
		assert.ok(error instanceof GitHubCopilotEmptyResponseError, message.errorMessage);
		assert.equal(error.retryable, true);
		assert.deepEqual(inferredStopReasonNotes(message), []);
	});

	it("counts a [DONE] that ends the stream without its blank line", async () => {
		const message = await streamBody(sseBody(TEXT_ANSWER).replace(/\n\n$/, ""));

		assert.equal(message.stopReason, "stop", message.errorMessage);
	});

	it("finds [DONE] however the body is split and whatever line endings it uses", async () => {
		const baseUrl = await startServer(sseBody(PARALLEL_TOOL_CALLS).replaceAll("\n", "\r\n"));
		const message = await streamFrom(gemini(baseUrl), { fetch: inSmallPieces(3) });

		assert.equal(message.stopReason, "toolUse", message.errorMessage);
		assert.equal(toolCalls(message).length, 2);
	});
});

describe("a GitHub Copilot Chat Completions stream that ends without [DONE]", () => {
	it.each([
		["closes", "close"],
		["is cut off", "cut"],
	] as const)("stays a stream that ended early when it %s, even after complete tool calls", async (_name, ending) => {
		const message = await streamBody(sseBody(PARALLEL_TOOL_CALLS, { done: false }), ending);

		assertEndedEarly(message);
	});

	it("stays a stream that ended early after a text answer", async () => {
		const message = await streamBody(sseBody(TEXT_ANSWER, { done: false }));

		assertEndedEarly(message);
	});
});

describe("streams whose finish reason decides the turn", () => {
	it.each([
		["tool_calls", "toolUse"],
		["stop", "stop"],
		["length", "length"],
	] as const)("keeps a Copilot finish reason %s as %s without a note", async (finish, stopReason) => {
		const events = [chatChunk({ content: "Paris" }), chatChunk({ content: null }, { finish, usage: FINAL_USAGE })];
		const message = await streamBody(sseBody(events));

		assert.equal(message.stopReason, stopReason, message.errorMessage);
		assert.equal(message.rawStopReason, finish);
		assert.equal(message.diagnostics, undefined);
	});

	it("leaves another provider's stream that ends with [DONE] but no finish reason an error", async () => {
		const baseUrl = await startServer(sseBody(PARALLEL_TOOL_CALLS));
		const message = await streamFrom({ ...gemini(baseUrl), provider: "fixture-provider" });

		assert.equal(message.stopReason, "error");
		assert.equal(message.errorMessage, "Stream ended without finish_reason");
		assert.equal(getGitHubCopilotError(message), undefined);
		assert.deepEqual(inferredStopReasonNotes(message), []);
	});
});

describe("a GitHub Copilot response that is never read", () => {
	it("releases its connection once the response is collected", async () => {
		const collectGarbage = forcedGarbageCollection();
		const server = await startEndlessServer();

		const message = await streamSimple(gemini(server.baseUrl), userTurn, {
			apiKey: API_KEY,
			maxRetries: 0,
			reasoning: "low",
			onResponse: () => {
				throw new Error("response rejected before its body was read");
			},
		}).result();
		assert.equal(message.stopReason, "error");

		const deadline = Date.now() + 15_000;
		while (!server.connectionClosed() && Date.now() < deadline) {
			collectGarbage();
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(server.connectionClosed(), true, "the unread response kept its connection open");
	});
});

describe("DoneEventWatch", () => {
	it("leaves a response's body to be released until the body is read", async () => {
		let original: Response | undefined;
		const watch = new DoneEventWatch();
		const fetch = watch.watch(async () => {
			original = new Response(sseBody(TEXT_ANSWER), { status: 200 });
			return original;
		});

		const watched = await fetch("http://127.0.0.1:9/unread");
		assert.equal(original?.body?.locked, false);
		assert.equal(await watched.text(), sseBody(TEXT_ANSWER));
		assert.equal(watch.received, true);
	});

	it("keeps the response's URL", async () => {
		const url = `${await startServer(sseBody(TEXT_ANSWER))}/chat/completions`;

		const watched = await new DoneEventWatch().watch(globalThis.fetch)(url);
		assert.equal(watched.url, url);
		await watched.text();
	});

	it.each([
		["a [DONE] event", "data: {}\n\ndata: [DONE]\n\n", true],
		["[DONE] without a space after the colon", "data:[DONE]\n\n", true],
		["[DONE] with an event name, an ID and a comment", ": ping\nevent: end\nid: 7\ndata: [DONE]\r\n\r\n", true],
		["[DONE] that ends the stream without a line end", "data: {}\n\ndata: [DONE]", true],
		["[DONE] beside a field whose name only starts with data", "data: [DONE]\ndatabase: x\n\n", true],
		["[DONE] after one very long event", `data: "${"x".repeat(300_000)}"\n\ndata: [DONE]\n\n`, true],
		["[DONE] with trailing text", "data: [DONE] \n\n", false],
		["[DONE] with two spaces after the colon", "data:  [DONE]\n\n", false],
		["[DONE] inside a longer data line", 'data: {"text":"data: [DONE]"}\n\n', false],
		["[DONE] followed by a second data line in the same event", "data: [DONE]\r\ndata: more\r\n\r\n", false],
		["[DONE] after another data line in the same event", "data: more\ndata: [DONE]\n\n", false],
		["[DONE] in a field that is not data", "datum: [DONE]\n\nevent: [DONE]\n\n", false],
	] as const)("reads %s the way the SDK does, however the body is split", async (_name, body, received) => {
		for (const size of [1, 2, 5, body.length]) {
			const watch = new DoneEventWatch();
			const fetch = watch.watch(async () => new Response(inPieces(body, size), { status: 200 }));

			assert.equal(await (await fetch("http://127.0.0.1:9/pieces")).text(), body);
			assert.equal(watch.received, received, `pieces of ${size} bytes`);
		}
	});

	it("forgets an earlier response's [DONE] when the next request starts", async () => {
		const bodies = [sseBody(TEXT_ANSWER), sseBody(TEXT_ANSWER, { done: false })];
		const watch = new DoneEventWatch();
		const fetch = watch.watch(async () => new Response(bodies.shift(), { status: 200 }));

		await (await fetch("http://127.0.0.1:9/first")).text();
		assert.equal(watch.received, true);
		const second = await fetch("http://127.0.0.1:9/second");
		assert.equal(watch.received, false);
		assert.equal(await second.text(), sseBody(TEXT_ANSWER, { done: false }));
		assert.equal(watch.received, false);
	});
});

/** `body` as a stream of pieces of at most `size` bytes. */
function inPieces(body: string, size: number): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(body);
	let start = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (start >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(start, start + size));
			start += size;
		},
	});
}

/** Node's `gc()`, exposed for this test without a command-line flag. */
function forcedGarbageCollection(): () => void {
	setFlagsFromString("--expose-gc");
	return runInNewContext("gc") as () => void;
}

/** Answers 200 and streams a chunk every 20 ms for a minute, noting when the client's connection closes. */
async function startEndlessServer(): Promise<{ baseUrl: string; connectionClosed: () => boolean }> {
	let closed = false;
	const server = createServer((request, response) => {
		request.resume();
		response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": REQUEST_ID });
		const chunk = `data: ${JSON.stringify(chatChunk({ content: "more " }))}\n\n`;
		const timer = setInterval(() => response.write(chunk), 20);
		const stop = setTimeout(() => response.end(), 60_000);
		request.socket.once("close", () => {
			closed = true;
			clearInterval(timer);
			clearTimeout(stop);
		});
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		connectionClosed: () => closed,
	};
}

/** A fetch that hands the response body on in pieces of at most `size` bytes. */
function inSmallPieces(size: number): typeof globalThis.fetch {
	return async (input, init) => {
		const response = await globalThis.fetch(input, init);
		const source = response.body;
		if (!source) return response;
		const body = source.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					for (let start = 0; start < chunk.length; start += size) {
						controller.enqueue(chunk.slice(start, start + size));
					}
				},
			}),
		);
		return new Response(body, { status: response.status, headers: response.headers });
	};
}
