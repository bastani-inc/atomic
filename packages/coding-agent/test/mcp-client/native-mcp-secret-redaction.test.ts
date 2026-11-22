import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage-backends.js";
import { ModelRuntime } from "../../src/core/model-runtime.js";
import { runMcpCommand } from "../../src/extensions/mcp/cli.js";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.js";
import { startOAuthMcpServer } from "./native-oauth-server.js";

const STDERR_FIXTURE = fileURLToPath(new URL("./fixtures/stderr-server.mjs", import.meta.url));

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

describe("mcp CLI secret redaction", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	function createAgentDir(servers?: Record<string, unknown>): string {
		const agentDir = mkdtempSync(join(tmpdir(), "atomic-mcp-secret-redaction-"));
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		if (servers) writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
		return agentDir;
	}

	async function runCli(
		args: string[],
		options: {
			agentDir: string;
			credentials?: McpOAuthCredentialStore;
			openUrl?: (url: string) => void;
			providerToken?: (provider: string) => Promise<string | undefined>;
		},
	) {
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];
		const exitCode = await runMcpCommand(args, {
			cwd: options.agentDir,
			agentDir: options.agentDir,
			credentials: options.credentials,
			openUrl: options.openUrl,
			providerToken: options.providerToken,
			log: (line) => stdoutLines.push(line),
			error: (line) => stderrLines.push(line),
		});
		const stdout = stdoutLines.join("\n");
		const stderr = stderrLines.join("\n");
		return { exitCode, stdout, stderr, combined: `${stdout}\n${stderr}` };
	}

	function assertNoSecretLeaked(output: { stdout: string; stderr: string }, secrets: readonly string[]): void {
		for (const secret of secrets) {
			assert.equal(output.stdout.includes(secret), false, `stdout leaked secret ${secret}: ${output.stdout}`);
			assert.equal(output.stderr.includes(secret), false, `stderr leaked secret ${secret}: ${output.stderr}`);
		}
	}

	async function startCustomServer(
		handler: (request: IncomingMessage, response: ServerResponse, origin: string) => Promise<void> | void,
	): Promise<{ origin: string; url: string }> {
		let origin = "";
		const server: Server = createServer((request, response) => {
			void Promise.resolve(handler(request, response, origin)).catch((error) => {
				response.writeHead(500).end(String(error));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server did not bind to TCP");
		origin = `http://127.0.0.1:${address.port}`;
		cleanups.push(
			() =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		);
		return { origin, url: `${origin}/mcp` };
	}

	it("login does not leak a !-prefixed clientSecret, failing !command inline secret, or $-containing clientSecret", async () => {
		const oauthServer = await startOAuthMcpServer();
		cleanups.push(oauthServer.close);

		const bangSecret = "opaqueBangClientSecret98765";
		const cmdInlineSecret = "inlineCmdBearerSecret55443";
		const dollarSuffix = "UnsetSecretChunk43210";

		const cases = [
			{
				name: "bang-literal",
				clientSecret: `!${bangSecret}`,
				secrets: [bangSecret],
			},
			{
				name: "failing-command-with-inline-secret",
				clientSecret: `!printf 'Authorization: Bearer ${cmdInlineSecret}' >/dev/null && exit 1`,
				secrets: [cmdInlineSecret],
			},
			{
				name: "dollar-literal",
				clientSecret: `prefix$${dollarSuffix}`,
				secrets: [dollarSuffix, "prefix$"],
			},
		];

		for (const testCase of cases) {
			const agentDir = createAgentDir({
				issues: {
					url: oauthServer.url,
					oauth: { clientId: "client-1", clientSecret: testCase.clientSecret },
				},
			});
			const result = await runCli(["login", "issues"], {
				agentDir,
				credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
				openUrl: () => {},
			});
			assert.equal(result.exitCode, 1, testCase.name);
			assert.match(result.stderr, /oauth\.clientSecret/, testCase.name);
			assertNoSecretLeaked(result, testCase.secrets);
		}
	});

	it("login does not leak client_secret, code_verifier, code, or Basic auth when token exchange returns an echoing HTTP error", async () => {
		const clientSecret = "opaque+Client/Secret=778899";
		let capturedVerifier = "";
		let capturedCode = "";
		let capturedAuthHeader = "";
		const encodedSecret = encodeURIComponent(clientSecret);

		const server = await startCustomServer(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/mcp") {
				response
					.writeHead(401, {
						"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
					})
					.end();
				return;
			}
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				json(response, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
				});
				return;
			}
			if (url.pathname === "/authorize") {
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				capturedCode = "auth-code-secret-665544";
				redirect.searchParams.set("code", capturedCode);
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			if (url.pathname === "/token") {
				const rawBody = await readBody(request);
				const params = new URLSearchParams(rawBody);
				capturedVerifier = params.get("code_verifier") ?? "";
				capturedAuthHeader = request.headers.authorization ?? "";
				response
					.writeHead(500, { "content-type": "text/plain" })
					.end(
						`debug echo auth=${capturedAuthHeader} rawSecret=${clientSecret} encSecret=${encodedSecret} body=${rawBody}`,
					);
				return;
			}
			response.writeHead(404).end();
		});

		const agentDir = createAgentDir({
			issues: {
				url: server.url,
				oauth: { clientId: "client-1", clientSecret },
			},
		});
		const result = await runCli(["login", "issues", "--timeout", "10"], {
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: (authUrl) => {
				void fetch(authUrl, { redirect: "manual" }).then((res) => fetch(res.headers.get("location") ?? ""));
			},
		});

		assert.equal(result.exitCode, 1);
		assert.ok(capturedVerifier.length > 0, "expected PKCE verifier to be sent");
		assert.ok(capturedAuthHeader.startsWith("Basic "), "expected Basic auth header");
		const basicB64 = capturedAuthHeader.slice("Basic ".length);
		assertNoSecretLeaked(result, [clientSecret, encodedSecret, capturedVerifier, capturedCode, basicB64]);
		assert.match(result.stderr, /Sign-in to MCP server "issues" failed: HTTP 500:/);
	});

	it("login does not leak secrets echoed in OAuth JSON error_description, registration error, or redirect error", async () => {
		const clientSecret = "jsonDescClientSecret445566";
		const echoedAccess = "tok_echoed_access_112233445566";
		const echoedRefresh = "tok_echoed_refresh_665544332211";
		const regSecret = "regErrorBearerSecret887766";
		const redirectSecret = "redirectErrSecret334455";
		let capturedVerifier = "";

		const server = await startCustomServer(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/mcp" || url.pathname === "/mcp-reg" || url.pathname === "/mcp-redir") {
				response
					.writeHead(401, {
						"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${url.pathname}"`,
					})
					.end();
				return;
			}
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource/")) {
				const suffix = url.pathname.slice("/.well-known/oauth-protected-resource".length);
				json(response, 200, { resource: `${origin}${suffix}`, authorization_servers: [`${origin}${suffix}-as`] });
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server/mcp-as") {
				json(response, 200, {
					issuer: `${origin}/mcp-as`,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["client_secret_post"],
				});
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server/mcp-reg-as") {
				json(response, 200, {
					issuer: `${origin}/mcp-reg-as`,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server/mcp-redir-as") {
				json(response, 200, {
					issuer: `${origin}/mcp-redir-as`,
					authorization_endpoint: `${origin}/authorize-err`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
				return;
			}
			if (url.pathname === "/register") {
				response
					.writeHead(400, { "content-type": "text/plain" })
					.end(`registration failed: Authorization: Bearer ${regSecret}`);
				return;
			}
			if (url.pathname === "/authorize") {
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("code", "code-json-err-99");
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			if (url.pathname === "/authorize-err") {
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("error", "access_denied");
				redirect.searchParams.set("error_description", `denied token=${redirectSecret}`);
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			if (url.pathname === "/token") {
				const params = new URLSearchParams(await readBody(request));
				capturedVerifier = params.get("code_verifier") ?? "";
				json(response, 400, {
					error: "invalid_grant",
					error_description: `Bad verifier ${capturedVerifier}, secret ${clientSecret}, access_token=${echoedAccess}, refresh_token=${echoedRefresh}`,
				});
				return;
			}
			response.writeHead(404).end();
		});

		const agentDir = createAgentDir({
			issues: { url: server.url, oauth: { clientId: "client-1", clientSecret } },
			regfail: { url: `${server.origin}/mcp-reg` },
			redirfail: { url: `${server.origin}/mcp-redir`, oauth: { clientId: "client-1" } },
		});
		const open = (authUrl: string) => {
			void fetch(authUrl, { redirect: "manual" }).then((res) => fetch(res.headers.get("location") ?? ""));
		};

		const tokenErr = await runCli(["login", "issues", "--timeout", "10"], {
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: open,
		});
		assert.equal(tokenErr.exitCode, 1);
		assert.ok(capturedVerifier.length > 0);
		assertNoSecretLeaked(tokenErr, [clientSecret, capturedVerifier, echoedAccess, echoedRefresh, "code-json-err-99"]);

		const regErr = await runCli(["login", "regfail", "--timeout", "10"], {
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: open,
		});
		assert.equal(regErr.exitCode, 1);
		assertNoSecretLeaked(regErr, [regSecret]);

		const redirErr = await runCli(["login", "redirfail", "--timeout", "10"], {
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: open,
		});
		assert.equal(redirErr.exitCode, 1);
		assertNoSecretLeaked(redirErr, [redirectSecret]);
	});

	it("login does not leak the newly-issued access_token when post-login reconnect echoes it on console.error", async () => {
		const accessToken = "opaquePostLoginAccessToken554433";
		const refreshToken = "opaquePostLoginRefreshToken221100";
		let issued = false;

		const server = await startCustomServer(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/mcp") {
				if (!issued) {
					response
						.writeHead(401, {
							"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
						})
						.end();
					return;
				}
				// Post-login reconnect returns 500 echoing the bare access token.
				response.writeHead(500, { "content-type": "text/plain" }).end(`backend rejected ${accessToken}`);
				return;
			}
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				json(response, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
				return;
			}
			if (url.pathname === "/authorize") {
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("code", "code-reconnect-1");
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			if (url.pathname === "/token") {
				issued = true;
				json(response, 200, {
					access_token: accessToken,
					refresh_token: refreshToken,
					token_type: "Bearer",
					expires_in: 3600,
				});
				return;
			}
			response.writeHead(404).end();
		});

		const agentDir = createAgentDir({
			issues: { url: server.url, oauth: { clientId: "client-1" } },
		});
		const consoleLogLines: string[] = [];
		const consoleErrLines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			consoleLogLines.push(args.map(String).join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			consoleErrLines.push(args.map(String).join(" "));
		});

		const exitCode = await runMcpCommand(["login", "issues", "--timeout", "10"], {
			cwd: agentDir,
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: (authUrl) => {
				void fetch(authUrl, { redirect: "manual" }).then((res) => fetch(res.headers.get("location") ?? ""));
			},
		});

		assert.equal(exitCode, 1);
		assertNoSecretLeaked({ stdout: consoleLogLines.join("\n"), stderr: consoleErrLines.join("\n") }, [
			accessToken,
			refreshToken,
			"code-reconnect-1",
		]);
		assert.match(consoleErrLines.join("\n"), /Signed in, but /);
	});

	it("login prints only public parameters in the authorization URL and never prints secrets on success", async () => {
		const clientSecret = "loginSuccessClientSecret112233";
		const accessToken = "opaqueAccessTokenSuccess445566";
		const refreshToken = "opaqueRefreshTokenSuccess778899";
		let capturedVerifier = "";
		let openedAuthUrl = "";

		const server = await startCustomServer(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/mcp") {
				const token = request.headers.authorization?.replace(/^Bearer /, "");
				if (token !== accessToken) {
					response
						.writeHead(401, {
							"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
						})
						.end();
					return;
				}
				const message = JSON.parse(await readBody(request)) as { id?: number; method: string };
				if (message.id === undefined) {
					response.writeHead(202).end();
					return;
				}
				const body =
					message.method === "initialize"
						? {
								protocolVersion: "2025-11-25",
								capabilities: { tools: {} },
								serverInfo: { name: "issues", version: "1.0.0" },
							}
						: { tools: [] };
				json(response, 200, { jsonrpc: "2.0", id: message.id, result: body });
				return;
			}
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				json(response, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["client_secret_post"],
				});
				return;
			}
			if (url.pathname === "/authorize") {
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("code", "code-success-1");
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			if (url.pathname === "/token") {
				const params = new URLSearchParams(await readBody(request));
				capturedVerifier = params.get("code_verifier") ?? "";
				const expectedChallenge = createHash("sha256").update(capturedVerifier).digest("base64url");
				assert.equal(new URL(openedAuthUrl).searchParams.get("code_challenge"), expectedChallenge);
				json(response, 200, {
					access_token: accessToken,
					refresh_token: refreshToken,
					token_type: "Bearer",
					expires_in: 3600,
				});
				return;
			}
			response.writeHead(404).end();
		});

		const agentDir = createAgentDir({
			issues: { url: server.url, oauth: { clientId: "public-client-id", clientSecret } },
		});
		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const result = await runCli(["login", "issues", "--timeout", "10"], {
			agentDir,
			credentials,
			openUrl: (authUrl) => {
				openedAuthUrl = authUrl;
				void fetch(authUrl, { redirect: "manual" }).then((res) => fetch(res.headers.get("location") ?? ""));
			},
		});

		assert.equal(result.exitCode, 0, result.combined);
		assert.ok(openedAuthUrl.length > 0);
		const parsedUrl = new URL(openedAuthUrl);
		const allowedParams = new Set([
			"response_type",
			"client_id",
			"code_challenge",
			"code_challenge_method",
			"redirect_uri",
			"state",
			"scope",
			"prompt",
			"resource",
		]);
		for (const key of parsedUrl.searchParams.keys()) {
			assert.ok(allowedParams.has(key), `unexpected authorization URL parameter: ${key}`);
		}
		assertNoSecretLeaked(result, [clientSecret, capturedVerifier, accessToken, refreshToken, "code-success-1"]);

		// Logout must not print stored tokens or secrets either.
		const logoutResult = await runCli(["logout", "issues"], { agentDir, credentials });
		assert.equal(logoutResult.exitCode, 0);
		assertNoSecretLeaked(logoutResult, [clientSecret, capturedVerifier, accessToken, refreshToken]);
	});

	it("list and list --json do not leak refresh tokens, access tokens, client secrets, URL credentials, or stderr secrets", async () => {
		const refreshToken = "opaqueRefreshTokenList998877";
		const accessToken = "opaqueAccessTokenList665544";
		const clientSecret = "opaqueClientSecretList332211";
		const urlPassword = "embeddedUrlPassword112233";
		const stdioArgSecret = "sk-stdioArgSecret998877665544";
		const stdioStderrSecret = "stdioStderrBearerSecret443322";
		const bangHeaderSecret = "opaqueBangHeaderSecret556677";

		const server = await startCustomServer(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/mcp-refresh") {
				response
					.writeHead(401, {
						"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp-refresh"`,
					})
					.end();
				return;
			}
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp-refresh") {
				json(response, 200, { resource: `${origin}/mcp-refresh`, authorization_servers: [origin] });
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				json(response, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["client_secret_post"],
				});
				return;
			}
			if (url.pathname === "/token") {
				const rawBody = await readBody(request);
				response.writeHead(503, { "content-type": "text/plain" }).end(`upstream failed for ${rawBody}`);
				return;
			}
			if (url.pathname === "/mcp-http-echo") {
				const auth = request.headers.authorization ?? "";
				response.writeHead(500, { "content-type": "text/plain" }).end(`rejected ${auth} raw=${accessToken}`);
				return;
			}
			response.writeHead(404).end();
		});

		const credentials = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const refreshUrl = `${server.origin}/mcp-refresh`;
		await credentials.forServer("refresh-srv", refreshUrl).save({
			serverUrl: refreshUrl,
			clientInformation: { client_id: "client-1", client_secret: clientSecret },
			tokens: { access_token: "stale-access-1", refresh_token: refreshToken, token_type: "Bearer" },
			tokensExpireAt: Date.now() + 3_600_000,
		});
		const bangRefreshSecret = "opaqueBangRefreshSecret12345";
		await credentials.forServer("bang-refresh", refreshUrl).save({
			serverUrl: refreshUrl,
			clientInformation: { client_id: "client-1" },
			tokens: { access_token: "stale-access-2", refresh_token: "stale-refresh-2", token_type: "Bearer" },
			tokensExpireAt: Date.now() + 3_600_000,
		});

		const urlWithCreds = `${server.origin.replace("http://", `http://alice:${urlPassword}@`)}/mcp-http-echo`;
		let httpEchoHits = 0;
		const agentDir = createAgentDir({
			"refresh-srv": {
				url: refreshUrl,
				oauth: { clientId: "client-1", clientSecret },
			},
			"bang-refresh": {
				url: refreshUrl,
				oauth: { clientId: "client-1", clientSecret: `!${bangRefreshSecret}` },
			},
			"http-echo": {
				url: `${server.origin}/mcp-http-echo`,
				headers: { Authorization: `Bearer ${accessToken}` },
			},
			"url-creds": {
				url: urlWithCreds,
			},
			"bad-header": {
				url: `${server.origin}/mcp-http-echo`,
				headers: { "X-Api-Key": `!${bangHeaderSecret}` },
			},
			"stdio-leak": {
				command: process.execPath,
				args: [
					STDERR_FIXTURE,
					"fail",
					JSON.stringify(`Authorization: Bearer ${stdioStderrSecret}`),
					"--api-key",
					stdioArgSecret,
				],
			},
		});

		const allSecrets = [
			refreshToken,
			accessToken,
			clientSecret,
			bangRefreshSecret,
			urlPassword,
			stdioArgSecret,
			stdioStderrSecret,
			bangHeaderSecret,
		];

		for (const args of [["list"], ["list", "--json"]]) {
			const result = await runCli(args, { agentDir, credentials });
			assert.equal(result.exitCode, 1, args.join(" "));
			assertNoSecretLeaked(result, allSecrets);
			assert.equal(result.stdout.includes("MCP HTTP request failed with status 500"), true, result.stdout);
			httpEchoHits++;
		}
		assert.equal(httpEchoHits, 2);
	});

	it("list redacts provider credential errors before writing to mcp.log", async () => {
		const oauthServer = await startOAuthMcpServer();
		cleanups.push(oauthServer.close);
		const leakedBearer = "providerBearerLeak112233";
		const leakedRefresh = "providerRefreshLeak445566";
		const create = ModelRuntime.create.bind(ModelRuntime);
		vi.spyOn(ModelRuntime, "create").mockImplementation(async (options) => {
			const runtime = await create(options);
			vi.spyOn(runtime, "getAuth").mockImplementation(async () => {
				throw new Error(`refresh rejected Authorization: Bearer ${leakedBearer} refresh_token=${leakedRefresh}`);
			});
			return runtime;
		});

		const agentDir = createAgentDir({
			issues: { url: oauthServer.url, auth: { provider: "anthropic" } },
		});
		const result = await runCli(["list"], { agentDir });
		assert.equal(result.exitCode, 1);
		assertNoSecretLeaked(result, [leakedBearer, leakedRefresh]);
		const logPath = join(agentDir, "mcp.log");
		assert.equal(existsSync(logPath), true);
		const logContent = readFileSync(logPath, "utf8");
		assert.equal(logContent.includes(leakedBearer), false, `mcp.log leaked bearer: ${logContent}`);
		assert.equal(logContent.includes(leakedRefresh), false, `mcp.log leaked refresh_token: ${logContent}`);
	});

	it("add and remove never echo secrets on stdout or stderr across success and option-error paths", async () => {
		const clientSecret = "addCmdClientSecret998877";
		const headerSecret = "addCmdHeaderSecret665544";
		const urlSecret = "addCmdUrlPass332211";
		const eqSecret = "addEqClientSecret112233";
		const badPairSecret = "addBadPairSecret445566";

		const agentDir = createAgentDir();

		const addOk = await runCli(
			[
				"add",
				"sentry",
				"--url",
				`https://alice:${urlSecret}@mcp.example.com/mcp`,
				"--oauth-client-id",
				"cid-1",
				"--oauth-client-secret",
				clientSecret,
				"--header",
				`X-Custom=Bearer ${headerSecret}`,
			],
			{ agentDir },
		);
		assert.equal(addOk.exitCode, 0, addOk.combined);
		assertNoSecretLeaked(addOk, [clientSecret, headerSecret, urlSecret]);

		const addEqFail = await runCli(
			["add", "bad1", "--url", "https://mcp.example.com/mcp", `--oauth-client-secret=${eqSecret}`],
			{ agentDir },
		);
		assert.equal(addEqFail.exitCode, 1);
		assertNoSecretLeaked(addEqFail, [eqSecret]);

		const addPairFail = await runCli(
			["add", "bad2", "--url", "https://mcp.example.com/mcp", "--header", `Authorization Bearer ${badPairSecret}`],
			{ agentDir },
		);
		assert.equal(addPairFail.exitCode, 1);
		assertNoSecretLeaked(addPairFail, [badPairSecret]);

		const removeOk = await runCli(["remove", "sentry"], { agentDir });
		assert.equal(removeOk.exitCode, 0);
		assertNoSecretLeaked(removeOk, [clientSecret, headerSecret, urlSecret]);

		const removeMissing = await runCli(["remove", "sentry"], { agentDir });
		assert.equal(removeMissing.exitCode, 1);
		assertNoSecretLeaked(removeMissing, [clientSecret, headerSecret, urlSecret]);
	});
});
