import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAUTH_REFRESH_LOCK_HOLD_MS, type OAuthCredential } from "@bastani/pi-ai";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { sleep } from "../../../test/helpers/runtime.ts";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { ProviderConfig } from "../src/core/extensions/provider-types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { OAuthRefreshRejectedError } from "../src/index.ts";

const PROVIDER = "corp-oauth";
const HOUR_MS = 60 * 60 * 1000;
const FAKE_REFRESH = "fake-corp-refresh-81b2";
/** A contender that ignored the provider lock would present the refresh token well within this. */
const CONTENDER_HEAD_START_MS = 200;
const RELOGIN = "The provider rejected the stored login; run /login corp-oauth to sign in again.";
type RefreshToken = NonNullable<ProviderConfig["oauth"]>["refreshToken"];

function expiredLogin(): OAuthCredential {
	return { type: "oauth", access: "fake-corp-access-81b2", refresh: FAKE_REFRESH, expires: 1 };
}

/** How an extension's refresher reports a revoked or expired login with the typed contract. */
function rejectedLogin(credentials: { refresh: string; access: string }, description?: string) {
	return new OAuthRefreshRejectedError(
		"Corp token refresh failed",
		{ status: 400, code: "invalid_grant", description },
		[credentials.refresh, credentials.access],
	);
}

function extensionOAuthProvider(refreshToken: RefreshToken): ProviderConfig {
	return {
		baseUrl: "https://corp.example.test/v1",
		api: "openai-completions",
		models: [
			{
				id: "corp-model",
				name: "Corp Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10_000,
				maxTokens: 1_000,
			},
		],
		oauth: {
			name: "Corp SSO",
			login: async () => {
				throw new Error("login is not part of this test");
			},
			refreshToken,
			getApiKey: (credential) => credential.access,
		},
	};
}

async function runtimeFor(credentials: AuthStorage, refreshToken: RefreshToken): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
	runtime.registerProvider(PROVIDER, extensionOAuthProvider(refreshToken));
	await runtime.getAvailable();
	return runtime;
}

async function storedAccess(credentials: AuthStorage): Promise<string | undefined> {
	const credential = await credentials.read(PROVIDER);
	return credential?.type === "oauth" ? credential.access : undefined;
}

describe("extension OAuth providers get the built-in rejected-login guidance", () => {
	let dir: string;
	let authPath: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "extension-oauth-rejected-"));
		authPath = join(dir, "auth.json");
		await AuthStorage.create(authPath).modify(PROVIDER, async () => expiredLogin());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	async function refreshFailure(thrown: unknown): Promise<string> {
		const runtime = await runtimeFor(AuthStorage.create(authPath), async () => {
			throw thrown;
		});
		try {
			await runtime.getAuth(PROVIDER);
		} catch (error) {
			assert.ok(error instanceof Error);
			return error.message;
		}
		assert.fail("the refresh unexpectedly succeeded");
	}

	test("an extension refresher that throws OAuthRefreshRejectedError tells the user to run /login", async () => {
		assert.equal(
			await refreshFailure(rejectedLogin(expiredLogin(), "Session revoked")),
			`OAuth refresh failed for corp-oauth: invalid_grant (Session revoked). ${RELOGIN}`,
		);
		assert.equal(await storedAccess(AuthStorage.create(authPath)), "fake-corp-access-81b2");
	});

	const commonShapes: Array<[string, unknown, string]> = [
		[
			"HTTP error carrying the OAuth response body as an object",
			Object.assign(new Error(`refresh failed for ${FAKE_REFRESH}`), {
				status: 400,
				body: { error: "invalid_grant", error_description: "Refresh token expired" },
			}),
			"invalid_grant (Refresh token expired)",
		],
		[
			"HTTP error carrying the OAuth response body as JSON text",
			Object.assign(new Error("Bad Request"), {
				statusCode: 400,
				data: '{"error":"invalid_grant","error_description":"Token expired"}',
			}),
			"invalid_grant (Token expired)",
		],
		[
			"axios-style error with the body in response.data",
			Object.assign(new Error("Request failed with status code 400"), {
				code: "ERR_BAD_REQUEST",
				response: { status: 400, data: { error: "invalid_grant", error_description: "Bad refresh token" } },
			}),
			"invalid_grant (Bad refresh token)",
		],
		[
			"openid-client-style error with error and error_description properties",
			Object.assign(new Error("server responded with an error"), {
				error: "invalid_grant",
				error_description: "Grant revoked",
			}),
			"invalid_grant (Grant revoked)",
		],
		[
			"error with code invalid_grant",
			Object.assign(new Error("refresh failed"), { code: "invalid_grant" }),
			"invalid_grant",
		],
		["HTTP 401 from the token endpoint", Object.assign(new Error("Unauthorized"), { status: 401 }), "HTTP 401"],
		[
			"recognised error wrapped as the cause of the extension's own error",
			new Error("corp refresh failed", { cause: Object.assign(new Error("Unauthorized"), { status: 401 }) }),
			"HTTP 401",
		],
	];
	for (const [shape, thrown, detail] of commonShapes) {
		test(`an extension refresher's ${shape} gets the built-in /login guidance`, async () => {
			const message = await refreshFailure(thrown);
			assert.equal(message, `OAuth refresh failed for corp-oauth: ${detail}. ${RELOGIN}`);
			assert.equal(message.includes(FAKE_REFRESH), false);
		});
	}

	test("an extension refresh failure that may succeed on retry does not ask for a new login", async () => {
		for (const thrown of [
			Object.assign(new Error("Service Unavailable"), { status: 503 }),
			Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
			Object.assign(new Error("Bad Request"), { status: 400, body: { error: "invalid_request" } }),
		]) {
			assert.doesNotMatch(await refreshFailure(thrown), /run \/login/);
		}
	});

	test("a rejected extension refresh uses the newer login another session saved", async () => {
		const newer: OAuthCredential = {
			type: "oauth",
			access: "fake-corp-access-newer",
			refresh: "fake-corp-refresh-newer",
			expires: Date.now() + HOUR_MS,
		};
		const otherSession = new FileAuthStorageBackend(authPath);
		const runtime = await runtimeFor(AuthStorage.create(authPath), async (credential) => {
			await otherSession.withLockAsync(async (content) => ({
				result: undefined,
				next: JSON.stringify({ ...JSON.parse(content ?? "{}"), [PROVIDER]: newer }),
			}));
			throw rejectedLogin(credential);
		});

		assert.equal((await runtime.getAuth(PROVIDER))?.auth.apiKey, "fake-corp-access-newer");
		assert.equal(await storedAccess(AuthStorage.create(authPath)), "fake-corp-access-newer");
	});

	test("another session waits for an extension token exchange instead of presenting the same refresh token", async () => {
		const presented: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let markStarted!: () => void;
		const exchangeStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const refreshToken: RefreshToken = async (credential) => {
			presented.push(credential.refresh);
			markStarted();
			await gate;
			return {
				access: "fake-corp-access-rotated",
				refresh: "fake-corp-refresh-rotated",
				expires: Date.now() + HOUR_MS,
			};
		};
		const first = await runtimeFor(AuthStorage.create(authPath), refreshToken);
		const second = await runtimeFor(AuthStorage.create(authPath), refreshToken);

		const firstAuth = first.getAuth(PROVIDER);
		await exchangeStarted;
		const secondAuth = second.getAuth(PROVIDER);
		// Time for the second session to present the stored refresh token if the lock did not hold it back.
		await sleep(CONTENDER_HEAD_START_MS);
		release();

		assert.equal((await firstAuth)?.auth.apiKey, "fake-corp-access-rotated");
		assert.equal((await secondAuth)?.auth.apiKey, "fake-corp-access-rotated");
		assert.deepEqual(presented, [FAKE_REFRESH]);
	});

	test("an extension token rotation that settles after the lock hold is still saved", async () => {
		const credentials = AuthStorage.inMemory({ [PROVIDER]: expiredLogin() });
		let finishRotation!: (credential: OAuthCredential) => void;
		const runtime = await runtimeFor(
			credentials,
			() =>
				new Promise((resolve) => {
					finishRotation = resolve;
				}),
		);
		vi.useFakeTimers();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
			return controller.signal;
		});

		const auth = runtime.getAuth(PROVIDER).catch((error: Error) => error);
		await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_LOCK_HOLD_MS + 1);
		assert.ok((await auth) instanceof Error);
		finishRotation({ ...expiredLogin(), access: "fake-corp-access-late", expires: Date.now() + HOUR_MS });
		await vi.waitFor(async () => assert.equal(await storedAccess(credentials), "fake-corp-access-late"));
	});
});
