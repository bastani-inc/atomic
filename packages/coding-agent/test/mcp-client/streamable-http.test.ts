import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, it, vi } from "vitest";
import {
	LATEST_PROTOCOL_VERSION,
	type McpAuthRequiredError,
	McpClient,
	type McpFetch,
	McpSessionExpiredError,
	StreamableHttpTransport,
} from "../../src/extensions/mcp/client/index.js";
import { consumeSseStream, type SseEvent } from "../../src/extensions/mcp/client/transports/streamable-http.js";
import { closeServers, listen, readBody } from "./helpers.js";

interface RecordedRequest {
	method: string;
	headers: IncomingMessage["headers"];
	message?: Record<string, unknown>;
}

async function startServer(
	handler: (request: IncomingMessage, response: ServerResponse, requests: RecordedRequest[]) => Promise<void>,
): Promise<{ url: string; requests: RecordedRequest[] }> {
	const requests: RecordedRequest[] = [];
	const origin = await listen((request, response) => handler(request, response, requests));
	return { url: `${origin}/mcp`, requests };
}

async function protocolHandler(
	request: IncomingMessage,
	response: ServerResponse,
	requests: RecordedRequest[],
	body?: Record<string, unknown>,
): Promise<void> {
	if (request.method === "GET") {
		requests.push({ method: "GET", headers: request.headers });
		response.statusCode = 405;
		response.end();
		return;
	}
	if (request.method === "DELETE") {
		requests.push({ method: "DELETE", headers: request.headers });
		response.statusCode = 200;
		response.end();
		return;
	}
	const message = body ?? (JSON.parse(await readBody(request)) as Record<string, unknown>);
	requests.push({ method: request.method ?? "", headers: request.headers, message });
	if (!("id" in message)) {
		response.statusCode = 202;
		response.end();
		return;
	}
	if (message.method === "initialize") {
		response.writeHead(200, {
			"content-type": "application/json",
			"mcp-session-id": "session-1",
		});
		response.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "http-fixture", version: "1.0.0" },
				},
			}),
		);
		return;
	}
	if (message.method === "tools/list") {
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
			}),
		);
		return;
	}
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write("id: tool-result\n");
	response.end(
		`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "hello" }] } })}\n\n`,
	);
}

afterEach(closeServers);

describe("consumeSseStream", () => {
	it("parses chunked CRLF events, comments, IDs, and multiline data", async () => {
		const encoder = new TextEncoder();
		const chunks = [': keepalive\r\nid: 7\r\ndata: {"one":\r\n', "data: 1}\r\n\r\n"];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
		const events: SseEvent[] = [];
		await consumeSseStream(stream, { onEvent: (event) => events.push(event) });
		assert.deepEqual(events, [{ id: "7", data: '{"one":\n1}' }]);
	});

	it("rejects events whose data lines exceed the limit without a blank line", async () => {
		const encoder = new TextEncoder();
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				// Never sends a blank line, so the event is never dispatched.
				if (sent++ > 1000) controller.close();
				else controller.enqueue(encoder.encode("data: xxxxxxxxxxxxxxxx\n"));
			},
		});
		await assert.rejects(
			consumeSseStream(stream, { maxEventBytes: 256, onEvent: () => {} }),
			/MCP SSE event exceeds 256 bytes/,
		);
		assert.ok(sent < 100);
	});
});

describe("StreamableHttpTransport", () => {
	it("handles JSON and SSE responses with session and protocol headers", async () => {
		const { url, requests } = await startServer(protocolHandler);
		const transport = new StreamableHttpTransport({ url });
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(transport);
		assert.equal(transport.sessionId, "session-1");
		assert.deepEqual(await client.listTools(), [{ name: "echo", inputSchema: { type: "object" } }]);
		assert.deepEqual(await client.callTool("echo", { text: "hello" }), {
			content: [{ type: "text", text: "hello" }],
		});
		await client.close();

		const listRequest = requests.find((entry) => entry.message?.method === "tools/list");
		assert.equal(listRequest?.headers["mcp-session-id"], "session-1");
		assert.equal(listRequest?.headers["mcp-protocol-version"], LATEST_PROTOCOL_VERSION);
		assert.equal(
			requests.some((entry) => entry.method === "GET"),
			true,
		);
		assert.equal(
			requests.some((entry) => entry.method === "DELETE"),
			true,
		);
	});

	it("classifies authentication failures", async () => {
		const { url } = await startServer(async (request, response) => {
			await readBody(request);
			response.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="https://example.com/meta"' });
			response.end("login required");
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await assert.rejects(client.connect(new StreamableHttpTransport({ url })), {
			name: "McpAuthRequiredError",
			status: 401,
			body: "login required",
			wwwAuthenticate: 'Bearer resource_metadata="https://example.com/meta"',
		} satisfies Partial<McpAuthRequiredError>);
	});

	it("fails only the request whose SSE stream breaks", async () => {
		let releaseSlow = () => {};
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			const name = (message.params as { name?: string } | undefined)?.name;
			if (name === "broken") {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end("data: not json\n\n");
				return;
			}
			if (name === "slow") await slowGate;
			await protocolHandler(request, response, requests, message);
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		const errors: Error[] = [];
		client.onError((error) => errors.push(error));
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));

		const slow = client.callTool("slow");
		await assert.rejects(client.callTool("broken"), /MCP response stream failed/);
		releaseSlow();
		assert.deepEqual(await slow, { content: [{ type: "text", text: "hello" }] });
		assert.equal(errors.length, 1);
		await client.close();
	});

	it("opens the GET stream after initialization and sends Last-Event-ID only when resuming", async () => {
		const order: string[] = [];
		const { url, requests } = await startServer(async (request, response, requests) => {
			if (request.method === "POST") {
				const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
				order.push(String(message.method));
				return protocolHandler(request, response, requests, message);
			}
			order.push(request.method ?? "");
			return protocolHandler(request, response, requests);
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(new StreamableHttpTransport({ url }));
		await client.callTool("echo");
		await client.listTools();
		await client.close();
		assert.ok(order.indexOf("GET") > order.indexOf("notifications/initialized"));
		assert.equal(
			requests.every((entry) => entry.headers["last-event-id"] === undefined),
			true,
		);
	});

	it("resumes a response stream the server closed before answering", async () => {
		const resumeHeaders: (string | undefined)[] = [];
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method === "GET" && request.headers["last-event-id"]) {
				resumeHeaders.push(request.headers["last-event-id"] as string);
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					`id: 2\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "resumed" }] } })}\n\n`,
				);
				return;
			}
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (message.method !== "tools/call") return protocolHandler(request, response, requests, message);
			// Priming event (ID, no data) and a retry hint, then the server drops the stream.
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end("id: 1\nretry: 5\ndata:\n\n");
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		const errors: Error[] = [];
		client.onError((error) => errors.push(error));
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		assert.deepEqual(await client.callTool("echo"), { content: [{ type: "text", text: "resumed" }] });
		assert.deepEqual(resumeHeaders, ["1"]);
		assert.deepEqual(errors, []);
		await client.close();
	});

	it("fails a request whose response stream ends without an answer", async () => {
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (message.method !== "tools/call") return protocolHandler(request, response, requests, message);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(": nothing here\n\n");
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		await assert.rejects(
			client.callTool("echo", {}, { timeoutMs: 5_000 }),
			/MCP response stream failed: stream ended without a response/,
		);
		await client.close();
	});

	it("reconnects the GET stream after it drops", async () => {
		let gets = 0;
		const lastEventIds: (string | undefined)[] = [];
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method !== "GET") return protocolHandler(request, response, requests);
			gets++;
			lastEventIds.push(request.headers["last-event-id"] as string | undefined);
			response.writeHead(200, { "content-type": "text/event-stream" });
			const notification = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
			if (gets === 1) {
				response.end(`id: g1\ndata: ${JSON.stringify(notification)}\n\n`);
				return;
			}
			response.write(`id: g2\ndata: ${JSON.stringify(notification)}\n\n`);
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		let changes = 0;
		const secondChange = new Promise<void>((resolve) => {
			client.onNotification("notifications/tools/list_changed", () => {
				if (++changes === 2) resolve();
			});
		});
		await client.connect(new StreamableHttpTransport({ url, reconnect: { initialDelayMs: 1 } }));
		await secondChange;
		assert.deepEqual(lastEventIds, [undefined, "g1"]);
		await client.close();
	});

	it("rejects a request the server accepts without a response", async () => {
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (message.method !== "tools/call") return protocolHandler(request, response, requests, message);
			response.statusCode = 202;
			response.end();
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		await assert.rejects(client.callTool("echo"), /without a response/);
		await client.close();
	});

	it("includes the response body in HTTP errors", async () => {
		const { url } = await startServer(async (request, response) => {
			await readBody(request);
			response.statusCode = 400;
			response.end("Invalid Accept header");
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await assert.rejects(
			client.connect(new StreamableHttpTransport({ url })),
			/MCP HTTP request failed with status 400: Invalid Accept header/,
		);
	});

	it("hands 401 and insufficient-scope 403 responses to the auth provider with the rejected token", async () => {
		const seen: { status: number; token?: string }[] = [];
		let token = "old";
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (request.headers.authorization === "Bearer old") {
				response.writeHead(401, { "www-authenticate": "Bearer" }).end();
				return;
			}
			if (message.method === "tools/call" && request.headers.authorization === "Bearer new") {
				response.writeHead(403, { "www-authenticate": 'Bearer error="insufficient_scope", scope="admin"' }).end();
				return;
			}
			return protocolHandler(request, response, requests, message);
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(
			new StreamableHttpTransport({
				url,
				openGetStream: false,
				authProvider: {
					token: async () => token,
					onUnauthorized: async ({ response, token: rejected }) => {
						seen.push({ status: response.status, token: rejected });
						if (response.status === 401) token = "new";
						else token = "admin";
					},
				},
			}),
		);
		assert.deepEqual(await client.callTool("echo"), { content: [{ type: "text", text: "hello" }] });
		assert.deepEqual(seen, [
			{ status: 401, token: "old" },
			{ status: 403, token: "new" },
		]);
		await client.close();
	});

	// #10188: Cloudflare Workers reject the platform fetch when called with a receiver other than globalThis.
	it("calls fetch without a receiver", async () => {
		const realFetch = globalThis.fetch;
		const strictFetch = function (this: unknown, input: string | URL, init?: RequestInit) {
			if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
			return realFetch(input, init);
		} satisfies McpFetch;
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method === "POST" && request.headers.authorization === undefined) {
				await readBody(request);
				response.writeHead(401, { "www-authenticate": "Bearer" }).end();
				return;
			}
			return protocolHandler(request, response, requests);
		});
		const connect = async (fetch: McpFetch | undefined) => {
			let token: string | undefined;
			const client = new McpClient({ name: "http-test", version: "1.0.0" });
			await client.connect(
				new StreamableHttpTransport({
					url,
					fetch,
					openGetStream: false,
					authProvider: {
						token: async () => token,
						onUnauthorized: async (context) => {
							await (await context.fetch(url)).body?.cancel();
							token = "token";
						},
					},
				}),
			);
			assert.deepEqual(await client.listTools(), [{ name: "echo", inputSchema: { type: "object" } }]);
			await client.close();
		};

		await connect(strictFetch);
		vi.stubGlobal("fetch", strictFetch);
		try {
			await connect(undefined);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("classifies an expired established session", async () => {
		let posts = 0;
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method === "POST" && posts++ >= 2) {
				await readBody(request);
				response.statusCode = 404;
				response.end("gone");
				return;
			}
			await protocolHandler(request, response, requests);
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		await assert.rejects(client.listTools(), McpSessionExpiredError);
		await client.close();
	});
});
