import type { Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { getSupportedContextWindows } from "../src/core/context-window.ts";
import {
	defaultModelPerProvider,
	findInitialModel,
	restoreModelFromSession,
} from "../src/core/model-resolver.ts";

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
	test("findInitialModel restores saved custom Cursor model ids from an authenticated provider template", async () => {
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
		expect(result.model?.provider).toBe("cursor");
		expect(result.model?.id).toBe("cursor-compose-2.5");
		expect(result.model?.api).toBe("cursor-agent");
		expect(result.thinkingLevel).toBe("medium");
	});
	test("restoreModelFromSession restores saved custom Cursor model ids from an authenticated provider template", async () => {
		const registry = {
			find: () => undefined,
			getAvailable: async () => [cursorBaseModel],
		} as unknown as Parameters<typeof restoreModelFromSession>[4];
		const result = await restoreModelFromSession(
			"cursor",
			"cursor-compose-2.5",
			undefined,
			false,
			registry,
		);
		expect(result.fallbackMessage).toBeUndefined();
		expect(result.model?.provider).toBe("cursor");
		expect(result.model?.id).toBe("cursor-compose-2.5");
		expect(result.model?.api).toBe("cursor-agent");
	});
	test("restoreModelFromSession scrubs inherited context-window options from fallback models", async () => {
		const registry = {
			find: () => undefined,
			getAvailable: async () => [copilotSelectableBaseModel],
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
});
