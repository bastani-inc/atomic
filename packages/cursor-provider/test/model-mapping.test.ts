import { describe, expect, it } from "bun:test";
import {
	dedupeCursorModelVariants,
	mapAtomicThinkingLevelToCursorEffort,
	parseCursorEffortVariant,
	resolveCursorRequestModelId,
	toProviderModels,
} from "../model-mapping.ts";

describe("Cursor model mapping", () => {
	it("parses known effort suffixes without stripping unrelated composer ids", () => {
		expect(parseCursorEffortVariant("gpt-5-high-fast")).toEqual({ baseId: "gpt-5", effort: "high", speed: "fast" });
		expect(parseCursorEffortVariant("claude-4-thinking")).toEqual({
			baseId: "claude-4",
			effort: "thinking",
			speed: undefined,
		});
		expect(parseCursorEffortVariant("composer-1")).toEqual({ baseId: "composer-1", effort: undefined, speed: undefined });
	});

	it("deduplicates effort variants while preserving the most capable representative", () => {
		const models = dedupeCursorModelVariants([
			{ id: "gpt-5-low", name: "GPT 5 Low", reasoning: true, contextWindow: 100, maxTokens: 10 },
			{ id: "gpt-5-high-fast", name: "GPT 5 High Fast", reasoning: true, contextWindow: 200, maxTokens: 20 },
			{ id: "composer-1", name: "Composer 1", reasoning: false, contextWindow: 50, maxTokens: 5 },
		]);

		expect(models.map((model) => model.id)).toEqual(["gpt-5", "composer-1"]);
		expect(models[0]?.rawVariants?.map((variant) => variant.id)).toEqual(["gpt-5-low", "gpt-5-high-fast"]);
		expect(models[0]?.contextWindow).toBe(200);
	});

	it("maps Atomic thinking levels to Cursor effort labels", () => {
		expect(mapAtomicThinkingLevelToCursorEffort("minimal")).toBe("none");
		expect(mapAtomicThinkingLevelToCursorEffort("low")).toBe("low");
		expect(mapAtomicThinkingLevelToCursorEffort("medium")).toBe("medium");
		expect(mapAtomicThinkingLevelToCursorEffort("high")).toBe("high");
		expect(mapAtomicThinkingLevelToCursorEffort("xhigh")).toBe("xhigh");
	});

	it("resolves deduped request models back to Cursor reasoning variants", () => {
		const models = dedupeCursorModelVariants([
			{ id: "gpt-5-low", name: "GPT 5 Low", reasoning: true, contextWindow: 100, maxTokens: 10 },
			{ id: "gpt-5-high", name: "GPT 5 High", reasoning: true, contextWindow: 100, maxTokens: 10 },
		]);

		expect(resolveCursorRequestModelId(models, "gpt-5", "high")).toBe("gpt-5-high");
	});

	it("resolves to high-fast when that is the only matching high variant", () => {
		const models = dedupeCursorModelVariants([
			{ id: "gpt-5-low", name: "GPT 5 Low", reasoning: true, contextWindow: 100, maxTokens: 10 },
			{ id: "gpt-5-high-fast", name: "GPT 5 High Fast", reasoning: true, contextWindow: 100, maxTokens: 10 },
		]);

		expect(resolveCursorRequestModelId(models, "gpt-5", "high")).toBe("gpt-5-high-fast");
	});

	it("preserves non-effort models and falls back to a real raw variant when no matching effort exists", () => {
		const models = dedupeCursorModelVariants([
			{ id: "composer-1", name: "Composer 1", reasoning: false, contextWindow: 50, maxTokens: 5 },
			{ id: "gpt-5-low", name: "GPT 5 Low", reasoning: true, contextWindow: 100, maxTokens: 10 },
		]);

		expect(resolveCursorRequestModelId(models, "composer-1", "high")).toBe("composer-1");
		expect(resolveCursorRequestModelId(models, "gpt-5", "medium")).toBe("gpt-5-low");
		expect(resolveCursorRequestModelId(models, "unknown", "high")).toBe("unknown");
	});

	it("resolves absent effort to a real lowest raw variant instead of the deduped id", () => {
		const models = dedupeCursorModelVariants([
			{ id: "gpt-5-low", name: "GPT 5 Low", reasoning: true, contextWindow: 100, maxTokens: 10 },
			{ id: "gpt-5-high-fast", name: "GPT 5 High Fast", reasoning: true, contextWindow: 100, maxTokens: 10 },
		]);

		expect(resolveCursorRequestModelId(models, "gpt-5", undefined)).toBe("gpt-5-low");
	});

	it("resolves unavailable effort to the nearest available raw variant with lower-effort tie break", () => {
		const models = dedupeCursorModelVariants([
			{ id: "gpt-5-low", name: "GPT 5 Low", reasoning: true, contextWindow: 100, maxTokens: 10 },
			{ id: "gpt-5-high-fast", name: "GPT 5 High Fast", reasoning: true, contextWindow: 100, maxTokens: 10 },
		]);

		expect(resolveCursorRequestModelId(models, "gpt-5", "medium")).toBe("gpt-5-low");
	});

	it("converts normalized Cursor models to OpenAI-compatible provider model configs", () => {
		const providerModels = toProviderModels([
			{ id: "gpt-5", name: "GPT 5", reasoning: true, contextWindow: 200_000, maxTokens: 16_384 },
		]);

		expect(providerModels).toEqual([
			expect.objectContaining({
				id: "gpt-5",
				name: "GPT 5",
				api: "openai-completions",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 16_384,
				compat: expect.objectContaining({ supportsDeveloperRole: false, maxTokensField: "max_tokens" }),
			}),
		]);
	});
});
