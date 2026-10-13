import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { resolveRestoredModelReference } from "../../packages/coding-agent/src/core/model-resolver.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { resolveRouterModel, routeModel } from "../../packages/coding-agent/src/core/structured-output/index.js";
import { decisionRequest } from "../helpers/structured-output.js";

const OPENROUTER_KEY = "mock-openrouter-key";
const ALLOWED_CHAT_MODEL = "~anthropic/claude-sonnet-latest";
const JEV = "~typesafe/jev-latest";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function classifierWireResponse(body: string) {
	const request = JSON.parse(body) as { questions: Record<string, { criteria: Record<string, string> }> };
	return {
		model: JEV,
		usage: { input_tokens: 20, output_tokens: 10 },
		answers: Object.fromEntries(
			Object.entries(request.questions).map(([id, question]) => {
				const keys = Object.keys(question.criteria);
				const choice = keys.find((key) => key === "review" || key === '"review"') ?? keys[0]!;
				return [id, { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 }];
			}),
		),
	};
}

/**
 * pi.dev has no newer OpenRouter catalog, `/models/user` allows a single chat model, and the
 * System One endpoint answers classifier calls.
 */
function stubOpenRouter() {
	const transport = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/api/models/providers/openrouter")) return new Response("not found", { status: 404 });
		if (url === "https://openrouter.ai/api/v1/models/user") {
			assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${OPENROUTER_KEY}`);
			return Response.json({
				data: [{ id: ALLOWED_CHAT_MODEL, top_provider: { context_length: 123_456, max_completion_tokens: 4_321 } }],
			});
		}
		if (url === "https://openrouter.ai/api/v1/systemone") {
			assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${OPENROUTER_KEY}`);
			return Response.json(classifierWireResponse(String(options?.body)));
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	vi.stubGlobal("fetch", transport);
	return transport;
}

async function openRouterRuntime(modelsStore = new InMemoryCodingAgentModelsStore()) {
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		modelsStore,
		credentials: AuthStorage.inMemory({ openrouter: { type: "api_key", key: OPENROUTER_KEY } }),
		allowModelNetwork: false,
	});
	return { runtime, registry: new ModelRegistry(runtime), modelsStore };
}

test("a personalized OpenRouter catalog keeps Jev routable and saved chat IDs restorable", async () => {
	vi.stubEnv("OPENROUTER_API_KEY", "");
	const transport = stubOpenRouter();
	const { runtime, registry, modelsStore } = await openRouterRuntime();

	const refreshed = await runtime.refresh({ providers: ["openrouter"], allowNetwork: true });
	assert.deepEqual([...refreshed.errors], []);

	// Only the chat model the key may use is listed, with the key's limits.
	const chat = runtime.getModels("openrouter");
	assert.deepEqual(
		chat.map((model) => model.id),
		[ALLOWED_CHAT_MODEL],
	);
	assert.equal(chat[0]?.contextWindow, 123_456);
	assert.equal(chat[0]?.maxTokens, 4_321);

	// /models/user lists chat models only, so the Jev classifier stays in the catalog and routes.
	assert.ok(registry.getClassifierModel("openrouter", JEV));
	const request = {
		...decisionRequest(),
		settings: SettingsManager.inMemory({ routerModel: `openrouter/${JEV}` }),
		modelRegistry: registry,
	};
	assert.equal(resolveRouterModel(request).kind, "classifier");
	assert.equal((await routeModel(request)).model, `openrouter/${JEV}`);
	assert.ok(transport.mock.calls.some(([url]) => String(url) === "https://openrouter.ai/api/v1/systemone"));

	// A session saved with a model the key can no longer list still restores.
	const restored = await resolveRestoredModelReference("openrouter", "vendor/removed-model", runtime);
	assert.equal(restored?.provider, "openrouter");
	assert.equal(restored?.id, "vendor/removed-model");

	// The saved list replaces the catalog offline, and Jev is still there.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("offline");
		}),
	);
	const offline = await openRouterRuntime(modelsStore);
	assert.deepEqual(
		offline.runtime.getModels("openrouter").map((model) => model.id),
		[ALLOWED_CHAT_MODEL],
	);
	assert.ok(offline.registry.getClassifierModel("openrouter", JEV));
});
