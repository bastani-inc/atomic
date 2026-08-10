import type { Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { defaultModelPerProvider, findInitialModel, restoreModelFromSession } from "../src/core/model-resolver.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const COPILOT_ENV_KEYS = [
	"COPILOT_API_TARGET",
	"GITHUB_COPILOT_BASE_URL",
	"COPILOT_GITHUB_TOKEN",
	"GITHUB_SERVER_URL",
] as const;
const allModels: Model<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		api: "anthropic-messages",
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
	{
		id: "qwen/qwen3-coder:exacto",
		name: "Qwen3 Coder Exacto",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "openai/gpt-4o:extended",
		name: "GPT-4o Extended",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

const copilotSelectableBaseModel: Model<"openai-completions"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-completions",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 64000,
};

describe("default model selection", () => {
	test("openai defaults track current models", () => {
		expect(defaultModelPerProvider.openai).toBe("gpt-5.5");
		expect(defaultModelPerProvider["openai-codex"]).toBe("gpt-5.5");
	});
	test("zai, minimax, cerebras, and ant-ling defaults track current models", () => {
		expect(defaultModelPerProvider.zai).toBe("glm-5.1");
		expect(defaultModelPerProvider.minimax).toBe("MiniMax-M2.7");
		expect(defaultModelPerProvider["minimax-cn"]).toBe("MiniMax-M2.7");
		expect(defaultModelPerProvider.cerebras).toBe("zai-glm-4.7");
		expect(defaultModelPerProvider["ant-ling"]).toBe("Ring-2.6-1T");
	});
	test("ai-gateway default tracks current model", () => {
		expect(defaultModelPerProvider["vercel-ai-gateway"]).toBe("zai/glm-5.1");
	});
	test("Baseten and Qwen Token Plan Individual defaults track current models", () => {
		expect(defaultModelPerProvider.baseten).toBe("zai-org/GLM-5.2");
		expect(defaultModelPerProvider["qwen-token-plan-individual"]).toBe("qwen3.8-max");
	});
	test("findInitialModel accepts explicit provider custom model ids", async () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];
		const result = await findInitialModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			scopedModels: [],
			isContinuing: false,
			modelRuntime: registry instanceof ModelRegistry ? getModelRuntime(registry) : registry,
		});
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/ghost-model");
	});
	test("findInitialModel reports an unusable complete saved default without switching providers", async () => {
		const availableModel = allModels[1]!;
		const registry = {
			getModel: () => undefined,
			getProvider: () => undefined,
			getAvailableSnapshot: () => [availableModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: ["cur", "sor"].join(""),
			defaultModelId: ["composer", "-2"].join(""),
			defaultThinkingLevel: "medium",
			modelRuntime: registry instanceof ModelRegistry ? getModelRuntime(registry) : registry,
		});
		expect(result.model).toBeUndefined();
		expect(result.fallbackMessage).toBe(
			"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.",
		);
		expect(result.fallbackReason).toBe("configured-provider-unsupported");
	});
	test("findInitialModel keeps normal fallback for an unknown model on a supported provider", async () => {
		const availableModel = allModels[1]!;
		const registry = {
			getModel: () => undefined,
			getProvider: (provider: string) => (provider === "openai" ? ({ id: "openai" } as never) : undefined),
			getAvailableSnapshot: () => [availableModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "openai",
			defaultModelId: "unknown-saved-model",
			modelRuntime: registry instanceof ModelRegistry ? getModelRuntime(registry) : registry,
		});
		expect(result.model).toBe(availableModel);
		expect(result.fallbackMessage).toBeUndefined();
		expect(result.fallbackReason).toBeUndefined();
	});
	test("findInitialModel keeps automatic selection permissive when a saved-default field is omitted", async () => {
		const availableModel = allModels[1]!;
		const registry = {
			getAvailableSnapshot: () => [availableModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		for (const partialDefault of [{ defaultProvider: "openai" }, { defaultModelId: "gpt-4o" }]) {
			const result = await findInitialModel({
				scopedModels: [],
				isContinuing: false,
				...partialDefault,
				modelRuntime: registry instanceof ModelRegistry ? getModelRuntime(registry) : registry,
			});
			expect(result.model).toBe(availableModel);
			expect(result.fallbackMessage).toBeUndefined();
		}
	});
	test("findInitialModel resolves a valid authenticated custom-provider default", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		registry.registerProvider("custom-openai", {
			baseUrl: "https://custom.example/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [
				{
					id: "custom-default",
					name: "Custom default",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 4096,
				},
			],
		});

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "custom-openai",
			defaultModelId: "custom-default",
			modelRuntime: registry instanceof ModelRegistry ? getModelRuntime(registry) : registry,
		});
		expect(result.model?.provider).toBe("custom-openai");
		expect(result.model?.id).toBe("custom-default");
		expect(result.fallbackMessage).toBeUndefined();
	});
	test("restoreModelFromSession does not synthesize removed catalog-backed OpenAI ids", async () => {
		const openaiBaseModel = allModels[1]!;
		const registry = {
			getModel: () => undefined,
			getProvider: () => ({ id: "openai" }) as never,
			getAvailableSnapshot: () => [openaiBaseModel],
			canRestoreUnknownModel: () => false,
		} as unknown as Parameters<typeof restoreModelFromSession>[4];
		const result = await restoreModelFromSession("openai", "gpt-5.6", undefined, false, registry);

		expect(result.model).toBe(openaiBaseModel);
		expect(result.model?.id).not.toBe("gpt-5.6");
		expect(result.fallbackMessage).toContain("model no longer exists");
	});
	test("restoreModelFromSession restores missing ids for registered OpenAI-compatible providers", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		registry.registerProvider("custom-openai", {
			baseUrl: "https://custom.example/v1",
			apiKey: "test-key",
			api: "openai-completions",
			models: [
				{
					id: "catalog-template",
					name: "Catalog template",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 4096,
				},
			],
		});

		const result = await restoreModelFromSession(
			"custom-openai",
			"newly-discovered-model",
			undefined,
			false,
			getModelRuntime(registry),
		);

		expect(result.fallbackMessage).toBeUndefined();
		expect(result.model?.provider).toBe("custom-openai");
		expect(result.model?.id).toBe("newly-discovered-model");
	});
	test("restoreModelFromSession rejects an exact unauthenticated model instead of synthesizing it", async () => {
		const unauthenticatedExact = { ...allModels[1]!, id: "saved-exact" };
		const fallbackModel = allModels[0]!;
		const registry = {
			getModel: () => unauthenticatedExact,
			getProvider: () => ({ id: unauthenticatedExact.provider }) as never,
			hasConfiguredAuth: () => false,
			getAvailableSnapshot: () => [fallbackModel],
		} as unknown as Parameters<typeof restoreModelFromSession>[4];
		const result = await restoreModelFromSession("openai", "saved-exact", undefined, false, registry);
		expect(result.model).toBe(fallbackModel);
		expect(result.model?.id).not.toBe("saved-exact");
		expect(result.fallbackMessage).toContain("no auth configured");
	});
	test("restoreModelFromSession restores missing ids from registered provider models", async () => {
		const registry = {
			getModel: () => undefined,
			getProvider: () => ({ id: "github-copilot" }) as never,
			canRestoreUnknownModel: () => true,
			getAvailableSnapshot: () => [copilotSelectableBaseModel],
			hasConfiguredAuth: () => true,
		} as unknown as Parameters<typeof restoreModelFromSession>[4];
		const result = await restoreModelFromSession(
			"github-copilot",
			"future-copilot-model",
			undefined,
			false,
			registry,
		);
		expect(result.fallbackMessage).toBeUndefined();
		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("future-copilot-model");
		expect(result.model?.contextWindow).toBe(400000);
	});
	test("keeps missing Copilot account-policy model IDs eligible for session restoration", async () => {
		const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());

		expect(getModelRuntime(registry).canRestoreUnknownModel("github-copilot")).toBe(true);
	});
	test("restores Individual account policy-fallback Copilot model IDs after runtime refresh", async () => {
		const previousEnvironment = new Map(COPILOT_ENV_KEYS.map((key) => [key, process.env[key]]));
		for (const key of COPILOT_ENV_KEYS) delete process.env[key];
		const policyModelId = "copilot-policy-restoration-probe";
		const storage = AuthStorage.inMemory({
			"github-copilot": { type: "oauth", access: "expired-access", refresh: "refresh-token", expires: 0 },
		});
		try {
			const registry = await createInMemoryModelRegistry(storage);
			const modelRuntime = getModelRuntime(registry);
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
				const url = input.toString();
				if (url === "https://api.github.com/copilot_internal/v2/token") {
					return Response.json({
						token: "tid=test;exp=1;proxy-ep=proxy.individual.githubcopilot.com;st=dotcom",
						expires_at: Math.floor(Date.now() / 1_000) + 3_600,
					});
				}
				if (url === "https://api.individual.githubcopilot.com/models") {
					// Individual accounts can report every picker flag as false while their
					// policies stay enabled, so this catalog is only selectable through the
					// Individual-host policy fallback.
					return Response.json({
						data: [
							{
								id: "gpt-5.4",
								model_picker_enabled: false,
								policy: { state: "enabled" },
								capabilities: { supports: { tool_calls: true } },
							},
							{
								id: policyModelId,
								model_picker_enabled: false,
								policy: { state: "enabled" },
								capabilities: { supports: { tool_calls: true } },
							},
							{
								id: "policy-disabled",
								model_picker_enabled: false,
								policy: { state: "disabled" },
								capabilities: { supports: { tool_calls: true } },
							},
							{
								id: "embeddings-only",
								model_picker_enabled: false,
								policy: { state: "enabled" },
								capabilities: { supports: { tool_calls: false } },
							},
						],
					});
				}
				if (url.includes("/api/models/providers/")) return new Response("not found", { status: 404 });
				throw new Error(`Unexpected fetch: ${url}`);
			});

			const refreshed = await modelRuntime.refresh({ providers: ["github-copilot"], allowNetwork: true });
			expect(refreshed.errors.size).toBe(0);
			expect(await storage.read("github-copilot")).toMatchObject({
				type: "oauth",
				availableModelIds: ["gpt-5.4", policyModelId],
			});
			expect(
				modelRuntime
					.getAvailableSnapshot()
					.filter((model) => model.provider === "github-copilot")
					.map((model) => model.id),
			).toEqual(["gpt-5.4"]);
			expect(modelRuntime.getModel("github-copilot", policyModelId)).toBeUndefined();

			const restored = await restoreModelFromSession(
				"github-copilot",
				policyModelId,
				undefined,
				false,
				modelRuntime,
			);
			const template = modelRuntime.getModel("github-copilot", "gpt-5.4");
			expect(restored.fallbackMessage).toBeUndefined();
			expect(restored.model).toMatchObject({
				provider: "github-copilot",
				id: policyModelId,
				name: policyModelId,
				contextWindow: template?.contextWindow,
			});
		} finally {
			vi.restoreAllMocks();
			for (const key of COPILOT_ENV_KEYS) {
				const value = previousEnvironment.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
	test("findInitialModel selects ai-gateway default when available", async () => {
		const aiGatewayModel: Model<"anthropic-messages"> = {
			id: "anthropic/claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
			contextWindow: 200000,
			maxTokens: 8192,
		};
		const registry = {
			getAvailableSnapshot: () => [aiGatewayModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRuntime: registry instanceof ModelRegistry ? getModelRuntime(registry) : registry,
		});
		expect(result.model?.provider).toBe("vercel-ai-gateway");
		expect(result.model?.id).toBe("anthropic/claude-opus-4-6");
	});
	test("keeps normal fallback for an unauthenticated model on a supported provider", async () => {
		const savedModel = allModels[0]!;
		const availableModel = allModels[1]!;
		const registry = {
			getModel: () => savedModel,
			getProvider: (provider: string) => provider === savedModel.provider,
			hasConfiguredAuth: (model: Model<"anthropic-messages">) => model === availableModel,
			getAvailableSnapshot: () => [availableModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: savedModel.provider,
			defaultModelId: savedModel.id,
			modelRuntime: registry instanceof ModelRegistry ? getModelRuntime(registry) : registry,
		});

		expect(result.model).toBe(availableModel);
		expect(result.fallbackMessage).toBeUndefined();
	});
});
