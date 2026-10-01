import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { OAuthIssuerMismatchError } from "../../src/extensions/mcp/client/oauth/index.js";
import {
	createMcpAuthProvider,
	McpOAuthCredentialStore,
	type McpOAuthSettings,
	signInMcpServer,
} from "../../src/extensions/mcp/oauth.ts";
import { startOAuthMcpServer } from "./native-oauth-server.js";

describe("MCP OAuth refresh", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function signedIn() {
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const lockDir = mkdtempSync(join(tmpdir(), "pi-mcp-refresh-"));
		cleanups.push(() => rmSync(lockDir, { recursive: true, force: true }));
		// Stores sharing the credential file and lock directory stand in for separate pi processes.
		const backend = new InMemoryAuthStorageBackend();
		const process = () => {
			const store = new McpOAuthCredentialStore(backend, lockDir).forServer(server.url);
			const provider = createMcpAuthProvider({
				serverUrl: server.url,
				store,
				settings: () => ({}),
				onChallenge: () => {},
			});
			return { store, provider };
		};
		await signInMcpServer({
			serverUrl: server.url,
			store: process().store,
			settings: {},
			prompt: {
				showAuthorizationUrl: (url) => void fetch(url),
				promptForRedirectUrl: (signal) =>
					new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
			},
		});
		return { server, lockDir, process };
	}

	it("refreshes once when several processes find the same token rejected", async () => {
		const { server, lockDir, process } = await signedIn();
		server.expireAccessTokens();
		const processes = [process(), process(), process()];

		// The server rotates refresh tokens: a second refresh with refresh-1 would fail with invalid_grant.
		await Promise.all(
			processes.map(({ provider }) =>
				provider.onUnauthorized?.({
					response: new Response(null, { status: 401 }),
					serverUrl: new URL(server.url),
					fetch: globalThis.fetch,
					token: "access-1",
				}),
			),
		);

		expect(server.log.filter((entry) => entry === "token refresh")).toHaveLength(1);
		for (const { provider } of processes) expect(await provider.token()).toBe("access-2");
		// The lock is released.
		expect(readdirSync(lockDir)).toEqual([]);
	});

	it("waits for a running refresh to save the new tokens", async () => {
		const { server, process } = await signedIn();
		server.expireAccessTokens();
		const { store, provider } = process();

		const refresh = provider.onUnauthorized?.({
			response: new Response(null, { status: 401 }),
			serverUrl: new URL(server.url),
			fetch: globalThis.fetch,
			token: "access-1",
		});
		await provider.settled();
		expect((await store.load())?.tokens?.access_token).toBe("access-2");
		await refresh;
	});
});

describe("MCP OAuth sign-in", () => {
	async function signIn(options: { iss?: string }, settings: (serverUrl: string) => McpOAuthSettings = () => ({})) {
		const server = await startOAuthMcpServer(options);
		try {
			await signInMcpServer({
				serverUrl: server.url,
				store: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()).forServer(server.url),
				settings: settings(server.url),
				prompt: {
					showAuthorizationUrl: (url) => void fetch(url),
					promptForRedirectUrl: (signal) =>
						new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
				},
			});
		} finally {
			await server.close();
		}
	}

	it("rejects an authorization response from another issuer", async () => {
		await expect(signIn({ iss: "https://attacker.example" })).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
	});

	// #10172
	it("uses the configured authorization server metadata URL", async () => {
		const settings = (serverUrl: string) => ({ authServerMetadataUrl: new URL("/missing", serverUrl) });
		await expect(signIn({}, settings)).rejects.toThrow("HTTP 404 loading authorization server metadata");
	});
});
