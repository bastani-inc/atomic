import assert from "node:assert/strict";
import { getDecisionModels } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import {
	getStructuredOutputProviders,
	inferRouterDecision,
	inferStructuredOutput,
} from "../../packages/coding-agent/src/core/structured-output/index.js";
import { decisionRequest, jevResponse } from "../helpers/structured-output.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const gateways = [
	{
		fullId: "vercel-ai-gateway/typesafe-ai/jev",
		providerId: "vercel-ai-gateway",
		wireModel: "typesafe-ai/jev",
		endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
		apiKeyEnv: "AI_GATEWAY_API_KEY",
		modelsDevProvider: "vercel",
	},
	{
		fullId: "opencode/jev-1.13",
		providerId: "opencode",
		wireModel: "jev-1.13",
		endpoint: "https://opencode.ai/zen/v1/systemone",
		apiKeyEnv: "OPENCODE_API_KEY",
		modelsDevProvider: "opencode",
	},
	{
		fullId: "opencode/jev-1.13-free",
		providerId: "opencode",
		wireModel: "jev-1.13-free",
		endpoint: "https://opencode.ai/zen/v1/systemone",
		apiKeyEnv: "OPENCODE_API_KEY",
		modelsDevProvider: "opencode",
	},
] as const;

test("gateway Jev registrations come from the models.dev decision catalog", () => {
	const providers = getStructuredOutputProviders();
	assert.deepEqual(
		providers.slice(0, 2).map((provider) => provider.fullId),
		["typesafe/jev-latest", "openrouter/~typesafe/jev-latest"],
	);
	for (const gateway of gateways) {
		const provider = providers.find((candidate) => candidate.fullId === gateway.fullId);
		assert.ok(provider, `${gateway.fullId} is registered`);
		assert.equal(provider.id, gateway.providerId);
		assert.equal(provider.wireModel, gateway.wireModel);
		assert.equal(provider.endpoint, gateway.endpoint);
		assert.equal(provider.apiKeyEnv, gateway.apiKeyEnv);
		assert.equal(provider.capabilities.maxChoiceOptions, 255);
		const catalog = getDecisionModels().find(
			(model) => model.provider === gateway.modelsDevProvider && model.id === gateway.wireModel,
		);
		assert.ok(catalog, `${gateway.fullId} has a models.dev decision row`);
		assert.equal(provider.contextWindow, catalog.contextWindow);
		assert.deepEqual(provider.cost, catalog.cost);
	}
	// Catalog rows without a verified systemone transport stay out of the registration list.
	assert.ok(getDecisionModels().some((model) => model.provider === "cloudflare-ai-gateway"));
	assert.ok(!providers.some((provider) => provider.id === "cloudflare-ai-gateway"));
	assert.ok(!providers.some((provider) => provider.id === "nano-gpt" || provider.id === "vivgrid"));
});

for (const gateway of gateways) {
	for (const method of ["api_key", "environment"] as const) {
		test(`${gateway.fullId} uses existing ${method} auth and the provider systemone endpoint`, async () => {
			vi.stubEnv("TYPESAFE_API_KEY", "synthetic-wrong-provider");
			vi.stubEnv(gateway.apiKeyEnv, "synthetic-env");
			const credentials = AuthStorage.inMemory({
				typesafe: { type: "api_key", key: "synthetic-wrong-stored" },
				...(method === "api_key"
					? { [gateway.providerId]: { type: "api_key" as const, key: "synthetic-api_key" } }
					: {}),
			});
			const runtime = await ModelRuntime.create({ modelsPath: null, credentials, allowModelNetwork: false });
			const registry = new ModelRegistry(runtime);
			const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				assert.equal(url, gateway.endpoint);
				assert.equal(init?.redirect, "error");
				assert.equal(
					new Headers(init?.headers).get("Authorization"),
					`Bearer synthetic-${method === "environment" ? "env" : method}`,
				);
				const body = JSON.parse(String(init?.body));
				assert.equal(body.model, gateway.wireModel);
				assert.deepEqual(body.state, decisionRequest().state);
				assert.equal(body.questions.route.type, "choice");
				assert.doesNotMatch(String(init?.body), /synthetic-/);
				return Response.json({ ...jevResponse(), model: "jev-1.13.0" });
			});
			vi.stubGlobal("fetch", transport);
			const request = {
				...decisionRequest(),
				modelRegistry: registry,
				settings: { getRouterModel: () => gateway.fullId },
			};
			const routed = await inferRouterDecision(request);
			assert.equal(routed.model, gateway.fullId);
			assert.equal(routed.responseModel, "jev-1.13.0");
			assert.deepEqual(routed.value, { route: "review", limit: 1.23456789 });
			const direct = await inferStructuredOutput({ ...request, model: { kind: "jev", fullId: gateway.fullId } });
			assert.equal(direct.model, gateway.fullId);
			assert.equal(transport.mock.calls.length, 2);
		});
	}

	test(`${gateway.fullId} does not use TypeSafe or OpenRouter credentials when its own auth is missing`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "synthetic-wrong-provider");
		vi.stubEnv("OPENROUTER_API_KEY", "synthetic-wrong-provider");
		vi.stubEnv(gateway.apiKeyEnv, "");
		const runtime = await ModelRuntime.create({
			modelsPath: null,
			credentials: AuthStorage.inMemory({
				typesafe: { type: "api_key", key: "synthetic-wrong-stored" },
				openrouter: { type: "api_key", key: "synthetic-wrong-stored" },
			}),
			allowModelNetwork: false,
		});
		const transport = vi.fn();
		vi.stubGlobal("fetch", transport);
		await assert.rejects(
			inferRouterDecision({
				...decisionRequest(),
				currentModel: undefined,
				modelRegistry: new ModelRegistry(runtime),
				settings: { getRouterModel: () => gateway.fullId },
			}),
			new RegExp(`${gateway.providerId}/.*requires an API key.*/login ${gateway.providerId}.*${gateway.apiKeyEnv}`),
		);
		assert.equal(transport.mock.calls.length, 0);
	});
}

test("minimal adapters use only the gateway environment key", async () => {
	vi.stubEnv("OPENCODE_API_KEY", "synthetic-opencode");
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-typesafe");
	const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-opencode");
		return Response.json(jevResponse());
	});
	vi.stubGlobal("fetch", transport);
	await inferStructuredOutput({ ...decisionRequest(), model: { kind: "jev", fullId: "opencode/jev-1.13-free" } });
	assert.equal(transport.mock.calls.length, 1);
});

test("gateway Jev selections are explicit-only and never chosen automatically", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	vi.stubEnv("OPENCODE_API_KEY", "synthetic-opencode");
	vi.stubEnv("AI_GATEWAY_API_KEY", "synthetic-vercel");
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	await assert.rejects(
		inferRouterDecision({ ...decisionRequest(), settings: { getRouterModel: () => "" }, currentModel: undefined }),
		/Router inference needs a selected chat model, configured Jev credentials, or an explicit routerModel/,
	);
	assert.equal(transport.mock.calls.length, 0);
});
