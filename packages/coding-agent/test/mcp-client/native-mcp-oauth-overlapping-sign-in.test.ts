import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { FileAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { McpOAuthCredentialStore, signInMcpServer } from "../../src/extensions/mcp/oauth.ts";
import { startOAuthMcpServer } from "./native-oauth-server.js";

describe("overlapping MCP OAuth sign-ins", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	/** Two sessions signing in to one server, each with its own credential store on the same file. */
	async function twoSessions() {
		const server = await startOAuthMcpServer();
		cleanups.push(server.close);
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-overlap-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, "mcp-auth.json");
		const credentials = () => new McpOAuthCredentialStore(new FileAuthStorageBackend(path), dir);

		/** Start a sign-in and wait until it shows its authorization URL, which the user has not approved yet. */
		const startSignIn = async () => {
			let shown: URL | undefined;
			const done = signInMcpServer({
				serverUrl: server.url,
				store: credentials().forServer("issues", server.url),
				settings: {},
				prompt: {
					showAuthorizationUrl: (url) => {
						shown = url;
					},
					promptForRedirectUrl: (signal) =>
						new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
				},
			});
			const outcome = done.then(
				() => "signed in",
				(error: Error) => error,
			);
			await vi.waitFor(() => assert.ok(shown));
			const url = shown as URL;
			return {
				outcome,
				// The browser follows the authorization server's redirect to this sign-in's loopback callback.
				approve: async () => {
					await fetch(url);
					return outcome;
				},
			};
		};
		return { server, startSignIn, storedTokens: () => credentials().tokens("issues", server.url) };
	}

	for (const approvedFirst of [0, 1]) {
		const which = approvedFirst === 0 ? "first" : "second";
		it(`both complete without losing tokens when the ${which} sign-in is approved first (#4916)`, async () => {
			const { server, startSignIn, storedTokens } = await twoSessions();
			const signIns = [await startSignIn(), await startSignIn()];
			const order = approvedFirst === 0 ? signIns : [...signIns].reverse();

			assert.equal(await order[0].approve(), "signed in");
			assert.equal(storedTokens()?.access_token, "access-1");
			assert.equal(await order[1].approve(), "signed in");

			// Each code was exchanged with its own sign-in's PKCE verifier, and the latest tokens are kept.
			assert.deepEqual(
				server.log.filter((entry) => entry.startsWith("token")),
				["token code", "token code"],
			);
			assert.equal(storedTokens()?.access_token, "access-2");
			assert.equal(storedTokens()?.refresh_token, "refresh-2");
		});
	}
});
