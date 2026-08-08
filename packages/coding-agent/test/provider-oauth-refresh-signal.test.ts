import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ProviderConfig } from "../src/core/extensions/provider-types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ExtensionOAuthConfig } from "../src/core/provider-composer-internal.ts";

/**
 * pi hands the abort signal to the OAuth refresh hook: `Models.refresh({signal})`
 * forwards it through `resolveRefreshCredential` into `oauth.refresh(current,
 * signal)` (pi-ai `models.js:87,131`, declared at `auth/types.d.ts:202`). Atomic
 * owns the extension-facing `refreshToken` contract, which used to take only the
 * credential, so `adaptOAuth` received the signal and dropped it and an in-flight
 * token refresh could not be cancelled.
 *
 * The login half of the same adapter already threaded `signal` through, so this
 * closes the asymmetry.
 *
 * Both tests must define `refreshModels`: `Models.refresh()` only visits
 * providers that declare it (`models.js:74`), and the OAuth refresh path hangs
 * off that walk. Without it the hook is never entered at all.
 */

/**
 * Bounds the unforwarded case: without the signal the hook cannot observe the
 * abort, so it must still finish rather than hang the suite.
 */
const ABORT_OBSERVATION_TIMEOUT_MS = 200;

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;

type PublicRefreshSignal = Parameters<NonNullable<NonNullable<ProviderConfig["oauth"]>["refreshToken"]>>[1];
type InternalRefreshSignal = Parameters<ExtensionOAuthConfig["refreshToken"]>[1];
const publicRefreshSignalIsExact: Equal<PublicRefreshSignal, AbortSignal> = true;
const internalRefreshSignalIsExact: Equal<InternalRefreshSignal, AbortSignal> = true;

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

/** An expired credential is what forces pi to take the refresh path. */
function expiredOAuthStore() {
	return AuthStorage.inMemory({
		"oauth-signal": { type: "oauth", access: "expired-access", refresh: "refresh-token", expires: 1 },
	});
}

describe("extension OAuth refreshToken abort signal", () => {
	it("requires an exact concrete AbortSignal in public and internal contracts", () => {
		expect(publicRefreshSignalIsExact).toBe(true);
		expect(internalRefreshSignalIsExact).toBe(true);
	});
	it("forwards the caller's abort signal to refreshToken", async () => {
		const runtime = await ModelRuntime.create({ credentials: expiredOAuthStore(), modelsPath: null });
		let hookEntered = false;
		let observedSignal: AbortSignal | undefined;

		runtime.registerProvider("oauth-signal", {
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "OAuth Signal",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async (credential, signal) => {
					hookEntered = true;
					observedSignal = signal;
					return { ...credential, access: "refreshed", expires: Date.now() + 60_000 };
				},
				getApiKey: (credential) => credential.access,
			},
			refreshModels: async () => [testModel("signal-model")],
		});

		const controller = new AbortController();
		await runtime.refresh({ allowNetwork: true, signal: controller.signal });

		// Guards the assertion below: a never-entered hook would also leave
		// observedSignal undefined and would prove nothing.
		expect(hookEntered).toBe(true);
		// Models composes the caller signal with its provider-operation controller,
		// so identity is intentionally not stable. The hook must receive a signal
		// that follows the caller's abort, which the second test exercises.
		expect(observedSignal).toBeDefined();
		controller.abort();
		expect(observedSignal?.aborted).toBe(true);
	});

	it("lets an abort that arrives mid-refresh abandon the in-flight refresh", async () => {
		const runtime = await ModelRuntime.create({ credentials: expiredOAuthStore(), modelsPath: null });
		let hookEntered = false;
		let refreshCompleted = false;
		let markEntered: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});

		runtime.registerProvider("oauth-signal", {
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "OAuth Signal",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async (credential, signal) => {
					// Abort only after the hook is entered, so pi's own pre-flight
					// `if (signal?.aborted) return undefined` cannot short-circuit it.
					// Reaching the abort therefore requires the signal to have been
					// forwarded here. The timeout bounds the run when it was not.
					hookEntered = true;
					markEntered();
					await new Promise<void>((resolve) => {
						if (signal.aborted) return resolve();
						signal.addEventListener("abort", () => resolve(), { once: true });
						setTimeout(resolve, ABORT_OBSERVATION_TIMEOUT_MS);
					});
					// A real implementation forwards the signal into fetch(); reject on
					// abort the same way an aborted fetch would.
					if (signal.aborted) throw new Error("refresh aborted");
					refreshCompleted = true;
					return { ...credential, access: "refreshed", expires: Date.now() + 60_000 };
				},
				getApiKey: (credential) => credential.access,
			},
			refreshModels: async () => [testModel("signal-model")],
		});

		const controller = new AbortController();
		const pending = runtime.refresh({ allowNetwork: true, signal: controller.signal });
		await entered;
		controller.abort();
		const result = await pending;

		expect(hookEntered).toBe(true);
		// Without forwarding, the hook never observes the abort, falls through the
		// timeout, and completes — which is exactly the defect.
		expect(refreshCompleted).toBe(false);
		expect(result.aborted || result.errors.size > 0).toBe(true);
	});
});
