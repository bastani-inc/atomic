import type { Model } from "@bastani/pi-ai/compat";
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

	test("adds every provider for an ambiguous bare literal ID, with a warning", async () => {
		const unique = model("literal[free]:high", "p");
		const uniqueResult = await resolve(["literal[free]:high"], [unique]);
		expect(uniqueResult.scopedModels).toEqual([{ model: unique, thinkingLevel: undefined }]);
		expect(uniqueResult.diagnostics).toEqual([]);

		const first = model("literal[free]", "q");
		const second = model("literal[free]", "p");
		const ambiguousResult = await resolve(["literal[free]"], [first, second]);
		expect(ambiguousResult.scopedModels).toEqual([
			{ model: first, thinkingLevel: undefined },
			{ model: second, thinkingLevel: undefined },
		]);
		expect(ambiguousResult.diagnostics).toEqual([
			{
				type: "warning",
				code: "ambiguous",
				message: 'Pattern "literal[free]" matches several providers: p, q. Use provider/id to choose one.',
				pattern: "literal[free]",
			},
		]);
	});

	test("adds every provider for a pattern matching the same id on several providers, with a warning (#10160)", async () => {
		const openai = model("gpt-4o", "openai");
		const azure = model("gpt-4o", "azure");
		const codexMini = model("gpt-4o-mini", "openai-codex");

		for (const [pattern, thinkingLevel] of [
			["gpt-4o:high", "high"],
			["GPT-4o", undefined],
		] as const) {
			for (const models of [
				[openai, azure, codexMini],
				[codexMini, azure, openai],
			]) {
				const result = await resolve([pattern], models);

				expect(
					result.scopedModels
						.map((scoped) => [`${scoped.model.provider}/${scoped.model.id}`, scoped.thinkingLevel])
						.sort(),
				).toEqual([
					["azure/gpt-4o", thinkingLevel],
					["openai/gpt-4o", thinkingLevel],
				]);
				expect(result.diagnostics).toEqual([
					{
						type: "warning",
						code: "ambiguous",
						message: `Pattern "${pattern}" matches several providers: azure, openai. Use provider/id to choose one.`,
						pattern,
					},
				]);
			}
		}
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
