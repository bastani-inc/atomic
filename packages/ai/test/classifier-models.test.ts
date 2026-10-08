import assert from "node:assert/strict";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { Credential } from "../src/auth/types.ts";
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

	it("routes OpenAI GPT-6 Luna Decisions through the Decisions API with images", async () => {
		const models = builtinModels();
		const luna = models.getModelOfType("classifier", "openai-decisions", "gpt-6-luna");
		assert(luna);
		assert.equal(luna.api, "openai-decisions");
		assert.equal(luna.name, "GPT-6 Luna Decisions");
		assert.deepEqual(luna.input, ["text", "image"]);
		assert.equal(luna.contextWindow, 922000);
		assert.equal(models.getModel("openai", "gpt-6-luna")?.api, "openai-responses");
		assert.equal(models.getModelOfType("classifier", "openai", "gpt-6-luna"), undefined);
		assert.equal(models.getModel("openai-decisions", "gpt-6-luna"), undefined);

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

	it("keeps OpenAI Decisions on an API key while openai uses a ChatGPT subscription", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai", async () => ({
			type: "oauth",
			access: "access",
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
		}));
		const models = builtinModels({
			credentials,
			authContext: { env: async (name) => (name === "OPENAI_API_KEY" ? "sk-key" : undefined), fileExists: async () => false },
		});

		assert.deepEqual(
			(await models.getAvailableOfType("classifier", "openai-decisions")).map((model) => model.id),
			["gpt-6-luna"],
		);
		assert.equal((await models.getAuth("openai-decisions"))?.source, "OPENAI_API_KEY");
		assert.equal((await models.checkAuth("openai"))?.type, "oauth");
		assert((await models.getAvailable("openai")).some((model) => model.id === "gpt-6-luna"));
	});

	it("has no login of its own and rejects login attempts", async () => {
		const models = builtinModels();
		const apiKey = models.getProvider("openai-decisions")?.auth.apiKey;
		assert(apiKey);
		assert.equal(apiKey.login, undefined);
		assert.equal(models.getProvider("openai-decisions")?.auth.oauth, undefined);
		await assert.rejects(
			models.login("openai-decisions", "api_key", {
				prompt: async () => "sk-typed",
				notify: () => {},
			}),
			/does not support api_key login/,
		);
	});

	describe("OpenAI Decisions shared credential", () => {
		const noEnv = { env: async () => undefined, fileExists: async () => false };

		function decisionsModels(options: { stored?: Record<string, Credential>; env?: string } = {}) {
			const credentials = new InMemoryCredentialStore();
			const seeded = Promise.all(
				Object.entries(options.stored ?? {}).map(([providerId, credential]) =>
					credentials.modify(providerId, async () => credential),
				),
			);
			const models = builtinModels({
				credentials,
				authContext: options.env
					? { env: async (name) => (name === "OPENAI_API_KEY" ? options.env : undefined), fileExists: async () => false }
					: noEnv,
			});
			return { models, seeded };
		}

		const apiKey = (key: string): Credential => ({ type: "api_key", key });
		const oauth: Credential = { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000 };

		async function availableIds(models: ReturnType<typeof builtinModels>): Promise<string[]> {
			return (await models.getAvailableOfType("classifier", "openai-decisions")).map((model) => model.id);
		}

		it("resolves from an API key stored for openai-api", async () => {
			const { models, seeded } = decisionsModels({ stored: { "openai-api": apiKey("sk-openai-api") } });
			await seeded;
			assert.deepEqual(await availableIds(models), ["gpt-6-luna"]);
			assert.equal((await models.getAuth("openai-decisions"))?.auth.apiKey, "sk-openai-api");
			assert.equal((await models.checkAuth("openai-decisions"))?.type, "api_key");
			assert.deepEqual(
				(await models.getAllAvailable("openai-decisions")).map((model) => model.id),
				["gpt-6-luna"],
			);
		});

		it("resolves from an API key stored for openai", async () => {
			const { models, seeded } = decisionsModels({ stored: { openai: apiKey("sk-openai") } });
			await seeded;
			assert.deepEqual(await availableIds(models), ["gpt-6-luna"]);
			assert.equal((await models.getAuth("openai-decisions"))?.auth.apiKey, "sk-openai");
		});

		it("prefers openai-api over openai over OPENAI_API_KEY", async () => {
			const stored = { "openai-api": apiKey("sk-openai-api"), openai: apiKey("sk-openai") };
			const both = decisionsModels({ stored, env: "sk-env" });
			await both.seeded;
			assert.equal((await both.models.getAuth("openai-decisions"))?.auth.apiKey, "sk-openai-api");

			const openaiOnly = decisionsModels({ stored: { openai: stored.openai }, env: "sk-env" });
			await openaiOnly.seeded;
			assert.equal((await openaiOnly.models.getAuth("openai-decisions"))?.auth.apiKey, "sk-openai");
		});

		it("ignores a ChatGPT OAuth login on openai", async () => {
			const withoutKey = decisionsModels({ stored: { openai: oauth } });
			await withoutKey.seeded;
			assert.deepEqual(await availableIds(withoutKey.models), []);
			assert.equal(await withoutKey.models.getAuth("openai-decisions"), undefined);
			assert.equal(await withoutKey.models.checkAuth("openai-decisions"), undefined);
			assert.equal((await withoutKey.models.checkAuth("openai"))?.type, "oauth");

			const withEnv = decisionsModels({ stored: { openai: oauth }, env: "sk-env" });
			await withEnv.seeded;
			assert.deepEqual(await availableIds(withEnv.models), ["gpt-6-luna"]);
			const resolution = await withEnv.models.getAuth("openai-decisions");
			assert.equal(resolution?.auth.apiKey, "sk-env");
			assert.equal(resolution?.source, "OPENAI_API_KEY");
		});

		it("falls back to OPENAI_API_KEY", async () => {
			const { models } = decisionsModels({ env: "sk-env" });
			assert.deepEqual(await availableIds(models), ["gpt-6-luna"]);
			assert.equal((await models.getAuth("openai-decisions"))?.auth.apiKey, "sk-env");
		});

		it("is unavailable without any OpenAI API credential", async () => {
			const { models } = decisionsModels();
			assert.deepEqual(await availableIds(models), []);
			assert.equal(await models.getAuth("openai-decisions"), undefined);
			assert.equal(await models.checkAuth("openai-decisions"), undefined);
		});

		it("sends the borrowed key when classifying", async () => {
			const { models, seeded } = decisionsModels({ stored: { "openai-api": apiKey("sk-openai-api") } });
			await seeded;
			const luna = models.getModelOfType("classifier", "openai-decisions", "gpt-6-luna");
			assert(luna);
			const authorizations: Array<string | null> = [];
			const result = await models.classify(
				luna,
				{ ...context },
				{
					fetch: async (_input, init) => {
						authorizations.push(new Headers(init?.headers).get("authorization"));
						return Response.json({ answers: [{ type: "predicate", name: "approved", probability: 0.8 }] });
					},
				},
			);

			assert.deepEqual(authorizations, ["Bearer sk-openai-api"]);
			assert.equal(result.stopReason, "stop");
		});
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
