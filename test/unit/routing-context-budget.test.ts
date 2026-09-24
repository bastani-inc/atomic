import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { routeModel } from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	classifierResult,
	decisionClassifier,
	decisionMessage,
	decisionModel,
	decisionRequest,
	messageStream,
	parseInferenceUserPayload,
} from "../helpers/structured-output.js";

function largeDecision() {
	const request = decisionRequest();
	const candidates = Array.from({ length: 300 }, (_, index) => ({
		id: `candidate-${index}`,
		description: `Candidate ${index}`,
	}));
	return {
		...request,
		settings: { getRouterModel: () => "decision-test/classifier" },
		state: { ...request.state, candidates },
		classifier: {
			questions: {
				route: {
					instructions: "Choose a candidate",
					criteria: Object.fromEntries(candidates.map(({ id, description }) => [id, description])),
				},
			},
			decode: () => ({ route: "review" as const }),
		},
		candidates,
	};
}

test("registry classifier receives the complete routing context without a Jev-specific candidate limit", async () => {
	const { candidates, ...request } = largeDecision();
	const classify = vi.fn(async (_model, context) => {
		assert.deepEqual(context.state.candidates, candidates);
		assert.deepEqual(
			Object.keys(context.questions.route.criteria),
			candidates.map(({ id }) => id),
		);
		return classifierResult({ route: candidates.at(-1)!.id });
	});
	const result = await routeModel({
		...request,
		modelRegistry: { ...request.modelRegistry, getClassifierModel: () => decisionClassifier, classify },
	});
	assert.equal(result.model, "decision-test/classifier");
	assert.equal(result.value.route, "review");
	assert.equal(classify.mock.calls.length, 1);
});

for (const task of ["x".repeat(40_000), "🌙".repeat(15_000)]) {
	test(`classifier runtime failure preserves a ${task.length}-character task for chat fallback`, async () => {
		const request = decisionRequest();
		const state = { ...request.state, task };
		const classify = vi.fn(async () => ({
			...classifierResult(),
			stopReason: "error" as const,
			errorMessage: "Provider request is too large",
		}));
		const chat = vi.fn((_model, context) => {
			assert.equal(parseInferenceUserPayload(context).state?.task, task);
			return messageStream(decisionMessage());
		});
		const result = await routeModel({
			...request,
			state,
			settings: { getRouterModel: () => "decision-test/classifier" },
			modelRegistry: {
				getAll: () => [decisionModel],
				streamSimple: chat,
				getClassifierModel: () => decisionClassifier,
				classify,
			},
		});
		assert.equal(result.model, "decision-test/chat");
		assert.equal(result.fallback?.from, "decision-test/classifier");
		assert.equal(classify.mock.calls.length, 1);
		assert.equal(chat.mock.calls.length, 1);
	});
}

test("an unavailable classifier with no current chat model fails without a hidden selection", async () => {
	const { candidates: _candidates, ...request } = largeDecision();
	const classify = vi.fn(async () => ({ ...classifierResult(), stopReason: "error" as const }));
	await assert.rejects(
		routeModel({
			...request,
			currentModel: undefined,
			modelRegistry: { ...request.modelRegistry, getClassifierModel: () => decisionClassifier, classify },
		}),
		/Classifier returned no valid decision/,
	);
	assert.equal(classify.mock.calls.length, 1);
});
