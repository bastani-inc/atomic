import assert from "node:assert/strict";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { describe, expect, it } from "vitest";
import { createModels, createProvider, getModelType } from "../src/models.ts";
import {
	builtinModels,
	getAllBuiltinModels,
	getBuiltinClassifierModel,
	getBuiltinClassifierModels,
} from "../src/providers/all.ts";
import type { Api, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function classifierModel(provider: string, id: string): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id,
		name: id,
		api: "test-classifier",
		provider,
		baseUrl: "https://example.test/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
	};
}

function chatModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "test-chat",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

const context: ClassifierContext = {
	state: { text: "yes" },
	questions: {
		approved: {
			type: "bool",
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

describe("Models with classifier models", () => {
	it("keeps chat and classifier entries with the same provider and id separate", async () => {
		const chat = chatModel("test", "shared");
		const classifier = classifierModel("test", "shared");
		const provider = createProvider({
			id: "test",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [chat, classifier],
			api: {
				"test-chat": {
					stream: () => new AssistantMessageEventStream(),
					streamSimple: () => new AssistantMessageEventStream(),
				},
			},
			classifiers: {
				"test-classifier": {
					classify: async (model): Promise<ClassifierResult> => ({
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers: { approved: { type: "bool", probability: 0.9 } },
						stopReason: "stop",
						timestamp: Date.now(),
					}),
				},
			},
		});
		const models = createModels();
		models.setProvider(provider);

		const listedChat = models.getModel("test", "shared");
		expect(listedChat && getModelType(listedChat)).toBe("chat");
		expect(models.getModelOfType("classifier", "test", "shared")?.type).toBe("classifier");
		expect(models.getModelsOfType("classifier")).toEqual([classifier]);
		expect(models.getAllModels()).toHaveLength(2);
		expect(await models.getAvailableOfType("classifier")).toEqual([classifier]);
		expect((await models.classify(classifier, context)).answers.approved).toEqual({
			type: "bool",
			probability: 0.9,
		});
	});

	it("rejects chat models at the classifier entry point at runtime", async () => {
		const chat = chatModel("test", "chat");
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "test",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [chat],
				api: {
					stream: () => new AssistantMessageEventStream(),
					streamSimple: () => new AssistantMessageEventStream(),
				},
			}),
		);

		const result = await models.classify(chat as unknown as ClassifierModel<ClassifierApi>, context);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("is not a classifier model");
	});

	it("exposes Jev only through classifier catalog accessors", () => {
		const jev = getBuiltinClassifierModel("typesafe", "jev-latest");
		expect(jev).toMatchObject({
			type: "classifier",
			api: "typesafe-system-one",
			provider: "typesafe",
			contextWindow: 64000,
		});
		expect(getBuiltinClassifierModels("typesafe")).toEqual([jev]);
		expect(getAllBuiltinModels("typesafe")).toEqual([jev]);

		const models = builtinModels();
		expect(models.getModel("typesafe", "jev-latest")).toBeUndefined();
		expect(models.getModelOfType("classifier", "typesafe", "jev-latest")).toEqual(jev);
	});

	it("rejects images for classifier models without image input before calling the provider", async () => {
		const classifier = classifierModel("test", "text-only");
		let calls = 0;
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "test",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [classifier],
				classifiers: {
					"test-classifier": {
						classify: async (): Promise<ClassifierResult> => {
							calls++;
							return {
								api: classifier.api,
								provider: classifier.provider,
								model: classifier.id,
								answers: {},
								stopReason: "stop",
								timestamp: Date.now(),
							};
						},
					},
				},
			}),
		);

		const result = await models.classify(classifier, {
			...context,
			images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		});
		const withoutImages = await models.classify(classifier, { ...context, images: [] });

		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "Model test/text-only does not accept image input");
		assert.equal(withoutImages.stopReason, "stop");
		assert.equal(calls, 1);
	});

	it("routes OpenAI GPT-6 Luna through the Decisions API with images", async () => {
		const models = builtinModels();
		const luna = models.getModelOfType("classifier", "openai", "gpt-6-luna");
		assert(luna);
		assert.equal(luna.api, "openai-decisions");
		assert.deepEqual(luna.input, ["text", "image"]);
		assert.equal(luna.contextWindow, 922000);
		assert.equal(models.getModel("openai", "gpt-6-luna")?.api, "openai-responses");

		const urls: string[] = [];
		const result = await models.classify(
			luna,
			{ ...context, images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
			{
				apiKey: "secret",
				fetch: async (input) => {
					urls.push(String(input));
					return Response.json({ answers: [{ type: "predicate", name: "approved", probability: 0.8 }] });
				},
			},
		);

		assert.deepEqual(urls, ["https://api.openai.com/v1/decisions"]);
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.answers.approved, { type: "bool", probability: 0.8 });
	});

	it("lists OpenAI Decisions models only for API key credentials", async () => {
		const apiKeyStore = new InMemoryCredentialStore();
		await apiKeyStore.modify("openai", async () => ({ type: "api_key", key: "secret" }));
		const oauthStore = new InMemoryCredentialStore();
		await oauthStore.modify("openai", async () => ({
			type: "oauth",
			access: "access",
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
		}));

		const withApiKey = builtinModels({ credentials: apiKeyStore });
		const withOAuth = builtinModels({ credentials: oauthStore });

		assert.deepEqual((await withApiKey.getAvailableOfType("classifier", "openai")).map((model) => model.id), [
			"gpt-6-luna",
		]);
		assert.deepEqual(await withOAuth.getAvailableOfType("classifier", "openai"), []);
		assert((await withOAuth.getAvailable("openai")).some((model) => model.id === "gpt-6-luna"));
	});

	it("routes OpenRouter classifier models through the System One API", () => {
		const models = builtinModels();
		for (const model of getBuiltinClassifierModels("openrouter")) {
			expect(model).toMatchObject({ api: "typesafe-system-one", baseUrl: "https://openrouter.ai/api/v1" });
			expect(models.getModel("openrouter", model.id)).toBeUndefined();
			expect(models.getModelOfType("classifier", "openrouter", model.id)).toEqual(model);
		}
	});
	it("routes Jev classifiers on Gateway and Zen without exposing them as chat models", () => {
		const models = builtinModels();
		const gateway = models.getModelOfType("classifier", "vercel-ai-gateway", "typesafe-ai/jev");
		expect(gateway).toMatchObject({
			api: "typesafe-system-one",
			baseUrl: "https://ai-gateway.vercel.sh/typesafe/v1",
		});
		for (const id of ["jev-1.13", "jev-1.13-free"]) {
			expect(models.getModelOfType("classifier", "opencode", id)).toMatchObject({
				api: "typesafe-system-one",
				baseUrl: "https://opencode.ai/zen/v1",
			});
			expect(models.getModel("opencode", id)).toBeUndefined();
		}
		expect(models.getModel("vercel-ai-gateway", "typesafe-ai/jev")).toBeUndefined();
	});
});
