import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { test, vi } from "vitest";
import { getAuthForUrl, saveAuthEntry } from "../../packages/mcp/mcp-auth.js";
import { McpOAuthProvider } from "../../packages/mcp/mcp-oauth-provider.js";
import { McpServerManager } from "../../packages/mcp/server-manager.js";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnProcess } from "../helpers/runtime.js";

test("SDK MCP refreshes reuse rotated tokens across processes", async () => {
	const dir = makeTempDirectory("atomic-mcp-refresh-");
	const originalDir = process.env.MCP_OAUTH_DIR;
	process.env.MCP_OAUTH_DIR = dir;
	const ready: ServerResponse[] = [];
	let refreshCalls = 0;
	let serverUrl = "";
	const server = createServer(async (req, res) => {
		if (req.url === "/ready") {
			ready.push(res);
			if (ready.length >= 2) for (const response of ready) if (!response.writableEnded) response.end("ready");
			return;
		}
		res.setHeader("Content-Type", "application/json");
		if (req.url?.includes("oauth-protected-resource")) {
			res.end(JSON.stringify({ resource: serverUrl, authorization_servers: [serverUrl] }));
		} else if (req.url?.includes("oauth-authorization-server")) {
			res.end(
				JSON.stringify({
					issuer: serverUrl,
					authorization_endpoint: `${serverUrl}/authorize`,
					token_endpoint: `${serverUrl}/token`,
					response_types_supported: ["code"],
				}),
			);
		} else if (req.url === "/token") {
			let body = "";
			for await (const chunk of req) body += chunk;
			refreshCalls++;
			if (refreshCalls > 1 || new URLSearchParams(body).get("refresh_token") !== "old-refresh") {
				res.writeHead(400);
				res.end(JSON.stringify({ error: "invalid_grant" }));
				return;
			}
			res.end(
				JSON.stringify({
					access_token: "new-access",
					refresh_token: "new-refresh",
					token_type: "Bearer",
					expires_in: 3600,
				}),
			);
		} else {
			res.writeHead(404);
			res.end("{}");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	serverUrl = `http://127.0.0.1:${address.port}`;
	saveAuthEntry(
		"rotating",
		{
			tokens: { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1 },
			clientInfo: { clientId: "client" },
		},
		serverUrl,
	);
	const children = [0, 1].map(() =>
		spawnProcess([bunExecutable(), join(process.cwd(), "test/unit/fixtures/mcp-refresh-worker.ts"), serverUrl], {
			env: { ...process.env, MCP_OAUTH_DIR: dir },
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	try {
		const results = await Promise.all(
			children.map(async (child) => ({
				code: await child.exited,
				stdout: await new Response(child.stdout).text(),
				stderr: await new Response(child.stderr).text(),
			})),
		);
		for (const result of results) {
			assert.equal(result.code, 0, result.stderr);
			assert.ok(result.stdout.includes("AUTHORIZED"));
		}
		assert.equal(refreshCalls, 1);
		assert.equal(getAuthForUrl("rotating", serverUrl)?.tokens?.refreshToken, "new-refresh");
	} finally {
		for (const child of children) child.kill();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (originalDir === undefined) delete process.env.MCP_OAUTH_DIR;
		else process.env.MCP_OAUTH_DIR = originalDir;
		removeTempDirectory(dir);
	}
});

test("failed SDK exchanges release the lock and preserve the current unrotated refresh token", async () => {
	const dir = makeTempDirectory("atomic-mcp-refresh-failure-");
	const originalDir = process.env.MCP_OAUTH_DIR;
	process.env.MCP_OAUTH_DIR = dir;
	let requests = 0;
	const observedTokens: Array<string | null> = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		observedTokens.push(new URLSearchParams(body).get("refresh_token"));
		requests++;
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify(requests === 1 ? {} : { access_token: "access", token_type: "Bearer", expires_in: 3600 }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;
	saveAuthEntry("rotating", { tokens: { accessToken: "expired", refreshToken: "latest-refresh", expiresAt: 1 } }, url);
	const provider = new McpOAuthProvider("rotating", url, {}, { onRedirect: () => {} });
	const options = {
		clientInformation: { client_id: "client" },
		refreshToken: "stale-refresh",
		fetchFn: provider.fetch,
	};
	try {
		await assert.rejects(refreshAuthorization(url, options));
		await provider.waitForRefresh();
		const tokens = await refreshAuthorization(url, options);
		await provider.saveTokens(tokens);
		await provider.waitForRefresh();
		assert.equal(tokens.refresh_token, "latest-refresh");
		assert.equal(getAuthForUrl("rotating", url)?.tokens?.refreshToken, "latest-refresh");
		assert.equal(requests, 2);
		assert.deepEqual(observedTokens, ["latest-refresh", "latest-refresh"]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (originalDir === undefined) delete process.env.MCP_OAUTH_DIR;
		else process.env.MCP_OAUTH_DIR = originalDir;
		removeTempDirectory(dir);
	}
});

test.each([
	{ phase: "headers", end: "timeout", status: 200 },
	{ phase: "body", end: "timeout", status: 200 },
	{ phase: "body", end: "timeout", status: 400 },
	{ phase: "headers", end: "cancel", status: 200 },
	{ phase: "body", end: "cancel", status: 200 },
	{ phase: "body", end: "rotate", status: 200 },
	{ phase: "body", end: "invalid", status: 200 },
	{ phase: "body", end: "invalid", status: 400 },
])("manager close drains SDK refresh: $phase / $end / $status", async ({ phase, end, status }) => {
	const dir = makeTempDirectory("atomic-mcp-refresh-deadline-");
	const originalDir = process.env.MCP_OAUTH_DIR;
	process.env.MCP_OAUTH_DIR = dir;
	const url = "https://mock.invalid/mcp";
	const started = Promise.withResolvers<AbortSignal | null | undefined>();
	const response = Promise.withResolvers<Response>();
	const bodyStarted = Promise.withResolvers<void>();
	const caller = new AbortController();
	const cancellation = new Error("caller cancelled refresh");
	let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	let bodyCancelled = false;
	let transport: StreamableHTTPClientTransport | undefined;
	let refresh: Promise<unknown> | undefined;
	const payload = JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer" });
	try {
		saveAuthEntry("rotating", { tokens: { accessToken: "expired", refreshToken: "old-refresh", expiresAt: 1 } }, url);
		vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
		transport = await (
			new McpServerManager() as unknown as {
				createHttpTransport(
					definition: { url: string; oauth: object },
					name: string,
				): Promise<StreamableHTTPClientTransport>;
			}
		).createHttpTransport({ url, oauth: {} }, "rotating");
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			started.resolve(init?.signal);
			return response.promise;
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const sdk = transport as unknown as { _fetch: typeof fetch; _authProvider: McpOAuthProvider };
		refresh = refreshAuthorization(url, {
			clientInformation: { client_id: "client" },
			refreshToken: "old-refresh",
			fetchFn:
				end === "cancel" ? (input, init) => sdk._fetch(input, { ...init, signal: caller.signal }) : sdk._fetch,
		}).then(async (tokens) => {
			assert.ok(existsSync(join(dir, "rotating.lock")), "lock must survive SDK parsing until persistence");
			await sdk._authProvider.saveTokens(tokens);
		});
		const outcome = refresh.then(
			() => undefined,
			(error: unknown) => error,
		);
		const signal = await started.promise;
		assert.ok(signal);
		assert.notEqual(signal, caller.signal, "refresh must compose caller cancellation with a finite deadline");
		assert.ok(existsSync(join(dir, "rotating.lock")));
		let closed = false;
		const close = transport.close().then(() => {
			closed = true;
		});
		await vi.advanceTimersByTimeAsync(10_000);
		if (phase === "body") {
			response.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							stream = controller;
						},
						pull() {
							bodyStarted.resolve();
						},
						cancel() {
							bodyCancelled = true;
						},
					}),
					{ status, headers: { "Content-Type": "application/json" } },
				),
			);
			await bodyStarted.promise;
		}
		await vi.advanceTimersByTimeAsync(4_999);
		assert.equal(closed, false);
		assert.equal(signal.aborted, false);
		assert.ok(existsSync(join(dir, "rotating.lock")));
		if (end === "timeout") await vi.advanceTimersByTimeAsync(1);
		else if (end === "cancel") caller.abort(cancellation);
		else {
			stream!.enqueue(new TextEncoder().encode(end === "rotate" ? payload : "{}"));
			stream!.close();
		}
		const error = await outcome;
		if (end === "timeout") assert.equal((error as Error).name, "TimeoutError");
		else if (end === "cancel") assert.equal(error, cancellation);
		else if (end === "invalid") assert.ok(error instanceof Error);
		else assert.equal(error, undefined);
		await close;
		assert.equal(closed, true);
		assert.equal(signal.aborted, end === "timeout" || end === "cancel");
		assert.equal(caller.signal.aborted, end === "cancel");
		if (phase === "body" && (end === "timeout" || end === "cancel")) assert.equal(bodyCancelled, true);
		assert.equal(existsSync(join(dir, "rotating.lock")), false);
		assert.equal(
			getAuthForUrl("rotating", url)?.tokens?.refreshToken,
			end === "rotate" ? "new-refresh" : "old-refresh",
		);
		if (phase === "headers" && end === "timeout") {
			response.resolve(Response.json(JSON.parse(payload)));
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(
				getAuthForUrl("rotating", url)?.tokens?.refreshToken,
				"old-refresh",
				"late token response must not persist after timeout",
			);
		}
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(signal.aborted, end === "timeout" || end === "cancel", "settled refresh must clear its timer");
	} finally {
		response.resolve(Response.json(JSON.parse(payload)));
		if (stream && !bodyCancelled) {
			try {
				stream.enqueue(new TextEncoder().encode(payload));
				stream.close();
			} catch {}
		}
		await refresh?.catch(() => {});
		vi.useRealTimers();
		vi.restoreAllMocks();
		await transport?.close();
		if (originalDir === undefined) delete process.env.MCP_OAUTH_DIR;
		else process.env.MCP_OAUTH_DIR = originalDir;
		removeTempDirectory(dir);
	}
});
