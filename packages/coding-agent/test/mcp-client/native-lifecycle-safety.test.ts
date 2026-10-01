import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAuthStorageBackend, InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { LATEST_PROTOCOL_VERSION } from "../../src/extensions/mcp/client/index.js";
import { TransportEvents } from "../../src/extensions/mcp/client/transports/transport.js";
import { createMcpAuthProvider, McpOAuthCredentialStore, signInMcpServer } from "../../src/extensions/mcp/oauth.ts";
import { createDefaultTransport, McpServerConnection } from "../../src/extensions/mcp/runtime.ts";
import { bunExecutable } from "../cli-test-helpers.ts";
import { closeServers, listen, readBody } from "./helpers.js";
import { startOAuthMcpServer } from "./native-oauth-server.js";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("native MCP lifecycle safety", () => {
	const cleanups: (() => Promise<void> | void)[] = [];
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
		await closeServers();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("logout cancels a browser sign-in whose token response arrives late", async () => {
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const requested = deferred();
		const release = deferred();
		const originalFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const response = await originalFetch(input, init);
			if (String(input) === new URL("/token", server.url).href) {
				requested.resolve();
				await release.promise;
			}
			return response;
		});
		const signIn = signInMcpServer({
			serverUrl: server.url,
			store: credentials.forServer(server.url),
			settings: {},
			prompt: {
				showAuthorizationUrl: (url) => {
					void fetch(url);
				},
				promptForRedirectUrl: (signal) =>
					new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
			},
		});
		const outcome = signIn.catch((error: unknown) => error);
		await requested.promise;
		await credentials.removeAsync(server.url);
		release.resolve();
		expect(await outcome).toMatchObject({ name: "McpSignInCancelledError" });
		expect(credentials.tokens(server.url)).toBeUndefined();
	});

	it("serialized logout waits for another process's refresh and fences its late sign-in writes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "native-mcp-revoke-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const url = "https://synthetic.invalid/mcp";
		const path = join(dir, "mcp-auth.json");
		const credentials = new McpOAuthCredentialStore(new FileAuthStorageBackend(path), dir);
		await credentials.forServer(url).save({ serverUrl: url, tokens: { access_token: "old", token_type: "Bearer" } });
		const child = spawn(
			bunExecutable(),
			[fileURLToPath(new URL("./fixtures/native-refresh-retirement.ts", import.meta.url)), path, dir, url],
			{ stdio: "pipe" },
		);
		cleanups.push(() => {
			child.kill();
		});
		let output = "";
		let errors = "";
		child.stdout.on("data", (data: Buffer) => {
			output += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			errors += data.toString();
		});
		const exited = new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", resolve);
		});
		await vi.waitFor(() => expect(output, errors).toContain("locked"));
		let removed = false;
		const logout = credentials.removeAsync(url).then((result) => {
			removed = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(removed).toBe(false);
		child.stdin.write("release refresh\n");
		expect(await logout).toBe(true);
		expect(credentials.tokens(url)).toBeUndefined();
		await vi.waitFor(() => expect(output, errors).toContain("saved"));
		child.stdin.write("release sign-in\n");
		expect(await exited, errors).toBe(0);
		expect(output).toContain("fenced");
		expect(credentials.tokens(url)).toBeUndefined();
	});

	it("allows a same-origin redirect without losing the provider credential", async () => {
		const authorized: string[] = [];
		const origin = await listen(async (request, response) => {
			if (request.url === "/mcp") {
				response.writeHead(307, { location: "/canonical" });
				response.end();
				return;
			}
			if (request.method !== "POST") {
				response.writeHead(405);
				response.end();
				return;
			}
			authorized.push(request.headers.authorization ?? "");
			const message = JSON.parse(await readBody(request)) as { id?: number };
			if (message.id === undefined) {
				response.writeHead(202);
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: {},
						serverInfo: { name: "synthetic", version: "1" },
					},
				}),
			);
		});
		const connection = new McpServerConnection({
			entry: { name: "redirect", source: "test", config: { url: `${origin}/mcp`, auth: { provider: "synthetic" } } },
			cwd: process.cwd(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			providerToken: async () => "synthetic-secret",
			onTools: () => {},
		});
		cleanups.push(() => connection.close());
		await connection.getClient();
		expect(connection.state).toBe("connected");
		expect(authorized).toEqual(["Bearer synthetic-secret", "Bearer synthetic-secret"]);
	});

	it("does not follow a credential-bearing redirect to another origin", async () => {
		let destinationRequests = 0;
		const destination = await listen(async (_request, response) => {
			destinationRequests++;
			response.end();
		});
		const origin = await listen(async (_request, response) => {
			response.writeHead(307, { location: `${destination}/mcp` });
			response.end();
		});
		vi.stubEnv("NATIVE_MCP_DESTINATION", `${origin}/mcp`);
		const connection = new McpServerConnection({
			entry: {
				name: "redirect",
				source: "test",
				config: { url: "$env:NATIVE_MCP_DESTINATION", auth: { provider: "synthetic" } },
			},
			cwd: process.cwd(),
			createTransport: createDefaultTransport,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			providerToken: async () => "synthetic-secret",
			onTools: () => {},
		});
		cleanups.push(() => connection.close());
		await expect(connection.getClient()).rejects.toThrow(/origin/i);
		expect(destinationRequests).toBe(0);
	});

	it("revalidates interpolated provider destinations before reading a credential", () => {
		vi.stubEnv("NATIVE_MCP_DESTINATION", "http://192.0.2.1/mcp");
		const providerToken = vi.fn(async () => "synthetic-secret");
		expect(
			() =>
				new McpServerConnection({
					entry: {
						name: "unsafe",
						source: "test",
						config: { url: `\${NATIVE_MCP_DESTINATION}`, auth: { provider: "synthetic" } },
					},
					cwd: process.cwd(),
					createTransport: createDefaultTransport,
					credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
					providerToken,
					onTools: () => {},
				}),
		).toThrow(/https|loopback/i);
		expect(providerToken).not.toHaveBeenCalled();
	});

	it("bounds shutdown when a transport ignores cancellation, then retires a late start", async () => {
		const started = deferred();
		const release = deferred();
		let closes = 0;
		class StuckTransport extends TransportEvents {
			async start() {
				started.resolve();
				await release.promise;
			}
			async send() {
				throw new Error("must not send after close");
			}
			async close() {
				closes++;
			}
		}
		const connection = new McpServerConnection({
			entry: { name: "stuck", source: "test", config: { command: "synthetic" } },
			cwd: process.cwd(),
			createTransport: () => new StuckTransport(),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => {},
		});
		const opening = connection.getClient().catch((error: unknown) => error);
		await started.promise;
		await connection.close();
		try {
			expect(closes).toBeGreaterThan(0);
			const immediateCloses = closes;
			release.resolve();
			expect(await opening).toBeInstanceOf(Error);
			expect(closes).toBeGreaterThan(immediateCloses);
			expect(connection.state).toBe("closed");
		} finally {
			release.resolve();
			await opening;
		}
	}, 3_000);

	it("shutdown closes a transport whose start is still pending and waits for its retirement", async () => {
		const started = deferred();
		const release = deferred();
		let closed = false;
		class DelayedTransport extends TransportEvents {
			async start() {
				started.resolve();
				await release.promise;
			}
			async send() {
				throw new Error("must not send after close");
			}
			async close() {
				closed = true;
				release.resolve();
				this.emitClose();
			}
		}
		const connection = new McpServerConnection({
			entry: { name: "delayed", source: "test", config: { command: "synthetic" } },
			cwd: process.cwd(),
			createTransport: () => new DelayedTransport(),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => {},
		});
		let retired = false;
		const opening = connection
			.getClient()
			.catch((error: unknown) => error)
			.finally(() => {
				retired = true;
			});
		await started.promise;
		await connection.close();
		try {
			expect(closed).toBe(true);
			expect(retired).toBe(true);
			expect(await opening).toBeInstanceOf(Error);
			expect(connection.state).toBe("closed");
		} finally {
			release.resolve();
			await opening;
		}
	});

	it("logout cannot be undone by an already-running token refresh", async () => {
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const store = credentials.forServer(server.url);
		await store.save({
			serverUrl: server.url,
			clientInformation: { client_id: "synthetic-client" },
			tokens: { access_token: "old", refresh_token: "synthetic-refresh", token_type: "Bearer" },
		});
		const requested = deferred();
		const release = deferred();
		const provider = createMcpAuthProvider({
			serverUrl: server.url,
			store,
			settings: () => ({}),
			onChallenge: () => {},
		});
		const refresh = provider.onUnauthorized!({
			response: new Response(null, { status: 401 }),
			serverUrl: new URL(server.url),
			token: "old",
			fetch: async (input, init) => {
				if (new URL(String(input)).pathname === "/token") {
					requested.resolve();
					await release.promise;
					return Response.json({ access_token: "late", refresh_token: "rotated", token_type: "Bearer" });
				}
				return fetch(input, init);
			},
		});
		await requested.promise;
		credentials.remove(server.url);
		release.resolve();
		await refresh.catch(() => undefined);
		expect(credentials.tokens(server.url)).toBeUndefined();
	});
});
