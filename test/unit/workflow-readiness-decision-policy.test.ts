import assert from "node:assert/strict";
import { test } from "vitest";
import {
	DecisionConfigError,
	DecisionModelUnavailableError,
	DecisionTimeoutError,
} from "../../packages/coding-agent/src/core/decision/errors.js";
import type { DecisionResult } from "../../packages/coding-agent/src/core/decision/types.js";
import {
	describeReadinessDecision,
	READINESS_DECISION_INSTRUCTIONS,
	READINESS_DECISION_QUESTIONS,
	READINESS_DECISION_THRESHOLDS,
	READINESS_STATE_MAX_CHARS,
	type ReadinessDecisionQuestions,
	readinessDecisionRecord,
	readinessFailureRecord,
	readinessState,
	readinessVerdict,
} from "../../packages/workflows/src/runs/foreground/readiness-decision.js";
import * as workflowsSdk from "../../packages/workflows/src/sdk-surface.js";

function answers(
	advance: number | undefined,
	stay: number | undefined,
	addressed: number | undefined,
): Pick<DecisionResult<ReadinessDecisionQuestions>, "answers"> {
	const choice = (advance ?? 0) >= (stay ?? 0) ? "advance" : "stay";
	return {
		answers: {
			next_action: {
				type: "choice",
				choice,
				...(advance === undefined || stay === undefined ? {} : { probabilities: { advance, stay } }),
			},
			reply_addresses_message: {
				type: "bool",
				value: (addressed ?? 0) >= 0.5,
				...(addressed === undefined ? {} : { probability: addressed }),
			},
		},
	};
}

test("the thresholds are one exported constant: advance 0.85 with addressed 0.8, stay 0.7 (#4358)", () => {
	assert.deepEqual({ ...READINESS_DECISION_THRESHOLDS }, { advance: 0.85, addressed: 0.8, stay: 0.7 });
	assert.equal(Object.isFrozen(READINESS_DECISION_THRESHOLDS), true);
	assert.equal(workflowsSdk.READINESS_DECISION_THRESHOLDS, READINESS_DECISION_THRESHOLDS);
	assert.equal(workflowsSdk.readinessVerdict, readinessVerdict);
	assert.equal(typeof workflowsSdk.decide, "function");
	assert.equal(typeof workflowsSdk.isDecisionError, "function");
});

test("the decision asks an advance/stay Choice and its companion yes/no question", () => {
	assert.equal(READINESS_DECISION_QUESTIONS.next_action.type, "choice");
	assert.deepEqual(Object.keys(READINESS_DECISION_QUESTIONS.next_action.criteria), ["advance", "stay"]);
	assert.equal(READINESS_DECISION_QUESTIONS.reply_addresses_message.type, "bool");
	assert.equal(
		READINESS_DECISION_QUESTIONS.reply_addresses_message.instructions,
		"Does the stage's reply fully address the user's message and leave nothing the user still needs to answer?",
	);
});

const CASES: ReadonlyArray<readonly [string, number, number, number, "advance" | "stay" | "ask"]> = [
	["advance at both thresholds exactly", 0.85, 0.15, 0.8, "advance"],
	["advance well above both thresholds", 0.97, 0.03, 0.95, "advance"],
	["advance just below its threshold", 0.8499, 0.1501, 0.99, "ask"],
	["advance with the companion just below its threshold", 0.95, 0.05, 0.7999, "ask"],
	["advance with a confident no from the companion", 0.99, 0.01, 0.1, "ask"],
	["stay at its threshold exactly", 0.3, 0.7, 0.2, "stay"],
	["stay just below its threshold", 0.3001, 0.6999, 0.2, "ask"],
	["stay regardless of the companion", 0.1, 0.9, 0.95, "stay"],
	["an even split", 0.5, 0.5, 0.5, "ask"],
];

for (const [label, advance, stay, addressed, outcome] of CASES) {
	test(`readiness verdict: ${label} → ${outcome}`, () => {
		const verdict = readinessVerdict(answers(advance, stay, addressed));
		assert.equal(verdict.outcome, outcome);
		assert.deepEqual(verdict.probabilities, { advance, stay, addressed });
	});
}

test("answers without probabilities (a chat model's) always ask", () => {
	assert.deepEqual(readinessVerdict(answers(undefined, undefined, 0.99)), { outcome: "ask" });
	assert.deepEqual(readinessVerdict(answers(0.99, 0.01, undefined)), { outcome: "ask" });
});

test("a caller can apply its own thresholds", () => {
	const strict = { advance: 0.99, addressed: 0.99, stay: 0.99 };
	assert.equal(readinessVerdict(answers(0.97, 0.03, 0.95), strict).outcome, "ask");
});

test("each outcome is recorded with its model and probabilities, and described for status and the transcript", () => {
	const advanced = readinessDecisionRecord(readinessVerdict(answers(0.93, 0.07, 0.91)), "typesafe/jev-latest", 5);
	assert.deepEqual(advanced, {
		outcome: "advanced",
		at: 5,
		model: "typesafe/jev-latest",
		probabilities: { advance: 0.93, stay: 0.07, addressed: 0.91 },
	});
	assert.equal(Object.isFrozen(advanced), true);
	assert.equal(describeReadinessDecision(advanced), "Decision model advanced the stage (p=0.93, addressed p=0.91)");
	const stayed = readinessDecisionRecord(readinessVerdict(answers(0.12, 0.88, 0.2)), "typesafe/jev-latest", 6);
	assert.equal(stayed.outcome, "stayed");
	assert.equal(describeReadinessDecision(stayed), "Decision model kept the stage open (p=0.88)");
	const asked = readinessDecisionRecord(readinessVerdict(answers(0.6, 0.4, 0.9)), "typesafe/jev-latest", 7);
	assert.equal(asked.outcome, "asked");
	assert.equal(
		describeReadinessDecision(asked),
		"Decision model was unsure (advance p=0.60, stay p=0.40, addressed p=0.90); asked whether to move on",
	);
	const noProbabilities = readinessDecisionRecord({ outcome: "ask" }, "decision-test/chat", 8);
	assert.equal(noProbabilities.probabilities, undefined);
	assert.equal(describeReadinessDecision(noProbabilities), "Decision model was unsure; asked whether to move on");
});

test("a failed decision records the typed error that made it ask, by class and code", () => {
	const timeout = readinessFailureRecord(
		new DecisionTimeoutError({ timeoutMs: 1, elapsedMs: 1, phase: "classifier" }),
		9,
	);
	assert.deepEqual(timeout, { outcome: "asked", at: 9, error: { name: "DecisionTimeoutError", code: "timeout" } });
	assert.equal(describeReadinessDecision(timeout), "Decision model failed (timeout); asked whether to move on");
	const wrapped = readinessFailureRecord(
		new Error("host", { cause: new DecisionModelUnavailableError({ reason: "no-probabilities" }) }),
	);
	assert.deepEqual(wrapped.error, { name: "DecisionModelUnavailableError", code: "model-unavailable" });
	assert.deepEqual(
		readinessFailureRecord(
			new DecisionConfigError({ code: "invalid-setting", source: "settings", field: "decisionModel" }),
		).error,
		{ name: "DecisionConfigError", code: "invalid-setting" },
	);
	assert.deepEqual(readinessFailureRecord(new TypeError("boom")).error, { name: "TypeError", code: "unknown" });
	assert.deepEqual(readinessFailureRecord("text").error, { name: "Error", code: "unknown" });
});

test("the decision state holds the objective, the user's message and the stage's reply, truncated", () => {
	const long = "x".repeat(READINESS_STATE_MAX_CHARS + 10);
	const state = readinessState({ objective: long, userMessage: "Use blue.", reply: undefined });
	assert.equal(state.stage_objective.length, READINESS_STATE_MAX_CHARS + 1);
	assert.ok(state.stage_objective.endsWith("…"));
	assert.equal(state.user_message, "Use blue.");
	assert.equal(state.stage_reply, "");
	const exact = "y".repeat(READINESS_STATE_MAX_CHARS);
	assert.equal(readinessState({ objective: undefined, userMessage: exact, reply: exact }).stage_reply, exact);
	assert.equal(readinessState({ objective: undefined, userMessage: "m", reply: "r" }).stage_objective, "");
});

test("a decision missing one option's probability asks, and the instructions describe the state", () => {
	const partial = {
		answers: {
			next_action: { type: "choice" as const, choice: "advance" as const, probabilities: { advance: 0.99 } },
			reply_addresses_message: { type: "bool" as const, value: true, probability: 0.99 },
		},
	};
	assert.deepEqual(readinessVerdict(partial), { outcome: "ask" });
	assert.equal(
		READINESS_DECISION_INSTRUCTIONS,
		"A workflow stage asked the user a question. The user then sent `user_message`, and the stage answered with `stage_reply`. `stage_objective` is what the stage was asked to do. Decide whether the stage can complete now or should stay open for the user.",
	);
});

test("a decision missing the advance probability asks rather than staying", () => {
	assert.deepEqual(
		readinessVerdict({
			answers: {
				next_action: { type: "choice", choice: "stay", probabilities: { stay: 0.95 } },
				reply_addresses_message: { type: "bool", value: false, probability: 0.1 },
			},
		}),
		{ outcome: "ask" },
	);
});
