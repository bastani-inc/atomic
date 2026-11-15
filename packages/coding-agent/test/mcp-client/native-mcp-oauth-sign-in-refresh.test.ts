import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { FileAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { createMcpAuthProvider, McpOAuthCredentialStore, signInMcpServer } from "../../src/extensions/mcp/oauth.ts";
import { startOAuthMcpServer } from "./native-oauth-server.js";

/** Long enough that the connection refresh and the sign-in overlap at the token endpoint. */
const REFRESH_DELAY_MS = 200;

describe("an MCP sign-in that overlaps a connection's token refresh", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	for (const revokeOnReplay of [false, true]) {
		const server = revokeOnReplay ? "a server that revokes replayed grants" : "a server that rotates refresh tokens";
		it(`refreshes once and keeps the new tokens with ${server} (#5019)`, async () => {
			const oauth = await startOAuthMcpServer({ refreshDelayMs: REFRESH_DELAY_MS, revokeOnReplay });
			cleanups.push(oauth.close);
			const dir = mkdtempSync(join(tmpdir(), "pi-mcp-sign-in-refresh-"));
			cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
			const path = join(dir, "mcp-auth.json");
			// The connection and the sign-in run in different sessions, each with its own store on the same file.
			const credentials = () => new McpOAuthCredentialStore(new FileAuthStorageBackend(path), dir);
			const store = () => credentials().forServer("issues", oauth.url);
			const prompt = {
				promptForRedirectUrl: (signal: AbortSignal) =>
					new Promise<undefined>((resolve) =>
						signal.addEventListener("abort", () => resolve(undefined), { once: true }),
					),
			};
			await signInMcpServer({
				serverUrl: oauth.url,
				store: store(),
				settings: {},
				prompt: { ...prompt, showAuthorizationUrl: (url) => void fetch(url) },
			});
			assert.equal(credentials().tokens("issues", oauth.url)?.refresh_token, "refresh-1");
			oauth.expireAccessTokens();

			const provider = createMcpAuthProvider({
				serverUrl: oauth.url,
				store: store(),
				settings: () => ({}),
				onChallenge: () => {},
			});
			const unauthorized = new Response(null, {
				status: 401,
				headers: {
					"www-authenticate": `Bearer resource_metadata="${new URL(oauth.url).origin}/.well-known/oauth-protected-resource/mcp"`,
				},
			});
			const connectionRefresh = provider.onUnauthorized?.({
				response: unauthorized,
				serverUrl: new URL(oauth.url),
				fetch: globalThis.fetch,
				token: "access-1",
			});
			const signIn = signInMcpServer({
				serverUrl: oauth.url,
				store: store(),
				settings: {},
				prompt: {
					...prompt,
					showAuthorizationUrl: () => {
						throw new Error("the sign-in fell back to the browser");
					},
				},
			});

			await Promise.all([connectionRefresh, signIn]);
			assert.deepEqual(oauth.refreshGrants, ["refresh-1"]);
			assert.equal(credentials().tokens("issues", oauth.url)?.refresh_token, "refresh-2");
			assert.ok(oauth.refreshTokens.has("refresh-2"));
		});
	}
});
