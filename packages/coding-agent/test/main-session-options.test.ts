import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import type { Args } from "../src/cli/args.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSessionOptions } from "../src/main-session-options.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		name: `${provider}/${id}`,
		api: provider === "cursor" ? "cursor-agent" : "openai-responses",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		...(provider === "cursor" ? { compat: { cursorRouting: { [id]: { modelId: id, maxMode: false, supportsImages: false, catalogOccurrence: 0 } } } } : {}),
	} as Model<Api>;
}

function registry(models: Model<Api>[]): ModelRegistry {
	return {
		getAll: () => models,
		find: (provider: string, id: string) => models.find((entry) => entry.provider === provider && entry.id === id),
	} as unknown as ModelRegistry;
}

function settings(defaultProvider?: string, defaultModel?: string): SettingsManager {
	return {
		getDefaultProvider: () => defaultProvider,
		getDefaultModel: () => defaultModel,
	} as unknown as SettingsManager;
}

function args(input: Partial<Args>): Args {
	return { unknownFlags: new Map(), diagnostics: [], ...input } as Args;
}

describe("buildSessionOptions literal blank model IDs", () => {
	test("resolves an explicit separate-provider blank CLI model", () => {
		const blank = model("cursor", "");
		const result = buildSessionOptions(args({ provider: "cursor", model: "" }), [], false, registry([blank]), settings());
		expect(result.options.model).toBe(blank);
	});

	test("prefers a saved blank model in an eager scope", () => {
		const first = model("openai", "fallback");
		const blank = model("cursor", "");
		const result = buildSessionOptions(
			args({}),
			[{ model: first }, { model: blank }],
			false,
			registry([first, blank]),
			settings("cursor", ""),
		);
		expect(result.options.model).toBe(blank);
	});

	test("uses the first eager scoped model only when the saved model is omitted", () => {
		const first = model("openai", "fallback");
		const blank = model("cursor", "");
		const result = buildSessionOptions(
			args({}),
			[{ model: first }, { model: blank }],
			false,
			registry([first, blank]),
			settings("cursor", undefined),
		);
		expect(result.options.model).toBe(first);
	});
});
