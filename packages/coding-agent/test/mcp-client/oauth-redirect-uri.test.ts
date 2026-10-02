import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.js";
import { OAuthCallbackServer } from "../../src/extensions/mcp/client/oauth/index.js";
import { McpOAuthCredentialStore, signInMcpServer } from "../../src/extensions/mcp/oauth.js";
import { startOAuthMcpServer } from "./native-oauth-server.js";

test("rejects an authorization response on another callback path (#10302)", async () => {
	const callback = await OAuthCallbackServer.listen({ extraPaths: ["/callback/server-id"] });
	try {
		const origin = new URL(callback.redirectUrl).origin;
		const mixedUp = callback.waitForCallback("s1", "/callback/server-id");
		const rejected = assert.rejects(mixedUp, /arrived on another redirect URI/);
		const wrong = await fetch(`${origin}/callback?code=abc&state=s1`);
		await rejected;
		assert.equal(wrong.status, 400);
		const pending = callback.waitForCallback("s2", "/callback/server-id");
		const right = await fetch(`${origin}/callback/server-id?code=abc&state=s2`);
		assert.equal(right.status, 200);
		assert.equal((await pending).code, "abc");
	} finally {
		await callback.close();
	}
});

test.each(["path", "origin"])(
	"rejects a pasted redirect with the wrong %s before exchanging its code (#10302)",
	async (mismatch) => {
		const server = await startOAuthMcpServer();
		try {
			let shown: URL | undefined;
			await assert.rejects(
				signInMcpServer({
					serverUrl: server.url,
					store: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()).forServer("test", server.url),
					settings: {},
					prompt: {
						showAuthorizationUrl: (url) => {
							shown = url;
						},
						promptForRedirectUrl: async () => {
							assert.ok(shown);
							const redirect = new URL(shown.searchParams.get("redirect_uri")!);
							if (mismatch === "path") redirect.pathname = "/another-callback";
							else redirect.hostname = "other.example";
							redirect.searchParams.set("code", "wrong-code");
							redirect.searchParams.set("state", shown.searchParams.get("state")!);
							return redirect.href;
						},
					},
				}),
				/does not match this sign-in's redirect URI/,
			);
			assert.ok(!server.log.some((entry) => entry.startsWith("token")));
		} finally {
			await server.close();
		}
	},
);
