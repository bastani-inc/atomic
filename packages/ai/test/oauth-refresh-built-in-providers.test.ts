import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { kimiCodingOAuth } from "../src/auth/oauth/kimi-coding.ts";
import { openaiChatGPTOAuth } from "../src/auth/oauth/openai-chatgpt.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import { xaiOAuth } from "../src/auth/oauth/xai.ts";
import type { OAuthAuth, OAuthCredential } from "../src/auth/types.ts";
import { OAuthRefreshRejectedError } from "../src/index.ts";
import { createModels, OAUTH_REFRESH_TIMEOUT_MS, type Provider } from "../src/models.ts";

/** A fake refresh token the provider echoes back in its rejection; it must never reach the user. */
const ECHOED_REFRESH_TOKEN = "fake-secret-refresh-XYZ123";

/** Slower than the 30-second per-request abort Kimi used to add, still inside the caller's wait. */
const LATE_TOKEN_RESPONSE_MS = OAUTH_REFRESH_TIMEOUT_MS / 2 + 1_000;

function oauthProvider(id: string, oauth: OAuthAuth): Provider {
	const unused = (): never => {
		throw new Error("streaming is not part of this test");
	};
	return {
		id,
		name: id,
		auth: { oauth },
		getModels: () => [],
		refreshModels: async () => {},
		stream: unused,
		streamSimple: unused,
	};
}

async function modelsWithExpiredLogin(providerId: string, oauth: OAuthAuth, stored: Partial<OAuthCredential>) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(providerId, async () => ({
		type: "oauth",
		access: "fake-access-1",
		refresh: "fake-refresh-1",
		expires: 0,
		...stored,
	}));
	const models = createModels({ credentials });
	models.setProvider(oauthProvider(providerId, oauth));
	return { models, credentials };
}

/** `AbortSignal.timeout` is not driven by vitest's fake timers; route it through the faked `setTimeout`. */
function mockAbortSignalTimeoutWithFakeTimers() {
	return vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
		return controller.signal;
	});
}

/**
 * Fake Kimi token endpoint that rotates the refresh token as soon as it receives a valid one, answers after
 * `responseDelayMs`, and honours the request's abort signal (the rotation has happened by then).
 */
function rotatingKimiTokenEndpoint(responseDelayMs: number) {
	let generation = 1;
	const presented: string[] = [];
	const fetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const token = new URLSearchParams(String(init?.body)).get("refresh_token");
		if (token !== `fake-refresh-${generation}`) {
			presented.push(`invalid_grant(${token})`);
			return Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 }));
		}
		generation++;
		presented.push(`rotated(${token}->fake-refresh-${generation})`);
		const body = {
			access_token: `fake-access-${generation}`,
			refresh_token: `fake-refresh-${generation}`,
			expires_in: 3600,
		};
		return new Promise<Response>((resolve, reject) => {
			const response = setTimeout(() => resolve(Response.json(body)), responseDelayMs);
			init?.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(response);
					reject(init.signal?.reason);
				},
				{ once: true },
			);
		});
	};
	return { fetch, presented };
}

/** Every text a rejected refresh could show: messages, string forms and stacks along the cause chain. */
function shownTexts(error: Error): string[] {
	const shown: string[] = [];
	for (let current: Error | undefined = error; current; ) {
		shown.push(current.message, String(current), current.stack ?? "");
		current = current.cause instanceof Error ? current.cause : undefined;
	}
	return shown;
}

async function assertRejectedLoginMessage(
	models: ReturnType<typeof createModels>,
	providerId: string,
	code: string | undefined,
): Promise<void> {
	await assert.rejects(models.getAuth(providerId), (error: Error) => {
		assert.equal(
			shownTexts(error).some((text) => text.includes(ECHOED_REFRESH_TOKEN)),
			false,
			`the presented refresh token leaked: ${error.message}`,
		);
		assert.match(error.message, new RegExp(`run /login ${providerId} to sign in again`));
		if (code !== undefined) assert.match(error.message, new RegExp(`^OAuth refresh failed for ${providerId}: ${code}`));
		return true;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("built-in OAuth refreshers", () => {
	it("keeps a Kimi token rotation whose response arrives after 30 seconds", async () => {
		vi.useFakeTimers();
		mockAbortSignalTimeoutWithFakeTimers();
		const endpoint = rotatingKimiTokenEndpoint(LATE_TOKEN_RESPONSE_MS);
		vi.stubGlobal("fetch", endpoint.fetch);
		const { models, credentials } = await modelsWithExpiredLogin("kimi-coding", kimiCodingOAuth, {});

		const refresh = models.refresh();
		await vi.advanceTimersByTimeAsync(LATE_TOKEN_RESPONSE_MS);

		const errors = (await refresh).errors;
		assert.deepEqual(endpoint.presented, ["rotated(fake-refresh-1->fake-refresh-2)"]);
		assert.equal(errors.size, 0);
		const stored = await credentials.read("kimi-coding");
		assert.equal(stored?.type === "oauth" ? stored.refresh : undefined, "fake-refresh-2");
	});

	const rejectedLogins: Array<{
		shape: string;
		providerId: string;
		oauth: OAuthAuth;
		stored?: Partial<OAuthCredential>;
		status: number;
		body: Record<string, string | Record<string, string>>;
		code?: string;
	}> = [
		...["refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].map((code) => ({
			shape: `OpenAI Codex 401 ${code}`,
			providerId: "openai-1",
			oauth: openaiCodexOAuth,
			status: 401,
			body: {
				error: { code, message: `Refresh token ${ECHOED_REFRESH_TOKEN} cannot be used`, type: "invalid_request_error" },
			},
			code,
		})),
		{
			shape: "OpenAI ChatGPT 401 refresh_token_reused",
			providerId: "openai-chatgpt",
			oauth: openaiChatGPTOAuth,
			stored: { clientId: "fake-client-id" },
			status: 401,
			body: { error: { code: "refresh_token_reused", message: `Refresh token ${ECHOED_REFRESH_TOKEN} reused` } },
			code: "refresh_token_reused",
		},
		{
			shape: "Kimi 400 invalid_grant",
			providerId: "kimi-coding",
			oauth: kimiCodingOAuth,
			status: 400,
			body: { error: "invalid_grant", error_description: `token ${ECHOED_REFRESH_TOKEN} revoked` },
			code: "invalid_grant",
		},
		{
			shape: "Kimi 401 without an error code",
			providerId: "kimi-coding",
			oauth: kimiCodingOAuth,
			status: 401,
			body: { error_description: `token ${ECHOED_REFRESH_TOKEN} revoked` },
		},
		{
			shape: "Kimi 403 without an error code",
			providerId: "kimi-coding",
			oauth: kimiCodingOAuth,
			status: 403,
			body: { error_description: `token ${ECHOED_REFRESH_TOKEN} revoked` },
		},
		{
			shape: "xAI 401 invalid_grant",
			providerId: "xai",
			oauth: xaiOAuth,
			status: 401,
			body: { error: "invalid_grant", error_description: `refresh token ${ECHOED_REFRESH_TOKEN} revoked` },
			code: "invalid_grant",
		},
	];

	it.each(rejectedLogins)(
		"tells the user to sign in again, without the token, on a $shape rejection",
		async ({ providerId, oauth, stored, status, body, code }) => {
			vi.stubGlobal("fetch", async () => Response.json({ ...body, refresh_token: ECHOED_REFRESH_TOKEN }, { status }));
			const { models } = await modelsWithExpiredLogin(providerId, oauth, { refresh: ECHOED_REFRESH_TOKEN, ...stored });

			await assertRejectedLoginMessage(models, providerId, code);
		},
	);

	it("tells the user to sign in again when a custom refresher reports a nested refresh_token_* code", async () => {
		const oauth: OAuthAuth = {
			name: "Custom OAuth",
			login: async () => {
				throw new Error("login is not part of this test");
			},
			refresh: async () => {
				throw new Error(
					`token refresh failed (401): {"error":{"code":"refresh_token_reused","message":"Refresh token ${ECHOED_REFRESH_TOKEN} was already used"},"refresh_token":"${ECHOED_REFRESH_TOKEN}"}`,
					{ cause: new Error(`request body: grant_type=refresh_token&refresh_token=${ECHOED_REFRESH_TOKEN}`) },
				);
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const { models } = await modelsWithExpiredLogin("custom-1", oauth, { refresh: ECHOED_REFRESH_TOKEN });

		await assertRejectedLoginMessage(models, "custom-1", "refresh_token_reused");
	});

	it("tells the user to sign in again when a custom refresher throws the exported OAuthRefreshRejectedError", async () => {
		const oauth: OAuthAuth = {
			name: "Custom OAuth",
			login: async () => {
				throw new Error("login is not part of this test");
			},
			refresh: async (credential) => {
				throw new OAuthRefreshRejectedError(
					"Custom token refresh failed (HTTP 403)",
					{ status: 403, code: "account_disabled", description: `login ${credential.refresh} was disabled` },
					[],
				);
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const { models } = await modelsWithExpiredLogin("custom-2", oauth, { refresh: ECHOED_REFRESH_TOKEN });

		await assertRejectedLoginMessage(models, "custom-2", "account_disabled");
	});
});
