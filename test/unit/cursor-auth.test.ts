import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	CursorAuthError,
	CursorAuthService,
	CursorToken,
	createPkcePair,
	deriveCursorTokenExpiry,
	toOAuthCredentials,
	type CursorFetch,
	type CursorRandomBytes,
} from "../../packages/cursor/src/auth.js";

function jwtWithExp(exp: number): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
	return `${header}.${payload}.signature`;
}

const deterministicRandom: CursorRandomBytes = (length: number) => new Uint8Array(length).fill(7);

function loginCallbacks(openedUrls: string[]): OAuthLoginCallbacks {
	return {
		onAuth: (info) => openedUrls.push(info.url),
		onDeviceCode: () => {},
		onPrompt: async () => "",
		onSelect: async () => undefined,
	};
}

describe("CursorAuthService", () => {
	test("runs Cursor PKCE login polling and returns persist-compatible OAuth credentials", async () => {
		const openedUrls: string[] = [];
		const sleeps: number[] = [];
		const token = jwtWithExp(2_000);
		const responses = [
			new Response("pending", { status: 404 }),
			new Response(JSON.stringify({ accessToken: token, refreshToken: "refresh-secret" }), { status: 200 }),
		];
		const requestedUrls: string[] = [];
		const fakeFetch: CursorFetch = async (url) => {
			requestedUrls.push(url);
			return responses.shift() ?? new Response("missing", { status: 500 });
		};
		const service = new CursorAuthService({
			fetch: fakeFetch,
			randomBytes: deterministicRandom,
			uuid: () => "uuid-1",
			now: () => 1_000,
			sleep: async (milliseconds) => {
				sleeps.push(milliseconds);
			},
			initialPollDelayMs: 10,
		});

		const credentials = await service.login(loginCallbacks(openedUrls));
		const expectedPkce = createPkcePair(deterministicRandom);
		const loginUrl = new URL(openedUrls[0] ?? "");
		assert.equal(loginUrl.hostname, "cursor.com");
		assert.equal(loginUrl.pathname, "/loginDeepControl");
		assert.equal(loginUrl.searchParams.get("challenge"), expectedPkce.challenge);
		assert.equal(loginUrl.searchParams.get("uuid"), "uuid-1");
		assert.equal(loginUrl.searchParams.get("mode"), "login");
		assert.equal(loginUrl.searchParams.get("redirectTarget"), "cli");
		assert.equal(new URL(requestedUrls[0] ?? "").pathname, "/auth/poll");
		assert.deepEqual(sleeps, [10]);
		assert.equal(credentials.access, token);
		assert.equal(credentials.refresh, "refresh-secret");
		assert.equal(credentials.expires, 2_000_000 - 300_000);
	});

	test("refreshes Cursor credentials, preserves omitted refresh token, and redacts token wrappers", async () => {
		const access = jwtWithExp(3_000);
		let sawAuthorization = false;
		const fakeFetch: CursorFetch = async (_url, init) => {
			const headers = init?.headers as Record<string, string>;
			sawAuthorization = headers.Authorization === "Bearer old-refresh-secret";
			return new Response(JSON.stringify({ accessToken: access }), { status: 200 });
		};
		const service = new CursorAuthService({ fetch: fakeFetch, now: () => 1_000 });

		const refreshed = await service.refreshToken({ access: "old-access-secret", refresh: "old-refresh-secret", expires: 0 });
		assert.equal(sawAuthorization, true);
		assert.equal(refreshed.access, access);
		assert.equal(refreshed.refresh, "old-refresh-secret");
		assert.equal(refreshed.expires, 3_000_000 - 300_000);

		const bundle = {
			access: new CursorToken("access", "access-secret"),
			refresh: new CursorToken("refresh", "refresh-secret"),
			expires: 1,
		};
		assert.equal(String(bundle.access), "[redacted cursor access token]");
		assert.doesNotMatch(JSON.stringify(bundle), /access-secret|refresh-secret/u);
		assert.deepEqual(toOAuthCredentials(bundle), { access: "access-secret", refresh: "refresh-secret", expires: 1 });
	});

	test("surfaces timeout and refresh rejection without leaking tokens", async () => {
		const timeoutService = new CursorAuthService({
			fetch: async () => new Response("pending", { status: 404 }),
			randomBytes: deterministicRandom,
			uuid: () => "uuid-timeout",
			sleep: async () => {},
			maxPollAttempts: 1,
		});
		await assert.rejects(
			timeoutService.login(loginCallbacks([])),
			(error) => error instanceof CursorAuthError && error.code === "PollTimedOut",
		);

		const refreshService = new CursorAuthService({
			fetch: async () => new Response("bad old-refresh-secret", { status: 500 }),
		});
		await assert.rejects(
			refreshService.refreshToken({ access: "old-access-secret", refresh: "old-refresh-secret", expires: 0 }),
			(error) => {
				assert.ok(error instanceof CursorAuthError);
				assert.doesNotMatch(error.message, /old-refresh-secret/u);
				return true;
			},
		);
	});

	test("redacts PKCE verifier, uuid, and poll URL from repeated poll rejection errors", async () => {
		const expectedPkce = createPkcePair(deterministicRandom);
		let echoedPollUrl = "";
		const service = new CursorAuthService({
			fetch: async (url) => {
				echoedPollUrl = url;
				return new Response(`rejected verifier=${expectedPkce.verifier} uuid=uuid-redact url=${url}`, { status: 500 });
			},
			randomBytes: deterministicRandom,
			uuid: () => "uuid-redact",
			sleep: async () => {},
			maxPollAttempts: 3,
			initialPollDelayMs: 1,
		});

		await assert.rejects(
			service.login(loginCallbacks([])),
			(error) => {
				assert.ok(error instanceof CursorAuthError);
				assert.equal(error.code, "PollRejected");
				assert.doesNotMatch(error.message, new RegExp(expectedPkce.verifier, "u"));
				assert.doesNotMatch(error.message, /uuid-redact/u);
				assert.ok(echoedPollUrl.length > 0);
				assert.doesNotMatch(error.message, new RegExp(echoedPollUrl.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
				return true;
			},
		);
	});

	test("applies fetch deadlines to polling and refresh without leaking secrets", async () => {
		const neverFetch: CursorFetch = async () => await new Promise<Response>(() => {});
		const pollService = new CursorAuthService({
			fetch: neverFetch,
			randomBytes: deterministicRandom,
			uuid: () => "uuid-deadline",
			sleep: async () => {},
			fetchTimeoutMs: 1,
			maxPollAttempts: 3,
		});
		await assert.rejects(
			pollService.login(loginCallbacks([])),
			(error) => error instanceof CursorAuthError && error.code === "NetworkError" && !error.message.includes("uuid-deadline"),
		);

		const refreshService = new CursorAuthService({ fetch: neverFetch, fetchTimeoutMs: 1 });
		await assert.rejects(
			refreshService.refreshToken({ access: "old-access-secret", refresh: "old-refresh-secret", expires: 0 }),
			(error) => error instanceof CursorAuthError && error.code === "NetworkError" && !error.message.includes("old-refresh-secret"),
		);
	});

	test("derives a safe fallback expiry for non-JWT tokens", () => {
		assert.equal(deriveCursorTokenExpiry("not-a-jwt", () => 10), 10 + 60 * 60 * 1000);
	});
});
