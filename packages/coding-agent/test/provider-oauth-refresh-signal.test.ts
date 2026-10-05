import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ProviderConfig } from "../src/core/extensions/provider-types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ExtensionOAuthConfig } from "../src/core/provider-composer-internal.ts";

/** Extension refresh hooks receive a timeout signal; caller cancellation must not discard rotation. */

/** Let the provider complete even though the caller no longer waits for the result. */
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
	it("keeps the refresh timeout signal independent of caller cancellation (#3429)", async () => {
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
		assert.ok(observedSignal instanceof AbortSignal);
		controller.abort();
		assert.equal(observedSignal.aborted, false);
	});

	it("persists rotated credentials after caller cancellation mid-refresh (#3429)", async () => {
		const credentials = expiredOAuthStore();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
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
					// Abort only after the provider starts so this exercises actual token rotation.
					hookEntered = true;
					markEntered();
					await new Promise<void>((resolve) => {
						if (signal.aborted) return resolve();
						signal.addEventListener("abort", () => resolve(), { once: true });
						setTimeout(resolve, ABORT_OBSERVATION_TIMEOUT_MS);
					});
					signal.throwIfAborted();
					refreshCompleted = true;
					return { ...credential, access: "refreshed", refresh: "rotated", expires: Date.now() + 60_000 };
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

		assert.equal(hookEntered, true);
		assert.equal(result.aborted, true);
		await vi.waitFor(async () => {
			assert.equal(refreshCompleted, true);
			const stored = await credentials.read("oauth-signal");
			assert.ok(stored?.type === "oauth");
			assert.equal(stored.refresh, "rotated");
		});
	});
});
