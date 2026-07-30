import { ModelsError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginRuntimeOAuthProvider } from "../src/core/agent-session-runtime-auth.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	isOAuthLoginCancelled,
	normalizeOAuthLoginError,
	OAuthLoginTransactionError,
} from "../src/core/oauth-login.ts";

const callbacks = (signal?: AbortSignal) => ({
	signal,
	onAuth() {},
	onDeviceCode() {},
	onPrompt: async () => "",
	onProgress() {},
	onSelect: async () => undefined,
});

afterEach(() => vi.restoreAllMocks());

describe("OAuth cancellation normalization", () => {
	it("recognizes exact cancellation, AbortError causes, and active signals", () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled by caller"));
		expect(isOAuthLoginCancelled(controller.signal.reason, controller.signal)).toBe(true);
		expect(isOAuthLoginCancelled(new Error("Login cancelled"))).toBe(true);
		expect(isOAuthLoginCancelled(new Error("wrapped", { cause: new DOMException("aborted", "AbortError") }))).toBe(
			true,
		);
	});

	it("does not classify ordinary failures or completed-transaction failures as cancellation", () => {
		expect(isOAuthLoginCancelled(new Error("provider failed"))).toBe(false);
		expect(isOAuthLoginCancelled(new OAuthLoginTransactionError(new DOMException("aborted", "AbortError")))).toBe(
			false,
		);
	});

	it("normalizes cancellation while preserving the native cause", () => {
		const cause = new DOMException("aborted", "AbortError");
		const normalized = normalizeOAuthLoginError(cause);
		expect(normalized).toBeInstanceOf(Error);
		expect((normalized as Error).message).toBe("Login cancelled");
		expect((normalized as Error).cause).toBe(cause);
	});

	it("preserves genuine provider and persistence failures", () => {
		const providerFailure = new Error("provider failed");
		expect(normalizeOAuthLoginError(providerFailure)).toBe(providerFailure);
		const persistenceFailure = new OAuthLoginTransactionError(new DOMException("aborted", "AbortError"));
		expect(normalizeOAuthLoginError(persistenceFailure)).toBe(persistenceFailure);
	});

	it("does not write provider-owned credentials for a pre-aborted builtin Kimi login", async () => {
		const previous = { type: "api_key" as const, key: "previous" };
		const authStorage = AuthStorage.inMemory({ "kimi-coding": previous });
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		const controller = new AbortController();
		controller.abort();

		await expect(
			loginRuntimeOAuthProvider({ modelRuntime } as never, "kimi-coding", callbacks(controller.signal)),
		).rejects.toMatchObject({ message: "Login cancelled" });
		expect(await authStorage.read("kimi-coding")).toEqual(previous);
	});

	it("normalizes Kimi cancellation immediately after the device code is shown", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					device_code: "device",
					user_code: "KIMI-CODE",
					verification_uri: "https://auth.kimi.com/device",
					verification_uri_complete: "https://auth.kimi.com/device?code=KIMI-CODE",
					interval: 1,
					expires_in: 60,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const authStorage = AuthStorage.inMemory();
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		const controller = new AbortController();

		await expect(
			loginRuntimeOAuthProvider({ modelRuntime } as never, "kimi-coding", {
				...callbacks(controller.signal),
				onDeviceCode: () => controller.abort(new Error("user stopped")),
			}),
		).rejects.toMatchObject({ message: "Login cancelled" });
		expect(fetch).toHaveBeenCalledOnce();
		expect(await authStorage.read("kimi-coding")).toBeUndefined();
	});
	it("normalizes provider-owned runtime aborts", async () => {
		const abort = new DOMException("aborted", "AbortError");
		const session = {
			modelRuntime: {
				login: async () => {
					throw abort;
				},
			},
		};

		await expect(loginRuntimeOAuthProvider(session as never, "kimi-coding", callbacks())).rejects.toMatchObject({
			message: "Login cancelled",
			cause: abort,
		});
	});

	it("does not relabel a persistence failure when the signal aborts during persistence", async () => {
		const controller = new AbortController();
		const persistenceCause = new DOMException("credential write aborted", "AbortError");
		const persistenceFailure = new ModelsError("auth", "Credential store modify failed for openrouter", {
			cause: persistenceCause,
		});
		const session = {
			modelRuntime: {
				login: async () => {
					controller.abort(new Error("user stopped"));
					throw persistenceFailure;
				},
			},
		};

		await expect(
			loginRuntimeOAuthProvider(session as never, "openrouter", callbacks(controller.signal)),
		).rejects.toEqual(new OAuthLoginTransactionError(persistenceFailure));
	});
});
