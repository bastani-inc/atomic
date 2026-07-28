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
import { planDeletedLineRanges, resolvePlannerRequest } from "../../packages/coding-agent/src/core/compaction/range-planner.js";
import { PARAMETERS, region, registryOf, scriptedStream, testModel } from "./compaction-rung-support.js";

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

test("a non-reasoning model keeps its configured level in the budget and key", async () => {
	// The suffix stays in the identity even though the request will omit it:
	// dropping it would collapse `plain/planner-d:high` and `plain/planner-d:low`
	// into one attempt key.
	const plain = testModel({ provider: "plain", id: "planner-d", reasoning: false });
	const borrowedPlanner = await borrowFallbackPlanner(
		context({ fallbackModels: ["plain/planner-d:high"], registry: registryOf([primary, plain]) }),
		new Set(),
		authFor,
	);
	assert.equal(borrowedPlanner?.budget.reasoning, "high");
	assert.equal(plannerAttemptKey(borrowedPlanner!), "plain/planner-d:high");
});

test("a non-reasoning model still sends no reasoning parameter", async () => {
	const plain = testModel({ provider: "plain", id: "planner-d", reasoning: false });
	const stream = scriptedStream({ default: [{ text: "1,10\n" }] });
	await planDeletedLineRanges(
		region(),
		PARAMETERS,
		{ model: plain, budget: resolvePlannerRequest(plain, "high"), auth: { apiKey: "plain-key" } },
		30,
		{ streamFn: stream.streamFn },
	);
	assert.equal("reasoning" in stream.calls[0].options, false);
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

test("one ordered pass: an auth-unusable candidate is consumed, never re-inspected", async () => {
	// The runner calls the borrower once per terminal planner outcome. Without
	// consuming an auth-unusable candidate, the walk restarts from the top each
	// time and resolves its credentials again — the A, B, A traversal RFC §5.3
	// forbids.
	const seen: string[] = [];
	const attempted = new Set<string>(["primary/planner-a:high"]);
	const authUnusableB = async (model: Model<Api>): Promise<PlannerAuth | undefined> => {
		seen.push(model.id);
		return model.id === "planner-b" ? undefined : authFor(model);
	};

	const first = await borrowFallbackPlanner(context(), attempted, authUnusableB);
	assert.equal(first?.model.id, "planner-c");
	assert.deepEqual(seen, ["planner-b", "planner-c"]);
	assert.ok(attempted.has("backup/planner-b:minimal"), "the unusable candidate was not retired");

	// C then fails at the planner, so the runner records it and borrows again.
	attempted.add(plannerAttemptKey(first!));
	assert.equal(await borrowFallbackPlanner(context(), attempted, authUnusableB), undefined);
	assert.deepEqual(seen, ["planner-b", "planner-c"]);
});

test("a rejected auth resolver retires its candidate exactly like an undefined one", async () => {
	const seen: string[] = [];
	const attempted = new Set<string>(["primary/planner-a:high"]);
	const authThrowsForB = async (model: Model<Api>): Promise<PlannerAuth> => {
		seen.push(model.id);
		if (model.id === "planner-b") throw new Error("auth backend down");
		return authFor(model);
	};

	const first = await borrowFallbackPlanner(context(), attempted, authThrowsForB);
	assert.equal(first?.model.id, "planner-c");
	assert.ok(attempted.has("backup/planner-b:minimal"));

	attempted.add(plannerAttemptKey(first!));
	assert.equal(await borrowFallbackPlanner(context(), attempted, authThrowsForB), undefined);
	assert.deepEqual(seen, ["planner-b", "planner-c"]);
});

test("configured order cannot rewind if an unusable candidate's auth later works", async () => {
	let backupHasAuth = false;
	const seen: string[] = [];
	const attempted = new Set<string>(["primary/planner-a:high"]);
	const flakyAuth = async (model: Model<Api>): Promise<PlannerAuth | undefined> => {
		seen.push(model.id);
		if (model.id === "planner-b" && !backupHasAuth) return undefined;
		return authFor(model);
	};

	const first = await borrowFallbackPlanner(context(), attempted, flakyAuth);
	assert.equal(first?.model.id, "planner-c");
	attempted.add(plannerAttemptKey(first!));

	backupHasAuth = true;
	assert.equal(await borrowFallbackPlanner(context(), attempted, flakyAuth), undefined);
	assert.deepEqual(seen, ["planner-b", "planner-c"]);
});

test("duplicate configured entries resolve auth once", async () => {
	const seen: string[] = [];
	const countingAuth = async (model: Model<Api>): Promise<PlannerAuth | undefined> => {
		seen.push(model.id);
		return model.id === "planner-b" ? undefined : authFor(model);
	};
	const borrowedPlanner = await borrowFallbackPlanner(
		context({ fallbackModels: ["backup/planner-b:minimal", "backup/planner-b:minimal", "spare/planner-c"] }),
		new Set<string>(),
		countingAuth,
	);
	assert.equal(borrowedPlanner?.model.id, "planner-c");
	assert.deepEqual(seen, ["planner-b", "planner-c"]);
});

test("consuming candidates only writes the run-owned set", async () => {
	// The borrower touches only the set it is handed, which the compaction run
	// owns; the main chat's `_fallbackAttemptedKeys` is a different object.
	const mainChatKeys = new Set<string>(["main/chat:high"]);
	const runKeys = new Set<string>(["primary/planner-a:high"]);
	await borrowFallbackPlanner(context(), runKeys, async (model) =>
		model.id === "planner-b" ? undefined : authFor(model),
	);
	assert.deepEqual([...mainChatKeys], ["main/chat:high"]);
	assert.ok(runKeys.has("backup/planner-b:minimal"));
});
