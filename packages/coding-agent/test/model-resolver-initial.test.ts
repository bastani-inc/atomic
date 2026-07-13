import type { Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getSupportedContextWindows } from "../src/core/context-window.ts";
import {
	defaultModelPerProvider,
	findInitialModel,
	restoreModelFromSession,
} from "../src/core/model-resolver.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

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

const cursorBaseModel: Model<"cursor-agent"> = {
	id: "composer-2",
	name: "Composer 2",
	api: "cursor-agent",
	provider: "cursor",
	baseUrl: "https://api2.cursor.sh",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 64000,
};

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
	defaultContextWindow: 400000,
	contextWindowOptions: [400000, 1000000],
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
	test("findInitialModel accepts explicit provider custom model ids", async () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];
		const result = await findInitialModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/ghost-model");
	});
	test("findInitialModel does not synthesize unknown saved settings model ids", async () => {
		const registry = {
			find: () => undefined,
			getAvailable: async () => [cursorBaseModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "cursor",
			defaultModelId: "cursor-compose-2.5",
			defaultThinkingLevel: "medium",
			modelRegistry: registry,
		});
		expect(result.model).toBe(cursorBaseModel);
		expect(result.thinkingLevel).toBe("medium");
	});
	test("findInitialModel accepts an exact authenticated saved settings model", async () => {
		const registry = {
			find: () => cursorBaseModel,
			hasConfiguredAuth: () => true,
			getAvailable: async () => [],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: cursorBaseModel.provider,
			defaultModelId: cursorBaseModel.id,
			defaultThinkingLevel: "medium",
			modelRegistry: registry,
		});
		expect(result.model).toBe(cursorBaseModel);
		expect(result.thinkingLevel).toBe("medium");
	});
	test("restoreModelFromSession rejects unknown Cursor ids that lack exact routing", async () => {
		const registry = {
			find: () => undefined,
			canRestoreUnknownModel: () => false,
			getAvailable: async () => [cursorBaseModel],
		} as unknown as Parameters<typeof restoreModelFromSession>[4];
		const result = await restoreModelFromSession(
			"cursor",
			"cursor-compose-2.5",
			cursorBaseModel,
			false,
			registry,
		);
		expect(result.model).toBe(cursorBaseModel);
		expect(result.model?.id).not.toBe("cursor-compose-2.5");
		expect(result.fallbackMessage).toContain("model no longer exists");
	});
	test("registry and session restore migrate one prior Cursor synthetic id to the canonical row", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set("cursor", { type: "api_key", key: "cursor-test-key" });
		const registry = ModelRegistry.inMemory(authStorage);
		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh",
			apiKey: "cursor-test-key",
			api: "cursor-agent",
			models: [{
				id: "claude-fable-5-1m-max",
				name: "Fable 5 (1M, Max)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				compat: { cursorModelAliases: ["claude-fable-5-context-1m-max-mode-low"] } as Model<"cursor-agent">["compat"],
			}],
		});
		const legacyId = "claude-fable-5-context-1m-max-mode-low";
		const canonical = registry.find("cursor", "claude-fable-5-1m-max");
		expect(registry.find("cursor", legacyId)).toBe(canonical);
		const restored = await restoreModelFromSession("cursor", legacyId, undefined, false, registry);
		expect(restored.model).toBe(canonical);
		expect(restored.model?.id).toBe("claude-fable-5-1m-max");
	});
	test("session restore rejects an ambiguous prior Cursor synthetic id", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set("cursor", { type: "api_key", key: "cursor-test-key" });
		const registry = ModelRegistry.inMemory(authStorage);
		const legacyId = "claude-fable-5-context-1m-max-mode-low";
		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh",
			apiKey: "cursor-test-key",
			api: "cursor-agent",
			models: ["first", "second"].map((id) => ({
				id,
				name: id,
				reasoning: true,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 64_000,
				compat: { cursorModelAliases: [legacyId] } as Model<"cursor-agent">["compat"],
			})),
		});
		const current = registry.find("cursor", "first");
		const restored = await restoreModelFromSession("cursor", legacyId, current, false, registry);
		expect(restored.model).toBe(current);
		expect(restored.model?.id).not.toBe(legacyId);
		expect(restored.fallbackMessage).toContain("model no longer exists");
	});
	test("restoreModelFromSession does not synthesize removed catalog-backed OpenAI ids", async () => {
		const openaiBaseModel = allModels[1]!;
		const registry = {
			find: () => undefined,
			getAvailable: async () => [openaiBaseModel],
			canRestoreUnknownModel: () => false,
		} as unknown as Parameters<typeof restoreModelFromSession>[4];
		const result = await restoreModelFromSession("openai", "gpt-5.6", undefined, false, registry);

		expect(result.model).toBe(openaiBaseModel);
		expect(result.model?.id).not.toBe("gpt-5.6");
		expect(result.fallbackMessage).toContain("model no longer exists");
	});
	test("restoreModelFromSession restores missing ids for registered OpenAI-compatible providers", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
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
			registry,
		);

		expect(result.fallbackMessage).toBeUndefined();
		expect(result.model?.provider).toBe("custom-openai");
		expect(result.model?.id).toBe("newly-discovered-model");
	});
	test("restoreModelFromSession rejects an exact unauthenticated model instead of synthesizing it", async () => {
		const unauthenticatedExact = { ...cursorBaseModel, id: "saved-exact" };
		const registry = {
			find: () => unauthenticatedExact,
			hasConfiguredAuth: () => false,
			getAvailable: async () => [cursorBaseModel],
		} as unknown as Parameters<typeof restoreModelFromSession>[4];
		const result = await restoreModelFromSession("cursor", "saved-exact", undefined, false, registry);
		expect(result.model).toBe(cursorBaseModel);
		expect(result.model?.id).not.toBe("saved-exact");
		expect(result.fallbackMessage).toContain("no auth configured");
	});
	test("restoreModelFromSession scrubs inherited context-window options from fallback models", async () => {
		const registry = {
			find: () => undefined,
			getAvailable: async () => [copilotSelectableBaseModel],
			canRestoreUnknownModel: () => true,
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
		expect(result.model?.defaultContextWindow).toBe(400000);
		expect(result.model?.contextWindowOptions).toBeUndefined();
		expect(result.model ? getSupportedContextWindows(result.model) : []).toEqual([400000]);
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
			getAvailable: async () => [aiGatewayModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});
		expect(result.model?.provider).toBe("vercel-ai-gateway");
		expect(result.model?.id).toBe("anthropic/claude-opus-4-6");
	});
	test("skips an unauthenticated saved default in favor of an available model", async () => {
		const savedModel = allModels[0]!;
		const availableModel = allModels[1]!;
		const registry = {
			find: () => savedModel,
			hasConfiguredAuth: (model: Model<"anthropic-messages">) => model === availableModel,
			getAvailable: async () => [availableModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: savedModel.provider,
			defaultModelId: savedModel.id,
			modelRegistry: registry,
		});

		expect(result.model).toBe(availableModel);
	});
});
