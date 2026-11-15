import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { type McpFetch, StreamableHttpTransport } from "../../src/extensions/mcp/client/index.js";
import type { McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { McpOAuthCredentialStore, type McpOAuthServerStore, signInMcpServer } from "../../src/extensions/mcp/oauth.ts";
import { McpServerConnection, type McpTransportFactory } from "../../src/extensions/mcp/runtime.ts";
import { createHarness } from "../suite/harness.ts";
import { type RefreshFailure, startOAuthMcpServer } from "./native-oauth-server.js";
import { createTestUiContext } from "./native-test-ui.js";

/**
 * Token requests give up after this long, standing in for the 15 s limit of real refreshes. Long
 * enough that a loaded machine still answers a healthy refresh in time.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 1_000;

/** The transport's fetch, with token requests limited to `TOKEN_REQUEST_TIMEOUT_MS`. */
const transportWithTokenTimeout: McpTransportFactory = (entry, _cwd, authProvider) => {
	if (!("url" in entry.config)) throw new Error("expected an HTTP server");
	const timedTokenFetch: McpFetch = (input, init) => {
		if (new URL(String(input)).pathname !== "/token") return fetch(input, init);
		const timeout = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
	return new StreamableHttpTransport({ url: entry.config.url, authProvider, fetch: timedTokenFetch });
};

const failures: RefreshFailure[] = ["503", "network error", "stall"];

describe("MCP OAuth refresh against a temporarily unavailable token endpoint", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	/** Signed in to a server that has since expired the access token; the refresh token is still valid. */
	async function signedInWithExpiredToken() {
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const backend = new InMemoryAuthStorageBackend();
		const credentials = new McpOAuthCredentialStore(backend);
		const store = credentials.forServer("issues", server.url);
		await signInMcpServer({
			serverUrl: server.url,
			store,
			settings: {},
			prompt: {
				showAuthorizationUrl: (url) => void fetch(url),
				promptForRedirectUrl: (signal) =>
					new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
			},
		});
		server.expireAccessTokens();
		const stored = await store.load();
		assert.ok(stored?.tokens?.refresh_token);
		return { server, backend, credentials, store, stored };
	}

	function connect(server: { url: string }, credentials: McpOAuthCredentialStore) {
		const connection = new McpServerConnection({
			entry: { name: "issues", config: { url: server.url }, source: "test" },
			cwd: process.cwd(),
			createTransport: transportWithTokenTimeout,
			credentials,
			onTools: () => {},
		});
		cleanups.push(() => connection.close());
		return connection;
	}

	/** The stored grant and pending PKCE state, which a failed refresh must leave as they were. */
	async function grant(store: McpOAuthServerStore) {
		const state = await store.load();
		return {
			refreshToken: state?.tokens?.refresh_token,
			codeVerifier: state?.codeVerifier,
			oauthState: state?.oauthState,
		};
	}

	for (const failure of failures) {
		it(`connects without sign-in when one refresh fails with ${failure} (#4910)`, async () => {
			const { server, credentials, store, stored } = await signedInWithExpiredToken();
			server.failRefreshes(failure, 1);
			const connection = connect(server, credentials);

			await connection.getClient();

			assert.equal(connection.state, "connected");
			assert.deepEqual(
				connection.tools.map((tool) => tool.name),
				["whoami"],
			);
			assert.deepEqual(
				server.log.filter((entry) => entry.startsWith("token")),
				["token code", `token refresh ${failure}`, "token refresh"],
			);
			const after = await store.load();
			assert.equal(after?.codeVerifier, stored.codeVerifier);
			assert.equal(after?.oauthState, stored.oauthState);
		});

		it(`reports ${failure} during a refresh as temporary, keeps the grant, and connects on retry (#4910)`, async () => {
			const { server, credentials, store } = await signedInWithExpiredToken();
			const before = await grant(store);
			server.failRefreshes(failure);
			const connection = connect(server, credentials);

			await assert.rejects(connection.getClient(), /failed to connect: .*temporarily unavailable/);

			assert.equal(connection.state, "failed");
			assert.match(connection.error ?? "", /temporarily unavailable/);
			// The connection was retried before giving up.
			assert.ok(server.log.filter((entry) => entry === `token refresh ${failure}`).length > 1);
			assert.deepEqual(await grant(store), before);

			server.failRefreshes(failure, 0);
			await connection.getClient();
			assert.equal(connection.state, "connected");
			assert.equal(server.log.at(-1), "token refresh");
		});
	}

	it("still asks for sign-in when the authorization server rejects the refresh token (#4910)", async () => {
		const { server, credentials } = await signedInWithExpiredToken();
		server.revokeRefreshTokens();
		const connection = connect(server, credentials);

		await assert.rejects(connection.getClient(), /MCP server "issues" requires sign-in/);

		assert.equal(connection.state, "needs-auth");
	});

	it("names the temporary outage instead of a sign-in in the startup notice (#4910)", async () => {
		const { server, backend } = await signedInWithExpiredToken();
		server.failRefreshes("503");
		const entry: McpServerEntry = { name: "issues", config: { url: server.url }, source: "test" };
		const notifications: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [] }),
					credentials: new McpOAuthCredentialStore(backend),
				}),
			],
		});
		cleanups.push(() => harness.cleanup());
		await harness.session.bindExtensions({
			mode: "print",
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});

		await vi.waitFor(
			() => assert.ok(notifications.some((message) => message.startsWith("MCP servers need attention"))),
			{
				timeout: 10_000,
			},
		);
		const notice = notifications.find((message) => message.startsWith("MCP servers need attention")) ?? "";
		assert.match(notice, /issues: failed: .*temporarily unavailable/);
		assert.doesNotMatch(notice, /sign-in/);
	});
});
