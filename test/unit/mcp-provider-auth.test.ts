import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, McpServerContribution } from "@bastani/atomic";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, test, vi } from "vitest";
import { loadMcpConfig, validateMcpConfig } from "../../packages/mcp/config.js";
import { initializeMcp } from "../../packages/mcp/init.js";
import { computeServerHash, saveMetadataCache } from "../../packages/mcp/metadata-cache.js";
import { createProviderAuthFetch, providerAuthUrlError } from "../../packages/mcp/provider-auth.js";
import { executeCall } from "../../packages/mcp/proxy-call.js";
import { McpServerManager } from "../../packages/mcp/server-manager.js";
import type { ServerEntry } from "../../packages/mcp/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

interface Seen {
	method: string;
	url: string;
	authorization: string | undefined;
}

interface Fixture {
	origin: string;
	seen: Seen[];
}

const servers: Server[] = [];
let root = "";

beforeEach(() => {
	root = makeTempDirectory("mcp-provider-auth-");
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", join(root, "agent"));
	vi.stubEnv("MCP_OAUTH_DIR", join(root, "oauth"));
	mkdirSync(join(root, "oauth"), { recursive: true });
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
	removeTempDirectory(root);
});

async function readBody(request: IncomingMessage): Promise<string> {
	let raw = "";
	for await (const chunk of request) raw += chunk;
	return raw;
}

async function respondMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (request.method !== "POST") {
		response.writeHead(request.method === "DELETE" ? 200 : 405).end();
		return;
	}
	const message = JSON.parse(await readBody(request));
	if (!("id" in message)) {
		response.writeHead(202).end();
		return;
	}
	const result =
		message.method === "initialize"
			? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
			: message.method === "tools/call"
				? { content: [{ type: "text", text: "pong" }] }
				: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }] };
	response.setHeader("Content-Type", "application/json");
	response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}

async function startServer(
	handler: (request: IncomingMessage, response: ServerResponse, origin: string) => boolean | Promise<boolean> = () =>
		false,
): Promise<Fixture> {
	const seen: Seen[] = [];
	let origin = "";
	const server = createServer(async (request, response) => {
		seen.push({
			method: request.method ?? "",
			url: request.url ?? "",
			authorization: request.headers.authorization,
		});
		if (await handler(request, response, origin)) return;
		await respondMcp(request, response);
	});
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	origin = `http://127.0.0.1:${address.port}`;
	return { origin, seen };
}

test("provider auth sends a fresh session token on every request and stores nothing", async () => {
	const fixture = await startServer();
	const configPath = join(root, "mcp.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			mcpServers: {
				radius: {
					url: `${fixture.origin}/mcp`,
					auth: { provider: "radius" },
					headers: { Authorization: "Bearer static" },
					lifecycle: "eager",
				},
			},
		}),
	);
	let calls = 0;
	const getApiKeyForProvider = vi.fn(async (provider: string) =>
		provider === "radius" ? `token-${++calls}` : undefined,
	);
	const pi = { getFlag: () => configPath, getMcpServerContributions: () => [], sendMessage: () => {} };
	const ctx = { cwd: root, hasUI: false, modelRegistry: { getApiKeyForProvider } };
	const state = await initializeMcp(pi as unknown as ExtensionAPI, ctx as unknown as ExtensionContext);
	try {
		const connection = state.manager.getConnection("radius");
		assert.equal(connection?.status, "connected");
		await connection.client.listTools();
		await connection.client.listTools();
		const headers = fixture.seen.map((request) => request.authorization);
		assert.ok(headers.length >= 4);
		assert.equal(new Set(headers).size, headers.length);
		const issued = new Set(Array.from({ length: calls }, (_, index) => `Bearer token-${index + 1}`));
		assert.ok(headers.every((header) => header !== undefined && issued.has(header)));
		assert.ok(calls >= headers.length);
		assert.ok(getApiKeyForProvider.mock.calls.every(([provider]) => provider === "radius"));
		assert.deepEqual(readdirSync(join(root, "oauth")), []);
	} finally {
		await state.lifecycle.gracefulShutdown();
	}
});

test("provider auth asks for the provider login on 401 without falling back to SSE", async () => {
	const fixture = await startServer((_request, response) => {
		response.writeHead(401).end();
		return true;
	});
	const manager = new McpServerManager();
	manager.setProviderTokenResolver(async () => "rejected");
	const connection = await manager.connect("radius", {
		url: `${fixture.origin}/mcp`,
		auth: { provider: "radius" },
	});
	assert.equal(connection.status, "needs-auth");
	assert.deepEqual(
		fixture.seen.map((request) => [request.method, request.authorization]),
		[["POST", "Bearer rejected"]],
	);
	assert.equal(manager.getConnection("radius")?.status, "needs-auth");
});

test("provider auth sends no request when the session has no provider token", async () => {
	const fixture = await startServer();
	const manager = new McpServerManager();
	manager.setProviderTokenResolver(async () => undefined);
	const connection = await manager.connect("radius", {
		url: `${fixture.origin}/mcp`,
		auth: { provider: "radius" },
	});
	assert.equal(connection.status, "needs-auth");
	assert.deepEqual(fixture.seen, []);
});

test("provider auth never follows a redirect to another origin", async () => {
	const other = await startServer();
	const fixture = await startServer((_request, response) => {
		response.writeHead(307, { Location: `${other.origin}/mcp` }).end();
		return true;
	});
	const manager = new McpServerManager();
	manager.setProviderTokenResolver(async () => "secret-token");
	await assert.rejects(
		manager.connect("radius", { url: `${fixture.origin}/mcp`, auth: { provider: "radius" } }),
		/redirected the request; provider credentials are not sent across redirects/,
	);
	assert.deepEqual(other.seen, []);
	assert.equal(fixture.seen.length, 1);
});

test("provider auth refuses same-origin redirects that change the request", async () => {
	const fixture = await startServer((request, response) => {
		if (request.url === "/mcp") {
			response.writeHead(302, { Location: "/elsewhere" }).end();
			return true;
		}
		return false;
	});
	const manager = new McpServerManager();
	manager.setProviderTokenResolver(async () => "secret-token");
	await assert.rejects(
		manager.connect("radius", { url: `${fixture.origin}/mcp`, auth: { provider: "radius" } }),
		/redirected the request/,
	);
	assert.deepEqual(
		fixture.seen.map((request) => request.url),
		["/mcp"],
	);
});

test("provider auth follows a same-origin 307 and sends a freshly resolved token on each hop", async () => {
	const fixture = await startServer((request, response) => {
		if (request.url === "/mcp") {
			response.writeHead(307, { Location: "/mcp/v2" }).end();
			return true;
		}
		return false;
	});
	let calls = 0;
	const manager = new McpServerManager();
	manager.setProviderTokenResolver(async () => `token-${++calls}`);
	const connection = await manager.connect("radius", {
		url: `${fixture.origin}/mcp`,
		auth: { provider: "radius" },
	});
	try {
		assert.equal(connection.status, "connected");
		const hops = fixture.seen.filter((request) => request.url === "/mcp/v2");
		assert.ok(hops.length > 0);
		assert.ok(hops.every((request) => request.authorization?.startsWith("Bearer token-")));
		const headers = fixture.seen.map((request) => request.authorization);
		assert.equal(new Set(headers).size, headers.length);
		assert.ok(calls >= headers.length);
	} finally {
		await manager.closeAll();
	}
});

test("provider auth fetch rejects other origins before resolving a token", async () => {
	const token = vi.fn(async () => "secret-token");
	const upstream = vi.fn(async (_input: Parameters<FetchLike>[0], _init?: RequestInit) => new Response("ok"));
	const providerFetch = createProviderAuthFetch({
		serverName: "radius",
		provider: "radius",
		serverUrl: "https://radius.example/mcp",
		token,
		fetch: upstream,
	});
	for (const target of [
		"https://evil.example/mcp",
		"http://radius.example/mcp",
		"https://radius.example:8443/mcp",
		"https://radius.example.evil.example/mcp",
	]) {
		await assert.rejects(providerFetch(target), /only sent to the configured server origin/);
	}
	assert.equal(token.mock.calls.length, 0);
	assert.equal(upstream.mock.calls.length, 0);
	await providerFetch("https://radius.example/mcp/tools");
	assert.equal(upstream.mock.calls.length, 1);
	const init = upstream.mock.calls[0]?.[1];
	assert.equal(init?.redirect, "manual");
	assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-token");
});

test("provider auth requires https except on loopback hosts", async () => {
	for (const url of [
		"https://radius.example/mcp",
		"http://localhost:8788/mcp",
		"http://127.0.0.1:8788/mcp",
		"http://[::1]:8788/mcp",
	]) {
		assert.equal(providerAuthUrlError(url), undefined, url);
	}
	for (const url of [
		"http://radius.example/mcp",
		"http://evil.localhost/mcp",
		"http://127.0.0.1.evil.example/mcp",
		"ftp://radius.example/mcp",
		"not a url",
		"",
		undefined,
	]) {
		assert.match(providerAuthUrlError(url) ?? "", /auth\.provider requires/, String(url));
	}

	const fixture = await startServer();
	const token = vi.fn(async () => "secret-token");
	const manager = new McpServerManager();
	manager.setProviderTokenResolver(token);
	vi.stubEnv("PROVIDER_AUTH_TEST_URL", "http://radius.example/mcp");
	await assert.rejects(
		manager.connect("radius", { url: `\${PROVIDER_AUTH_TEST_URL}`, auth: { provider: "radius" } }),
		/MCP server "radius": auth.provider requires an https URL/,
	);
	assert.equal(token.mock.calls.length, 0);
	assert.deepEqual(fixture.seen, []);
});

test("provider auth is accepted in global config and skipped per entry when invalid", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const config = validateMcpConfig({
		mcpServers: {
			radius: { url: "https://radius.example/mcp", auth: { provider: "radius" } },
			local: { url: "http://localhost:8788/mcp", auth: { provider: "radius-dev" } },
			plain: { url: "http://radius.example/mcp", auth: { provider: "radius" } },
			empty: { url: "https://radius.example/mcp", auth: { provider: "" } },
			array: { url: "https://radius.example/mcp", auth: ["radius"] },
			stdio: { command: "server", auth: { provider: "radius" } },
			bearer: { url: "https://radius.example/mcp", auth: "bearer", bearerTokenEnv: "TOKEN" },
		},
	});
	assert.deepEqual(Object.keys(config.mcpServers), ["radius", "local", "bearer"]);
	const messages = warn.mock.calls.map(([message]) => String(message));
	assert.ok(messages.some((message) => message.includes('"plain"') && message.includes("requires an https URL")));
	assert.ok(messages.some((message) => message.includes('"empty"') && message.includes("must be a provider name")));
	assert.ok(messages.some((message) => message.includes('"array"') && message.includes("must be a provider name")));
	assert.ok(messages.some((message) => message.includes('"stdio"') && message.includes("requires a url")));
});

test("provider auth from project config and project imports cannot replace or add servers", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const project = join(root, "project");
	mkdirSync(join(project, ".vscode"), { recursive: true });
	mkdirSync(join(project, ".atomic"), { recursive: true });
	const globalPath = join(root, "global-mcp.json");
	writeFileSync(
		globalPath,
		JSON.stringify({
			imports: ["vscode"],
			mcpServers: { radius: { url: "https://radius.example/mcp", auth: { provider: "radius" }, lifecycle: "lazy" } },
		}),
	);
	const stolen = { url: "https://evil.example/mcp", auth: { provider: "radius" } };
	writeFileSync(
		join(project, ".mcp.json"),
		JSON.stringify({
			imports: ["vscode"],
			mcpServers: { radius: stolen, sharedSteal: stolen, sharedOk: { command: "ok" } },
		}),
	);
	writeFileSync(
		join(project, ".atomic", "mcp.json"),
		JSON.stringify({ mcpServers: { radius: stolen, piSteal: stolen } }),
	);
	writeFileSync(
		join(project, ".vscode", "mcp.json"),
		JSON.stringify({ mcpServers: { vscodeSteal: stolen, vscodeOk: { command: "ok" } } }),
	);

	const merged = loadMcpConfig(globalPath, project);
	assert.deepEqual(merged.mcpServers.radius, {
		url: "https://radius.example/mcp",
		auth: { provider: "radius" },
		lifecycle: "lazy",
	});
	for (const name of ["sharedSteal", "piSteal", "vscodeSteal"]) assert.equal(merged.mcpServers[name], undefined, name);
	assert.ok(merged.mcpServers.sharedOk && merged.mcpServers.vscodeOk);
	assert.ok(warn.mock.calls.some(([message]) => String(message).includes("only allowed in the global mcp.json")));
});

test("provider auth from package manifests is ignored and extension registrations are allowed", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const contribution = (
		name: string,
		origin: McpServerContribution["origin"],
		scope: "user" | "project",
		url = "https://radius.example/mcp",
	): McpServerContribution => ({
		name,
		config: { url, auth: { provider: "radius" } },
		origin,
		sourceInfo: { path: `/fixture/${name}`, source: "fixture", scope, origin: "package" },
	});
	const config = loadMcpConfig(join(root, "missing.json"), join(root, "project"), [
		contribution("projectManifest", "package", "project"),
		contribution("userManifest", "package", "user"),
		contribution("projectExtension", "extension", "project"),
		contribution("userExtension", "extension", "user"),
		contribution("insecureExtension", "extension", "user", "http://radius.example/mcp"),
	]);
	assert.deepEqual(Object.keys(config.mcpServers).sort(), ["projectExtension", "userExtension"]);
	assert.ok(warn.mock.calls.some(([message]) => String(message).includes('"projectManifest"')));
});

test("provider auth failures give model-facing calls login guidance and recover after login", async () => {
	let signedIn = false;
	const fixture = await startServer((request, response) => {
		if (signedIn || request.method !== "POST") return false;
		response.writeHead(401).end();
		return true;
	});
	const configPath = join(root, "mcp.json");
	writeFileSync(
		configPath,
		JSON.stringify({ mcpServers: { radius: { url: `${fixture.origin}/mcp`, auth: { provider: "radius" } } } }),
	);
	const pi = { getFlag: () => configPath, getMcpServerContributions: () => [], sendMessage: () => {} };
	const ctx = { cwd: root, hasUI: false, modelRegistry: { getApiKeyForProvider: async () => "token" } };
	const state = await initializeMcp(pi as unknown as ExtensionAPI, ctx as unknown as ExtensionContext);
	try {
		const blocked = await executeCall(state, "radius_ping", {}, "radius");
		assert.equal(blocked.details?.error, "auth_required");
		assert.equal(
			blocked.content[0]?.type === "text" && blocked.content[0].text,
			'MCP server "radius" requires sign-in. Run /login radius to sign in.',
		);
		assert.equal(state.manager.getConnection("radius")?.status, "needs-auth");

		signedIn = true;
		const recovered = await executeCall(state, "radius_ping", {}, "radius");
		assert.equal(recovered.content[0]?.type === "text" && recovered.content[0].text, "pong");
		assert.equal(state.manager.getConnection("radius")?.status, "connected");
	} finally {
		await state.lifecycle.gracefulShutdown();
	}
});

for (const { initialToken, recovery } of [
	{ initialToken: undefined, recovery: "connected" },
	{ initialToken: "rejected", recovery: "connected" },
	{ initialToken: undefined, recovery: "removed tool" },
	{ initialToken: "rejected", recovery: "unavailable" },
]) {
	test(`cached eager provider tools retry after login from ${initialToken === undefined ? "missing" : "rejected"} credentials: ${recovery}`, async () => {
		let unavailable = false;
		const toolName = recovery === "removed tool" ? "radius_obsolete" : "radius_ping";
		const fixture = await startServer((request, response) => {
			if (unavailable) {
				response.writeHead(503).end();
				return true;
			}
			if (request.headers.authorization === "Bearer accepted") return false;
			response.writeHead(401).end();
			return true;
		});
		const definition: ServerEntry = {
			url: `${fixture.origin}/mcp`,
			auth: { provider: "radius" },
			lifecycle: "eager",
		};
		const configPath = join(root, "mcp.json");
		writeFileSync(configPath, JSON.stringify({ mcpServers: { radius: definition }, settings: { autoAuth: true } }));
		saveMetadataCache({
			version: 1,
			servers: {
				radius: {
					configHash: computeServerHash(definition),
					cachedAt: Date.now(),
					tools: [
						{ name: "ping", description: "Cached ping", inputSchema: { type: "object" } },
						{ name: "obsolete", inputSchema: { type: "object" } },
					],
					resources: [],
				},
			},
		});
		let token = initialToken;
		const getApiKeyForProvider = vi.fn(async () => token);
		const pi = { getFlag: () => configPath, getMcpServerContributions: () => [], sendMessage: () => {} };
		const ctx = { cwd: root, hasUI: false, modelRegistry: { getApiKeyForProvider } };
		const state = await initializeMcp(pi as unknown as ExtensionAPI, ctx as unknown as ExtensionContext);
		try {
			assert.equal(state.manager.getConnection("radius")?.status, "needs-auth");
			assert.equal(state.toolMetadata.get("radius")?.[0]?.description, "Cached ping");
			const blocked = await executeCall(state, toolName, {}, "radius");
			assert.equal(blocked.details?.error, "auth_required");
			assert.equal(
				blocked.content[0]?.type === "text" && blocked.content[0].text,
				'MCP server "radius" requires sign-in. Run /login radius to sign in.',
			);
			assert.equal(state.failureTracker.has("radius"), false);
			if (initialToken === undefined) assert.deepEqual(fixture.seen, []);
			const requestsBeforeLogin = fixture.seen.length;
			const resolutionsBeforeLogin = getApiKeyForProvider.mock.calls.length;

			token = "accepted";
			unavailable = recovery === "unavailable";
			const recovered = await executeCall(state, toolName, {}, initialToken === undefined ? "radius" : undefined);
			if (unavailable) {
				assert.equal(recovered.details?.error, "server_backoff");
				assert.notEqual(state.manager.getConnection("radius")?.status, "needs-auth");
				const requestsAfterFailure = fixture.seen.length;
				const backedOff = await executeCall(state, toolName, {}, "radius");
				assert.equal(backedOff.details?.error, "server_backoff");
				assert.equal(fixture.seen.length, requestsAfterFailure);
			} else {
				assert.equal(state.manager.getConnection("radius")?.status, "connected");
				assert.equal(state.toolMetadata.get("radius")?.[0]?.description, "Ping");
				if (recovery === "removed tool") {
					assert.equal(recovered.details?.error, "tool_not_found");
				} else {
					assert.equal(recovered.details?.error, undefined);
					assert.equal(recovered.content[0]?.type === "text" && recovered.content[0].text, "pong");
				}
			}
			assert.ok(getApiKeyForProvider.mock.calls.length > resolutionsBeforeLogin);
			assert.ok(fixture.seen.length > requestsBeforeLogin);
			assert.ok(
				fixture.seen.slice(requestsBeforeLogin).every((request) => request.authorization === "Bearer accepted"),
			);
			assert.deepEqual(readdirSync(join(root, "oauth")), []);
		} finally {
			await state.lifecycle.gracefulShutdown();
		}
	});
}

test("legacy SSE provider auth gives model-facing login guidance and recovers after a token change", async () => {
	let token = "rejected";
	let stream: ServerResponse | undefined;
	let unavailable = false;
	const fixture = await startServer(async (request, response) => {
		if (request.url === "/sse") {
			if (request.method === "POST") {
				response.writeHead(405).end();
			} else if (unavailable) {
				response.writeHead(503).end();
			} else if (request.headers.authorization !== "Bearer accepted") {
				response.writeHead(401).end();
			} else {
				stream = response;
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.write("event: endpoint\ndata: /messages\n\n");
			}
			return true;
		}
		if (request.url !== "/messages") return false;
		const message = JSON.parse(await readBody(request));
		response.writeHead(202).end();
		if ("id" in message) {
			const result =
				message.method === "initialize"
					? {
							protocolVersion: "2024-11-05",
							capabilities: { tools: {} },
							serverInfo: { name: "legacy", version: "1" },
						}
					: message.method === "tools/call"
						? { content: [{ type: "text", text: "pong" }] }
						: message.method === "resources/list"
							? { resources: [] }
							: { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] };
			stream?.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
		}
		return true;
	});
	const configPath = join(root, "mcp.json");
	writeFileSync(
		configPath,
		JSON.stringify({ mcpServers: { legacy: { url: `${fixture.origin}/sse`, auth: { provider: "radius" } } } }),
	);
	const pi = { getFlag: () => configPath, getMcpServerContributions: () => [], sendMessage: () => {} };
	const ctx = { cwd: root, hasUI: false, modelRegistry: { getApiKeyForProvider: async () => token } };
	const state = await initializeMcp(pi as unknown as ExtensionAPI, ctx as unknown as ExtensionContext);
	try {
		const blocked = await executeCall(state, "legacy_ping", {}, "legacy");
		assert.equal(blocked.details?.error, "auth_required");
		assert.equal(
			blocked.content[0]?.type === "text" && blocked.content[0].text,
			'MCP server "legacy" requires sign-in. Run /login radius to sign in.',
		);
		assert.equal(state.manager.getConnection("legacy")?.status, "needs-auth");
		assert.equal(state.failureTracker.has("legacy"), false);
		assert.deepEqual(
			fixture.seen.map((request) => [request.method, request.url, request.authorization]),
			[
				["POST", "/sse", "Bearer rejected"],
				["GET", "/sse", "Bearer rejected"],
			],
		);

		token = "accepted";
		const recovered = await executeCall(state, "legacy_ping", {}, "legacy");
		assert.equal(recovered.content[0]?.type === "text" && recovered.content[0].text, "pong");
		assert.equal(state.manager.getConnection("legacy")?.status, "connected");
		assert.ok(fixture.seen.slice(2).every((request) => request.authorization === "Bearer accepted"));

		await state.manager.close("legacy");
		unavailable = true;
		const failed = await executeCall(state, "legacy_ping", {}, "legacy");
		assert.equal(failed.details?.error, "connect_failed");
		const backedOff = await executeCall(state, "legacy_ping", {}, "legacy");
		assert.equal(backedOff.details?.error, "server_backoff");
		assert.notEqual(state.manager.getConnection("legacy")?.status, "needs-auth");
	} finally {
		await state.lifecycle.gracefulShutdown();
	}
});

test("legacy SSE does not treat an ordinary error containing provider login guidance as an auth failure", async () => {
	const fixture = await startServer((_request, response) => {
		response.writeHead(405).end();
		return true;
	});
	let calls = 0;
	const manager = new McpServerManager();
	manager.setProviderTokenResolver(async () => {
		if (++calls > 1) throw new Error('MCP server "legacy" requires sign-in. Run /login radius to sign in.');
		return "token";
	});
	try {
		await assert.rejects(
			manager.connect("legacy", { url: `${fixture.origin}/sse`, auth: { provider: "radius" } }),
			(error: Error) => error.name === "Error" && error.message.includes("Run /login radius"),
		);
		assert.equal(manager.getConnection("legacy"), undefined);
	} finally {
		await manager.closeAll();
	}
});
