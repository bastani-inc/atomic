import assert from "node:assert/strict";
import { createServer } from "node:net";
import { afterEach, test, vi } from "vitest";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import type { ProviderAuthInteraction } from "../src/auth/types.ts";

const DEVICE_ID = "e61bbe28-07ef-466d-8e5d-a344f94ab305";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const token = { access_token: "access", refresh_token: "refresh", expires_in: 3600, id_token: "id", scope: SCOPE };
afterEach(() => vi.unstubAllGlobals());

function interaction(clientId: string | undefined, inspect?: (url: URL) => void): ProviderAuthInteraction {
	let authorize: URL;
	return {
		signal: new AbortController().signal,
		notify: (event) => {
			if (event.type === "auth_url") {
				authorize = new URL(event.url);
				inspect?.(authorize);
			}
		},
		prompt: async () => {
			const callback = new URL(authorize.searchParams.get("redirect_uri")!);
			callback.searchParams.set("code", "code");
			callback.searchParams.set("state", authorize.searchParams.get("state")!);
			if (clientId) callback.searchParams.set("client_id", clientId);
			return callback.href;
		},
	};
}

test("ChatGPT registers Atomic and persists the issued client and direct-use scope", async () => {
	let body: URLSearchParams | undefined;
	vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
		assert.equal(String(url), "https://auth.openai.com/api/accounts/oauth/token");
		body = new URLSearchParams(String(init?.body));
		return Response.json(token);
	});
	const credential = await openaiChatGPTOAuth.login(
		interaction("oaiapp_issued", (url) => {
			assert.equal(url.searchParams.get("agent_name_hint"), "Atomic");
			assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
			assert.equal(url.searchParams.get("ext_agent_host_id"), `urn:uuid:${DEVICE_ID}`);
			assert.equal(url.searchParams.get("scope"), SCOPE);
			assert.equal(url.searchParams.get("code_challenge_method"), "S256");
		}),
		{ getDeviceId: () => DEVICE_ID },
	);
	assert.equal(body?.get("client_id"), "oaiapp_issued");
	assert.equal(body?.get("resource"), "https://api.openai.com/v1");
	assert.ok(body?.get("code_verifier"));
	assert.equal(credential.clientId, "oaiapp_issued");
	assert.deepEqual(credential.scopes, SCOPE.split(" "));
});

test("ChatGPT requires the issued client ID before exchanging credentials", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await assert.rejects(
		openaiChatGPTOAuth.login(interaction(undefined), { getDeviceId: () => DEVICE_ID }),
		/issued client ID/,
	);
	assert.equal(fetch.mock.calls.length, 0);
});

test("ChatGPT login fails before opening the browser when the callback port is taken", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const holder = createServer();
	const held = await new Promise<boolean>((resolve, reject) => {
		holder.once("error", (error: NodeJS.ErrnoException) =>
			error.code === "EADDRINUSE" ? resolve(false) : reject(error),
		);
		holder.listen(1455, "127.0.0.1", () => resolve(true));
	});
	const events: string[] = [];
	const login = openaiChatGPTOAuth.login(
		{
			signal: new AbortController().signal,
			notify: (event) => events.push(event.type),
			prompt: async () => {
				events.push("prompt");
				throw new Error("login must not prompt for a pasted redirect URL");
			},
		},
		{ getDeviceId: () => DEVICE_ID },
	);
	try {
		await assert.rejects(login, /Port 1455 is in use/);
	} finally {
		if (held) await new Promise((resolve) => holder.close(resolve));
	}
	assert.deepEqual(events, []);
	assert.equal(fetch.mock.calls.length, 0);
});

test("ChatGPT refuses missing direct-use scope", async () => {
	vi.stubGlobal("fetch", async () => Response.json({ ...token, scope: "openid profile" }));
	await assert.rejects(
		openaiChatGPTOAuth.login(interaction("client"), { getDeviceId: () => DEVICE_ID }),
		/grant did not include/,
	);
});

test("ChatGPT requires a stable installation UUID before authorization", async () => {
	await assert.rejects(openaiChatGPTOAuth.login(interaction("client")), /requires a device ID/);
	await assert.rejects(
		openaiChatGPTOAuth.login(interaction("client"), { getDeviceId: () => "invalid" }),
		/requires a device ID/,
	);
});

test("ChatGPT refresh uses the issued client ID and requires token rotation", async () => {
	const credential = { type: "oauth" as const, access: "old", refresh: "old-refresh", expires: 0, clientId: "issued" };
	let body: URLSearchParams | undefined;
	vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
		body = new URLSearchParams(String(init?.body));
		return Response.json(token);
	});
	const result = await openaiChatGPTOAuth.refresh(credential, new AbortController().signal);
	assert.equal(body?.get("client_id"), "issued");
	assert.equal(body?.get("refresh_token"), "old-refresh");
	assert.equal(result.refresh, "refresh");
	assert.equal(result.clientId, "issued");
	vi.stubGlobal("fetch", async () => Response.json({ ...token, refresh_token: undefined }));
	await assert.rejects(openaiChatGPTOAuth.refresh(credential, new AbortController().signal), /invalid refresh_token/);
});
