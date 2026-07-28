/**
 * RFC §8 — Unit: borrowing order, exhaustion, and per-candidate auth.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
	borrowFallbackPlanner,
	plannerAttemptKey,
	type FallbackPlannerContext,
} from "../../packages/coding-agent/src/core/compaction/fallback-planner.js";
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
	assert.equal(plannerAttemptKey(first!), "backup/planner-b:minimal");
	attempted.add(plannerAttemptKey(first!));

	const second = await borrowFallbackPlanner(context(), attempted, authFor);
	assert.equal(second?.model.id, "planner-c");
	// The unsuffixed entry inherits the session level, so its effective key is
	// `:high`, not the raw `:` the configured string alone would imply.
	assert.equal(plannerAttemptKey(second!), "spare/planner-c:high");
	attempted.add(plannerAttemptKey(second!));

	assert.equal(await borrowFallbackPlanner(context(), attempted, authFor), undefined);
});

test("an unsuffixed entry naming an already-attempted effective model is skipped", async () => {
	// The primary ran as primary/planner-a at the inherited `high`; a configured
	// unsuffixed entry naming the same model is the identical effective request.
	const attempted = new Set<string>(["primary/planner-a:high"]);
	const borrowedPlanner = await borrowFallbackPlanner(
		context({ fallbackModels: ["primary/planner-a", "spare/planner-c"] }),
		attempted,
		authFor,
	);
	assert.equal(borrowedPlanner?.model.id, "planner-c");
});

test("an explicit same-level entry for an already-attempted model is skipped", async () => {
	const attempted = new Set<string>(["primary/planner-a:high"]);
	const borrowedPlanner = await borrowFallbackPlanner(
		context({ fallbackModels: ["primary/planner-a:high", "spare/planner-c"] }),
		attempted,
		authFor,
	);
	assert.equal(borrowedPlanner?.model.id, "planner-c");
});

test("the same model at a different explicit level stays a distinct candidate", async () => {
	const attempted = new Set<string>(["primary/planner-a:high"]);
	const borrowedPlanner = await borrowFallbackPlanner(
		context({ fallbackModels: ["primary/planner-a:low"] }),
		attempted,
		authFor,
	);
	assert.equal(borrowedPlanner?.model.id, "planner-a");
	assert.equal(plannerAttemptKey(borrowedPlanner!), "primary/planner-a:low");
});

test("a non-reasoning model keys with no effective level", async () => {
	const plain = testModel({ provider: "plain", id: "planner-d", reasoning: false });
	const borrowedPlanner = await borrowFallbackPlanner(
		context({ fallbackModels: ["plain/planner-d:high"], registry: registryOf([primary, plain]) }),
		new Set(),
		authFor,
	);
	assert.equal(borrowedPlanner?.budget.reasoning, undefined);
	assert.equal(plannerAttemptKey(borrowedPlanner!), "plain/planner-d:");
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
