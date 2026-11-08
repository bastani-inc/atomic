import assert from "node:assert/strict";
import { test } from "vitest";
import type { NumberedRegion, VerbatimCompactionPreparation } from "../src/core/compaction/compaction-types.js";
import type { PolicyRefusalPhase, TerminalPlannerOutcome } from "../src/core/compaction/planner-outcome.js";
import {
	MAX_REFUSAL_SPLIT_DEPTH,
	type PlannerAttempt,
	planWithRefusalRecovery,
} from "../src/core/compaction/refusal-recovery.js";
import { conversationRegion, preparationFor } from "./compaction-midstream-fixtures.js";

function refusal(phase: PolicyRefusalPhase): PlannerAttempt {
	return { kind: "terminal", outcome: { kind: "policyRefusal", phase, message: `refused ${phase}` } };
}

function failed(outcome: TerminalPlannerOutcome): PlannerAttempt {
	return { kind: "terminal", outcome };
}

function planned(...ranges: Array<[number, number]>): PlannerAttempt {
	return { kind: "planned", ranges: ranges.map(([start, end]) => ({ start, end })) };
}

interface ScriptedPlanner {
	readonly planRegion: (preparation: VerbatimCompactionPreparation) => Promise<PlannerAttempt>;
	/** Line count of each region the planner was asked about, in call order. */
	readonly requested: number[];
	readonly maxInFlight: () => number;
}

function scripted(script: PlannerAttempt[]): ScriptedPlanner {
	const requested: number[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	return {
		requested,
		maxInFlight: () => maxInFlight,
		planRegion: async (preparation) => {
			const answer = script[requested.length];
			assert.ok(answer, `unexpected planner request ${requested.length + 1}`);
			requested.push(preparation.region.lines.length);
			maxInFlight = Math.max(maxInFlight, ++inFlight);
			await Promise.resolve();
			inFlight--;
			return answer;
		},
	};
}

const WHOLE = preparationFor(conversationRegion(8));
const WHOLE_LINES = WHOLE.region.lines.length;
const HALF_LINES = 16;
const SECOND_HALF_LINES = WHOLE_LINES - HALF_LINES;
const QUARTER_LINES = 8;

function protectedRegion(region: NumberedRegion, lines: number[]): NumberedRegion {
	return { ...region, protectedLineNumbers: new Set(lines) };
}

test("the split is bounded to halves and quarters (#4543)", () => {
	assert.equal(MAX_REFUSAL_SPLIT_DEPTH, 2);
});

test("a planned region is returned without a retry (#4543)", async () => {
	const planner = scripted([planned([1, 5])]);

	assert.deepEqual(await planWithRefusalRecovery(WHOLE, planner.planRegion), planned([1, 5]));
	assert.deepEqual(planner.requested, [WHOLE_LINES]);
});

test("an input refusal is returned at once, neither retried nor split (#4543)", async () => {
	const planner = scripted([refusal("input")]);

	assert.deepEqual(await planWithRefusalRecovery(WHOLE, planner.planRegion), refusal("input"));
	assert.deepEqual(planner.requested, [WHOLE_LINES]);
});

test("a failure that is not a refusal is returned at once (#4543)", async () => {
	for (const outcome of [
		{ kind: "providerError", message: "boom" },
		{ kind: "overflowed" },
		{ kind: "rateLimited", category: "rate_limited", exhausted: true, message: "slow down" },
	] satisfies TerminalPlannerOutcome[]) {
		const planner = scripted([failed(outcome)]);

		assert.deepEqual(await planWithRefusalRecovery(WHOLE, planner.planRegion), failed(outcome));
		assert.deepEqual(planner.requested, [WHOLE_LINES]);
	}
});

test("a mid-stream refusal is retried once and a successful retry is not split (#4543)", async () => {
	const planner = scripted([refusal("midstream"), planned([2, 9])]);

	assert.deepEqual(await planWithRefusalRecovery(WHOLE, planner.planRegion), planned([2, 9]));
	assert.deepEqual(planner.requested, [WHOLE_LINES, WHOLE_LINES]);
});

test("a retry that fails without a refusal returns the original mid-stream refusal and is not split (#4543)", async () => {
	for (const outcome of [
		{ kind: "providerError", message: "boom" },
		{ kind: "unusable", category: "no_usable_ranges", excerpt: "" },
		{ kind: "overflowed" },
		{ kind: "rateLimited", category: "rate_limited", exhausted: true, message: "slow down" },
	] satisfies TerminalPlannerOutcome[]) {
		const first = refusal("midstream");
		const planner = scripted([first, failed(outcome)]);

		assert.equal(await planWithRefusalRecovery(WHOLE, planner.planRegion), first);
		assert.deepEqual(planner.requested, [WHOLE_LINES, WHOLE_LINES]);
	}
});

test("two mid-stream refusals plan the halves and merge their ranges onto the whole region (#4543)", async () => {
	const planner = scripted([refusal("midstream"), refusal("midstream"), planned([1, 4], [9, 12]), planned([3, 6])]);

	const result = await planWithRefusalRecovery(WHOLE, planner.planRegion);

	assert.deepEqual(result, planned([1, 4], [9, 12], [HALF_LINES + 3, HALF_LINES + 6]));
	assert.deepEqual(planner.requested, [WHOLE_LINES, WHOLE_LINES, HALF_LINES, SECOND_HALF_LINES]);
});

test("a retry refused before any output still leads to the split (#4543)", async () => {
	const planner = scripted([refusal("midstream"), refusal("input"), planned([1, 2]), planned([1, 2])]);

	const result = await planWithRefusalRecovery(WHOLE, planner.planRegion);

	assert.deepEqual(result, planned([1, 2], [HALF_LINES + 1, HALF_LINES + 2]));
});

test("halves are planned one after the other (#4543)", async () => {
	const planner = scripted([refusal("midstream"), refusal("midstream"), planned([1, 2]), planned([1, 2])]);

	await planWithRefusalRecovery(WHOLE, planner.planRegion);

	assert.equal(planner.maxInFlight(), 1);
});

test("a refused half is planned in quarters and the ranges of all parts merge (#4543)", async () => {
	const planner = scripted([
		refusal("midstream"),
		refusal("midstream"),
		refusal("midstream"),
		planned([1, 3]),
		planned([2, 4]),
		refusal("input"),
		planned([5, 6]),
		planned([1, 2]),
	]);

	const result = await planWithRefusalRecovery(WHOLE, planner.planRegion);

	assert.deepEqual(
		result,
		planned([1, 3], [QUARTER_LINES + 2, QUARTER_LINES + 4], [16 + 5, 16 + 6], [16 + 8 + 1, 16 + 8 + 2]),
	);
	assert.deepEqual(planner.requested, [
		WHOLE_LINES,
		WHOLE_LINES,
		HALF_LINES,
		QUARTER_LINES,
		QUARTER_LINES,
		SECOND_HALF_LINES,
		QUARTER_LINES,
		SECOND_HALF_LINES - QUARTER_LINES,
	]);
});

test("a refused quarter ends the split with the retry's refusal, after four planner requests (#4543)", async () => {
	const retried = refusal("midstream");
	const planner = scripted([refusal("midstream"), retried, refusal("midstream"), refusal("midstream")]);

	const result = await planWithRefusalRecovery(WHOLE, planner.planRegion);

	assert.equal(result, retried);
	assert.deepEqual(planner.requested, [WHOLE_LINES, WHOLE_LINES, HALF_LINES, QUARTER_LINES]);
});

test("a refused second quarter ends the split without planning the rest (#4543)", async () => {
	const retried = refusal("midstream");
	const planner = scripted([
		refusal("midstream"),
		retried,
		refusal("midstream"),
		planned([1, 2]),
		refusal("midstream"),
	]);

	assert.equal(await planWithRefusalRecovery(WHOLE, planner.planRegion), retried);
	assert.equal(planner.requested.length, 5);
});

test("a part that fails without a refusal ends the split without a further request (#4543)", async () => {
	const retried = refusal("midstream");
	const planner = scripted([
		refusal("midstream"),
		retried,
		failed({ kind: "unusable", category: "no_usable_ranges", excerpt: "" }),
	]);

	assert.equal(await planWithRefusalRecovery(WHOLE, planner.planRegion), retried);
	assert.equal(planner.requested.length, 3);
});

test("a part that cannot be split further ends the split (#4543)", async () => {
	const twoMessages = preparationFor(conversationRegion(2, 12));
	const retried = refusal("midstream");
	const planner = scripted([refusal("midstream"), retried, refusal("midstream")]);

	assert.equal(await planWithRefusalRecovery(twoMessages, planner.planRegion), retried);
	assert.equal(planner.requested.length, 3);
});

test("a region holding one message is not split (#4543)", async () => {
	const oneMessage = preparationFor(conversationRegion(1, 30));
	const retried = refusal("midstream");
	const planner = scripted([refusal("midstream"), retried]);

	assert.equal(await planWithRefusalRecovery(oneMessage, planner.planRegion), retried);
	assert.equal(planner.requested.length, 2);
});

test("a part with nothing to delete is skipped without a request (#4543)", async () => {
	const firstHalfProtected = Array.from({ length: HALF_LINES }, (_, index) => index + 1);
	const preparation = preparationFor(protectedRegion(WHOLE.region, firstHalfProtected));
	const planner = scripted([refusal("midstream"), refusal("midstream"), planned([2, 5])]);

	const result = await planWithRefusalRecovery(preparation, planner.planRegion);

	assert.deepEqual(result, planned([HALF_LINES + 2, HALF_LINES + 5]));
	assert.deepEqual(planner.requested, [WHOLE_LINES, WHOLE_LINES, SECOND_HALF_LINES]);
});

test("a part's ranges never cover its protected lines (#4543)", async () => {
	const preparation = preparationFor(protectedRegion(WHOLE.region, [3, 4]));
	const planner = scripted([refusal("midstream"), refusal("midstream"), planned([1, 8]), planned([1, 2])]);

	const result = await planWithRefusalRecovery(preparation, planner.planRegion);

	assert.deepEqual(result, planned([1, 2], [5, 8], [HALF_LINES + 1, HALF_LINES + 2]));
});

test("when every part is skipped the retry's refusal is returned (#4543)", async () => {
	const everyLine = Array.from({ length: WHOLE_LINES }, (_, index) => index + 1);
	const preparation = preparationFor(protectedRegion(WHOLE.region, everyLine));
	const retried = refusal("midstream");
	const planner = scripted([refusal("midstream"), retried]);

	assert.equal(await planWithRefusalRecovery(preparation, planner.planRegion), retried);
	assert.equal(planner.requested.length, 2);
});

test("cancellation during the split is thrown, not turned into an outcome (#4543)", async () => {
	let requests = 0;
	const planRegion = async (): Promise<PlannerAttempt> => {
		if (++requests === 3) throw new Error("Compaction cancelled");
		return refusal("midstream");
	};

	await assert.rejects(planWithRefusalRecovery(WHOLE, planRegion), /Compaction cancelled/);
	assert.equal(requests, 3);
});
