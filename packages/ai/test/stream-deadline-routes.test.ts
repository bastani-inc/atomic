import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

const STREAM_DEADLINE_MS = 50;
const STREAM_SETTLEMENT_TIMEOUT_MS = 10_000;
const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

const servers: Server[] = [];

function createCodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function createCodexModel(baseUrl: string): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

async function startStalledServer(initialEvent: string): Promise<{ baseUrl: string; connections: Set<Socket> }> {
	const connections = new Set<Socket>();
	const server = createServer((request, response) => {
		request.resume();
		response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
		response.write(initialEvent);
		// Deliberately leave the SSE body open. The provider deadline must cancel
		// the reader and close this server-side socket.
	});
	server.on("connection", (socket) => {
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${address.port}`, connections };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + STREAM_SETTLEMENT_TIMEOUT_MS;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("stalled provider socket did not close");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
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

describe("provider stream deadlines for native SSE routes (#2553)", () => {
	it("bounds a stalled pi-messages response and closes its body", async () => {
		const { baseUrl, connections } = await startStalledServer('data: {"type":"start"}\n\n');
		const model: Model<"pi-messages"> = {
			id: "test-model",
			name: "Test model",
			api: "pi-messages",
			provider: "test-provider",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_000,
			maxTokens: 1024,
		};

		const message = await streamPiMessages(model, context, {
			apiKey: "test-key",
			streamDeadlineMs: STREAM_DEADLINE_MS,
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("stream deadline exceeded");
		await waitFor(() => connections.size === 0);
	});

	it("bounds a stalled Mistral response and closes its body", async () => {
		const { baseUrl, connections } = await startStalledServer(
			'data: {"id":"response-1","choices":[{"index":0,"finish_reason":null,"delta":{"content":"partial"}}]}\n\n',
		);
		const model = { ...getModel("mistral", "mistral-large-latest"), baseUrl };

		const message = await streamMistral(model, context, {
			apiKey: "test-key",
			streamDeadlineMs: STREAM_DEADLINE_MS,
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("stream deadline exceeded");
		await waitFor(() => connections.size === 0);
	});

	it("bounds a stalled Codex SSE response and closes its body", async () => {
		const { baseUrl, connections } = await startStalledServer(
			'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
		);
		const message = await streamCodex(createCodexModel(baseUrl), context, {
			apiKey: createCodexToken("test-account"),
			transport: "sse",
			streamDeadlineMs: STREAM_DEADLINE_MS,
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("stream deadline exceeded");
		await waitFor(() => connections.size === 0);
	});
});
