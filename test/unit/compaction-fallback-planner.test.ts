/**
 * RFC §8 — Unit: borrowing order, exhaustion, and per-candidate auth.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { borrowFallbackPlanner, type FallbackPlannerContext } from "../../packages/coding-agent/src/core/compaction/fallback-planner.js";
import type { PlannerAuth } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { registryOf, testModel } from "./compaction-rung-support.js";

const primary = testModel();
const secondary = testModel({ provider: "backup", id: "planner-b", baseUrl: "https://backup.example" });
const tertiary = testModel({ provider: "spare", id: "planner-c", baseUrl: "https://spare.example" });

function context(overrides: Partial<FallbackPlannerContext> = {}): FallbackPlannerContext {
	return {
		fallbackModels: ["backup/planner-b:minimal", "spare/planner-c"],
		registry: registryOf([primary, secondary, tertiary]),
		preferredProvider: "primary",
		sessionThinkingLevel: "high",
		...overrides,
	};
}

const authFor = async (model: Model<Api>): Promise<PlannerAuth> => ({
	apiKey: `${model.provider}-key`,
	baseUrl: model.baseUrl,
});

test("candidates are returned in configured order, each at most once", async () => {
	const attempted = new Set<string>(["primary/planner-a:high"]);
	const first = await borrowFallbackPlanner(context(), attempted, authFor);
	assert.equal(first?.model.id, "planner-b");
	assert.equal(first?.key, "backup/planner-b:minimal");
	attempted.add(first!.key);

	const second = await borrowFallbackPlanner(context(), attempted, authFor);
	assert.equal(second?.model.id, "planner-c");
	assert.equal(second?.key, "spare/planner-c:");
	attempted.add(second!.key);

	assert.equal(await borrowFallbackPlanner(context(), attempted, authFor), undefined);
});

test("a candidate `model:level` suffix wins over the inherited session level", async () => {
	const withSuffix = await borrowFallbackPlanner(context(), new Set(), authFor);
	assert.equal(withSuffix?.budget.reasoning, "minimal");
	const withoutSuffix = await borrowFallbackPlanner(
		context({ fallbackModels: ["spare/planner-c"] }),
		new Set(),
		authFor,
	);
	assert.equal(withoutSuffix?.budget.reasoning, "high");
});

test("candidates without configured auth are skipped", async () => {
	const borrowedPlanner = await borrowFallbackPlanner(
		context({ registry: registryOf([primary, secondary, tertiary], ["planner-b"]) }),
		new Set(),
		authFor,
	);
	assert.equal(borrowedPlanner?.model.id, "planner-c");
});

test("resolveAuth is called once per inspected candidate with that candidate's model", async () => {
	const seen: string[] = [];
	const borrowedPlanner = await borrowFallbackPlanner(context(), new Set(), async (model) => {
		seen.push(`${model.provider}/${model.id}`);
		return authFor(model);
	});
	assert.deepEqual(seen, ["backup/planner-b"]);
	assert.equal(borrowedPlanner?.auth.apiKey, "backup-key");
	assert.equal(borrowedPlanner?.auth.baseUrl, "https://backup.example");
	// The session model's credentials never travel to another provider.
	assert.notEqual(borrowedPlanner?.auth.apiKey, "primary-key");
});

test("a candidate whose credentials fail to resolve is skipped, not thrown", async () => {
	const borrowedPlanner = await borrowFallbackPlanner(context(), new Set(), async (model) => {
		if (model.id === "planner-b") throw new Error("auth backend down");
		return authFor(model);
	});
	assert.equal(borrowedPlanner?.model.id, "planner-c");
});

test("a candidate resolving to no credentials is skipped", async () => {
	const borrowedPlanner = await borrowFallbackPlanner(context(), new Set(), async (model) =>
		model.id === "planner-b" ? undefined : authFor(model),
	);
	assert.equal(borrowedPlanner?.model.id, "planner-c");
});

test("exhaustion returns undefined rather than throwing or reusing the session model", async () => {
	assert.equal(await borrowFallbackPlanner(context({ fallbackModels: [] }), new Set(), authFor), undefined);
	assert.equal(
		await borrowFallbackPlanner(context({ fallbackModels: ["nope/missing"] }), new Set(), authFor),
		undefined,
	);
});

test("unqualified entries resolve against available models and prefer the current provider", async () => {
	const sameId = testModel({ provider: "backup", id: "planner-a", baseUrl: "https://backup.example" });
	const borrowedPlanner = await borrowFallbackPlanner(
		context({
			fallbackModels: ["planner-a"],
			registry: registryOf([primary, sameId]),
			preferredProvider: "backup",
		}),
		new Set(),
		authFor,
	);
	assert.equal(borrowedPlanner?.model.provider, "backup");
});
