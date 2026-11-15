import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { makeTempDirectory, removeTempDirectory } from "../../../test/helpers/runtime.ts";
import { anthropicOAuth } from "../../ai/src/auth/oauth/anthropic.ts";
import { githubCopilotOAuth } from "../../ai/src/auth/oauth/github-copilot.ts";
import { kimiCodingOAuth } from "../../ai/src/auth/oauth/kimi-coding.ts";
import { metaOAuth } from "../../ai/src/auth/oauth/meta.ts";
import { openaiChatGPTOAuth } from "../../ai/src/auth/oauth/openai-chatgpt.ts";
import { openaiCodexOAuth } from "../../ai/src/auth/oauth/openai-codex.ts";
import { createRadiusOAuth } from "../../ai/src/auth/oauth/radius.ts";
import { xaiOAuth } from "../../ai/src/auth/oauth/xai.ts";
import { refreshStoredOAuthCredential } from "../../ai/src/auth/resolve.ts";
import type { OAuthAuth, OAuthCredential } from "../../ai/src/auth/types.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "../src/core/auth-storage.ts";

/** The only refresh token the fake servers ever issue; they never rotate it. */
const R0 = "fake-refresh-R0";

/** A JWT the OpenAI Codex flow can read its account ID from, expiring two hours after `nowMs`. */
function codexAccessToken(nowMs: number): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const payload = {
		exp: Math.floor(nowMs / 1000) + 2 * 60 * 60,
		"https://api.openai.com/auth": { chatgpt_account_id: "fake-account" },
	};
	return `${encode({ alg: "none" })}.${encode(payload)}.fake-signature`;
}

type Row = {
	providerId: string;
	oauth: (origin: string) => OAuthAuth;
	stored?: Partial<OAuthCredential>;
	/** A token response without `refresh_token` and without `expires_in`. */
	response: () => Record<string, string | number>;
};

/** Every built-in OAuth provider whose refresh exchanges a stored token. OpenRouter stores an API key and never refreshes. */
const rows: Row[] = [
	{ providerId: "anthropic", oauth: () => anthropicOAuth, response: () => ({ access_token: "fake-access" }) },
	{
		providerId: "openai-codex",
		oauth: () => openaiCodexOAuth,
		response: () => ({ access_token: codexAccessToken(Date.now()) }),
	},
	{
		providerId: "openai-chatgpt",
		oauth: () => openaiChatGPTOAuth,
		stored: { clientId: "fake-client-id" },
		response: () => ({ access_token: "fake-access", scope: "openid offline_access chatgpt.tokens.use.direct" }),
	},
	{ providerId: "xai", oauth: () => xaiOAuth, response: () => ({ access_token: "fake-access" }) },
	{ providerId: "kimi-coding", oauth: () => kimiCodingOAuth, response: () => ({ access_token: "fake-access" }) },
	{
		providerId: "radius",
		oauth: (origin) => createRadiusOAuth({ name: "Radius", gateway: origin }),
		response: () => ({ access_token: "fake-access" }),
	},
	{
		providerId: "github-copilot",
		oauth: () => githubCopilotOAuth,
		// The Copilot token exchange reports `expires_at`, never `expires_in`, and keeps the GitHub token by design.
		response: () => ({ token: "fake-copilot-token", expires_at: Math.floor(Date.now() / 1000) + 30 * 60 }),
	},
	// Meta mints an API key with its identity token, which it never reissues.
	{ providerId: "meta", oauth: () => metaOAuth, response: () => ({ api_key: "fake-api-key" }) },
];

/** The refresh token a request presents, in whichever form its provider sends it. */
function presentedRefreshToken(request: IncomingMessage, body: string): string | null {
	const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
	if (bearer) return bearer;
	if (request.headers["content-type"]?.includes("application/json")) {
		const token = (JSON.parse(body) as { refresh_token?: unknown }).refresh_token;
		return typeof token === "string" ? token : null;
	}
	return new URLSearchParams(body).get("refresh_token");
}

let server: Server;
let origin: string;
let respond: () => Record<string, string | number>;
const presented: Array<string | null> = [];

beforeAll(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			response.setHeader("content-type", "application/json");
			// GitHub Copilot reads the account's model list with the new Copilot token after its token exchange.
			if (request.url === "/models") {
				response.end(JSON.stringify({ data: [] }));
				return;
			}
			const token = presentedRefreshToken(request, body);
			presented.push(token);
			if (token !== R0) {
				response.statusCode = 400;
				response.end(JSON.stringify({ error: "invalid_grant" }));
				return;
			}
			response.end(JSON.stringify(respond()));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
	vi.unstubAllGlobals();
	presented.length = 0;
});

/** Send every provider request, whatever its production host, to the local server. */
function routeFetchToLocalServer(): void {
	const realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		return realFetch(`${origin}${url.pathname}${url.search}`, init);
	});
}

describe("OAuth refresh against a server that does not rotate refresh tokens", () => {
	for (const row of rows) {
		it(`keeps the refresh token and a finite expiry for ${row.providerId} (#4959)`, async () => {
			const directory = makeTempDirectory("oauth-non-rotating-");
			try {
				const authPath = `${directory}/auth.json`;
				respond = row.response;
				routeFetchToLocalServer();
				const oauth = row.oauth(origin);
				await AuthStorage.create(authPath).modify(row.providerId, async () => ({
					type: "oauth",
					access: "expired-access",
					refresh: R0,
					expires: 0,
					...row.stored,
				}));

				for (let refresh = 1; refresh <= 2; refresh++) {
					const before = Date.now();
					await refreshStoredOAuthCredential(
						AuthStorage.create(authPath),
						row.providerId,
						oauth,
						() => true,
						AbortSignal.timeout(10_000),
					);
					// ReadOnlyAuthStorage validates every auth.json credential and throws on a malformed one.
					const stored = await new ReadOnlyAuthStorage(authPath).read(row.providerId);
					assert.equal(stored?.type, "oauth");
					assert.equal(stored.type === "oauth" ? stored.refresh : undefined, R0);
					const expires = stored.type === "oauth" ? stored.expires : Number.NaN;
					assert.ok(Number.isFinite(expires) && expires > before, `refresh ${refresh} stored expires=${expires}`);
				}
				assert.deepEqual(presented, [R0, R0]);
			} finally {
				removeTempDirectory(directory);
			}
		});
	}
});
