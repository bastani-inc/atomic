import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage-backends.js";
import { runMcpCommand } from "../../src/extensions/mcp/cli.js";
import { McpHttpError, StdioTransport, StreamableHttpTransport } from "../../src/extensions/mcp/client/index.js";
import { discoverOAuthServerInfo, registerClient } from "../../src/extensions/mcp/client/oauth/index.js";
import {
	redactAuthorizationUrlForDisplay,
	redactOAuthErrorText,
	redactUrlForTransportDisplay,
} from "../../src/extensions/mcp/client/oauth/redact.js";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.js";
import { McpServerConnection } from "../../src/extensions/mcp/runtime.js";

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

describe("mcp secret redaction follow-up gaps", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	function createAgentDir(servers?: Record<string, unknown>): string {
		const agentDir = mkdtempSync(join(tmpdir(), "atomic-mcp-redact-fu-"));
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		if (servers) writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
		return agentDir;
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

	it("clips multi-byte UTF-8 error bodies in UTF-8 byte coordinates and masks unknown JWTs straddling the 8 KiB cap", async () => {
		const utf8Secret = "opaqueUtf8BoundarySecret99887766";
		const jwtHeader = "eyJhbGciOiJIUzI1NiJ9";
		const jwtPayload = "eyJzdWIiOiJ1c2VyMTIzNDUifQ";
		const unknownJwt = `${jwtHeader}.${jwtPayload}.signatureTokenPart9988`;

		const srv = await startCustomServer((req, res, origin) => {
			const u = new URL(req.url ?? "/", origin);
			if (u.pathname === "/utf8") {
				// 2896 * 3 = 8688 UTF-8 bytes + 32-byte secret = 8720 bytes (crosses 8192 + 512 lookahead).
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(
					`${"中".repeat(2896)}${utf8Secret}`,
				);
				return;
			}
			if (u.pathname === "/jwt") {
				// Unknown server-minted JWT straddling byte 8192 (header+payload before 8192, signature after 8192).
				res.writeHead(500, { "content-type": "text/plain" }).end(`${"x".repeat(8171)} ${unknownJwt}`);
				return;
			}
			res.writeHead(404).end();
		});

		const utf8Transport = new StreamableHttpTransport({
			url: `${srv.origin}/utf8`,
			openGetStream: false,
			headers: { Authorization: `Bearer ${utf8Secret}` },
		});
		await utf8Transport.start();
		const utf8Err = await utf8Transport
			.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
			.catch((error: unknown) => error);
		await utf8Transport.close();
		assert.ok(utf8Err instanceof McpHttpError);
		assert.equal(utf8Err.body.includes(utf8Secret.slice(0, 12)), false, utf8Err.body.slice(-40));

		const jwtTransport = new StreamableHttpTransport({
			url: `${srv.origin}/jwt`,
			openGetStream: false,
		});
		await jwtTransport.start();
		const jwtErr = await jwtTransport
			.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
			.catch((error: unknown) => error);
		await jwtTransport.close();
		assert.ok(jwtErr instanceof McpHttpError);
		assert.equal(jwtErr.body.includes(jwtHeader), false, jwtErr.body.slice(-80));
		assert.equal(jwtErr.body.includes(jwtPayload), false, jwtErr.body.slice(-80));
	});

	it("scrubs settings.clientSecret from browser OAuthCallbackServer error redirects and callback HTML", async () => {
		const clientSecret = "opaqueBrowserCbClientSecret9988";
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
				json(res, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
				return;
			}
			if (u.pathname === "/authorize") {
				const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("error", "access_denied");
				redirect.searchParams.set("error_description", `client rejected for ${clientSecret}`);
				redirect.searchParams.set("state", u.searchParams.get("state") ?? "");
				res.writeHead(302, { location: redirect.href }).end();
				return;
			}
			res.writeHead(404).end();
		});

		const agentDir = createAgentDir({ s: { url: srv.url, oauth: { clientId: "cid", clientSecret } } });
		const stderrLines: string[] = [];
		let htmlPromise: Promise<string> | undefined;
		const exitCode = await runMcpCommand(["login", "s", "--timeout", "10"], {
			cwd: agentDir,
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: (authUrl) => {
				htmlPromise = fetch(authUrl, { redirect: "manual" })
					.then((response) => fetch(response.headers.get("location") ?? ""))
					.then((response) => response.text());
			},
			log: () => {},
			error: (line) => stderrLines.push(line),
		});

		const htmlBody = (await htmlPromise) ?? "";
		const stderr = stderrLines.join("\n");
		assert.equal(exitCode, 1);
		assert.equal(stderr.includes(clientSecret), false, stderr);
		assert.equal(htmlBody.includes(clientSecret), false, htmlBody);
	});

	it("retains superseded tokens after 401 rotation for the connection lifetime", async () => {
		const oldAccess = "opaqueOldAccessTok11112222";
		const newAccess = "opaqueNewAccessTok33334444";
		let mcpCalls = 0;
		const srv = await startCustomServer((req, res, origin) => {
			const u = new URL(req.url ?? "/", origin);
			if (u.pathname === "/mcp") {
				mcpCalls++;
				if (mcpCalls === 1) {
					res.writeHead(401, {
						"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
					}).end();
					return;
				}
				res.writeHead(500).end(`audit: superseded ${oldAccess} replaced by ${newAccess}`);
				return;
			}
			if (u.pathname === "/.well-known/oauth-protected-resource/mcp") {
				json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
				return;
			}
			if (u.pathname === "/.well-known/oauth-authorization-server") {
				json(res, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
				return;
			}
			if (u.pathname === "/token") {
				json(res, 200, {
					access_token: newAccess,
					refresh_token: "opaqueNewRefreshTok55556666",
					token_type: "Bearer",
					expires_in: 3600,
				});
				return;
			}
			res.writeHead(404).end();
		});

		const creds = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		await creds.forServer("rot", srv.url).save({
			serverUrl: srv.url,
			clientInformation: { client_id: "cid" },
			tokens: { access_token: oldAccess, refresh_token: "oldRefresh99", token_type: "Bearer" },
			tokensExpireAt: Date.now() + 3_600_000,
		});
		const agentDir = createAgentDir({ rot: { url: srv.url, oauth: { clientId: "cid" } } });
		const out: string[] = [];
		const exitCode = await runMcpCommand(["list", "--json"], {
			cwd: agentDir,
			agentDir,
			credentials: creds,
			log: (line) => out.push(line),
			error: () => {},
		});
		assert.equal(exitCode, 1);
		const errorText = (JSON.parse(out.join("\n")) as { servers: { error?: string }[] }).servers[0]?.error ?? "";
		assert.equal(errorText.includes(oldAccess), false, errorText);
		assert.equal(errorText.includes(newAccess), false, errorText);
	});

	it("scrubs providerToken throws during connected callTool and keeps live transport secrets for refreshTools", async () => {
		const accessTok = "opaqueRefreshToolsTok998877";
		const provSecret = "opaqueProvCallToolSecret9988";
		let listToolsCalls = 0;

		const srv = await startCustomServer(async (req, res) => {
			if (req.method === "GET") {
				res.writeHead(405).end();
				return;
			}
			const msg = JSON.parse(await readBody(req)) as { id?: number; method: string };
			if (msg.id === undefined) {
				res.writeHead(202).end();
				return;
			}
			if (msg.method === "initialize") {
				json(res, 200, {
					jsonrpc: "2.0",
					id: msg.id,
					result: {
						protocolVersion: "2025-11-25",
						capabilities: { tools: {} },
						serverInfo: { name: "rt", version: "1.0" },
					},
				});
				return;
			}
			if (msg.method === "tools/list") {
				listToolsCalls++;
				if (listToolsCalls === 1) {
					json(res, 200, { jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
				} else {
					// Duplicate cursor triggers non-transport McpClient error carrying bare accessTok.
					json(res, 200, { jsonrpc: "2.0", id: msg.id, result: { tools: [], nextCursor: accessTok } });
				}
				return;
			}
			res.writeHead(404).end();
		});

		const creds = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		await creds.forServer("rt", srv.url).save({
			serverUrl: srv.url,
			tokens: { access_token: accessTok, token_type: "Bearer" },
			tokensExpireAt: Date.now() + 3_600_000,
		});

		// R-5a: connected callTool providerToken throw
		let shouldThrow = false;
		const provConn = new McpServerConnection({
			entry: { name: "p", config: { url: srv.url, auth: { provider: "anthropic" } }, source: "mcp.json" },
			cwd: tmpdir(),
			createTransport: async (entry, _cwd, authProvider) =>
				new StreamableHttpTransport({
					url: (entry.config as { url: string }).url,
					authProvider,
					openGetStream: false,
				}),
			credentials: creds,
			providerToken: async () => {
				if (!shouldThrow) return "valid-tok";
				throw new Error(`provider OAuth refresh failed: Authorization: Bearer ${provSecret}`);
			},
			onTools: () => {},
		});
		await provConn.getClient();
		shouldThrow = true;
		const callErr = await provConn.callTool("nonexistent", {}, {}).catch((error: unknown) => error);
		await provConn.close();
		assert.ok(callErr instanceof Error);
		assert.equal(callErr.message.includes(provSecret), false, callErr.message);

		// R-5b: connected HTTP refreshTools has live transport secrets
		listToolsCalls = 0;
		const refreshConn = new McpServerConnection({
			entry: { name: "rt", config: { url: srv.url }, source: "mcp.json" },
			cwd: tmpdir(),
			createTransport: async (entry, _cwd, authProvider) =>
				new StreamableHttpTransport({
					url: (entry.config as { url: string }).url,
					authProvider,
					openGetStream: false,
				}),
			credentials: creds,
			onTools: () => {},
		});
		const client = await refreshConn.getClient();
		(client as unknown as { handleNotification(method: string, params: unknown): void }).handleNotification(
			"notifications/tools/list_changed",
			{},
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		const refreshError = refreshConn.error ?? "";
		await refreshConn.close();
		assert.ok(refreshError.includes("Failed to refresh tools:"), refreshError);
		assert.equal(refreshError.includes(accessTok), false, refreshError);
	});

	it("scrubs camelCase minted token fields, double-encoded !-secrets, Unicode NFC/NFD/uXXXX, and double JSON-escaped secrets", async () => {
		// R-6: camelCase accessToken in /token 400 error_description
		const camelTok = "opaqueCamelMintedTok9988";
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
				json(res, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
				return;
			}
			if (u.pathname === "/authorize") {
				const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("code", "c1");
				redirect.searchParams.set("state", u.searchParams.get("state") ?? "");
				res.writeHead(302, { location: redirect.href }).end();
				return;
			}
			if (u.pathname === "/token") {
				json(res, 400, {
					error: "server_error",
					accessToken: camelTok,
					error_description: `minted ${camelTok} could not be saved`,
				});
				return;
			}
			res.writeHead(404).end();
		});
		const agentDir = createAgentDir({ s: { url: srv.url, oauth: { clientId: "cid" } } });
		const stderrLines: string[] = [];
		await runMcpCommand(["login", "s", "--timeout", "10"], {
			cwd: agentDir,
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: (u) => {
				void fetch(u, { redirect: "manual" }).then((r) => fetch(r.headers.get("location") ?? ""));
			},
			log: () => {},
			error: (line) => stderrLines.push(line),
		});
		assert.equal(stderrLines.join("\n").includes(camelTok), false, stderrLines.join("\n"));

		// R-7: double-encoded !-prefixed client secret
		const bangSec = "!bangClientSecret9988";
		const doubleRfc = "%2521bangClientSecret9988";
		assert.equal(redactOAuthErrorText(`echoed=${doubleRfc}`, [bangSec]).includes(doubleRfc), false);

		// R-8: Unicode NFC/NFD and Python json.dumps \uXXXX escaping
		const nfcSecret = "caf\u00e9Secret9988";
		const nfdEcho = "cafe\u0301Secret9988";
		const pyJsonEcho = "caf\\u00e9Secret9988";
		const pyJsonUpper = "caf\\u00E9Secret9988";
		assert.equal(redactOAuthErrorText(`echoed=${nfdEcho}`, [nfcSecret]).includes(nfdEcho), false);
		assert.equal(redactOAuthErrorText(`echoed=${pyJsonEcho}`, [nfcSecret]).includes(pyJsonEcho), false);
		assert.equal(redactOAuthErrorText(`echoed=${pyJsonUpper}`, [nfcSecret]).includes(pyJsonUpper), false);

		// R-11: double JSON-escaped secret
		const qSec = 'sec"ret\\9988';
		const doubleEsc = JSON.stringify(JSON.stringify(qSec).slice(1, -1)).slice(1, -1);
		assert.equal(
			redactOAuthErrorText(`{"outer":"{\\"raw\\":\\"${doubleEsc}\\"}"}`, [qSec]).includes(doubleEsc),
			false,
		);
	});

	it("scrubs discovery and registerClient fetch rejections and stdio malformed JSON stdout SyntaxError", async () => {
		const discPass = "opaqueDiscFetchPass9988";
		const discCause = "opaqueDiscCausePass7766";

		const discErr = await discoverOAuthServerInfo("https://auth.example.com/mcp", {
			authorizationServerMetadataUrl: new URL(
				`https://alice:${discPass}@auth.example.com/.well-known/oauth-authorization-server`,
			),
			fetch: async () => {
				throw new TypeError(`fetch failed for https://alice:${discPass}@auth.example.com`, {
					cause: new Error(`connect ECONNREFUSED https://alice:${discCause}@auth.example.com`),
				});
			},
		}).catch((error: unknown) => error);
		assert.ok(discErr instanceof TypeError);
		assert.equal(discErr.message.includes(discPass), false, discErr.message);
		assert.equal(String((discErr.cause as Error | undefined)?.message ?? "").includes(discCause), false);

		const regErr = await registerClient("https://auth.example.com", {
			clientMetadata: { redirect_uris: ["http://127.0.0.1:1234/callback"] },
			fetch: async () => {
				throw new TypeError(`fetch failed https://alice:${discPass}@auth.example.com/register`, {
					cause: new Error(`ECONNREFUSED https://alice:${discCause}@auth.example.com/register`),
				});
			},
		}).catch((error: unknown) => error);
		assert.ok(regErr instanceof TypeError);
		assert.equal(regErr.message.includes(discPass), false, regErr.message);
		assert.equal(String((regErr.cause as Error | undefined)?.message ?? "").includes(discCause), false);

		// R-10: StdioTransport malformed JSON stdout SyntaxError never quotes env secret.
		const envSec = "opaqueStdioStdoutLeak9988";
		const dir = createAgentDir();
		const script = join(dir, "badjson.mjs");
		writeFileSync(
			script,
			`process.stdout.write(process.env.MY_API_SECRET + "\\n"); setTimeout(() => process.exit(0), 200);\n`,
		);
		const transport = new StdioTransport({
			command: process.execPath,
			args: [script],
			env: { MY_API_SECRET: envSec },
		});
		const errors: string[] = [];
		transport.onError((error) => errors.push(error.message));
		await transport.start();
		await new Promise((resolve) => setTimeout(resolve, 150));
		await transport.close();
		assert.ok(errors.length > 0, "expected parse error");
		assert.equal(errors.join("\n").includes(envSec), false, errors.join("\n"));
	});

	it("keeps benign display query params via entropy, scrubs authorization URL registered secrets/clientSecret/double-encoded userinfo for display and openUrl, and runs placeholder substitution in linear time", async () => {
		// 1. Benign display params stay visible in describeTransport.
		const envPlaceholder = `$\{TENANT_ID}`;
		const benignUrl = `https://mcp.example.com/mcp?region=us-east-1&tenant=acme-corp&version=2025-11-25&workspace=my_project&org=AcmeCorp&env=${envPlaceholder}`;
		assert.equal(redactUrlForTransportDisplay(benignUrl), benignUrl);
		// Registered secret values or sensitive keys or high-entropy values are omitted.
		assert.equal(
			redactUrlForTransportDisplay("https://mcp.example.com/mcp?region=us-east-1&custom=myRegSecret123", [
				"myRegSecret123",
			]),
			"https://mcp.example.com/mcp?region=us-east-1",
		);
		assert.equal(
			redactUrlForTransportDisplay("https://mcp.example.com/mcp?region=us-east-1&x=opaqueHighEntropy998877"),
			"https://mcp.example.com/mcp?region=us-east-1",
		);

		// 2. redactAuthorizationUrlForDisplay scrubs registered secrets under arbitrary keys, clientSecret/client-secret, and double-encoded nested userinfo.
		const regSecret = "opaqueCustomParamSecret9988";
		const doubleEncUrl =
			"https://auth.example.com/authorize?response_type=code&client_id=cid&clientSecret=cs1&client-secret=cs2" +
			`&custom=${regSecret}&next=https%253A%252F%252Falice%253AdoublePass99%2540evil.example%252Fcb`;
		const scrubbedAuthUrl = redactAuthorizationUrlForDisplay(doubleEncUrl, [regSecret]);
		assert.equal(scrubbedAuthUrl.includes("cs1"), false, scrubbedAuthUrl);
		assert.equal(scrubbedAuthUrl.includes("cs2"), false, scrubbedAuthUrl);
		assert.equal(scrubbedAuthUrl.includes(regSecret), false, scrubbedAuthUrl);
		assert.equal(scrubbedAuthUrl.includes("doublePass99"), false, scrubbedAuthUrl);
		assert.equal(scrubbedAuthUrl.includes("client_id=cid"), true, scrubbedAuthUrl);

		// openUrl receives the scrubbed URL when an authorization endpoint carries a registered clientSecret in a query param.
		const clientSecret = "opaqueOpenUrlQuerySecret9988";
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
				json(res, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize?leak=${clientSecret}&client-secret=extraSec99`,
					token_endpoint: `${origin}/token`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
				});
				return;
			}
			if (u.pathname === "/authorize") {
				const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("error", "access_denied");
				redirect.searchParams.set("state", u.searchParams.get("state") ?? "");
				res.writeHead(302, { location: redirect.href }).end();
				return;
			}
			res.writeHead(404).end();
		});
		const agentDir = createAgentDir({ s: { url: srv.url, oauth: { clientId: "cid", clientSecret } } });
		let openedUrl = "";
		await runMcpCommand(["login", "s", "--timeout", "10"], {
			cwd: agentDir,
			agentDir,
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			openUrl: (u) => {
				openedUrl = u;
				void fetch(u, { redirect: "manual" }).then((r) => fetch(r.headers.get("location") ?? ""));
			},
			log: () => {},
			error: () => {},
		});
		assert.ok(openedUrl.length > 0);
		assert.equal(openedUrl.includes(clientSecret), false, openedUrl);
		assert.equal(openedUrl.includes("extraSec99"), false, openedUrl);

		// 3. Crafted sequential placeholder prefixes do not cause quadratic scan in redactOAuthErrorText.
		const crafted = `${Array.from({ length: 2_000 }, (_, i) => `ATOMICPRX${i}P`).join(" ")} Invalid bearer token format`;
		const out = redactOAuthErrorText(crafted);
		assert.equal(out, crafted);
	});
});
