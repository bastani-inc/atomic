import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { fakeModelRuntime } from "./model-runtime-test-utils.ts";

/**
 * `ProviderHeaders` is `Record<string, string | null>`, and pi documents a null
 * value as "suppresses a provider/API default header with the same name"
 * (pi-ai `types.d.ts`). The marker only works if it survives all the way to the
 * request layer, so `getApiKeyAndHeaders` must pass it through untouched rather
 * than filtering it out.
 */

const model = { id: "test-model", provider: "test-provider", api: "openai-completions" } as Model<Api>;

describe("getApiKeyAndHeaders header suppression markers", () => {
	it("preserves a null suppression marker from resolved auth", async () => {
		const registry = new ModelRegistry(
			fakeModelRuntime({
				getAuth: async () => ({
					auth: { apiKey: "k", headers: { "x-keep": "kept", "x-suppress": null } },
				}),
			}),
		);

		const auth = await registry.getApiKeyAndHeaders(model);

		expect(auth.ok).toBe(true);
		if (!auth.ok) return;
		// The marker must be present AND null, not dropped and not coerced.
		expect(auth.headers).toEqual({ "x-keep": "kept", "x-suppress": null });
		expect(Object.hasOwn(auth.headers ?? {}, "x-suppress")).toBe(true);
		expect(auth.headers?.["x-suppress"]).toBeNull();
	});

	it("preserves a null suppression marker on the compatibility path", async () => {
		const registry = new ModelRegistry(
			fakeModelRuntime({
				getAuth: async () => undefined,
				getCompatibilityRequestConfig: () => ({
					authHeader: false,
					headers: { "x-keep": "kept", "x-suppress": null },
				}),
			}),
		);

		const auth = await registry.getApiKeyAndHeaders(model);

		expect(auth.ok).toBe(true);
		if (!auth.ok) return;
		expect(auth.headers).toEqual({ "x-keep": "kept", "x-suppress": null });
		expect(auth.headers?.["x-suppress"]).toBeNull();
	});

	it("preserves a marker that is the only configured header", async () => {
		const registry = new ModelRegistry(
			fakeModelRuntime({
				getAuth: async () => ({ auth: { apiKey: "k", headers: { "x-suppress": null } } }),
			}),
		);

		const auth = await registry.getApiKeyAndHeaders(model);

		expect(auth.ok).toBe(true);
		if (!auth.ok) return;
		// Stripping used to leave an empty object here, which reads as
		// "no headers configured" and silently sends the provider default.
		expect(auth.headers).toEqual({ "x-suppress": null });
	});

	it("forwards a credential-specific endpoint beside null header markers", async () => {
		const registry = new ModelRegistry(
			fakeModelRuntime({
				getAuth: async () => ({
					auth: {
						apiKey: "k",
						baseUrl: "https://api.enterprise.githubcopilot.com",
						headers: { "x-suppress": null },
					},
				}),
			}),
		);

		const auth = await registry.getApiKeyAndHeaders(model);

		expect(auth.ok).toBe(true);
		if (!auth.ok) return;
		expect(auth.baseUrl).toBe("https://api.enterprise.githubcopilot.com");
		expect(auth.headers).toEqual({ "x-suppress": null });
	});
});
