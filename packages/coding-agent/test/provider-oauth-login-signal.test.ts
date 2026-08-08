import type { AuthInteraction } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

/**
 * Bounds the pre-fix path: the fork-owned adapter used to call extension
 * `login(callbacks)` with no signal, so the hook could not observe cancellation
 * and would finish after this deadline instead of abandoning its work.
 */
const ABORT_OBSERVATION_TIMEOUT_MS = 200;

function interaction(signal: AbortSignal): AuthInteraction {
	return {
		signal,
		prompt: async () => "unused",
		notify: () => {},
	};
}

describe("extension OAuth login abort signal", () => {
	it("forwards the provider interaction signal exactly and abandons an in-flight login when it aborts", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		let observedCallbacksSignal: AbortSignal | undefined;
		let observedSignal: AbortSignal | undefined;
		let loginCompleted = false;
		let markEntered: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});

		runtime.registerProvider("oauth-login-signal", {
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "OAuth Login Signal",
				login: async (callbacks, signal) => {
					observedCallbacksSignal = callbacks.signal;
					observedSignal = signal;
					markEntered();
					await new Promise<void>((resolve) => {
						if (signal?.aborted) return resolve();
						signal?.addEventListener("abort", () => resolve(), { once: true });
						setTimeout(resolve, ABORT_OBSERVATION_TIMEOUT_MS);
					});
					if (signal?.aborted) throw signal.reason ?? new DOMException("Login cancelled", "AbortError");
					loginCompleted = true;
					return { access: "should-not-persist", refresh: "refresh", expires: Date.now() + 60_000 };
				},
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
			models: [],
		});

		const controller = new AbortController();
		const pending = runtime.login("oauth-login-signal", "oauth", interaction(controller.signal));
		await entered;

		// pi composes the caller signal with its operation controller. Atomic must
		// hand that one concrete ProviderAuthInteraction signal to both faces of
		// the fork-owned extension login contract without replacing it again.
		expect(observedSignal).toBeDefined();
		expect(observedSignal).toBe(observedCallbacksSignal);
		controller.abort(new DOMException("user cancelled login", "AbortError"));

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(observedSignal?.aborted).toBe(true);
		expect(loginCompleted).toBe(false);
		expect(await credentials.read("oauth-login-signal")).toBeUndefined();
	});
});
