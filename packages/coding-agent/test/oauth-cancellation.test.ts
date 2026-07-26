import { ModelsError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isOAuthLoginCancelled,
	loginOAuthProvider,
	normalizeOAuthLoginError,
	OAuthLoginTransactionError,
	registerLegacyOAuthProvider,
	resetLegacyOAuthProviders,
} from "../src/core/oauth-provider-bridge.ts";
import { loginRuntimeOAuthProvider } from "../src/core/agent-session-runtime-auth.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const callbacks = (signal?: AbortSignal) => ({
	signal,
	onAuth() {},
	onDeviceCode() {},
	onPrompt: async () => "",
	onProgress() {},
	onSelect: async () => undefined,
});

afterEach(() => {
	resetLegacyOAuthProviders();
	vi.restoreAllMocks();
});

describe("OAuth cancellation normalization", () => {
	it("normalizes a pre-aborted builtin Kimi login and preserves the native cause", async () => {
		const controller = new AbortController();
		controller.abort();
		let caught: unknown;
		try {
			await loginOAuthProvider("kimi-coding", callbacks(controller.signal));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe("Login cancelled");
		expect((caught as Error).cause).toBeInstanceOf(Error);
		expect(((caught as Error).cause as Error).name).toBe("AbortError");
	});

	it("does not write through the builtin registry route for pre-aborted Kimi", async () => {
		const previous = { type: "api_key" as const, key: "previous" };
		const authStorage = AuthStorage.inMemory({ "kimi-coding": previous });
		const registry = ModelRegistry.inMemory(authStorage);
		const controller = new AbortController();
		controller.abort();

		await expect(loginRuntimeOAuthProvider(
			{ modelRegistry: registry } as never,
			"kimi-coding",
			callbacks(controller.signal),
		)).rejects.toMatchObject({ message: "Login cancelled" });
		expect(authStorage.get("kimi-coding")).toEqual(previous);
	});

	it("normalizes Kimi cancellation immediately after the device code is shown", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
			device_code: "device",
			user_code: "KIMI-CODE",
			verification_uri: "https://auth.kimi.com/device",
			verification_uri_complete: "https://auth.kimi.com/device?code=KIMI-CODE",
			interval: 1,
			expires_in: 60,
		}), { status: 200, headers: { "content-type": "application/json" } }));
		const controller = new AbortController();
		let caught: unknown;
		try {
			await loginOAuthProvider("kimi-coding", {
				...callbacks(controller.signal),
				onDeviceCode: () => controller.abort(new Error("user stopped")),
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ message: "Login cancelled" });
		expect((caught as Error).cause).toBeInstanceOf(Error);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("recognizes only exact signal, AbortError cause, and compatibility cancellation", async () => {
		const reason = new Error("stop");
		const controller = new AbortController();
		controller.abort(reason);
		const nested = new Error("wrapper", { cause: new DOMException("aborted", "AbortError") });
		const cycle = new Error("cycle");
		(cycle as Error & { cause?: unknown }).cause = cycle;

		expect(isOAuthLoginCancelled(reason, controller.signal)).toBe(true);
		expect(isOAuthLoginCancelled(nested)).toBe(true);
		expect(isOAuthLoginCancelled(new Error("Login cancelled"))).toBe(true);
		expect(isOAuthLoginCancelled("Login cancelled")).toBe(true);
		expect(isOAuthLoginCancelled(new Error("wrapper", { cause: "Login cancelled" }))).toBe(true);
		expect(isOAuthLoginCancelled(cycle)).toBe(false);
		for (const message of ["login cancelled by provider", "Abort request failed", "request timeout", "access denied"]) {
			expect(isOAuthLoginCancelled(new Error(message))).toBe(false);
		}

		const preAborted = new AbortController();
		preAborted.abort();
		await expect(loginOAuthProvider("unknown-provider", callbacks(preAborted.signal)))
			.rejects.toThrow("Unknown OAuth provider: unknown-provider");
	});

	it("normalizes a legacy provider abort but preserves genuine provider failures", async () => {
		const abort = new DOMException("operation aborted", "AbortError");
		registerLegacyOAuthProvider("legacy", {
			name: "Legacy",
			login: async () => { throw abort; },
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
		});
		await expect(loginOAuthProvider("legacy", callbacks())).rejects.toMatchObject({
			message: "Login cancelled",
			cause: abort,
		});
		let runtimeError: unknown;
		try {
			await loginRuntimeOAuthProvider(
				{ modelRegistry: { authStorage: AuthStorage.inMemory() } } as never,
				"legacy",
				callbacks(),
			);
		} catch (error) {
			runtimeError = error;
		}
		expect(runtimeError).toMatchObject({ message: "Login cancelled", cause: abort });

		const failure = new Error("HTTP 403 access denied");
		expect(normalizeOAuthLoginError(failure)).toBe(failure);
	});

	it("normalizes provider-owned runtime aborts that bypass the compatibility bridge", async () => {
		const controller = new AbortController();
		const abort = new DOMException("aborted", "AbortError");
		const session = {
			modelRegistry: {
				login: async () => { throw abort; },
				authStorage: { login: async () => { throw new Error("unexpected legacy route"); } },
			},
		};
		await expect(loginRuntimeOAuthProvider(session as never, "kimi-coding", callbacks(controller.signal)))
			.rejects.toMatchObject({ message: "Login cancelled", cause: abort });
	});

	it("does not persist when a legacy provider ignores an abort and returns credentials", async () => {
		const controller = new AbortController();
		const previous = { type: "api_key" as const, key: "previous" };
		const authStorage = AuthStorage.inMemory({ legacy: previous });
		registerLegacyOAuthProvider("legacy", {
			name: "Legacy",
			login: async () => {
				controller.abort(new Error("user stopped"));
				return { access: "must-not-save", refresh: "refresh", expires: Date.now() + 60_000 };
			},
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
		});

		await expect(loginRuntimeOAuthProvider(
			{ modelRegistry: { authStorage } } as never,
			"legacy",
			callbacks(controller.signal),
		)).rejects.toMatchObject({ message: "Login cancelled", cause: controller.signal.reason });
		expect(authStorage.get("legacy")).toEqual(previous);
	});

	it("does not relabel a persistence failure when the signal aborts during persistence", async () => {
		const controller = new AbortController();
		const persistenceCause = new DOMException("credential write aborted", "AbortError");
		const persistenceFailure = new ModelsError("auth", "Credential store modify failed for openrouter", {
			cause: persistenceCause,
		});
		const session = {
			modelRegistry: {
				login: async () => {
					controller.abort(new Error("user stopped"));
					throw persistenceFailure;
				},
				authStorage: { login: async () => { throw new Error("unexpected legacy route"); } },
			},
		};
		await expect(loginRuntimeOAuthProvider(session as never, "openrouter", callbacks(controller.signal)))
			.rejects.toEqual(new OAuthLoginTransactionError(persistenceFailure));
	});

	it("does not relabel a legacy custom credential-store AbortError", async () => {
		registerLegacyOAuthProvider("legacy", {
			name: "Legacy",
			login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
		});
		const controller = new AbortController();
		const persistenceFailure = new DOMException("credential write aborted", "AbortError");
		const session = {
			modelRegistry: {
				authStorage: {
					asCredentialStore: () => ({
						modify: async () => {
							controller.abort(new Error("user stopped"));
							throw persistenceFailure;
						},
					}),
				},
			},
		};

		await expect(loginRuntimeOAuthProvider(session as never, "legacy", callbacks(controller.signal)))
			.rejects.toEqual(new OAuthLoginTransactionError(persistenceFailure));
	});
});
