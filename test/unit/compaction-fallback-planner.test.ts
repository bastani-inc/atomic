/**
 * RFC §8 — Unit: borrowing order, exhaustion, and per-candidate auth.
 *
 * The door is the two-argument closure `createFallbackPlannerBorrower(context)`
 * returns. One borrower per compaction run owns a monotonic cursor, so the
 * configured list is walked exactly once however many times the ladder asks for
 * the next candidate, and `attempted` stays a `ReadonlySet` the borrower never
 * writes.
 */

import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { test } from "vitest";
import type { PlannerAuth } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import {
	type BorrowFallbackPlanner,
	createFallbackPlannerBorrower,
	type FallbackPlannerContext,
	plannerAttemptKey,
} from "../../packages/coding-agent/src/core/compaction/fallback-planner.js";
import {
	planDeletedLineRanges,
	resolvePlannerRequest,
} from "../../packages/coding-agent/src/core/compaction/range-planner.js";
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

function borrower(overrides: Partial<FallbackPlannerContext> = {}): BorrowFallbackPlanner {
	return createFallbackPlannerBorrower(context(overrides));
}

const authFor = async (model: Model<Api>): Promise<PlannerAuth> => ({
	apiKey: `${model.provider}-key`,
	baseUrl: model.baseUrl,
});

/** An auth resolver that records inspection order and can deny chosen models. */
function trackedAuth(deny: (model: Model<Api>) => boolean = () => false) {
	const seen: string[] = [];
	const resolveAuth = async (model: Model<Api>): Promise<PlannerAuth | undefined> => {
		seen.push(model.id);
		return deny(model) ? undefined : authFor(model);
	};
	return { seen, resolveAuth };
}

test("candidates are returned in configured order, each at most once", async () => {
	const borrow = borrower();
	const attempted: ReadonlySet<string> = new Set(["primary/planner-a:high"]);

	const first = await borrow(attempted, authFor);
	assert.equal(first?.model.id, "planner-b");
	assert.equal(plannerAttemptKey(first!), "backup/planner-b:minimal");

	const second = await borrow(attempted, authFor);
	assert.equal(second?.model.id, "planner-c");
	// The unsuffixed entry inherits the session level, so its effective key is
	// `:high`, not the raw `:` the configured string alone would imply.
	assert.equal(plannerAttemptKey(second!), "spare/planner-c:high");

	assert.equal(await borrow(attempted, authFor), undefined);
});

test("an unsuffixed entry naming an already-attempted effective model is skipped", async () => {
	// The primary ran as primary/planner-a at the inherited `high`; a configured
	// unsuffixed entry naming the same model is the identical effective request.
	const borrow = borrower({ fallbackModels: ["primary/planner-a", "spare/planner-c"] });
	const attempted: ReadonlySet<string> = new Set(["primary/planner-a:high"]);
	assert.equal((await borrow(attempted, authFor))?.model.id, "planner-c");
});

test("an explicit same-level entry for an already-attempted model is skipped", async () => {
	const borrow = borrower({ fallbackModels: ["primary/planner-a:high", "spare/planner-c"] });
	const attempted: ReadonlySet<string> = new Set(["primary/planner-a:high"]);
	assert.equal((await borrow(attempted, authFor))?.model.id, "planner-c");
});

test("the same model at a different explicit level stays a distinct candidate", async () => {
	const borrow = borrower({ fallbackModels: ["primary/planner-a:low"] });
	const found = await borrow(new Set(["primary/planner-a:high"]), authFor);
	assert.equal(found?.model.id, "planner-a");
	assert.equal(plannerAttemptKey(found!), "primary/planner-a:low");
});

test("a non-reasoning model keeps its configured level in the budget and key", async () => {
	// The suffix stays in the identity even though the request will omit it:
	// dropping it would collapse `plain/planner-d:high` and `plain/planner-d:low`
	// into one attempt key.
	const plain = testModel({ provider: "plain", id: "planner-d", reasoning: false });
	const borrow = borrower({
		fallbackModels: ["plain/planner-d:high"],
		registry: registryOf([primary, plain]),
	});
	const found = await borrow(new Set(), authFor);
	assert.equal(found?.budget.reasoning, "high");
	assert.equal(plannerAttemptKey(found!), "plain/planner-d:high");
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
	assert.equal((await borrower()(new Set(), authFor))?.budget.reasoning, "minimal");
	const unsuffixed = borrower({ fallbackModels: ["spare/planner-c"] });
	assert.equal((await unsuffixed(new Set(), authFor))?.budget.reasoning, "high");
});

test("candidates without configured auth are skipped", async () => {
	const borrow = borrower({ registry: registryOf([primary, secondary, tertiary], ["planner-b"]) });
	assert.equal((await borrow(new Set(), authFor))?.model.id, "planner-c");
});

test("resolveAuth is called once per inspected candidate with that candidate's model", async () => {
	const seen: string[] = [];
	const found = await borrower()(new Set(), async (model) => {
		seen.push(`${model.provider}/${model.id}`);
		return authFor(model);
	});
	assert.deepEqual(seen, ["backup/planner-b"]);
	assert.equal(found?.auth.apiKey, "backup-key");
	assert.equal(found?.auth.baseUrl, "https://backup.example");
	// The session model's credentials never travel to another provider.
	assert.notEqual(found?.auth.apiKey, "primary-key");
});

test("exhaustion returns undefined rather than throwing or reusing the session model", async () => {
	assert.equal(await borrower({ fallbackModels: [] })(new Set(), authFor), undefined);
	assert.equal(await borrower({ fallbackModels: ["nope/missing"] })(new Set(), authFor), undefined);
});

test("unqualified entries resolve against available models and prefer the current provider", async () => {
	const sameId = testModel({ provider: "backup", id: "planner-a", baseUrl: "https://backup.example" });
	const borrow = borrower({
		fallbackModels: ["planner-a"],
		registry: registryOf([primary, sameId]),
		preferredProvider: "backup",
	});
	assert.equal((await borrow(new Set(), authFor))?.model.provider, "backup");
});

test("one ordered pass: an auth-unusable candidate is consumed, never re-inspected", async () => {
	const { seen, resolveAuth } = trackedAuth((model) => model.id === "planner-b");
	const borrow = borrower();
	const attempted: ReadonlySet<string> = new Set(["primary/planner-a:high"]);

	const first = await borrow(attempted, resolveAuth);
	assert.equal(first?.model.id, "planner-c");
	assert.deepEqual(seen, ["planner-b", "planner-c"]);

	assert.equal(await borrow(attempted, resolveAuth), undefined);
	assert.deepEqual(seen, ["planner-b", "planner-c"]);
});

test("a rejected auth resolver retires its candidate exactly like an undefined one", async () => {
	const seen: string[] = [];
	const resolveAuth = async (model: Model<Api>): Promise<PlannerAuth> => {
		seen.push(model.id);
		if (model.id === "planner-b") throw new Error("auth backend down");
		return authFor(model);
	};
	const borrow = borrower();
	assert.equal((await borrow(new Set(), resolveAuth))?.model.id, "planner-c");
	assert.equal(await borrow(new Set(), resolveAuth), undefined);
	assert.deepEqual(seen, ["planner-b", "planner-c"]);
});

test("configured order cannot rewind when an unusable candidate's auth later works", async () => {
	let backupHasAuth = false;
	const seen: string[] = [];
	const resolveAuth = async (model: Model<Api>): Promise<PlannerAuth | undefined> => {
		seen.push(model.id);
		if (model.id === "planner-b" && !backupHasAuth) return undefined;
		return authFor(model);
	};
	const borrow = borrower();
	assert.equal((await borrow(new Set(), resolveAuth))?.model.id, "planner-c");

	backupHasAuth = true;
	assert.equal(await borrow(new Set(), resolveAuth), undefined);
	assert.deepEqual(seen, ["planner-b", "planner-c"]);
});

test("an entry that could not resolve to a model is never revisited", async () => {
	// The B→A defect: without the cursor, an unresolvable entry is skipped with no
	// record, so once the registry exposes it the next call returns it *after* a
	// later configured candidate.
	const known = [primary, tertiary];
	const registry = {
		getAvailableSnapshot: () => known.filter((model) => model.id !== "planner-b"),
		getModel: (provider: string, id: string) => known.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => true,
	};
	const borrow = borrower({ fallbackModels: ["backup/planner-b", "spare/planner-c"], registry });

	// Pass 1: B does not resolve at all, so C is returned.
	assert.equal((await borrow(new Set(), authFor))?.model.id, "planner-c");

	// The registry now exposes B. The walk must not rewind to it.
	known.push(secondary);
	assert.equal(await borrow(new Set(), authFor), undefined);
});

test("duplicate configured entries resolve auth once", async () => {
	const { seen, resolveAuth } = trackedAuth((model) => model.id === "planner-b");
	const borrow = borrower({
		fallbackModels: ["backup/planner-b:minimal", "backup/planner-b:minimal", "spare/planner-c"],
	});
	assert.equal((await borrow(new Set(), resolveAuth))?.model.id, "planner-c");
	assert.deepEqual(seen, ["planner-b", "planner-c"]);
});

test("the borrower never writes the attempted set it is given", async () => {
	const attempted = new Set<string>(["primary/planner-a:high"]);
	const frozen: ReadonlySet<string> = attempted;
	const { resolveAuth } = trackedAuth((model) => model.id === "planner-b");
	await borrower()(frozen, resolveAuth);
	assert.deepEqual([...attempted], ["primary/planner-a:high"]);
});

test("concurrent borrowers keep separate cursors", async () => {
	const first = borrower();
	const second = borrower();
	const [a, b] = await Promise.all([first(new Set(), authFor), second(new Set(), authFor)]);
	// Each run starts its own walk at the configured head.
	assert.equal(a?.model.id, "planner-b");
	assert.equal(b?.model.id, "planner-b");
	assert.equal((await first(new Set(), authFor))?.model.id, "planner-c");
	assert.equal((await second(new Set(), authFor))?.model.id, "planner-c");
});
