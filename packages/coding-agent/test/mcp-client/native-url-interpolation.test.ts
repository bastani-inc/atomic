import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { resolveMcpServerUrl, validateMcpServerConfig } from "../../src/core/mcp-servers.ts";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
} from "../../src/extensions/mcp/runtime.ts";

test("native MCP resolves both URL environment syntaxes before connecting and preserves configured literals", async () => {
	const requests: string[] = [];
	const server = createServer(async (req, res) => {
		requests.push(req.url!);
		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}
		let text = "";
		for await (const chunk of req) text += chunk;
		const message = JSON.parse(text);
		if (message.id === undefined) {
			res.writeHead(202).end();
			return;
		}
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result:
					message.method === "initialize"
						? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "url", version: "1" } }
						: {},
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const origin = `http://127.0.0.1:${address.port}`;
	vi.stubEnv("ATOMIC_NATIVE_MCP_ORIGIN", origin);
	vi.stubEnv("ATOMIC_NATIVE_MCP_TOKEN", "test-token");
	try {
		for (const url of [
			`\${ATOMIC_NATIVE_MCP_ORIGIN}/mcp?token=\${ATOMIC_NATIVE_MCP_TOKEN}`,
			"$env:ATOMIC_NATIVE_MCP_ORIGIN/mcp?token=$env:ATOMIC_NATIVE_MCP_TOKEN",
		]) {
			const config = validateMcpServerConfig("url", { url });
			assert.ok(typeof config !== "string" && "url" in config);
			assert.equal(config.url, url);
			const connection = new McpServerConnection({
				entry: { name: "url", config, source: "test" },
				cwd: process.cwd(),
				credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
				createTransport: createDefaultTransport,
				onTools: () => {},
			});
			try {
				await connection.getClient();
				assert.equal(connection.state, "connected");
			} finally {
				await connection.close();
			}
		}
		assert.ok(requests.length >= 2);
		assert.ok(requests.every((url) => url === "/mcp?token=test-token"));
	} finally {
		vi.unstubAllEnvs();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("URL interpolation fails closed on missing variables and provider HTTP destinations", () => {
	vi.stubEnv("ATOMIC_NATIVE_MCP_UNSET", undefined);
	vi.stubEnv("ATOMIC_NATIVE_MCP_BAD", "http://evil.example/mcp");
	try {
		assert.throws(() => resolveMcpServerUrl(`https://example.com/\${ATOMIC_NATIVE_MCP_UNSET}`), /is not set/);
		const error = validateMcpServerConfig("unsafe", { url: `\${ATOMIC_NATIVE_MCP_BAD}`, auth: { provider: "test" } });
		assert.equal(typeof error, "string");
		assert.match(String(error), /auth requires an https URL/);
		assert.doesNotMatch(String(error), /evil\.example/);
	} finally {
		vi.unstubAllEnvs();
	}
});
