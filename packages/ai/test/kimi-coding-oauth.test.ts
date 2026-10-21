import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import type { ProviderAuthInteraction } from "../src/auth/types.ts";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_HOST = "https://auth.kimi.com";
/** Kimi waits 1 s, 2 s and 4 s before its three refresh retries. */
const KIMI_REFRESH_BACKOFF_TOTAL_MS = 7_000;

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function deviceAuthorizationResponse(overrides?: Record<string, unknown>): Response {
	return jsonResponse({
		user_code: "ABCD-1234",
		device_code: "device-code-123",
		verification_uri: "https://www.kimi.com/code",
		verification_uri_complete: "https://www.kimi.com/code?user_code=ABCD-1234",
		interval: 5,
		expires_in: 600,
		...overrides,
	});
}

function createInteraction(events: Array<Record<string, unknown>>): ProviderAuthInteraction {
	return {
		signal: new AbortController().signal,
		prompt: async () => {
			throw new Error("Kimi Code login should not prompt");
		},
		notify: (event) => events.push(event),
	};
}

describe("Kimi Code OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	it("logs in with the device authorization flow", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-07-20T00:00:00Z");
		vi.setSystemTime(startTime);

		const events: Array<Record<string, unknown>> = [];
		const pollResponses = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 }),
		];
		const pollTimes: number[] = [];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === `${OAUTH_HOST}/api/oauth/device_authorization`) {
					expect(init?.method).toBe("POST");
					expect(init?.headers).toMatchObject({
						"Content-Type": "application/x-www-form-urlencoded",
						Accept: "application/json",
					});
					expect(new URLSearchParams(String(init?.body)).get("client_id")).toBe(CLIENT_ID);
					return deviceAuthorizationResponse();
				}
				if (url === `${OAUTH_HOST}/api/oauth/token`) {
					pollTimes.push(Date.now());
					const params = new URLSearchParams(String(init?.body));
					expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
					expect(params.get("client_id")).toBe(CLIENT_ID);
					expect(params.get("device_code")).toBe("device-code-123");
					const response = pollResponses.shift();
					if (!response) throw new Error("Unexpected extra token poll");
					return response;
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialPromise = kimiCodingOAuth.login(createInteraction(events));
		for (let i = 0; i < 5 && events.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(events).toEqual([
			{
				type: "device_code",
				userCode: "ABCD-1234",
				verificationUri: "https://www.kimi.com/code?user_code=ABCD-1234",
				intervalSeconds: 5,
				expiresInSeconds: 600,
			},
		]);

		// waitBeforeFirstPoll: first poll happens after the 5s interval.
		await vi.advanceTimersByTimeAsync(4999);
		expect(pollTimes).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(pollTimes).toEqual([startTime.getTime() + 5000]);

		await vi.advanceTimersByTimeAsync(5000);
		await expect(credentialPromise).resolves.toEqual({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: startTime.getTime() + 10000 + 3600 * 1000,
		});
		expect(pollTimes).toEqual([startTime.getTime() + 5000, startTime.getTime() + 10000]);
	});

	it("fails when the device code expires", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === `${OAUTH_HOST}/api/oauth/device_authorization`) {
					return deviceAuthorizationResponse();
				}
				if (url === `${OAUTH_HOST}/api/oauth/token`) {
					return jsonResponse({ error: "expired_token" }, 400);
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialPromise = kimiCodingOAuth.login(createInteraction([]));
		const assertion = expect(credentialPromise).rejects.toThrow("expired");
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;
	});

	it("fails when the user denies the login", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				if (url === `${OAUTH_HOST}/api/oauth/device_authorization`) {
					return deviceAuthorizationResponse();
				}
				if (url === `${OAUTH_HOST}/api/oauth/token`) {
					return jsonResponse({ error: "access_denied" }, 400);
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialPromise = kimiCodingOAuth.login(createInteraction([]));
		const assertion = expect(credentialPromise).rejects.toThrow("denied");
		await vi.advanceTimersByTimeAsync(5000);
		await assertion;
	});

	it("honors the KIMI_CODE_OAUTH_HOST override", async () => {
		vi.useFakeTimers();
		vi.stubEnv("KIMI_CODE_OAUTH_HOST", "https://auth.example.com/");

		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown): Promise<Response> => {
				const url = getUrl(input);
				urls.push(url);
				if (url === "https://auth.example.com/api/oauth/device_authorization") {
					return deviceAuthorizationResponse({ interval: 1 });
				}
				if (url === "https://auth.example.com/api/oauth/token") {
					return jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 60 });
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialPromise = kimiCodingOAuth.login(createInteraction([]));
		await vi.advanceTimersByTimeAsync(1000);
		await expect(credentialPromise).resolves.toMatchObject({ access: "a", refresh: "r" });
		expect(urls).toEqual([
			"https://auth.example.com/api/oauth/device_authorization",
			"https://auth.example.com/api/oauth/token",
		]);
	});

	it("refreshes tokens and returns a Bearer header for requests", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				expect(url).toBe(`${OAUTH_HOST}/api/oauth/token`);
				const params = new URLSearchParams(String(init?.body));
				expect(params.get("grant_type")).toBe("refresh_token");
				expect(params.get("refresh_token")).toBe("old-refresh");
				expect(params.get("client_id")).toBe(CLIENT_ID);
				return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
			}),
		);

		const before = Date.now();
		const credential = await kimiCodingOAuth.refresh(
			{
				type: "oauth",
				access: "old-access",
				refresh: "old-refresh",
				expires: before,
			},
			new AbortController().signal,
		);
		expect(credential).toEqual({
			type: "oauth",
			access: "new-access",
			refresh: "new-refresh",
			expires: expect.any(Number),
		});
		expect(credential.expires).toBeGreaterThanOrEqual(before + 3600 * 1000);

		await expect(kimiCodingOAuth.toAuth(credential)).resolves.toEqual({
			headers: { Authorization: "Bearer new-access" },
		});
	});

	it("presents a refresh token again only after an attempt that never reached the server", async () => {
		vi.useFakeTimers();
		const connectionRefused = new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
		});
		const connectionLostAfterSend = new TypeError("fetch failed", {
			cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
		});
		const outcomes: Array<Error | Response> = [
			connectionRefused,
			connectionLostAfterSend,
			jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 60 }),
		];
		let attempts = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				attempts += 1;
				const outcome = outcomes.shift();
				if (outcome === undefined) throw new Error("unexpected extra token request");
				if (outcome instanceof Error) throw outcome;
				return outcome;
			}),
		);

		const refresh = kimiCodingOAuth.refresh(
			{ type: "oauth", access: "old", refresh: "old", expires: 0 },
			new AbortController().signal,
		);
		const rejected = assert.rejects(refresh, (error: Error) => error === connectionLostAfterSend);
		await vi.advanceTimersByTimeAsync(KIMI_REFRESH_BACKOFF_TOTAL_MS);
		await rejected;
		assert.equal(attempts, 2, "the refused connection is retried; the one lost after sending is not");
	});

	it.each([429, 503])(
		"does not present a refresh token again after a delivered HTTP %i response",
		async (status) => {
			vi.useFakeTimers();
			let attempts = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (): Promise<Response> => {
					attempts += 1;
					if (attempts > 1) throw new Error("unexpected extra token request");
					return jsonResponse({ error: "temporarily_unavailable" }, status);
				}),
			);

			const refresh = kimiCodingOAuth.refresh(
				{ type: "oauth", access: "old", refresh: "old", expires: 0 },
				new AbortController().signal,
			);
			const rejected = assert.rejects(refresh, new RegExp(`status ${status}`));
			await vi.advanceTimersByTimeAsync(KIMI_REFRESH_BACKOFF_TOTAL_MS);
			await rejected;
			assert.equal(attempts, 1);
		},
	);

	it("fails unauthorized on invalid_grant without retrying", async () => {
		let attempts = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				attempts += 1;
				return jsonResponse({ error: "invalid_grant" }, 400);
			}),
		);
		await expect(
			kimiCodingOAuth.refresh(
				{ type: "oauth", access: "old", refresh: "old", expires: 0 },
				new AbortController().signal,
			),
		).rejects.toThrow("unauthorized");
		expect(attempts).toBe(1);
	});
});
