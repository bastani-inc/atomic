/**
 * The gate a subagent launch's `modelConstraints` put on execution fallback (#4188): every applicable constraint, the
 * call's and the agent's, must hold for a model the child may fall back to.
 */

import assert from "node:assert/strict";
import { getModel, type Model } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { modelConstraintsFallbackGate } from "../../packages/subagents/src/runs/shared/model-fallback.js";

const base = getModel("anthropic", "claude-sonnet-4-5")!;
const model = (provider: string, id: string): Model<"anthropic-messages"> => ({
	...base,
	provider,
	id,
	reasoning: true,
});
const requestedOnOtherAccount = model("account-b", "argon");
const otherFamily = model("account-b", "opus");

test("a launch without constraints puts no gate on its fallbacks", () => {
	assert.equal(modelConstraintsFallbackGate([undefined, undefined]), undefined);
});

test("a fallback must be in every applicable allowedModels list", () => {
	const gate = modelConstraintsFallbackGate([undefined, { allowedModels: ["account-a/argon", "account-b/argon"] }])!;
	assert.equal(gate(requestedOnOtherAccount, "high"), true);
	assert.equal(gate(otherFamily, "high"), false, "a settings or parent fallback of another family is not allowed");
	const narrowed = modelConstraintsFallbackGate([
		{ allowedModels: ["account-b/opus"] },
		{ allowedModels: ["account-a/argon", "account-b/argon"] },
	])!;
	assert.equal(narrowed(requestedOnOtherAccount), false, "a call cannot widen its agent's list");
	assert.equal(narrowed(otherFamily), false);
});

test("a fallback must run at an allowed effort and come from an allowed provider", () => {
	const gate = modelConstraintsFallbackGate([{ allowedEfforts: ["high"], excludedProviders: ["account-c"] }])!;
	assert.equal(gate(requestedOnOtherAccount, "high"), true);
	assert.equal(gate(requestedOnOtherAccount, "low"), false);
	assert.equal(gate(requestedOnOtherAccount), true, "without an effort, any allowed level qualifies");
	assert.equal(gate(model("account-c", "argon"), "high"), false);
});
