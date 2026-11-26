import assert from "node:assert/strict";
import type { Api, Model } from "@bastani/atomic-ai";
import { getModels, getProviders } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { resolveFallbackModel } from "../../packages/coding-agent/src/core/fallback-models.js";
import { deriveFastModelVariants } from "../../packages/coding-agent/src/core/fast-model-variants.js";
import { toCodemodeModelInfo } from "../../packages/coding-agent/src/extensions/codemode/execute.js";
import { resolveCandidateModel } from "../../packages/subagents/src/shared/model-resolution.js";
import { getFixtureModel } from "../helpers/catalog-model-fixtures.ts";

function derived(id: string, variantId: string): Model<Api> {
	const base = getFixtureModel("openai", id as never) as Model<Api>;
	const variant = deriveFastModelVariants("openai", [base]).models.find((m) => m.id === variantId);
	assert.ok(variant, `${variantId} is derived from ${id}`);
	return variant;
}

test("a subagent model name resolves exactly as the same settings fallbackModels entry does (#5046)", () => {
	const catalog = getProviders().flatMap((provider) => getModels(provider) as Model<Api>[]);
	const settings = { getModels: () => catalog, hasConfiguredAuth: () => true };
	const registry = {
		getAvailable: () => catalog,
		find: (provider: string, id: string) => catalog.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => true,
	};
	const label = (resolved: { model: Model<Api>; thinkingLevel?: string } | undefined) =>
		resolved && `${resolved.model.provider}/${resolved.model.id}:${resolved.thinkingLevel ?? ""}`;
	for (const entry of ["Anthropic/claude-opus-4-8", "anthropic/Claude-Opus-4-8:high", "OPENAI/gpt-5.4-mini:low"]) {
		const expected = label(resolveFallbackModel(entry, settings, "anthropic"));
		assert.ok(expected, entry);
		assert.equal(label(resolveCandidateModel(entry, registry, "anthropic")), expected, entry);
	}
});

test("a subagent model name keeps the launch rules for whitespace, credentials and unknown effort words (#5046)", () => {
	const mini = getFixtureModel("openai", "gpt-5.4-mini" as never) as Model<Api>;
	const opus = getFixtureModel("anthropic", "claude-opus-4-8" as never) as Model<Api>;
	const registry = {
		getAvailable: () => [mini, opus],
		find: () => undefined,
		hasConfiguredAuth: (model: Model<Api>) => model.provider === "openai",
	};
	assert.deepEqual(resolveCandidateModel(" OpenAI/gpt-5.4-mini ", registry), { model: mini });
	assert.deepEqual(resolveCandidateModel("openai/gpt-5.4-mini:low", registry), { model: mini, thinkingLevel: "low" });
	assert.equal(resolveCandidateModel("  ", registry), undefined);
	assert.equal(resolveCandidateModel("anthropic/claude-opus-4-8", registry), undefined, "no credentials");
	assert.deepEqual(resolveCandidateModel("openai/gpt-5.4-mini:extreme", registry), {
		model: mini,
		unknownEffort: "extreme",
	});
	assert.equal(resolveCandidateModel("openai/gpt-5.4-mini:low:extreme", registry), undefined);
	assert.equal(resolveCandidateModel("openai/no-such-model", registry), undefined);
});

test("a fast route is listed at the service-tier price it is billed at, and its base model at its own (#5156)", () => {
	const fast = derived("gpt-5.4-mini", "gpt-5.4-mini-fast");
	const tier = fast.fastRoute!.serviceTier!;
	const priced: Model<Api> = {
		...fast,
		cost: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 },
		serviceTiers: [
			{ ...fast.serviceTiers![0]!, id: tier, cost: { input: 2, output: 20, cacheRead: 0, cacheWrite: 0 } },
		],
	};
	const { fastRoute: _, ...base } = priced;
	assert.deepEqual(toCodemodeModelInfo(priced).cost, { input: 2, output: 20, cacheRead: 0, cacheWrite: 0 });
	assert.deepEqual(toCodemodeModelInfo(base).cost, base.cost);
});
