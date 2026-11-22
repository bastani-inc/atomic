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
import { McpHttpError, StreamableHttpTransport } from "../../src/extensions/mcp/client/index.js";
import {
	exchangeAuthorizationCode,
	OAuthError,
	OAuthTemporarilyUnavailableError,
	registerClient,
	startAuthorization,
} from "../../src/extensions/mcp/client/oauth/index.js";
import {
	extractAuthorizationSecrets,
	redactAuthorizationUrlForDisplay,
	redactOAuthErrorText,
	redactSecretValues,
	redactWwwAuthenticateHeader,
} from "../../src/extensions/mcp/client/oauth/redact.js";
import { createMcpExtension } from "../../src/extensions/mcp/index.js";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.js";
import { createMcpResourceToolDefinitions } from "../../src/extensions/mcp/resources.js";
import { McpServerConnection } from "../../src/extensions/mcp/runtime.js";
import { initTheme } from "../../src/modes/interactive/theme/theme.js";
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

	it("single-pass redaction preserves HTTP status text, does not rescan [redacted], stays idempotent, and handles all producer encodings", () => {
		// Short secrets must not corrupt HTTP status text or [redacted].
		assert.equal(redactOAuthErrorText("HTTP 400: invalid_client", ["40"]), "HTTP 400: invalid_client");
		assert.equal(redactOAuthErrorText("HTTP 400: invalid_client", ["400"]), "HTTP 400: invalid_client");
		assert.equal(redactSecretValues("prefix acted suffix", ["acted", "red"]), "prefix [redacted] suffix");
		assert.equal(
			redactSecretValues("HTTP 500: bad longSecret123 and red", ["longSecret123", "red"]),
			"HTTP 500: bad [redacted] and red",
		);

		// Idempotence even when secrets are substrings of "[redacted]".
		const once = redactSecretValues("prefix acted redact suffix", ["acted", "redact"]);
		assert.equal(once, "prefix [redacted] [redacted] suffix");
		assert.equal(redactSecretValues(once, ["acted", "redact"]), once);

		// No exponential blowup when inputs repeat sentinel characters.
		const repeated = redactSecretValues("e".repeat(100), ["e", "d", "a", "c", "t", "r"]);
		assert.ok(repeated.length <= 1_100, `unexpected expansion: ${repeated.length}`);

		// Lowercase/mixed-case %xx, HTML entities, RFC 3986 reserved chars, Go JSON escapes.
		const sPct = "sec/ret+val=99";
		const sPctLower = encodeURIComponent(sPct).toLowerCase();
		const sPctMixed = "sec%2fret%2Bval%3d99";
		assert.equal(redactOAuthErrorText(`echoed=${sPctLower}`, [sPct]).includes(sPctLower), false);
		assert.equal(redactOAuthErrorText(`echoed=${sPctMixed}`, [sPct]).includes(sPctMixed), false);

		const sHtml = `sec&<"'>9988`;
		const sHtmlEsc = "sec&amp;&lt;&quot;&#39;&gt;9988";
		const sHtmlApos = "sec&amp;&lt;&quot;&apos;&gt;9988";
		assert.equal(redactOAuthErrorText(`echoed=${sHtmlEsc}`, [sHtml]).includes(sHtmlEsc), false);
		assert.equal(redactOAuthErrorText(`echoed=${sHtmlApos}`, [sHtml]).includes(sHtmlApos), false);

		const sRfc = "!sec'()* ret 9988";
		const sRfcEnc = "%21sec%27%28%29%2A%20ret%209988";
		const sRfcPlus = "%21sec%27%28%29%2a+ret+9988";
		assert.equal(redactOAuthErrorText(`echoed=${sRfcEnc}`, [sRfc]).includes(sRfcEnc), false);
		assert.equal(redactOAuthErrorText(`echoed=${sRfcPlus}`, [sRfc]).includes(sRfcPlus), false);

		const sGoJson = "a&b<c>d/e9988";
		const sGoEsc = String.raw`a\u0026b\u003cc\u003ed\/e9988`;
		assert.equal(redactOAuthErrorText(`{"x":"${sGoEsc}"}`, [sGoJson]).includes(sGoEsc), false);

		// Scheme + tab, Basic base64 decode, `=` scheme fields, code_verifier, Bearer with !/$/%.
		const basicPass = "opaqueDecodedBasicPass8877";
		const basicB64 = Buffer.from(`alice:${basicPass}`).toString("base64");
		assert.ok(extractAuthorizationSecrets(`Bearer\topaqueTabTok9988`).includes("opaqueTabTok9988"));
		assert.ok(extractAuthorizationSecrets(`Basic\t${basicB64}`).includes(basicPass));
		assert.equal(redactOAuthErrorText("auth=Bearer opaqueEqTok998877").includes("opaqueEqTok998877"), false);
		assert.equal(redactOAuthErrorText(`Authorization=Basic ${basicB64}`).includes(basicB64), false);
		assert.equal(redactOAuthErrorText(`rejected Basic ${basicB64}`).includes(basicB64), false);
		assert.equal(
			redactOAuthErrorText('{"code_verifier":"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE"}').includes(
				"AbCdEfGhIjKlMnOpQrStUvWxYz",
			),
			false,
		);
		assert.equal(redactOAuthErrorText("Bearer tok%2FopaqueTail998877").includes("opaqueTail998877"), false);
		assert.equal(redactOAuthErrorText("Bearer tok!cbBang$Dollar7788").includes("cbBang$Dollar7788"), false);
	});

	it("login redacts /token empty error_description fallback, /register JSON client_secret & Basic, and callback Basic/code/code_verifier/Bearer", async () => {
		const clientSecret = "opaqueEmptyDescSecret778899";
		const regSec = "opaqueRegSec445566";
		const basicB64 = Buffer.from("alice:opaqueBasicPass778899").toString("base64");
		const codeSec = "cbAuthCodeSecret3344";
		const verifierSec = "cbVerifierSecret5566";
		const bangBearer = "tok!cbBang$Dollar7788";
		let capturedVerifier = "";
		let capturedCode = "";
		let callbackHtml = "";

		const server = await startCustomServer(async (request, response, origin) => {
			const url = new URL(request.url ?? "/", origin);
			if (url.pathname === "/mcp-empty" || url.pathname === "/mcp-reg" || url.pathname === "/mcp-cb") {
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
			if (url.pathname === "/.well-known/oauth-authorization-server/mcp-empty-as") {
				json(response, 200, {
					issuer: `${origin}/mcp-empty-as`,
					authorization_endpoint: `${origin}/authorize-empty`,
					token_endpoint: `${origin}/token-empty`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["client_secret_post"],
				});
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server/mcp-reg-as") {
				json(response, 200, {
					issuer: `${origin}/mcp-reg-as`,
					authorization_endpoint: `${origin}/authorize-empty`,
					token_endpoint: `${origin}/token-empty`,
					registration_endpoint: `${origin}/register-secret`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
				return;
			}
			if (url.pathname === "/.well-known/oauth-authorization-server/mcp-cb-as") {
				json(response, 200, {
					issuer: `${origin}/mcp-cb-as`,
					authorization_endpoint: `${origin}/authorize-cb`,
					token_endpoint: `${origin}/token-empty`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
				return;
			}
			if (url.pathname === "/authorize-empty") {
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				capturedCode = "authCodeEmptyDesc9988";
				redirect.searchParams.set("code", capturedCode);
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			if (url.pathname === "/token-empty") {
				const params = new URLSearchParams(await readBody(request));
				capturedVerifier = params.get("code_verifier") ?? "";
				json(response, 400, {
					error: `rejected_${clientSecret}_${capturedVerifier}_${capturedCode}`,
					error_description: "",
				});
				return;
			}
			if (url.pathname === "/register-secret") {
				json(response, 400, {
					client_secret: regSec,
					error: `bad registration for ${regSec} auth Basic ${basicB64}`,
				});
				return;
			}
			if (url.pathname === "/authorize-cb") {
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("error", "access_denied");
				redirect.searchParams.set(
					"error_description",
					`Basic ${basicB64} code=${codeSec} code_verifier=${verifierSec} Authorization=Basic ${basicB64} Bearer ${bangBearer}`,
				);
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			response.writeHead(404).end();
		});

		const agentDir = createAgentDir({
			empty: { url: `${server.origin}/mcp-empty`, oauth: { clientId: "cid", clientSecret } },
			reg: { url: `${server.origin}/mcp-reg` },
			cb: { url: `${server.origin}/mcp-cb`, oauth: { clientId: "cid" } },
		});

		const emptyRes = await runCli(["login", "empty", "--timeout", "10"], {
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: (u) => {
				void fetch(u, { redirect: "manual" }).then((r) => fetch(r.headers.get("location") ?? ""));
			},
		});
		assert.equal(emptyRes.exitCode, 1);
		assert.ok(capturedVerifier.length > 0);
		assertNoSecretLeaked(emptyRes, [clientSecret, capturedVerifier, capturedCode]);

		const regRes = await runCli(["login", "reg", "--timeout", "10"], {
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: () => {},
		});
		assert.equal(regRes.exitCode, 1);
		assertNoSecretLeaked(regRes, [regSec, basicB64]);

		const cbRes = await runCli(["login", "cb", "--timeout", "10"], {
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: (u) => {
				void fetch(u, { redirect: "manual" })
					.then((r) => fetch(r.headers.get("location") ?? ""))
					.then(async (r) => {
						callbackHtml = await r.text();
					});
			},
		});
		assert.equal(cbRes.exitCode, 1);
		assertNoSecretLeaked(cbRes, [basicB64, codeSec, verifierSec, bangBearer, "!cbBang$Dollar7788"]);
		for (const secret of [basicB64, codeSec, verifierSec, bangBearer, "!cbBang$Dollar7788"]) {
			assert.equal(callbackHtml.includes(secret), false, `callback HTML leaked ${secret}: ${callbackHtml}`);
		}
	});

	it("add redacts --header=..., --env=..., and malformed pair values with missing or leading =", async () => {
		const agentDir = createAgentDir();
		const basicB64 = Buffer.from("u:addBasicPass9988").toString("base64");
		const cases: [string[], string][] = [
			[["add", "s", "--url", "https://example.com", "--header=X-Custom=opaqueHdrEq1122"], "opaqueHdrEq1122"],
			[["add", "s", "--url", "https://example.com", `--header=Authorization=Basic ${basicB64}`], basicB64],
			[["add", "s", "--env=MY_CUSTOM_VAR=opaqueEnvEq3344", "--", "node", "x.js"], "opaqueEnvEq3344"],
			[["add", "s", "--url", "https://example.com", "--header", `Authorization Basic ${basicB64}`], basicB64],
			[
				["add", "s", "--url", "https://example.com", "--header", "X-Custom opaqueCustomSpace7788"],
				"opaqueCustomSpace7788",
			],
			[
				["add", "s", "--url", "https://example.com", "--header", "=opaqueLeadingEqHdr9900"],
				"opaqueLeadingEqHdr9900",
			],
			[["add", "s", "--env", "MY_SECRET opaqueEnvSpace1122", "--", "node", "x.js"], "opaqueEnvSpace1122"],
			[["add", "s", "--env", "=opaqueLeadingEqEnv3344", "--", "node", "x.js"], "opaqueLeadingEqEnv3344"],
		];
		for (const [args, secret] of cases) {
			const res = await runCli(args, { agentDir });
			assert.equal(res.exitCode, 1, args.join(" "));
			assertNoSecretLeaked(res, [secret]);
		}
	});

	it("Streamable HTTP and SSE redact 200 JSON-RPC errors, Cookie/custom/tab headers, concurrent tokens, and URL query secrets", async () => {
		const accessTok = "opaqueHttp200JsonRpcTok998877";
		const cookieVal = "opaqueCookieSidVal998877";
		const customHdr = "opaqueCustomHdrVal998877";
		const sessHdr = "opaqueSessionHdrVal998877";
		const tabTok = "opaqueTabBearerTok998877";
		const urlQuerySec = "opaqueUrlQuerySecret5566";
		const tokA = "opaqueConcurrentTokenAAA111";
		const tokB = "opaqueConcurrentTokenBBB222";
		let releaseFirst: (() => void) | undefined;

		const srv = await startCustomServer(async (req, res, origin) => {
			const u = new URL(req.url ?? "/", origin);
			const bodyText = await readBody(req);
			if (u.pathname === "/mcp-200-rpc-err") {
				const msg = JSON.parse(bodyText) as { id?: number };
				json(res, 200, {
					jsonrpc: "2.0",
					id: msg.id ?? 1,
					error: { code: -32000, message: `rejected ${accessTok}` },
				});
				return;
			}
			if (u.pathname === "/mcp-sse-rpc-err") {
				const msg = JSON.parse(bodyText) as { id?: number };
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.end(
					`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? 1, error: { code: -32000, message: `sse rejected ${accessTok}` } })}\n\n`,
				);
				return;
			}
			if (u.pathname === "/mcp-500-cookie") {
				res.writeHead(500).end(`invalid session ${cookieVal}`);
				return;
			}
			if (u.pathname === "/mcp-500-custom") {
				res.writeHead(500).end(`rejected ${customHdr} and ${sessHdr}`);
				return;
			}
			if (u.pathname === "/mcp-500-tab") {
				res.writeHead(500).end(`rejected ${tabTok}`);
				return;
			}
			if (u.pathname === "/mcp-500-query") {
				res.writeHead(500).end(`rejected query ${u.searchParams.get("api_key") ?? ""}`);
				return;
			}
			if (u.pathname === "/mcp-500-boundary") {
				res.writeHead(500).end(`${"x".repeat(8180)}opaqueBoundaryTokenSplit12345${"y".repeat(500)}`);
				return;
			}
			if (u.pathname === "/mcp-200-badjson") {
				res.writeHead(200, { "content-type": "application/json" }).end(`opaqueBadJsonToken998877`);
				return;
			}
			if (u.pathname === "/mcp-concurrent") {
				const auth = req.headers.authorization ?? "";
				if (auth.includes(tokA)) {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
					res.writeHead(500).end(`first failed for ${tokA}`);
					return;
				}
				releaseFirst?.();
				res.writeHead(202).end();
				return;
			}
			res.writeHead(404).end();
		});

		const creds = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const rpcUrl = `${srv.origin}/mcp-200-rpc-err`;
		await creds.forServer("rpc-err", rpcUrl).save({
			serverUrl: rpcUrl,
			tokens: { access_token: accessTok, token_type: "Bearer" },
			tokensExpireAt: Date.now() + 3_600_000,
		});
		const sseUrl = `${srv.origin}/mcp-sse-rpc-err`;
		await creds.forServer("sse-err", sseUrl).save({
			serverUrl: sseUrl,
			tokens: { access_token: accessTok, token_type: "Bearer" },
			tokensExpireAt: Date.now() + 3_600_000,
		});

		const agentDir = createAgentDir({
			"rpc-err": { url: rpcUrl },
			"sse-err": { url: sseUrl },
			"cookie-err": { url: `${srv.origin}/mcp-500-cookie`, headers: { Cookie: `sid=${cookieVal}; other=abc` } },
			"custom-err": {
				url: `${srv.origin}/mcp-500-custom`,
				headers: { "X-Custom": customHdr, "X-Session": sessHdr },
			},
			"tab-err": { url: `${srv.origin}/mcp-500-tab`, headers: { Authorization: `Bearer\t${tabTok}` } },
			"url-query": { url: `${srv.origin}/mcp-500-query?api_key=${urlQuerySec}` },
			"boundary-err": {
				url: `${srv.origin}/mcp-500-boundary`,
				headers: { Authorization: "Bearer opaqueBoundaryTokenSplit12345" },
			},
			"badjson-err": { url: `${srv.origin}/mcp-200-badjson` },
		});

		const listRes = await runCli(["list", "--json"], { agentDir, credentials: creds });
		assert.equal(listRes.exitCode, 1);
		assertNoSecretLeaked(listRes, [
			accessTok,
			cookieVal,
			customHdr,
			sessHdr,
			tabTok,
			urlQuerySec,
			"opaqueBoundaryTokenSplit12345",
			"opaqueBoundary",
			"opaqueBadJsonToken998877",
		]);

		// Concurrent request token isolation on StreamableHttpTransport.
		let callCount = 0;
		const transport = new StreamableHttpTransport({
			url: `${srv.origin}/mcp-concurrent`,
			openGetStream: false,
			authProvider: {
				token: async () => (++callCount === 1 ? tokA : tokB),
			},
		});
		await transport.start();
		const firstReq = transport.send({ jsonrpc: "2.0", id: 1, method: "ping" }).catch((error: unknown) => error);
		// Let first request enter fetch before second overwrites lastToken.
		await new Promise((resolve) => setTimeout(resolve, 25));
		await transport.send({ jsonrpc: "2.0", method: "notifications/ping" });
		const firstErr = await firstReq;
		await transport.close();
		assert.ok(firstErr instanceof McpHttpError);
		assert.equal(firstErr.message.includes(tokA), false, firstErr.message);
		assert.equal(firstErr.body.includes(tokA), false, firstErr.body);
	});

	it("stdio redacts configured env values in stderr, redacts before sliceTail, and redacts mcp.log server notifications", async () => {
		const envSecret = "opaqueStdioEnvVal887766";
		const cutBearer = "opaqueCutBearerVal554433";
		const notifSecret = "opaqueNotifBearerVal332211";
		const notifUrlPass = "opaqueNotifUrlPass110099";

		const scriptDir = createAgentDir();
		const envLeakScript = join(scriptDir, "env-leak.mjs");
		writeFileSync(
			envLeakScript,
			`process.stderr.write("startup failed for " + process.env.API_SECRET + "\\n"); process.exit(1);\n`,
		);
		const cutBearerScript = join(scriptDir, "cut-bearer.mjs");
		writeFileSync(
			cutBearerScript,
			`process.stderr.write("Authorization: Bearer ${cutBearer} " + "x".repeat(1974) + "\\n"); process.exit(1);\n`,
		);
		const notifScript = join(scriptDir, "notif-server.mjs");
		writeFileSync(
			notifScript,
			`import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "notif", version: "1.0.0" } } }) + "\\n");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "Authorization: Bearer ${notifSecret} https://alice:${notifUrlPass}@host/mcp env=" + process.env.API_SECRET } }) + "\\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");
  }
});
`,
		);

		const agentDir = createAgentDir({
			"stdio-env": { command: process.execPath, args: [envLeakScript], env: { API_SECRET: envSecret } },
			"stdio-cut": { command: process.execPath, args: [cutBearerScript] },
			"stdio-notif": { command: process.execPath, args: [notifScript], env: { API_SECRET: envSecret } },
		});

		const listRes = await runCli(["list", "--json"], { agentDir });
		assert.equal(listRes.exitCode, 1);
		assertNoSecretLeaked(listRes, [envSecret, cutBearer]);

		const logPath = join(agentDir, "mcp.log");
		assert.equal(existsSync(logPath), true);
		const logContent = readFileSync(logPath, "utf8");
		for (const secret of [notifSecret, notifUrlPass, envSecret]) {
			assert.equal(logContent.includes(secret), false, `mcp.log leaked ${secret}: ${logContent}`);
		}
	});

	it("/mcp TUI signInWithUi strips userinfo from authorizationUrl and list_mcp_resources redacts tool result errors", async () => {
		initTheme("dark", false);
		const uiUrlPass = "opaqueUiAuthUrlPass776655";
		const srv = await startCustomServer((req, res, origin) => {
			const u = new URL(req.url ?? "/", origin);
			if (u.pathname === "/mcp") {
				res.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
				}).end();
				return;
			}
			if (u.pathname === "/.well-known/oauth-protected-resource/mcp") {
				json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
				return;
			}
			if (u.pathname === "/.well-known/oauth-authorization-server") {
				const authEndpoint = `${origin.replace("http://", `http://alice:${uiUrlPass}@`)}/authorize`;
				json(res, 200, {
					issuer: origin,
					authorization_endpoint: authEndpoint,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
				return;
			}
			res.writeHead(404).end();
		});

		let capturedRedirectPromptUrl = "";
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		const ext = createMcpExtension({
			loadConfig: () => ({
				servers: [
					{ name: "s", config: { url: srv.url, oauth: { clientId: "cid" } }, source: "mcp.json", scope: "global" },
				],
				errors: [],
			}),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: () => {},
		});
		ext({
			on: (ev: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(ev, fn),
			registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, cmd),
			registerTool: () => {},
			registerToolRenderer: () => {},
			getAllTools: () => [],
			getActiveTools: () => [],
			setActiveTools: () => {},
			appendEntry: async () => {},
		} as never);

		const ctx = {
			cwd: tmpdir(),
			hasUI: true,
			mode: "tui",
			isProjectTrusted: () => true,
			sessionManager: { getBranch: () => [] },
			ui: {
				notify: () => {},
				custom: async (
					factory: (
						tui: unknown,
						theme: unknown,
						keybindings: unknown,
						done: () => void,
					) => { redirectUrl: (title: string, authUrl: string) => Promise<string | undefined> },
				) => {
					await new Promise<void>((resolve) => {
						const view = factory(
							{ requestRender: () => {} },
							{ fg: (_: string, t: string) => t, bold: (t: string) => t },
							{ matches: () => false },
							resolve,
						);
						view.redirectUrl = async (_title: string, authUrl: string) => {
							capturedRedirectPromptUrl = authUrl;
							return undefined;
						};
					});
				},
			},
		};
		await handlers.get("session_start")?.({}, ctx);
		await commands.get("mcp")?.handler("login s", ctx);
		await handlers.get("session_shutdown")?.({}, ctx);
		assert.ok(capturedRedirectPromptUrl.length > 0, "expected redirect prompt URL");
		assert.equal(capturedRedirectPromptUrl.includes(uiUrlPass), false, capturedRedirectPromptUrl);

		// list_mcp_resources errorMessage must be redacted before entering tool results.
		const resSecret = "opaqueResourceErrBearer9988";
		const defs = createMcpResourceToolDefinitions({
			exposure: "direct",
			servers: () => [
				{
					name: "s",
					timeoutMs: 1000,
					resourcesPage: async () => ({ resources: [] }),
					resourceTemplatesPage: async () => ({ resourceTemplates: [] }),
					allResources: async () => {
						throw new Error(`failed with Authorization: Bearer ${resSecret} https://u:${resSecret}@host/x`);
					},
					allResourceTemplates: async () => [],
					readResource: async () => ({ contents: [] }),
				},
			],
		});
		const listRes = await defs[0]!.execute("call-1", {}, undefined, undefined, {} as never);
		const serialized = JSON.stringify(listRes);
		assert.equal(serialized.includes(resSecret), false, serialized);
	});

	it("OAuthError, OAuthTemporarilyUnavailableError, tokenRequest fetch/nested/custom-auth, and registerClient bad-JSON never leak secrets", async () => {
		const fetchSec = "opaqueFetchThrowSecret5544";
		const nestedTok = "opaqueNestedAccessTok8899";
		const customKey = "opaqueCustomClientKey6677";
		const assertion = "opaqueClientAssertion3344";
		const causePass = "opaqueNestedCausePass9911";
		const badRegBody = "opaqueRegBodyLeak998877";

		// tokenRequest fetch rejection scrubs requestSecrets while preserving TypeError for transient classification.
		const fetchErr = await exchangeAuthorizationCode("https://auth.example.com", {
			clientInformation: { client_id: "cid", client_secret: fetchSec },
			code: "auth-code-1",
			codeVerifier: "verifier-secret-123456789012345678901234567890123",
			redirectUrl: "http://127.0.0.1:9999/callback",
			fetch: async () => {
				throw new TypeError(`proxy rejected ${fetchSec}`);
			},
		}).catch((error: unknown) => error);
		assert.ok(fetchErr instanceof TypeError);
		assert.equal(fetchErr.message.includes(fetchSec), false, fetchErr.message);

		// OAuthTemporarilyUnavailableError scrubs message and does not retain raw nested cause with credentials.
		const rawCause = new TypeError("fetch failed", {
			cause: new Error(`connect https://alice:${causePass}@auth.example.com/token`),
		});
		const tempErr = new OAuthTemporarilyUnavailableError(rawCause);
		assert.equal(tempErr.message.includes(causePass), false);
		assert.equal(String((tempErr.cause as Error | undefined)?.message ?? "").includes(causePass), false);
		assert.equal((tempErr.cause as { cause?: unknown } | undefined)?.cause, undefined);

		// Nested details.access_token + addClientAuthentication custom header + client_assertion + error_uri query.
		const nestedErr = await exchangeAuthorizationCode("https://auth.example.com", {
			clientInformation: { client_id: "cid" },
			code: "auth-code-2",
			codeVerifier: "verifier-secret-223456789012345678901234567890123",
			redirectUrl: "http://127.0.0.1:9999/callback",
			addClientAuthentication: (headers, params) => {
				headers.set("X-Client-Key", customKey);
				params.set("client_assertion", assertion);
			},
			fetch: async () =>
				new Response(
					JSON.stringify({
						error: `bad_${customKey}`,
						error_description: `nested ${nestedTok} assert ${assertion}`,
						error_uri: `https://auth.example.com/err?secret=${customKey}`,
						details: { access_token: nestedTok },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		}).catch((error: unknown) => error);
		assert.ok(nestedErr instanceof OAuthError);
		for (const field of [nestedErr.message, nestedErr.code, nestedErr.errorUri ?? ""]) {
			for (const secret of [customKey, nestedTok, assertion]) {
				assert.equal(field.includes(secret), false, `OAuthError leaked ${secret} in ${field}`);
			}
		}

		// registerClient HTTP 200 non-JSON body never quotes raw body in SyntaxError.
		const regErr = await registerClient("https://auth.example.com", {
			clientMetadata: { redirect_uris: ["http://127.0.0.1:9999/callback"] },
			fetch: async () => new Response(badRegBody, { status: 200 }),
		}).catch((error: unknown) => error);
		assert.ok(regErr instanceof Error);
		assert.equal(regErr.message.includes(badRegBody), false, regErr.message);

		// Corrupted mcp-auth.json never quotes raw token fragments in JSON.parse SyntaxError.
		const corruptToken = "opaqueCorruptAuthToken9988";
		const corruptBackend = new InMemoryAuthStorageBackend();
		corruptBackend.withLock(() => ({ result: undefined, next: corruptToken }));
		const corruptStore = new McpOAuthCredentialStore(corruptBackend);
		const parseErr = await corruptStore
			.forServer("s", "https://example.com/mcp")
			.load()
			.catch((error: unknown) => error);
		assert.ok(parseErr instanceof Error);
		assert.equal(parseErr.message, "Failed to parse MCP OAuth credentials file");
		assert.equal(parseErr.message.includes(corruptToken), false);

		// Corrupted mcp.json during `add` never quotes raw secret fragments in JSON.parse SyntaxError.
		const corruptCfgSecret = "opaqueCorruptMcpJsonSecret7766";
		const agentDir = createAgentDir();
		writeFileSync(join(agentDir, "mcp.json"), corruptCfgSecret);
		const addCorrupt = await runCli(["add", "s", "--url", "https://example.com/mcp"], { agentDir });
		assert.equal(addCorrupt.exitCode, 1);
		assertNoSecretLeaked(addCorrupt, [corruptCfgSecret]);

		// RFC 6750/9728 WWW-Authenticate challenge keeps its challenge metadata intact while scrubbing URL userinfo.
		assert.equal(
			redactWwwAuthenticateHeader('Bearer resource_metadata="https://example.com/meta"'),
			'Bearer resource_metadata="https://example.com/meta"',
		);
		assert.equal(
			redactWwwAuthenticateHeader('Bearer resource_metadata="https://alice:wwwPass99@example.com/meta"').includes(
				"wwwPass99",
			),
			false,
		);
	});

	it("preserves non-secret diagnostics & RFC 8707 wire resource, scrubs connectFailed/lookahead-shrinkage/Basic-base64/escaped-JSON/ANSI/partial-overlap", async () => {
		// 1. connectFailed + authorizedFetch throw never leak transport secrets (even after initializingTransport clears).
		const fetchConnSecret = "opaqueFetchErrConnSecret9988";
		const conn = new McpServerConnection({
			entry: { name: "srv", config: { url: "https://mcp.example.com/mcp" }, source: "test" },
			cwd: tmpdir(),
			createTransport: () =>
				new StreamableHttpTransport({
					url: "https://mcp.example.com/mcp",
					openGetStream: false,
					headers: { Authorization: `Bearer ${fetchConnSecret}` },
					fetch: async () => {
						throw new Error(`proxy rejected ${fetchConnSecret}`);
					},
				}),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => {},
		});
		const connErr = await conn.getClient().catch((error: unknown) => error);
		await conn.close();
		assert.ok(connErr instanceof Error);
		assert.equal(connErr.message.includes(fetchConnSecret), false, connErr.message);
		assert.equal((conn.error ?? "").includes(fetchConnSecret), false, conn.error);

		// 2. Lookahead shrinkage must never emit raw bytes from >= 8192 (tail prefix cut at 8192 + lookahead).
		const shrinkSec = "opaqueShrinkSecret30Chars12345";
		const tailSec = "opaqueShrinkBoundaryTailSecret99";
		const repeatedPrefix = `${shrinkSec} `.repeat(30); // 930 bytes -> shrinks by 600 bytes after redaction
		const fillerLen = 8690 - repeatedPrefix.length;
		const shrinkBody = `${repeatedPrefix}${"z".repeat(fillerLen)}${tailSec}`;
		const shrinkTransport = new StreamableHttpTransport({
			url: "https://mcp.example.com/mcp",
			openGetStream: false,
			headers: { Authorization: `Bearer ${shrinkSec}`, "X-Extra-Token": tailSec },
			fetch: async () => new Response(shrinkBody, { status: 500 }),
		});
		await shrinkTransport.start();
		const shrinkErr = await shrinkTransport
			.send({ jsonrpc: "2.0", id: 1, method: "ping" })
			.catch((error: unknown) => error);
		await shrinkTransport.close();
		assert.ok(shrinkErr instanceof McpHttpError);
		assert.equal(shrinkErr.body.includes("opaqueShrinkBo"), false, shrinkErr.body.slice(-80));
		assert.equal(shrinkErr.body.includes(shrinkSec), false);

		// 3. Unbounded Basic Base64 credentials (including 4-char and all-lowercase Base64) + bare Base64 encoding of known secrets.
		for (const b64 of [
			Buffer.from("a:b").toString("base64"), // "YTpi"
			Buffer.from("j:j").toString("base64"), // "ajpq"
			Buffer.from("j:jjjj").toString("base64"), // "ajpqampq"
			Buffer.from("j:jjjjjjj").toString("base64"), // "ajpqampqampq"
			Buffer.from("jjjj:jjjjjjj").toString("base64"), // "ampqajpqampqampq"
		]) {
			const out = redactOAuthErrorText(`rejected Basic ${b64}`);
			assert.equal(out.includes(b64), false, `Basic ${b64} leaked: ${out}`);
		}
		assert.equal(redactOAuthErrorText("Basic auth failed"), "Basic auth failed");
		assert.equal(redactOAuthErrorText("Basic mode only"), "Basic mode only");
		assert.equal(redactOAuthErrorText("Basic text format"), "Basic text format");

		const rawKnown = "knownBareSecretValue7788";
		const bareB64 = Buffer.from(rawKnown).toString("base64");
		const bareB64Unpadded = bareB64.replace(/=+$/u, "");
		assert.equal(
			redactSecretValues(`b64=${bareB64} unpad=${bareB64Unpadded}`, [rawKnown]).includes(bareB64Unpadded),
			false,
		);

		// 4. Escaped JSON `\"code_verifier\"` and ANSI sequences around `Basic` / `code_verifier`.
		const verifier = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
		assert.equal(redactOAuthErrorText(`{\\"code_verifier\\":\\"${verifier}\\"}`).includes(verifier), false);
		assert.equal(
			redactOAuthErrorText(`\x1b[31mBasic\x1b[0m Y2xpZW50OnNlY3JldA==`).includes("Y2xpZW50OnNlY3JldA=="),
			false,
		);
		assert.equal(redactOAuthErrorText(`code_verifier\x1b[0m=${verifier}`).includes(verifier), false);

		// 5. Partial sentinel boundary overlap stays strictly idempotent and preserves `[redacted]`.
		const overlap1 = redactSecretValues("err foo1234 bar", ["foo1234", "ted] bar"]);
		const overlap2 = redactSecretValues(overlap1, ["foo1234", "ted] bar"]);
		assert.equal(overlap1, "err [redacted] bar");
		assert.equal(overlap2, overlap1);

		// 6. Ordinary prose, POSIX/OAuth error codes, and arbitrary WWW-Authenticate challenge params are never erased.
		assert.equal(redactOAuthErrorText("Invalid bearer token format"), "Invalid bearer token format");
		assert.equal(
			redactOAuthErrorText("MCP server requires bearer authentication"),
			"MCP server requires bearer authentication",
		);
		assert.equal(
			redactOAuthErrorText("connect ECONNREFUSED (code=ECONNREFUSED)"),
			"connect ECONNREFUSED (code=ECONNREFUSED)",
		);
		assert.equal(redactOAuthErrorText("spawn node failed: code=ENOENT"), "spawn node failed: code=ENOENT");
		assert.equal(redactOAuthErrorText("OAuth failed code=invalid_grant"), "OAuth failed code=invalid_grant");
		assert.equal(
			redactOAuthErrorText('WWW-Authenticate: Bearer authorization_uri="https://auth.example.com"'),
			'WWW-Authenticate: Bearer authorization_uri="https://auth.example.com"',
		);

		// 7. Non-secret HTTP query params/headers and stdio env vars do not erase normal error diagnostics.
		const normalHttp = new StreamableHttpTransport({
			url: "https://mcp.example.com/mcp?format=json&mode=read",
			openGetStream: false,
			headers: { "X-Env": "staging" },
			fetch: async () => new Response("failed to read json in staging server", { status: 500 }),
		});
		await normalHttp.start();
		const normalHttpErr = await normalHttp
			.send({ jsonrpc: "2.0", id: 1, method: "ping" })
			.catch((error: unknown) => error);
		await normalHttp.close();
		assert.ok(normalHttpErr instanceof McpHttpError);
		assert.equal(normalHttpErr.body, "failed to read json in staging server");

		const scriptDir = createAgentDir();
		const normalStdioScript = join(scriptDir, "normal-stderr.mjs");
		writeFileSync(
			normalStdioScript,
			'process.stderr.write("connection error to localhost:8080\\n"); process.exit(1);\n',
		);
		const normalAgentDir = createAgentDir({
			normal: {
				command: process.execPath,
				args: [normalStdioScript],
				env: { LOG_LEVEL: "error", HOST: "localhost", PORT: "8080" },
			},
		});
		const normalList = await runCli(["list", "--json"], { agentDir: normalAgentDir });
		assert.equal(normalList.exitCode, 1);
		assert.equal(normalList.stdout.includes("connection error to localhost:8080"), true, normalList.stdout);

		// 8. RFC 8707 wire `resource` keeps non-secret query params (`?tenant=acme`) while stripping userinfo; display strips query.
		const { authorizationUrl } = await startAuthorization("https://auth.example.com", {
			clientInformation: { client_id: "cid" },
			redirectUrl: "http://127.0.0.1:9999/callback",
			resource: "https://alice:resPass99@mcp.example.com/mcp?tenant=acme",
		});
		assert.equal(authorizationUrl.searchParams.get("resource"), "https://mcp.example.com/mcp?tenant=acme");
		const displayAuthUrl = redactAuthorizationUrlForDisplay(authorizationUrl);
		assert.equal(displayAuthUrl.includes("resPass99"), false);
		assert.equal(displayAuthUrl.includes("tenant=acme"), false);

		// 9. Long-line password= fallback (8KB line).
		const longPwd = redactOAuthErrorText(`password=myEnvSecret9988 ${"z ".repeat(4000)}`);
		assert.equal(longPwd.includes("myEnvSecret9988"), false);
	});
});
