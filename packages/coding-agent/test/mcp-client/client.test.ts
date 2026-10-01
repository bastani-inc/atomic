import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, it, vi } from "vitest";
import {
	type JsonRpcMessage,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpAbortError,
	McpClient,
	McpError,
	McpTimeoutError,
} from "../../src/extensions/mcp/client/index.js";
import { createInMemoryTransportPair, type InMemoryTransport } from "../../src/extensions/mcp/client/testing/index.js";

interface TestServer {
	transport: InMemoryTransport;
	messages: JsonRpcMessage[];
	setHandler(method: string, handler: (request: JsonRpcRequest) => unknown | Promise<unknown>): void;
}

async function createServer(): Promise<{ clientTransport: InMemoryTransport; server: TestServer }> {
	const pair = createInMemoryTransportPair();
	const handlers = new Map<string, (request: JsonRpcRequest) => unknown | Promise<unknown>>();
	const messages: JsonRpcMessage[] = [];
	pair.server.onMessage((message) => {
		messages.push(message);
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const handler = handlers.get(request.method);
		queueMicrotask(async () => {
			try {
				if (!handler) throw new McpError(-32601, `Method not found: ${request.method}`);
				await pair.server.send({ jsonrpc: "2.0", id: request.id, result: await handler(request) });
			} catch (error) {
				const mcpError = error instanceof McpError ? error : new McpError(-32603, String(error));
				await pair.server.send({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: mcpError.code, message: mcpError.message, data: mcpError.data },
				});
			}
		});
	});
	await pair.server.start();
	const server: TestServer = {
		transport: pair.server,
		messages,
		setHandler(method, handler) {
			handlers.set(method, handler);
		},
	};
	server.setHandler("initialize", () => ({
		protocolVersion: LATEST_PROTOCOL_VERSION,
		capabilities: { tools: { listChanged: true } },
		serverInfo: { name: "test-server", version: "1.0.0" },
		instructions: "Use test tools.",
	}));
	return { clientTransport: pair.client, server };
}

async function connect(): Promise<{ client: McpClient; server: TestServer }> {
	const { clientTransport, server } = await createServer();
	const client = new McpClient({ name: "test-client", version: "2.0.0" });
	await client.connect(clientTransport);
	return { client, server };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("McpClient", () => {
	it("initializes the connection before exposing server information", async () => {
		const { client, server } = await connect();
		assert.equal(client.connectionState, "connected");
		assert.equal(client.protocolVersion, LATEST_PROTOCOL_VERSION);
		assert.deepEqual(client.serverInfo, { name: "test-server", version: "1.0.0" });
		assert.deepEqual(client.serverCapabilities, { tools: { listChanged: true } });
		assert.equal(client.instructions, "Use test tools.");
		assert.deepEqual(server.messages, [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "test-client", version: "2.0.0" },
				},
			},
			{ jsonrpc: "2.0", method: "notifications/initialized" },
		]);
		await client.close();
	});

	it.each(["", null])(
		"paginates tools with final cursor %s and preserves protocol tool definitions (#10266)",
		async (nextCursor) => {
			const { client, server } = await connect();
			server.setHandler("tools/list", (request) => {
				const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
				return cursor === undefined
					? {
							tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
							nextCursor: "page-2",
						}
					: {
							tools: [
								{
									name: "read",
									inputSchema: { type: "object" },
									outputSchema: { type: "object" },
									annotations: { readOnlyHint: true },
								},
							],
							nextCursor,
						};
			});
			assert.deepEqual(await client.listTools(), [
				{ name: "search", description: "Search", inputSchema: { type: "object" } },
				{
					name: "read",
					inputSchema: { type: "object" },
					outputSchema: { type: "object" },
					annotations: { readOnlyHint: true },
				},
			]);
			await client.close();
		},
	);

	it.each([undefined, "", null])("lists and reads resources with final cursor %s (#10266)", async (nextCursor) => {
		const { client, server } = await connect();
		server.setHandler("resources/list", (request) =>
			(request.params as { cursor?: string } | undefined)?.cursor === undefined
				? { resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }], nextCursor: "2" }
				: { resources: [{ uri: "file:///b" }], nextCursor },
		);
		server.setHandler("resources/templates/list", () => ({
			resourceTemplates: [{ uriTemplate: "repo://{owner}/{repo}", name: "repo" }],
			nextCursor,
		}));
		server.setHandler("resources/read", (request) => ({
			contents: [{ uri: (request.params as { uri: string }).uri, text: "hello" }],
		}));
		// A missing name falls back to the URI.
		assert.deepEqual(await client.listResources(), [
			{ uri: "file:///a", name: "a", mimeType: "text/plain" },
			{ uri: "file:///b", name: "file:///b" },
		]);
		assert.deepEqual(await client.listResourceTemplates(), [{ uriTemplate: "repo://{owner}/{repo}", name: "repo" }]);
		// Single pages pass the cursor through.
		assert.deepEqual(await client.listResourcesPage(), {
			resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }],
			nextCursor: "2",
		});
		assert.deepEqual(await client.listResourcesPage("2"), { resources: [{ uri: "file:///b", name: "file:///b" }] });
		assert.deepEqual(await client.readResource("file:///a"), { contents: [{ uri: "file:///a", text: "hello" }] });

		server.setHandler("resources/read", () => ({ contents: [{ uri: "file:///a" }] }));
		await assert.rejects(client.readResource("file:///a"), /Invalid contents in MCP resources\/read result/);
		server.setHandler("resources/list", () => ({ resources: [{ name: "no uri" }] }));
		await assert.rejects(client.listResources(), /Invalid entry in MCP resources\/list result/);
		await client.close();
	});

	it("returns structured tool content and surfaces JSON-RPC errors", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", (request) => {
			const params = request.params as { name: string; arguments?: Record<string, unknown> };
			if (params.name === "fail") throw new McpError(1234, "tool failed", { retryable: false });
			return {
				content: [{ type: "text", text: "ok" }],
				structuredContent: { count: params.arguments?.count },
			};
		});
		assert.deepEqual(await client.callTool("count", { count: 3 }), {
			content: [{ type: "text", text: "ok" }],
			structuredContent: { count: 3 },
		});
		await assert.rejects(client.callTool("fail"), {
			name: "McpError",
			code: 1234,
			message: "tool failed",
			data: { retryable: false },
		});
		await client.close();
	});

	it("renews the timeout on progress", async () => {
		vi.useFakeTimers();
		const { client, server } = await connect();
		server.setHandler("tools/call", async (request) => {
			const token = ((request.params as Record<string, unknown>)._meta as Record<string, unknown>)
				.progressToken as number;
			setTimeout(() => {
				void server.transport.send({
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken: token, progress: 1, total: 2 },
				});
			}, 40);
			await new Promise((resolve) => setTimeout(resolve, 80));
			return { content: [{ type: "text", text: "done" }] };
		});
		const progress = vi.fn();
		const result = client.callTool("slow", {}, { timeoutMs: 50, onProgress: progress });
		await vi.advanceTimersByTimeAsync(40);
		await vi.advanceTimersByTimeAsync(40);
		assert.deepEqual(await result, { content: [{ type: "text", text: "done" }] });
		assert.deepEqual(progress.mock.calls, [[{ progressToken: 2, progress: 1, total: 2 }]]);
		await client.close();
	});

	it("cancels aborted and timed-out requests", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", () => new Promise(() => {}));
		const controller = new AbortController();
		const aborted = client.callTool("wait", {}, { signal: controller.signal });
		controller.abort("stop");
		await assert.rejects(aborted, McpAbortError);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(
			server.messages.some((item) =>
				isDeepStrictEqual(item, {
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: 2, reason: "stop" },
				}),
			),
		);

		await assert.rejects(client.callTool("wait", {}, { timeoutMs: 5 }), McpTimeoutError);
		await client.close();
	});

	it("reports transport errors without failing pending requests", async () => {
		const { clientTransport, server } = await createServer();
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		const errors: Error[] = [];
		client.onError((error) => errors.push(error));
		let respond = () => {};
		server.setHandler(
			"tools/call",
			() =>
				new Promise((resolve) => {
					respond = () => resolve({ content: [] });
				}),
		);
		const call = client.callTool("wait");
		await new Promise((resolve) => setTimeout(resolve, 0));
		clientTransport.emitError(new Error("stray log line"));
		respond();
		assert.deepEqual(await call, { content: [] });
		assert.deepEqual(
			errors.map((error) => error.message),
			["stray log line"],
		);
		await client.close();
	});

	it("accepts servers that answer with an older protocol version", async () => {
		const { clientTransport, server } = await createServer();
		server.setHandler("initialize", () => ({
			protocolVersion: "2024-11-05",
			capabilities: {},
			serverInfo: { name: "old-server", version: "0.1.0" },
		}));
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		assert.equal(client.protocolVersion, "2024-11-05");
		await client.close();

		const unsupported = await createServer();
		unsupported.server.setHandler("initialize", () => ({
			protocolVersion: "1999-01-01",
			capabilities: {},
			serverInfo: { name: "ancient-server", version: "0.1.0" },
		}));
		const rejected = new McpClient({ name: "test-client", version: "1.0.0" });
		await assert.rejects(rejected.connect(unsupported.clientTransport), /unsupported protocol version/);
		assert.equal(rejected.connectionState, "closed");
	});

	it("defaults missing tool result content to an empty list", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", () => ({ structuredContent: { ok: true } }));
		assert.deepEqual(await client.callTool("structured"), { content: [], structuredContent: { ok: true } });
		server.setHandler("tools/call", () => ({ content: "not a list" }));
		await assert.rejects(client.callTool("broken"), /Invalid MCP tools\/call result/);
		await client.close();
	});

	it("does not send notifications/cancelled for a timed-out initialize", async () => {
		const { clientTransport, server } = await createServer();
		server.setHandler("initialize", () => new Promise(() => {}));
		const client = new McpClient({ name: "test-client", version: "1.0.0", requestTimeoutMs: 5 });
		await assert.rejects(client.connect(clientTransport), McpTimeoutError);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(
			server.messages.some((message) => "method" in message && message.method === "notifications/cancelled"),
			false,
		);
	});

	it("notifies close listeners once when the transport drops", async () => {
		const { client, server } = await connect();
		const closed = vi.fn();
		client.onClose(closed);
		server.setHandler("tools/call", () => new Promise(() => {}));
		const pending = client.callTool("wait");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await server.transport.close();
		await assert.rejects(pending, /MCP connection closed/);
		assert.equal(client.connectionState, "closed");
		await client.close();
		assert.equal(closed.mock.calls.length, 1);
	});

	it("answers roots/list and dispatches notifications", async () => {
		const { clientTransport, server } = await createServer();
		const client = new McpClient({
			name: "test-client",
			version: "1.0.0",
			roots: [{ uri: "file:///workspace", name: "workspace" }],
		});
		await client.connect(clientTransport);
		const changed = vi.fn();
		client.onNotification("notifications/tools/list_changed", changed);
		await server.transport.send({ jsonrpc: "2.0", id: "roots", method: "roots/list" });
		await server.transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(
			server.messages.some((item) =>
				isDeepStrictEqual(item, {
					jsonrpc: "2.0",
					id: "roots",
					result: { roots: [{ uri: "file:///workspace", name: "workspace" }] },
				}),
			),
		);
		assert.deepEqual(changed.mock.calls, [[undefined]]);
		await client.close();
	});
});
