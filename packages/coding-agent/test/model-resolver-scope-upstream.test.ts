import type { Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { resolveModelScopeWithDiagnostics } from "../src/core/model-resolver.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

function model(id: string, provider = "openrouter"): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function runtime(models: Model<"openai-completions">[]): ModelRuntime {
	return { getAvailableSnapshot: () => models } as Pick<ModelRuntime, "getAvailableSnapshot"> as ModelRuntime;
}

async function resolve(patterns: string[], models: Model<"openai-completions">[]) {
	return resolveModelScopeWithDiagnostics(patterns, runtime(models));
}

describe("upstream model scope resolution", () => {
	test("resolves bracketed scoped model IDs literally before glob matching", async () => {
		const literal = model("meta-llama/llama-3.1-8b-instruct[free]");
		const globLookalike = model("meta-llama/llama-3.1-8b-instructf");
		const result = await resolve([`openrouter/${literal.id}`], [literal, globLookalike]);

		expect(result.scopedModels.map((entry) => entry.model.id)).toEqual([literal.id]);
		expect(result.diagnostics).toEqual([]);
	});

	test("prefers a complete suffix-bearing literal ID before parsing thinking or glob syntax", async () => {
		const complete = model("literal[free]:high", "p");
		const base = model("literal[free]", "p");
		const globLookalike = model("literalf", "p");
		const result = await resolve(["p/literal[free]:high"], [globLookalike, base, complete]);

		expect(result.scopedModels).toEqual([{ model: complete, thinkingLevel: undefined }]);
		expect(result.diagnostics).toEqual([]);
	});

	test("parses a thinking suffix after complete literal lookup when the stripped base exists", async () => {
		const base = model("literal[free]", "p");
		const globLookalike = model("literalf", "p");
		const result = await resolve(["p/literal[free]:high"], [globLookalike, base]);

		expect(result.scopedModels).toEqual([{ model: base, thinkingLevel: "high" }]);
		expect(result.diagnostics).toEqual([]);
	});

	test("uses bracket glob matching only after complete and stripped exact lookups miss", async () => {
		const globLookalike = model("literalf", "p");
		const result = await resolve(["p/literal[free]:high"], [globLookalike]);

		expect(result.scopedModels).toEqual([{ model: globLookalike, thinkingLevel: "high" }]);
		expect(result.diagnostics).toEqual([]);
	});

	test("preserves unique and ambiguous bare literal ID behavior", async () => {
		const unique = model("literal[free]:high", "p");
		const uniqueResult = await resolve(["literal[free]:high"], [unique]);
		expect(uniqueResult.scopedModels).toEqual([{ model: unique, thinkingLevel: undefined }]);
		expect(uniqueResult.diagnostics).toEqual([]);

		const first = model("literal[free]", "p");
		const second = model("literal[free]", "q");
		const ambiguousResult = await resolve(["literal[free]"], [first, second]);
		expect(ambiguousResult.scopedModels).toEqual([]);
		expect(ambiguousResult.diagnostics).toEqual([
			{
				type: "warning",
				code: "no-match",
				message: 'No models match pattern "literal[free]"',
				pattern: "literal[free]",
			},
		]);
	});

	test("preserves star, question-mark, and bracket glob behavior and catalog order", async () => {
		const one = model("model1", "p");
		const two = model("model2", "p");
		const ten = model("model10", "p");

		const star = await resolve(["p/model*"], [two, ten, one]);
		expect(star.scopedModels.map((entry) => entry.model)).toEqual([two, ten, one]);

		const question = await resolve(["p/model?"], [two, ten, one]);
		expect(question.scopedModels.map((entry) => entry.model)).toEqual([two, one]);

		const bracket = await resolve(["p/model[12]"], [two, ten, one]);
		expect(bracket.scopedModels.map((entry) => entry.model)).toEqual([two, one]);
	});

	test("preserves complete colon IDs and parses valid thinking suffixes only after exact lookup", async () => {
		const completeColon = model("vendor:model:high", "p");
		const baseColon = model("vendor:model", "p");
		const completeResult = await resolve(["p/vendor:model:high"], [baseColon, completeColon]);
		expect(completeResult.scopedModels).toEqual([{ model: completeColon, thinkingLevel: undefined }]);

		const suffixResult = await resolve(["p/vendor:model:high"], [baseColon]);
		expect(suffixResult.scopedModels).toEqual([{ model: baseColon, thinkingLevel: "high" }]);
	});

	test("retains first-entry deduplication across exact and glob patterns", async () => {
		const literal = model("literal[free]:high", "p");
		const result = await resolve(["p/literal[free]:high", "p/literal*:low", "p/literal[free]:high"], [literal]);

		expect(result.scopedModels).toEqual([{ model: literal, thinkingLevel: undefined }]);
		expect(result.diagnostics).toEqual([]);
	});

	test("retains exact no-match patterns and classified diagnostics for selector cleanup", async () => {
		const result = await resolve(["openrouter/unavailable[free]", "openrouter/missing"], [model("available")]);

		expect(result.scopedModels).toEqual([]);
		expect(result.diagnostics).toEqual([
			{
				type: "warning",
				code: "no-match",
				message: 'No models match pattern "openrouter/unavailable[free]"',
				pattern: "openrouter/unavailable[free]",
			},
			{
				type: "warning",
				code: "no-match",
				message: 'No models match pattern "openrouter/missing"',
				pattern: "openrouter/missing",
			},
		]);
	});
});
