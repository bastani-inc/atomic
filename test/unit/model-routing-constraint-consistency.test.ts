import assert from "node:assert/strict";
import { type Api, getServiceTierCost, type Model } from "@bastani/pi-ai";
import { getModel, getModels, getProviders } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { resolveFallbackModel } from "../../packages/coding-agent/src/core/fallback-models.js";
import { deriveFastModelVariants } from "../../packages/coding-agent/src/core/fast-model-variants.js";
import { eligiblePair } from "../../packages/coding-agent/src/core/model-routing-constraints.js";
import { modelConstraintsFallbackGate } from "../../packages/subagents/src/runs/shared/model-fallback.js";
import { resolveCandidateModel } from "../../packages/subagents/src/shared/model-resolution.js";

function derived(id: string, variantId: string): Model<Api> {
	const base = getModel("openai", id as never) as Model<Api>;
	const variant = deriveFastModelVariants("openai", [base]).models.find((m) => m.id === variantId);
	assert.ok(variant, `${variantId} is derived from ${id}`);
	return variant;
}

test("cost limits compare a fast route at the service-tier rate it is billed at (#5046)", () => {
	const miniFast = derived("gpt-5.4-mini", "gpt-5.4-mini-fast");
	const tier = miniFast.fastRoute?.serviceTier;
	assert.ok(tier);
	const billed = getServiceTierCost(miniFast, tier);
	assert.ok(billed && billed.input > miniFast.cost.input, "the tier rate is above the listed Standard rate");
	const pair = { model: `openai/${miniFast.id}`, effort: null };
	const between = (miniFast.cost.input + billed.input) / 2;
	assert.equal(eligiblePair(miniFast, pair, [{ maxInputCost: between }]), false);
	assert.equal(eligiblePair(miniFast, pair, [{ maxInputCost: billed.input }]), true);
	const betweenOutput = (miniFast.cost.output + billed.output) / 2;
	assert.equal(eligiblePair(miniFast, pair, [{ maxOutputCost: betweenOutput }]), false);
	assert.equal(modelConstraintsFallbackGate([{ maxInputCost: between }])!(miniFast), false);
	const tiered: Model<Api> = {
		...miniFast,
		serviceTiers: [
			{
				...miniFast.serviceTiers![0]!,
				cost: { ...billed, tiers: [{ ...billed, inputTokensAbove: 1, output: 99 }] },
			},
		],
	};
	assert.equal(eligiblePair(tiered, pair, [{ maxOutputCost: billed.output }]), false, "every billed tier counts");
});

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
	const mini = getModel("openai", "gpt-5.4-mini" as never) as Model<Api>;
	const opus = getModel("anthropic", "claude-opus-4-8" as never) as Model<Api>;
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
