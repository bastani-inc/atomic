import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { crc32 } from "node:zlib";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import { getApiProvider, getApiProviders } from "../src/compat.ts";
import type { AssistantMessage, AssistantMessageEventStream, KnownApi, Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * Every registered streaming provider must cut a response that sends one event
 * and then goes silent, settle with the retryable "stream deadline exceeded"
 * error, and close the abandoned connection (#4904).
 */

/** Deadline for the per-provider regression tests: long enough to measure, short enough for the suite. */
const STREAM_DEADLINE_MS = 1_000;
/** Shorter deadline for the table that runs every registered provider. */
const TABLE_STREAM_DEADLINE_MS = 200;
/** Headroom for request setup and settlement under a loaded test run; a hang exceeds it by construction. */
const SETTLEMENT_MARGIN_MS = 8_000;

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const servers: Server[] = [];

interface StalledServer {
	baseUrl: string;
	connections: Set<Socket>;
	requests: () => number;
}

/** A server that answers every request with headers and one event, then never writes again. */
async function startStalledServer(contentType: string, firstEvent: string | Buffer): Promise<StalledServer> {
	const connections = new Set<Socket>();
	let requests = 0;
	const server = createServer((request, response) => {
		requests++;
		request.resume();
		response.writeHead(200, { "cache-control": "no-cache", "content-type": contentType });
		response.write(firstEvent);
	});
	server.on("connection", (socket) => {
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${address.port}`, connections, requests: () => requests };
}

async function waitForClosedConnections(server: StalledServer): Promise<void> {
	const deadline = Date.now() + SETTLEMENT_MARGIN_MS;
	while (server.connections.size > 0) {
		if (Date.now() >= deadline) throw new Error("the stalled provider connection was never closed");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Resolve the stream's final message, or fail if it never settles (the #4904 hang). */
async function settle(stream: AssistantMessageEventStream, deadlineMs: number): Promise<AssistantMessage> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const hang = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`stream did not settle within ${deadlineMs + SETTLEMENT_MARGIN_MS}ms`)),
			deadlineMs + SETTLEMENT_MARGIN_MS,
		);
	});
	try {
		return await Promise.race([stream.result(), hang]);
	} finally {
		clearTimeout(timer);
	}
}

function assertDeadlineError(message: AssistantMessage): void {
	assert.equal(message.stopReason, "error");
	assert.match(message.errorMessage ?? "", /stream deadline exceeded/);
}

function testModel<TApi extends KnownApi>(
	api: TApi,
	provider: string,
	baseUrl: string,
	overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
	return {
		id: "test-model",
		name: "Test model",
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
		...overrides,
	};
}

/** Encode one AWS event-stream frame (prelude, CRCs, string headers, payload) as Bedrock sends it. */
function encodeEventStreamFrame(headers: Record<string, string>, payload: string): Buffer {
	const headerBytes = Buffer.concat(
		Object.entries(headers).map(([name, value]) => {
			const nameBytes = Buffer.from(name, "utf8");
			const valueBytes = Buffer.from(value, "utf8");
			const valueLength = Buffer.alloc(2);
			valueLength.writeUInt16BE(valueBytes.length);
			// Header value type 7 is a UTF-8 string.
			return Buffer.concat([Buffer.from([nameBytes.length]), nameBytes, Buffer.from([7]), valueLength, valueBytes]);
		}),
	);
	const payloadBytes = Buffer.from(payload, "utf8");
	const prelude = Buffer.alloc(8);
	prelude.writeUInt32BE(12 + headerBytes.length + payloadBytes.length + 4, 0);
	prelude.writeUInt32BE(headerBytes.length, 4);
	const preludeCrc = Buffer.alloc(4);
	preludeCrc.writeUInt32BE(crc32(prelude));
	const message = Buffer.concat([prelude, preludeCrc, headerBytes, payloadBytes]);
	const messageCrc = Buffer.alloc(4);
	messageCrc.writeUInt32BE(crc32(message));
	return Buffer.concat([message, messageCrc]);
}

const GOOGLE_FIRST_EVENT =
	'data: {"responseId":"response-1","candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]}}]}\n\n';
const BEDROCK_FIRST_EVENT = encodeEventStreamFrame(
	{ ":message-type": "event", ":event-type": "messageStart", ":content-type": "application/json" },
	'{"role":"assistant"}',
);
const BEDROCK_CONTENT_TYPE = "application/vnd.amazon.eventstream";
/** Route the real AWS SDK to the local server over HTTP/1.1 without real credentials. */
const BEDROCK_ENV = { AWS_BEDROCK_SKIP_AUTH: "1", AWS_BEDROCK_FORCE_HTTP1: "1", AWS_REGION: "us-east-1" };

function createCodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

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

describe("stream deadline for Google, Vertex and Bedrock (#4904)", () => {
	it("cuts a stalled Google Gemini stream at the deadline and closes the connection (#4904)", async () => {
		const server = await startStalledServer("text/event-stream", GOOGLE_FIRST_EVENT);
		const startedAt = Date.now();

		const message = await settle(
			streamGoogle(testModel("google-generative-ai", "google", `${server.baseUrl}/v1beta`), context, {
				apiKey: "test-key",
				streamDeadlineMs: STREAM_DEADLINE_MS,
			}),
			STREAM_DEADLINE_MS,
		);

		assertDeadlineError(message);
		assert.ok(Date.now() - startedAt >= STREAM_DEADLINE_MS);
		await waitForClosedConnections(server);
	});

	it("cuts a stalled Google Vertex stream at the deadline and closes the connection (#4904)", async () => {
		const server = await startStalledServer("text/event-stream", GOOGLE_FIRST_EVENT);
		const startedAt = Date.now();

		const message = await settle(
			streamVertex(testModel("google-vertex", "google-vertex", `${server.baseUrl}/v1`), context, {
				apiKey: "test-key",
				streamDeadlineMs: STREAM_DEADLINE_MS,
			}),
			STREAM_DEADLINE_MS,
		);

		assertDeadlineError(message);
		assert.ok(Date.now() - startedAt >= STREAM_DEADLINE_MS);
		await waitForClosedConnections(server);
	});

	it("cuts a stalled Bedrock event stream at the deadline and closes the connection (#4904)", async () => {
		const server = await startStalledServer(BEDROCK_CONTENT_TYPE, BEDROCK_FIRST_EVENT);
		const startedAt = Date.now();

		const message = await settle(
			streamBedrock(testModel("bedrock-converse-stream", "amazon-bedrock", server.baseUrl), context, {
				env: BEDROCK_ENV,
				streamDeadlineMs: STREAM_DEADLINE_MS,
			}),
			STREAM_DEADLINE_MS,
		);

		assertDeadlineError(message);
		assert.ok(Date.now() - startedAt >= STREAM_DEADLINE_MS);
		await waitForClosedConnections(server);
	});
});

interface StallCase {
	contentType: string;
	firstEvent: string | Buffer;
	model: (baseUrl: string) => Model<KnownApi>;
	options: (baseUrl: string) => StreamOptions & Record<string, unknown>;
}

const SSE = "text/event-stream";

/** One stall per registered streaming API. A new API must add a row here. */
const STALL_CASES: Record<KnownApi, StallCase> = {
	"anthropic-messages": {
		contentType: SSE,
		firstEvent:
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
		model: (baseUrl) => testModel("anthropic-messages", "anthropic", baseUrl),
		options: () => ({ apiKey: "test-key" }),
	},
	"openai-completions": {
		contentType: SSE,
		firstEvent:
			'data: {"id":"chunk-1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
		model: (baseUrl) => testModel("openai-completions", "test-provider", baseUrl),
		options: () => ({ apiKey: "test-key" }),
	},
	"openai-responses": {
		contentType: SSE,
		firstEvent:
			'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","status":"in_progress","output":[]}}\n\n',
		model: (baseUrl) => testModel("openai-responses", "openai", baseUrl),
		options: () => ({ apiKey: "test-key" }),
	},
	"azure-openai-responses": {
		contentType: SSE,
		firstEvent:
			'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","status":"in_progress","output":[]}}\n\n',
		model: (baseUrl) => testModel("azure-openai-responses", "azure-openai-responses", `${baseUrl}/openai/v1`),
		options: (baseUrl) => ({ apiKey: "test-key", azureBaseUrl: `${baseUrl}/openai/v1` }),
	},
	"openai-codex-responses": {
		contentType: SSE,
		firstEvent: 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
		model: (baseUrl) => testModel("openai-codex-responses", "openai-codex", baseUrl, { reasoning: true }),
		options: () => ({ apiKey: createCodexToken("test-account"), transport: "sse" }),
	},
	"google-generative-ai": {
		contentType: SSE,
		firstEvent: GOOGLE_FIRST_EVENT,
		model: (baseUrl) => testModel("google-generative-ai", "google", `${baseUrl}/v1beta`),
		options: () => ({ apiKey: "test-key" }),
	},
	"google-vertex": {
		contentType: SSE,
		firstEvent: GOOGLE_FIRST_EVENT,
		model: (baseUrl) => testModel("google-vertex", "google-vertex", `${baseUrl}/v1`),
		options: () => ({ apiKey: "test-key" }),
	},
	"mistral-conversations": {
		contentType: SSE,
		firstEvent:
			'data: {"id":"response-1","choices":[{"index":0,"finish_reason":null,"delta":{"content":"partial"}}]}\n\n',
		model: (baseUrl) => testModel("mistral-conversations", "mistral", baseUrl),
		options: () => ({ apiKey: "test-key" }),
	},
	"bedrock-converse-stream": {
		contentType: BEDROCK_CONTENT_TYPE,
		firstEvent: BEDROCK_FIRST_EVENT,
		model: (baseUrl) => testModel("bedrock-converse-stream", "amazon-bedrock", baseUrl),
		options: () => ({ env: BEDROCK_ENV }),
	},
	"pi-messages": {
		contentType: SSE,
		firstEvent: 'data: {"type":"start"}\n\n',
		model: (baseUrl) => testModel("pi-messages", "test-provider", baseUrl),
		options: () => ({ apiKey: "test-key" }),
	},
};

describe("stream deadline across every registered streaming provider (#4904)", () => {
	it("has a stall case for every registered streaming API (#4904)", () => {
		assert.deepEqual(
			getApiProviders()
				.map((provider) => provider.api)
				.sort(),
			Object.keys(STALL_CASES).sort(),
		);
	});

	for (const [api, stallCase] of Object.entries(STALL_CASES)) {
		it(`cuts a stalled ${api} stream at the deadline and closes the connection (#4904)`, async () => {
			const server = await startStalledServer(stallCase.contentType, stallCase.firstEvent);
			const provider = getApiProvider(api);
			assert.ok(provider, `${api} is not registered`);

			const message = await settle(
				provider.stream(stallCase.model(server.baseUrl), context, {
					...stallCase.options(server.baseUrl),
					streamDeadlineMs: TABLE_STREAM_DEADLINE_MS,
				}),
				TABLE_STREAM_DEADLINE_MS,
			);

			assertDeadlineError(message);
			assert.equal(server.requests(), 1, `${api} retried inside the attempt instead of failing over`);
			await waitForClosedConnections(server);
		});
	}
});
