import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import { _getRequiredRequestAuth } from "../src/core/agent-session-models.ts";

/**
 * Companion to `model-registry-header-suppression.test.ts`, which covers
 * `ModelRegistry.getApiKeyAndHeaders`. `_getRequiredRequestAuth` is the *other*
 * resolved-auth entry point, and its callers issue real outbound requests:
 * `agent-session-tree.ts` forwards its headers into `generateBranchSummary`, and
 * the compaction modules use it for planner and compaction model calls.
 *
 * `ProviderHeaders` is `Record<string, string | null>` and pi documents a null
 * value as suppressing the provider/API default header of the same name, so a
 * marker must survive this function untouched. It previously declared
 * `headers?: ProviderHeaders` while filtering every null out of the body.
 */

const model = { id: "test-model", provider: "test-provider", api: "openai-completions" } as Model<Api>;

function sessionWithResolvedHeaders(headers: Record<string, string | null>): AgentSessionInternalSurface {
	return {
		_modelRuntime: {
			getAuth: async () => ({ auth: { apiKey: "k", headers } }),
			isUsingOAuth: () => false,
		},
	} as unknown as AgentSessionInternalSurface;
}

describe("_getRequiredRequestAuth header suppression markers", () => {
	it("preserves a null suppression marker alongside a real header", async () => {
		const session = sessionWithResolvedHeaders({ "x-keep": "kept", "x-suppress": null });

		const auth = await _getRequiredRequestAuth.call(session, model);

		// The marker must be present AND null, not dropped and not coerced.
		expect(auth.headers).toEqual({ "x-keep": "kept", "x-suppress": null });
		expect(Object.hasOwn(auth.headers ?? {}, "x-suppress")).toBe(true);
		expect(auth.headers?.["x-suppress"]).toBeNull();
	});

	it("preserves a marker that is the only configured header", async () => {
		const session = sessionWithResolvedHeaders({ "x-suppress": null });

		const auth = await _getRequiredRequestAuth.call(session, model);

		// Stripping used to leave an empty object here, which reads as
		// "no headers configured" and silently sends the provider default on
		// every compaction and branch-summary request.
		expect(auth.headers).toEqual({ "x-suppress": null });
	});

	it("returns the api key, endpoint, and env alongside preserved markers", async () => {
		const session = {
			_modelRuntime: {
				getAuth: async () => ({
					auth: {
						apiKey: "secret",
						baseUrl: "https://api.enterprise.githubcopilot.com",
						headers: { "x-suppress": null },
					},
					env: { SOME_VAR: "value" },
				}),
				isUsingOAuth: () => false,
			},
		} as unknown as AgentSessionInternalSurface;

		const auth = await _getRequiredRequestAuth.call(session, model);

		expect(auth.apiKey).toBe("secret");
		expect(auth.baseUrl).toBe("https://api.enterprise.githubcopilot.com");
		expect(auth.env).toEqual({ SOME_VAR: "value" });
		expect(auth.headers).toEqual({ "x-suppress": null });
	});
});
