import { describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../src/core/auth-storage.ts";
import { McpOAuthCredentialStore } from "../../src/extensions/mcp/oauth.ts";

const SERVER_URL = "https://mcp.example.com/mcp";

function state(accessToken: string) {
	return { serverUrl: SERVER_URL, tokens: { access_token: accessToken, token_type: "Bearer" } };
}

function storedKeys(backend: InMemoryAuthStorageBackend): string[] {
	return Object.keys(JSON.parse(backend.withLock((current) => ({ result: current ?? "{}" }))));
}

function seedLegacy(backend: InMemoryAuthStorageBackend, legacy: object): void {
	backend.withLock(() => ({ result: undefined, next: JSON.stringify({ [SERVER_URL]: legacy }) }));
}

describe("MCP OAuth credential store", () => {
	// https://github.com/earendil-works/pi/issues/10252
	it("keeps separate credentials for servers sharing a URL", async () => {
		const store = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		await store.forServer("work", SERVER_URL).save(state("work-token"));
		await store.forServer("personal", SERVER_URL).save(state("personal-token"));

		expect((await store.forServer("work", SERVER_URL).load())?.tokens?.access_token).toBe("work-token");
		expect((await store.forServer("personal", SERVER_URL).load())?.tokens?.access_token).toBe("personal-token");

		expect(store.remove("work", SERVER_URL)).toBe(true);
		expect(await store.forServer("work", SERVER_URL).load()).toBeUndefined();
		expect(store.tokens("personal", SERVER_URL)?.access_token).toBe("personal-token");
	});

	it("moves credentials stored by URL to the first server that loads them", async () => {
		const backend = new InMemoryAuthStorageBackend();
		seedLegacy(backend, state("legacy-token"));
		const store = new McpOAuthCredentialStore(backend);

		expect(store.tokens("work", SERVER_URL)?.access_token).toBe("legacy-token");
		expect(storedKeys(backend)).toEqual([SERVER_URL]);

		expect((await store.forServer("my_work", SERVER_URL).load())?.tokens?.access_token).toBe("legacy-token");
		expect(store.tokens("my-work", SERVER_URL)?.access_token).toBe("legacy-token");
		expect(await store.forServer("personal", SERVER_URL).load()).toBeUndefined();
		expect(storedKeys(backend)).toEqual([`mcp__my_work|${SERVER_URL}`]);
	});

	it("lets a sign-in started before the takeover keep using the legacy credentials", async () => {
		const backend = new InMemoryAuthStorageBackend();
		seedLegacy(backend, { ...state("legacy-token"), credentialGeneration: "generation-1" });
		const flow = new McpOAuthCredentialStore(backend).forServer("work", SERVER_URL).fenced();

		expect((await flow.load())?.tokens?.access_token).toBe("legacy-token");
		await flow.save(state("renewed-token"));
		expect((await flow.load())?.tokens?.access_token).toBe("renewed-token");
	});

	it("signs out of credentials stored by URL", () => {
		const backend = new InMemoryAuthStorageBackend();
		seedLegacy(backend, state("legacy-token"));
		const store = new McpOAuthCredentialStore(backend);

		expect(store.remove("work", SERVER_URL)).toBe(true);
		expect(storedKeys(backend)).toEqual([`mcp__work|${SERVER_URL}`]);
		expect(store.tokens("work", SERVER_URL)).toBeUndefined();
		expect(store.remove("work", SERVER_URL)).toBe(false);
	});

	it("does not cancel a sign-in of one server when another server with the same URL signs out", async () => {
		const store = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		await store.forServer("work", SERVER_URL).save(state("work-token"));
		await store.forServer("personal", SERVER_URL).save(state("personal-token"));
		const personalFlow = store.forServer("personal", SERVER_URL).fenced();

		store.remove("work", SERVER_URL);

		expect((await personalFlow.load())?.tokens?.access_token).toBe("personal-token");
	});
});
