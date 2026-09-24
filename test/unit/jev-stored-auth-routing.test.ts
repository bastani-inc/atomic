import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	inferRouterDecision,
	inferStructuredOutput,
	resolveRouterModel,
} from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	decisionClassifier,
	decisionMessage,
	decisionModel,
	decisionRequest,
	messageStream,
	structuredOutputRequest,
} from "../helpers/structured-output.js";

function classifierWireResponse(body: string) {
	const request = JSON.parse(body) as { questions: Record<string, { criteria: Record<string, string> }> };
	return {
		model: "jev-latest",
		usage: { input_tokens: 20, output_tokens: 10 },
		answers: Object.fromEntries(
			Object.entries(request.questions).map(([id, question]) => {
				const keys = Object.keys(question.criteria);
				const choice = keys.find((key) => key === "review" || key === '"review"' || key === "exact") ?? keys[0]!;
				return [id, { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 }];
			}),
		),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function storedRuntime(key = "mock-stored-jev-key") {
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		credentials: AuthStorage.inMemory({ typesafe: { type: "api_key", key } }),
		allowModelNetwork: false,
	});
	return { runtime, registry: new ModelRegistry(runtime) };
}

for (const environmentKey of ["", "mock-env-jev-key"]) {
	test(`explicit classifier uses saved /login credentials through the registry, env=${Boolean(environmentKey)}`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", environmentKey);
		const { registry } = await storedRuntime();
		const transport = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
			assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer mock-stored-jev-key");
			assert.doesNotMatch(String(options?.body), /mock-stored-jev-key|mock-env-jev-key/);
			return Response.json(classifierWireResponse(String(options?.body)));
		});
		vi.stubGlobal("fetch", transport);
		const request = {
			...decisionRequest(),
			settings: SettingsManager.inMemory({ routerModel: "typesafe/jev-latest" }),
			modelRegistry: registry,
		};
		assert.equal(resolveRouterModel(request).kind, "classifier");
		assert.equal((await inferRouterDecision(request)).model, "typesafe/jev-latest");
		const direct = await inferStructuredOutput({
			...structuredOutputRequest(),
			modelRegistry: registry,
			model: "typesafe/jev-latest",
		});
		assert.equal(direct.model, "typesafe/jev-latest");
		assert.deepEqual(direct.value, { route: "review" });
		assert.equal(transport.mock.calls.length, 2);
		assert.equal(
			registry.getAll().some((model) => model.provider === "typesafe"),
			false,
		);
	});
}

test("saved and ambient classifier credentials do not auto-select a router", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-env-key");
	const { runtime, registry } = await storedRuntime();
	const request = { ...decisionRequest(), settings: SettingsManager.inMemory(), modelRegistry: registry };
	assert.equal(resolveRouterModel(request).kind, "chat");
	await runtime.logout("typesafe");
	assert.equal(resolveRouterModel(request).kind, "chat");
	assert.equal((await registry.getProviderAuth("typesafe"))?.auth.apiKey, "mock-env-key");
	assert.equal(
		resolveRouterModel({ ...request, settings: SettingsManager.inMemory({ routerModel: "auto" }) }).kind,
		"chat",
	);
});

test("classifier runtime failure does not leak private auth diagnostics across fallback", async () => {
	const chat = vi.fn(() => messageStream(decisionMessage({ route: "review" })));
	const result = await inferStructuredOutput({
		...structuredOutputRequest(),
		model: "decision-test/classifier",
		modelRegistry: {
			getAll: () => [decisionModel],
			streamSimple: chat,
			getClassifierModel: () => decisionClassifier,
			classify: async () => {
				throw new Error("private-key-material");
			},
		},
	});
	assert.equal(result.model, "decision-test/chat");
	assert.equal(chat.mock.calls.length, 1);
	assert.doesNotMatch(JSON.stringify(result), /private-key-material/);
});

test("classifier cancellation prevents fallback", async () => {
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const chat = vi.fn(() => messageStream(decisionMessage({ route: "review" })));
	const pending = inferStructuredOutput({
		...structuredOutputRequest(),
		model: "decision-test/classifier",
		signal: controller.signal,
		modelRegistry: {
			getAll: () => [decisionModel],
			streamSimple: chat,
			getClassifierModel: () => decisionClassifier,
			classify: async (_model, _context, options) => {
				assert.equal(options?.signal?.aborted, false);
				entered.resolve();
				return new Promise(() => {});
			},
		},
	});
	await entered.promise;
	controller.abort();
	await assert.rejects(pending, /cancelled/);
	assert.equal(chat.mock.calls.length, 0);
});

test("only chat and registered classifiers can be selected, never image generation", async () => {
	const { runtime, registry } = await storedRuntime();
	const image = runtime.getAllModels("openrouter").find((model) => model.type === "image");
	assert.ok(image);
	const classifier = registry.getClassifierModel("typesafe", "jev-latest");
	assert.ok(classifier);
	const router = { ...decisionRequest(), modelRegistry: registry };
	assert.deepEqual(
		resolveRouterModel({ ...router, settings: SettingsManager.inMemory({ routerModel: "typesafe/jev-latest" }) }),
		{ kind: "classifier", fullId: "typesafe/jev-latest", model: classifier },
	);
	assert.equal(resolveRouterModel({ ...router, settings: SettingsManager.inMemory() }).kind, "chat");
	assert.throws(
		() =>
			resolveRouterModel({
				...router,
				settings: SettingsManager.inMemory({ routerModel: `${image.provider}/${image.id}` }),
			}),
		/Invalid routerModel.*chat or classifier catalog/,
	);
	await assert.rejects(
		inferStructuredOutput({
			...structuredOutputRequest(),
			currentModel: undefined,
			model: `${image.provider}/${image.id}`,
			modelRegistry: registry,
		}),
		/not a chat or classifier model/,
	);
});
