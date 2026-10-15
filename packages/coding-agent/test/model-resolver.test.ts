import type { Api, Model } from "@bastani/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { type ModelReferenceRequest, resolveCliModel, resolveModelReference } from "../src/core/model-resolver.ts";
import { findPreferredAvailableModel } from "../src/core/model-resolver-defaults.ts";

// Mock models for testing
const mockModels: Model<"anthropic-messages">[] = [
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
		api: "anthropic-messages", // Using same type for simplicity
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

// Mock OpenRouter models with colons in IDs
const mockOpenRouterModels: Model<"anthropic-messages">[] = [
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

const allModels = [...mockModels, ...mockOpenRouterModels];

const openaiCodexBaseModel: Model<"anthropic-messages"> = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	api: "anthropic-messages",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
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
	maxTokens: 64000,
};

function referenceModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

const referenceCatalog = [
	referenceModel("anthropic", "claude-sonnet-4-5"),
	referenceModel("anthropic", "claude-sonnet-4-5-20250929"),
	referenceModel("anthropic", "claude-opus-4-8"),
	referenceModel("anthropic", "exact"),
	// Fuzzy-matches "shared"; an ambiguous exact "shared" must not fall through to it.
	referenceModel("anthropic", "shared-pro"),
	referenceModel("openai", "gpt-4o"),
	referenceModel("openrouter", "qwen/qwen3-coder:exacto"),
	referenceModel("openrouter", "openai/gpt-4o:extended"),
	referenceModel("gw-a", "shared"),
	referenceModel("gw-a", "anthropic/future"),
	referenceModel("gw-a", "anthropic/exact"),
	referenceModel("gw-a", "anthropic/claude-opus-4.8"),
	referenceModel("gw-a", "anthropic/claude-opus"),
	referenceModel("gw-b", "shared"),
	referenceModel("gw-b", "anthropic/future"),
	referenceModel("gw-b", "claude-opus-4-8"),
	referenceModel("gw-b", "gw-b/free"),
	referenceModel("gw-b", "zz:free"),
];

type ReferenceExpected =
	| { model: string; thinkingLevel?: string; warning?: string }
	| { ambiguous: string[]; usableCount: number }
	| "not-found";

interface ReferenceCase {
	name: string;
	text: string;
	expected: ReferenceExpected;
	usable?: string[];
	provider?: string;
	thinkingSuffix?: ModelReferenceRequest["thinkingSuffix"];
	fuzzy?: boolean;
}

const referenceCases: ReferenceCase[] = [
	// Reference syntax
	{ name: "exact id", text: "claude-sonnet-4-5", expected: { model: "anthropic/claude-sonnet-4-5" } },
	{ name: "exact id is case-insensitive", text: "GPT-4O", expected: { model: "openai/gpt-4o" } },
	{ name: "fuzzy prefers aliases over dated ids", text: "sonnet", expected: { model: "anthropic/claude-sonnet-4-5" } },
	{
		name: "thinking suffix",
		text: "sonnet:high",
		expected: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" },
	},
	{
		name: "colon in a literal id is not a thinking suffix",
		text: "qwen/qwen3-coder:exacto",
		expected: { model: "openrouter/qwen/qwen3-coder:exacto" },
	},
	{
		name: "provider prefix, colon id, and thinking suffix",
		text: "openrouter/qwen/qwen3-coder:exacto:high",
		expected: { model: "openrouter/qwen/qwen3-coder:exacto", thinkingLevel: "high" },
	},
	{
		name: "raw id wins when the provider prefix names no matching model",
		text: "openai/gpt-4o:extended",
		expected: { model: "openrouter/openai/gpt-4o:extended" },
	},
	{
		name: "fuzzy searches the prefixed provider first",
		text: "openrouter/qwen",
		expected: { model: "openrouter/qwen/qwen3-coder:exacto" },
	},
	{ name: "strict keeps an invalid suffix in the id", text: "gpt-4o:random", expected: "not-found" },
	{
		name: "lenient drops an invalid suffix with a warning",
		text: "gpt-4o:random",
		thinkingSuffix: "lenient",
		expected: { model: "openai/gpt-4o", warning: 'Invalid thinking level "random"' },
	},
	{
		name: "lenient invalid outer suffix discards the inner thinking level",
		text: "qwen/qwen3-coder:exacto:high:random",
		thinkingSuffix: "lenient",
		expected: { model: "openrouter/qwen/qwen3-coder:exacto", warning: 'Invalid thinking level "random"' },
	},
	{ name: "none keeps the suffix in the id", text: "gpt-4o:high", thinkingSuffix: "none", expected: "not-found" },
	{ name: "exact-only skips fuzzy matches", text: "sonnet", fuzzy: false, expected: "not-found" },
	{ name: "empty text", text: "  ", expected: "not-found" },

	// Exact matches across providers
	// #7327
	{ name: "sole usable provider wins", text: "shared", usable: ["gw-b"], expected: { model: "gw-b/shared" } },
	{
		name: "no usable provider is ambiguous instead of falling through to fuzzy",
		text: "shared",
		expected: { ambiguous: ["gw-a/shared", "gw-b/shared"], usableCount: 0 },
	},
	{
		name: "several usable providers are ambiguous",
		text: "shared",
		usable: ["gw-a", "gw-b"],
		expected: { ambiguous: ["gw-a/shared", "gw-b/shared"], usableCount: 2 },
	},
	{
		name: "thinking suffix does not change provider selection",
		text: "shared:high",
		usable: ["gw-b"],
		expected: { model: "gw-b/shared", thinkingLevel: "high" },
	},
	{
		name: "thinking suffix does not bypass ambiguity",
		text: "shared:high",
		usable: ["gw-a", "gw-b"],
		expected: { ambiguous: ["gw-a/shared", "gw-b/shared"], usableCount: 2 },
	},
	{
		// #10160
		name: "provider prefix without a direct model selects the usable raw id",
		text: "anthropic/future",
		usable: ["gw-b"],
		expected: { model: "gw-b/anthropic/future" },
	},
	{
		// #5823
		name: "usable qualified match beats a usable raw id",
		text: "anthropic/exact",
		usable: ["anthropic", "gw-a"],
		expected: { model: "anthropic/exact" },
	},
	{
		// #5643
		name: "usable raw id beats an unusable qualified match",
		text: "anthropic/exact",
		usable: ["gw-a"],
		expected: { model: "gw-a/anthropic/exact" },
	},
	{
		name: "unusable qualified match is kept when nothing is usable",
		text: "anthropic/exact",
		expected: { model: "anthropic/exact" },
	},

	{
		// Like `mistral/codestral` -> mistral/codestral-latest despite gateway id `mistral/codestral`
		name: "named provider's usable fuzzy match beats a raw id elsewhere",
		text: "anthropic/claude-opus",
		usable: ["anthropic"],
		expected: { model: "anthropic/claude-opus-4-8" },
	},
	{
		name: "usable raw id beats the named provider's unusable fuzzy match",
		text: "anthropic/claude-opus",
		usable: ["gw-a"],
		expected: { model: "gw-a/anthropic/claude-opus" },
	},
	{
		name: "named provider's fuzzy match is kept when nothing is usable",
		text: "anthropic/claude-opus",
		expected: { model: "anthropic/claude-opus-4-8" },
	},
	{
		name: "named provider's literal id beats its fuzzy matches",
		text: "gw-b/free",
		expected: { model: "gw-b/gw-b/free" },
	},

	// Fuzzy matches across providers
	{
		name: "fuzzy prefers usable providers",
		text: "opus",
		usable: ["gw-a"],
		expected: { model: "gw-a/anthropic/claude-opus-4.8" },
	},
	{
		name: "fuzzy id tie across usable providers is ambiguous",
		text: "opus",
		usable: ["anthropic", "gw-a", "gw-b"],
		expected: { ambiguous: ["anthropic/claude-opus-4-8", "gw-b/claude-opus-4-8"], usableCount: 2 },
	},
	{
		name: "fuzzy id tie resolves to the sole usable provider",
		text: "opus",
		usable: ["anthropic"],
		expected: { model: "anthropic/claude-opus-4-8" },
	},

	// Explicit provider constraint
	{
		name: "explicit provider ignores usable providers elsewhere",
		text: "shared",
		provider: "gw-a",
		usable: ["gw-b"],
		expected: { model: "gw-a/shared" },
	},
	{
		name: "explicit provider accepts its own prefix",
		text: "GW-B/shared",
		provider: "gw-b",
		expected: { model: "gw-b/shared" },
	},
	{
		name: "explicit provider allows fuzzy matches",
		text: "4o",
		provider: "openai",
		expected: { model: "openai/gpt-4o" },
	},
	{ name: "explicit provider never leaves the provider", text: "gpt-4o", provider: "gw-a", expected: "not-found" },
];

function modelRef(m: Model<Api>): string {
	return `${m.provider}/${m.id}`;
}

describe("resolveModelReference", () => {
	test.each(referenceCases)("$name", (testCase) => {
		const usable = new Set(testCase.usable);
		const request: ModelReferenceRequest = {
			text: testCase.text,
			provider: testCase.provider,
			thinkingSuffix: testCase.thinkingSuffix ?? "strict",
			fuzzy: testCase.fuzzy ?? true,
		};
		// Catalog order must never decide the result.
		for (const models of [referenceCatalog, [...referenceCatalog].reverse()]) {
			const result = resolveModelReference(request, models, (provider) => usable.has(provider));
			const expected = testCase.expected;
			if (expected === "not-found") {
				expect(result.status).toBe("not-found");
			} else if ("ambiguous" in expected) {
				expect(result.status).toBe("ambiguous");
				if (result.status !== "ambiguous") continue;
				expect(result.candidates.map(modelRef).sort()).toEqual(expected.ambiguous);
				expect(result.usableCount).toBe(expected.usableCount);
			} else {
				expect(result.status).toBe("resolved");
				if (result.status !== "resolved") continue;
				expect(modelRef(result.model)).toBe(expected.model);
				expect(result.thinkingLevel).toBe(expected.thinkingLevel);
				if (expected.warning) expect(result.warning).toContain(expected.warning);
				else expect(result.warning).toBeUndefined();
			}
		}
	});
});

describe("resolveCliModel", () => {
	test("separates thinking from an unknown provider-prefixed custom model id", () => {
		const registry = {
			getModels: () => [...allModels, openaiCodexBaseModel],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliModel: "openai-codex/gpt-5.6-sol:xhigh",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai-codex");
		expect(result.model?.id).toBe("gpt-5.6-sol");
		expect(result.model?.reasoning).toBe(true);
		expect(result.thinkingLevel).toBe("xhigh");
	});
	test("separates thinking from an explicit provider custom model id", () => {
		const registry = {
			getModels: () => [...allModels, openaiCodexBaseModel],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliProvider: "openai-codex",
			cliModel: "gpt-5.6-sol:high",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("gpt-5.6-sol");
		expect(result.model?.reasoning).toBe(true);
		expect(result.thinkingLevel).toBe("high");
	});
	test("separates off thinking from a custom model id", () => {
		const registry = {
			getModels: () => [...allModels, openaiCodexBaseModel],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliModel: "openai-codex/gpt-5.6-sol:off",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("gpt-5.6-sol");
		expect(result.model?.reasoning).toBe(false);
		expect(result.thinkingLevel).toBe("off");
	});
	test("preserves an unrecognized colon suffix on a custom model id", () => {
		const registry = {
			getModels: () => [...allModels, openaiCodexBaseModel],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliProvider: "openai-codex",
			cliModel: "gpt-5.6-sol:preview",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("gpt-5.6-sol:preview");
		expect(result.model?.reasoning).toBe(false);
		expect(result.thinkingLevel).toBeUndefined();
	});
	test("prefers a registered colon-bearing id even when its suffix is a thinking level", () => {
		const registeredModel = {
			...openaiCodexBaseModel,
			id: "gpt-5.6-sol:xhigh",
			name: "GPT-5.6 Sol XHigh",
		};
		const registry = {
			getModels: () => [...allModels, openaiCodexBaseModel, registeredModel],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliModel: "openai-codex/gpt-5.6-sol:xhigh",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model).toBe(registeredModel);
		expect(result.model?.reasoning).toBe(false);
		expect(result.thinkingLevel).toBeUndefined();
	});
	test("preserves a gateway raw exact id ending in a thinking suffix", () => {
		const inferredProviderModel = {
			...mockModels[1]!,
			id: "foo",
			name: "Foo",
		};
		const registeredGatewayModel = {
			...mockOpenRouterModels[0]!,
			id: "openai/foo:high",
			name: "OpenAI Foo High",
		};
		const registry = {
			getModels: () => [...allModels, inferredProviderModel, registeredGatewayModel],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "openai/foo:high",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model).toBe(registeredGatewayModel);
		expect(result.model?.provider).toBe("openrouter");
		expect(result.thinkingLevel).toBeUndefined();
	});
	test("resolves --model provider/id without --provider", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliModel: "openai/gpt-4o",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});
	test("resolves fuzzy patterns within an explicit provider", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "4o",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});
	test("supports --model <pattern>:<thinking> (without explicit --thinking)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliModel: "sonnet:high",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("high");
	});
	test("prefers exact model id match over provider inference (OpenRouter-style ids)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliModel: "openai/gpt-4o:extended",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/gpt-4o:extended");
	});
	test("does not strip invalid :suffix as thinking level in --model (treat as raw id)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o:extended",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o:extended");
	});
	test("allows custom model ids for explicit providers without double prefixing", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/ghost-model");
	});
	test("scrubs inherited context-window options from explicit provider fallback models", () => {
		const registry = {
			getModels: () => [copilotSelectableBaseModel],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliProvider: "github-copilot",
			cliModel: "future-copilot-model",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("future-copilot-model");
		expect(result.model?.contextWindow).toBe(400000);
	});
	test("returns a clear error when there are no models", () => {
		const registry = {
			getModels: () => [],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o",
			modelRuntime: registry,
		});
		expect(result.model).toBeUndefined();
		expect(result.error).toContain("No models available");
	});
	test("prefers the sole authenticated provider for an ambiguous bare exact model id", () => {
		const azureModel: Model<"anthropic-messages"> = {
			...mockModels[1]!,
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			provider: "azure",
		};
		const codexModel: Model<"anthropic-messages"> = {
			...mockModels[1]!,
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			provider: "openai-codex",
		};
		const registry = {
			getModels: () => [azureModel, codexModel],
			hasConfiguredAuth: (provider: string) => provider === "openai-codex",
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "gpt-5.6-sol",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai-codex");
		expect(result.model?.id).toBe("gpt-5.6-sol");
	});

	test("does not treat duplicate models from one provider as cross-provider ambiguity", () => {
		const openaiModel: Model<"anthropic-messages"> = {
			...mockModels[1]!,
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
		};
		const registry = {
			getModels: () => [openaiModel, { ...openaiModel }],
			hasConfiguredAuth: () => false,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "gpt-5.6-sol",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model).toBe(openaiModel);
	});

	test("uses authenticated-provider matching for an exact id that looks like a thinking suffix", () => {
		const azureModel: Model<"anthropic-messages"> = {
			...mockModels[1]!,
			id: "gpt-5.6-sol:high",
			name: "GPT-5.6 Sol",
			provider: "azure",
		};
		const codexModel: Model<"anthropic-messages"> = {
			...mockModels[1]!,
			id: "gpt-5.6-sol:high",
			name: "GPT-5.6 Sol",
			provider: "openai-codex",
		};
		const registry = {
			getModels: () => [azureModel, codexModel],
			hasConfiguredAuth: (provider: string) => provider === "openai-codex",
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "gpt-5.6-sol:high",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.thinkingLevel).toBeUndefined();
		expect(result.model?.provider).toBe("openai-codex");
	});

	test("requires an explicit provider for an ambiguous bare exact model id", () => {
		const azureModel: Model<"anthropic-messages"> = {
			...mockModels[1]!,
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			provider: "azure",
		};
		const codexModel: Model<"anthropic-messages"> = {
			...mockModels[1]!,
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			provider: "openai-codex",
		};
		const registry = {
			getModels: () => [azureModel, codexModel],
			hasConfiguredAuth: () => false,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "gpt-5.6-sol",
			modelRuntime: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain('Model "gpt-5.6-sol" is ambiguous across providers');
		expect(result.error).toContain("azure/gpt-5.6-sol");
		expect(result.error).toContain("openai-codex/gpt-5.6-sol");
		expect(result.error).toContain("No matching provider is authenticated.");
		expect(result.error).toContain("Use --provider or provider/model");
	});

	test("rejects an ambiguous bare exact model id when several matching providers are authenticated", () => {
		const azureModel: Model<"anthropic-messages"> = {
			...mockModels[1]!,
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			provider: "azure",
		};
		const codexModel: Model<"anthropic-messages"> = {
			...mockModels[1]!,
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			provider: "openai-codex",
		};
		const registry = {
			getModels: () => [azureModel, codexModel],
			hasConfiguredAuth: () => true,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliModel: "gpt-5.6-sol",
			modelRuntime: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("More than one matching provider is authenticated.");
		expect(result.error).toContain("Use --provider or provider/model");
	});
	test("prefers provider/model split over gateway model with matching id", () => {
		// When a user writes "zai/glm-5", and both a zai provider model (id: "glm-5")
		// and a gateway model (id: "zai/glm-5") exist, prefer the zai provider model.
		const zaiModel: Model<"anthropic-messages"> = {
			id: "glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const gatewayModel: Model<"anthropic-messages"> = {
			id: "zai/glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getModels: () => [...allModels, zaiModel, gatewayModel],
			hasConfiguredAuth: () => true,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliModel: "zai/glm-5",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("zai");
		expect(result.model?.id).toBe("glm-5");
	});
	test("resolves provider-prefixed fuzzy patterns (openrouter/qwen -> openrouter model)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];
		const result = resolveCliModel({
			cliModel: "openrouter/qwen",
			modelRuntime: registry,
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
	});

	describe("duplicate raw ids behind a known provider prefix (#10160)", () => {
		const direct = { ...mockModels[0]!, id: "claude-sonnet-4-5", provider: "anthropic" };
		const openrouter = { ...mockModels[0]!, id: "anthropic/claude-opus-5.5", provider: "openrouter" };
		const vercel = { ...mockModels[0]!, id: "anthropic/claude-opus-5.5", provider: "vercel-ai-gateway" };
		const registry = (configured: string[]) =>
			({
				getModels: () => [direct, openrouter, vercel],
				hasConfiguredAuth: (provider: string) => configured.includes(provider),
			}) as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		test("selects the authenticated gateway, with or without a thinking suffix", () => {
			for (const [cliModel, thinkingLevel] of [
				["anthropic/claude-opus-5.5", undefined],
				["anthropic/claude-opus-5.5:high", "high"],
			] as const) {
				const result = resolveCliModel({ cliModel, modelRuntime: registry(["vercel-ai-gateway"]) });

				expect(result.error).toBeUndefined();
				expect(result.model?.provider).toBe("vercel-ai-gateway");
				expect(result.thinkingLevel).toBe(thinkingLevel);
			}
		});

		test("reports ambiguity instead of choosing by catalog order", () => {
			const result = resolveCliModel({ cliModel: "anthropic/claude-opus-5.5", modelRuntime: registry([]) });

			expect(result.model).toBeUndefined();
			expect(result.error).toContain(
				"openrouter/anthropic/claude-opus-5.5, vercel-ai-gateway/anthropic/claude-opus-5.5",
			);
			expect(result.error).toContain("No matching provider is authenticated. Use --provider or provider/model.");
		});

		test("does not let stored credentials choose the provider for --api-key", () => {
			const result = resolveCliModel({
				cliModel: "anthropic/claude-opus-5.5",
				inlineApiKey: true,
				modelRuntime: registry(["vercel-ai-gateway"]),
			});

			expect(result.model).toBeUndefined();
			expect(result.error).toContain("--api-key does not choose a provider.");
		});
	});

	test("reports a fuzzy match offered by several account clones instead of choosing by catalog order", () => {
		const codex = { ...openaiCodexBaseModel, id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };
		const clone = { ...codex, provider: "openai-codex-2" };
		for (const models of [
			[codex, clone],
			[clone, codex],
		]) {
			const result = resolveCliModel({
				cliModel: "6.1-sol",
				modelRuntime: {
					getModels: () => models,
					hasConfiguredAuth: () => true,
				} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"],
			});

			expect(result.model).toBeUndefined();
			expect(result.error).toContain("openai-codex-2/gpt-6.1-sol, openai-codex/gpt-6.1-sol");
			expect(result.error).toContain("More than one matching provider is authenticated.");
		}
	});
});

test("prefers GPT-6.1 Sol when Codex models are available", () => {
	const sol = { ...openaiCodexBaseModel, id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };
	expect(findPreferredAvailableModel([openaiCodexBaseModel, sol])).toBe(sol);
});
