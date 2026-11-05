import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { decide } from "../../packages/coding-agent/src/core/decision/decide.js";
import {
	DecisionProviderError,
	isDecisionConfigError,
	isDecisionError,
	isDecisionModelUnavailableError,
	isDecisionOutputError,
	isDecisionProviderError,
	isDecisionTimeoutError,
} from "../../packages/coding-agent/src/core/decision/errors.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	ClassifierDecisionError,
	generateStructuredOutput,
	runDecision,
} from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	carriedProviderFailure,
	withProviderFailure,
} from "../../packages/coding-agent/src/core/structured-output/provider-failure.js";
import type {
	DecisionModelRequest,
	StructuredDecisionQuestion,
} from "../../packages/coding-agent/src/core/structured-output/types.js";
import {
	choiceDecisionSchema,
	decisionChatModel,
	decisionClassifier,
	decisionMessage,
	decisionRequest,
	decisionSchema,
	messageStream,
	registeredDecisionRuntime,
	routeModel,
	structuredOutputRequest,
} from "../helpers/structured-output.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const MALFORMED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
	["a blank ID", { " ": { instructions: "Pick", criteria: { a: "A" } } }],
	["missing instructions", { pick: { criteria: { a: "A" } } }],
	["blank instructions", { pick: { instructions: " ", criteria: { a: "A" } } }],
	["choice without criteria", { pick: { instructions: "Pick" } }],
	["choice with no options", { pick: { instructions: "Pick", criteria: {} } }],
	["choice with a blank key", { pick: { instructions: "Pick", criteria: { a: "A", " ": "B" } } }],
	["choice with a blank meaning", { pick: { instructions: "Pick", criteria: { a: "A", b: " " } } }],
	["choice with a non-text meaning", { pick: { instructions: "Pick", criteria: { a: 1 } } }],
	["bool without criteria", { yes: { type: "bool", instructions: "Yes?" } }],
	["bool without true", { yes: { type: "bool", instructions: "Yes?", criteria: { false: "No" } } }],
	["bool without false", { yes: { type: "bool", instructions: "Yes?", criteria: { true: "Yes", false: "" } } }],
	["score without levels", { grade: { type: "score", instructions: "Grade", criteria: "low" } }],
	["score with one level", { grade: { type: "score", instructions: "Grade", criteria: ["only"] } }],
	["score with a blank level", { grade: { type: "score", instructions: "Grade", criteria: ["low", " ", "high"] } }],
];

for (const [label, questions] of MALFORMED) {
	test(`the decision engine refuses a question with ${label} before any request`, async () => {
		const dispatch = vi.fn(() => messageStream(decisionMessage()));
		const { registry } = await registeredDecisionRuntime(dispatch);
		await assert.rejects(
			routeModel({
				...decisionRequest(),
				modelRegistry: registry,
				classifier: {
					questions: questions as Record<string, StructuredDecisionQuestion>,
					decode: () => ({ route: "review" as const }),
				},
			}),
			/questions require nonempty IDs, full instructions and described Choice candidates/,
		);
		assert.equal(dispatch.mock.calls.length, 0);
	});
}

test("the decision engine accepts described yes/no and two-level score questions", async () => {
	const dispatch = vi.fn(() => messageStream(decisionMessage({ route: "review" })));
	const { registry } = await registeredDecisionRuntime(dispatch);
	const result = await routeModel({
		...decisionRequest(),
		schema: choiceDecisionSchema,
		modelRegistry: registry,
		classifier: {
			questions: {
				yes: { type: "bool", instructions: "Yes?", criteria: { true: "Yes", false: "No" } },
				grade: { type: "score", instructions: "Grade", criteria: ["low", "high"] },
			},
			decode: () => ({ route: "review" as const }),
		},
	});
	assert.deepEqual(result.value, { route: "review" });
});

for (const [decisionModel, expected] of [
	["", "decision-test/chat"],
	["auto", "decision-test/chat"],
	["decision-test/classifier", "decision-test/classifier"],
] as const) {
	test(`structured output without its own model starts on decisionModel=${JSON.stringify(decisionModel)} (#4358)`, async () => {
		const dispatch = vi.fn(() => messageStream(decisionMessage({ route: "review" })));
		const classify = vi.fn(async () => ({
			api: decisionClassifier.api,
			provider: decisionClassifier.provider,
			model: decisionClassifier.id,
			answers: { route: { type: "choice" as const, choice: '"review"', probabilities: {}, confidence: 1 } },
			stopReason: "stop" as const,
			timestamp: 1,
		}));
		const result = await generateStructuredOutput({
			...structuredOutputRequest(),
			settings: SettingsManager.inMemory({ decisionModel }),
			modelRegistry: {
				getAll: () => [decisionChatModel],
				streamSimple: dispatch,
				getClassifierModel: () => decisionClassifier,
				classify,
			},
		});
		assert.equal(result.model, expected);
		assert.deepEqual(result.value, { route: "review" });
		assert.equal(result.fallback, undefined);
		assert.equal(result.modelAttempts, undefined);
		assert.equal(classify.mock.calls.length, expected === "decision-test/classifier" ? 1 : 0);
		assert.equal(dispatch.mock.calls.length, expected === "decision-test/chat" ? 1 : 0);
	});
}

test("structured output with its own model ignores decisionModel", async () => {
	const dispatch = vi.fn(() => messageStream(decisionMessage({ route: "review" })));
	const settings = SettingsManager.inMemory({ decisionModel: "decision-test/classifier" });
	const read = vi.spyOn(settings, "getDecisionModel");
	const result = await generateStructuredOutput({
		...structuredOutputRequest(),
		model: "decision-test/chat",
		settings,
		modelRegistry: { getAll: () => [decisionChatModel], streamSimple: dispatch },
	});
	assert.equal(result.model, "decision-test/chat");
	assert.equal(read.mock.calls.length, 0);
});

test("a classifier that never answers times out in the classifier phase", async () => {
	await assert.rejects(
		decide({
			state: { note: "x" },
			questions: { yes: { type: "bool", instructions: "Yes?", criteria: { true: "Yes", false: "No" } } },
			deadline: 30,
			requireProbabilities: true,
			settings: { getDecisionModel: () => "decision-test/classifier" },
			modelRegistry: {
				getAll: () => [decisionChatModel],
				streamSimple: vi.fn(),
				getClassifierModel: () => decisionClassifier,
				classify: () => new Promise(() => {}),
			},
		}),
		(error: unknown) => isDecisionTimeoutError(error) && error.phase === "classifier" && error.timeoutMs === 30,
	);
});

test("a failed classifier never falls back to a placeholder auto model", async () => {
	const dispatch = vi.fn(() => messageStream(decisionMessage({ yes: true })));
	const { registry } = await registeredDecisionRuntime(dispatch);
	await assert.rejects(
		decide({
			state: { note: "x" },
			questions: { yes: { type: "bool", instructions: "Yes?", criteria: { true: "Yes", false: "No" } } },
			settings: { getDecisionModel: () => "decision-test/classifier" },
			currentModel: { ...decisionChatModel, id: "auto" },
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			modelRegistry: {
				getAll: () => [decisionChatModel],
				streamSimple: (...args) => registry.streamSimple(...args),
				getClassifierModel: () => decisionClassifier,
				classify: async () => {
					throw new Error("unavailable");
				},
			},
		}),
		(error: unknown) => isDecisionProviderError(error) && error.model === "decision-test/classifier",
	);
	assert.equal(dispatch.mock.calls.length, 0);
});

test("a classifier's request failure is a provider failure, not invalid output", async () => {
	for (const classify of [
		async () => {
			throw new Error("network down");
		},
		async () => ({
			api: decisionClassifier.api,
			provider: decisionClassifier.provider,
			model: decisionClassifier.id,
			answers: {},
			stopReason: "error" as const,
			errorMessage: "System One API error (503)",
			timestamp: 1,
		}),
	]) {
		await assert.rejects(
			decide({
				state: { note: "x" },
				questions: { yes: { type: "bool", instructions: "Yes?", criteria: { true: "Yes", false: "No" } } },
				requireProbabilities: true,
				settings: { getDecisionModel: () => "decision-test/classifier" },
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
				modelRegistry: {
					getAll: () => [decisionChatModel],
					streamSimple: vi.fn(),
					getClassifierModel: () => decisionClassifier,
					classify,
				},
			}),
			(error: unknown) => isDecisionProviderError(error) && error.model === "decision-test/classifier",
		);
	}
	await assert.rejects(
		decide({
			state: { note: "x" },
			questions: { yes: { type: "bool", instructions: "Yes?", criteria: { true: "Yes", false: "No" } } },
			requireProbabilities: true,
			settings: { getDecisionModel: () => "decision-test/classifier" },
			modelRegistry: {
				getAll: () => [decisionChatModel],
				streamSimple: vi.fn(),
				getClassifierModel: () => decisionClassifier,
			},
		}),
		(error: unknown) => isDecisionProviderError(error),
	);
});

test("an aborted classifier response stops the decision without a fallback", async () => {
	const dispatch = vi.fn(() => createAssistantMessageEventStream());
	await assert.rejects(
		decide({
			state: { note: "x" },
			questions: { yes: { type: "bool", instructions: "Yes?", criteria: { true: "Yes", false: "No" } } },
			settings: { getDecisionModel: () => "decision-test/classifier" },
			currentModel: decisionChatModel,
			modelRegistry: {
				getAll: () => [decisionChatModel],
				streamSimple: dispatch,
				getClassifierModel: () => decisionClassifier,
				classify: async () => ({
					api: decisionClassifier.api,
					provider: decisionClassifier.provider,
					model: decisionClassifier.id,
					answers: {},
					stopReason: "aborted" as const,
					timestamp: 1,
				}),
			},
		}),
		(error: unknown) => isDecisionProviderError(error) && /aborted/.test(error.detail ?? ""),
	);
	assert.equal(dispatch.mock.calls.length, 0);
});

test("a provider failure signal is carried by the error that wraps it and read from a decision provider error", () => {
	const signal = { status: 429, code: "rate_limit_exceeded" as const, retryAfterMs: 9 };
	const carried = withProviderFailure(new Error("x"), signal);
	assert.deepEqual(carriedProviderFailure(carried), signal);
	assert.equal(withProviderFailure(new Error("y"), undefined).message, "y");
	assert.equal(carriedProviderFailure(new Error("plain")), undefined);
	assert.equal(carriedProviderFailure("text"), undefined);
	assert.deepEqual(
		carriedProviderFailure(
			new DecisionProviderError({ providerStatus: 402, providerCode: "insufficient_quota", retryAfterMs: 5 }),
		),
		{ status: 402, code: "insufficient_quota", retryAfterMs: 5 },
	);
	const withoutHint = carriedProviderFailure(
		new DecisionProviderError({ providerStatus: 429, providerCode: "rate_limit_exceeded" }),
	);
	assert.deepEqual(withoutHint, { status: 429, code: "rate_limit_exceeded" });
	assert.equal(Object.hasOwn(withoutHint ?? {}, "retryAfterMs"), false);
	assert.equal(carriedProviderFailure(new DecisionProviderError({ providerCode: "rate_limit_exceeded" })), undefined);
	assert.equal(carriedProviderFailure(new DecisionProviderError({ providerStatus: 500 })), undefined);
	assert.equal(carriedProviderFailure(new DecisionProviderError({})), undefined);
});

test("a decision trace reports the resolve phase before its first request", async () => {
	const { DecisionTrace } = await import("../../packages/coding-agent/src/core/structured-output/deadline.js");
	const trace = new DecisionTrace();
	assert.equal(trace.phase, "resolve");
	trace.begin("chat");
	assert.equal(trace.phase, "chat");
	trace.begin("classifier");
	assert.equal(trace.phase, "classifier");
});

test("an auto-routing inference failure keeps the decision error as its cause (#4358)", async () => {
	const { routeExecutionModel, AutoRoutingInferenceError } = await import(
		"../../packages/coding-agent/src/core/execution-model-router.js"
	);
	const other = { ...decisionChatModel, id: "other", name: "Other" };
	const failing = vi.fn(() => {
		throw new Error("connection refused");
	});
	const error = await routeExecutionModel({
		ctx: {
			model: decisionChatModel,
			getDecisionModel: () => "",
			modelRegistry: {
				getAll: () => [decisionChatModel, other],
				getAvailable: () => [decisionChatModel, other],
				streamSimple: failing as never,
				containsConfiguredCredential: async () => false,
			},
		},
		task: "Summarize the change.",
		agent: { name: "worker", description: "test" },
		taskNeeds: {
			work: "coding",
			difficulty: "easy",
			mistakeCost: "low",
			needsImages: false,
			longContext: false,
			latencySensitive: false,
		},
	}).then(
		() => undefined,
		(failure: unknown) => failure,
	);
	assert.ok(error instanceof AutoRoutingInferenceError);
	assert.ok(isDecisionProviderError(error.cause));
	assert.equal((error.cause as DecisionProviderError).model, "decision-test/chat");
	assert.ok(failing.mock.calls.length > 0);
});

test("the structured_output tool tells the calling model it starts on the decision model", async () => {
	const { createStructuredOutputTool, StructuredOutputParameters } = await import(
		"../../packages/coding-agent/src/core/tools/structured-output.js"
	);
	assert.equal(
		(StructuredOutputParameters.properties.model as { description?: string }).description,
		"Exact provider/model ID of a chat or classifier model, such as typesafe/jev-latest. Omit to use the configured decision model, which defaults to the current chat model.",
	);
	const tool = createStructuredOutputTool({ schema: choiceDecisionSchema });
	assert.equal(
		tool.description,
		"Infer the final machine-readable result from instructions and named state using the selected model (default: the configured decision model), then any fallbacks, then the current chat model.",
	);
	assert.ok(
		tool.promptGuidelines?.includes(
			"Pass complete instructions and named state; omit model to use the configured decision model.",
		),
	);
});

test("auto routing asks the decision model to choose among the shortlist with the task's needs as state", async () => {
	const { routeExecutionModel } = await import("../../packages/coding-agent/src/core/execution-model-router.js");
	const { chatChoiceAnswer } = await import("../helpers/model-routing.js");
	const other = { ...decisionChatModel, id: "other", name: "Other" };
	const states: unknown[] = [];
	const dispatch = vi.fn((_model: unknown, context: Parameters<typeof chatChoiceAnswer>[0]) => {
		const payload = JSON.parse(
			String(context.messages.find((message: { role: string }) => message.role === "user")?.content),
		) as { state: unknown };
		states.push(payload.state);
		return messageStream(decisionMessage(chatChoiceAnswer(context, "decision-test/other")));
	});
	const route = await routeExecutionModel({
		ctx: {
			model: decisionChatModel,
			getDecisionModel: () => "",
			modelRegistry: {
				getAll: () => [decisionChatModel, other],
				getAvailable: () => [decisionChatModel, other],
				streamSimple: dispatch as never,
				containsConfiguredCredential: async () => false,
			},
		},
		task: "Summarize the change.",
		agent: { name: "worker", description: "test" },
		taskNeeds: {
			work: "coding",
			difficulty: "easy",
			mistakeCost: "low",
			needsImages: false,
			longContext: false,
			latencySensitive: false,
		},
	});
	assert.equal(route.routerSelection.model, "decision-test/other");
	assert.equal(dispatch.mock.calls.length, 1);
	assert.deepEqual((states[0] as { needs: unknown }).needs, {
		work: "coding",
		difficulty: "easy",
		mistake_cost: "low",
		needs_images: false,
		long_context: false,
		latency_sensitive: false,
	});
});

const MIXED_QUESTIONS: Record<string, StructuredDecisionQuestion> = {
	route: { instructions: "Which route?", criteria: { none: "No route fits", review: "Review the patch" } },
	yes: { type: "bool", instructions: "Yes?", criteria: { true: "Yes", false: "No" } },
	grade: { type: "score", instructions: "Grade", criteria: ["low", "high"] },
};

const MIXED_ANSWERS = {
	route: { type: "choice", choice: "review", probabilities: { none: 0.1, review: 0.9 }, confidence: 0.9 },
	yes: { type: "bool", probability: 0.8 },
	grade: { type: "score", score: 1, confidence: 0.7 },
} as const;

function classifierOnlyDecision(
	answers: Record<string, unknown>,
	decode: DecisionModelRequest<typeof choiceDecisionSchema>["classifier"]["decode"],
) {
	return runDecision(
		{
			...decisionRequest(),
			settings: SettingsManager.inMemory({ decisionModel: "decision-test/classifier" }),
			schema: choiceDecisionSchema,
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			modelRegistry: {
				getAll: () => [decisionChatModel],
				streamSimple: vi.fn(),
				getClassifierModel: () => decisionClassifier,
				classify: async () =>
					({
						api: decisionClassifier.api,
						provider: decisionClassifier.provider,
						model: decisionClassifier.id,
						answers,
						stopReason: "stop",
						timestamp: 1,
					}) as never,
			},
			classifier: { questions: MIXED_QUESTIONS, decode },
		},
		undefined,
		{ chatFallback: false },
	);
}

test("a classifier decision hands decode only Choice answers as choices, and every answer with its probabilities", async () => {
	let choiceKeys: string[] = [];
	let answers: Readonly<Record<string, unknown>> = {};
	const result = await classifierOnlyDecision(MIXED_ANSWERS, (choices, received) => {
		choiceKeys = Object.keys(choices);
		answers = received;
		return { route: choices.route as "none" | "review" };
	});
	assert.deepEqual(result.value, { route: "review" });
	assert.deepEqual(choiceKeys, ["route"]);
	assert.deepEqual(answers, MIXED_ANSWERS);
});

for (const [label, answer] of [
	["a score that is not finite", { grade: { type: "score", score: Number.POSITIVE_INFINITY, confidence: 1 } }],
	["a yes/no answer to a score question", { grade: { type: "bool", probability: 0.9 } }],
	["a yes/no probability that is not finite", { yes: { type: "bool", probability: Number.NaN } }],
	[
		"an option the question does not offer",
		{ route: { type: "choice", choice: "maybe", probabilities: {}, confidence: 1 } },
	],
	[
		"another type's answer to a Choice question that names an offered option",
		{ route: { type: "bool", probability: 0.9, choice: "review" } },
	],
	[
		"another type's answer to a yes/no question that carries a probability",
		{ yes: { type: "score", score: 1, confidence: 1, probability: 0.9 } },
	],
	[
		"another type's answer to a score question that carries a score",
		{ grade: { type: "bool", probability: 0.9, score: 1 } },
	],
] as const) {
	test(`a classifier answer with ${label} is refused even when decode would ignore it`, async () => {
		const decode = vi.fn(() => ({ route: "review" as const }));
		await assert.rejects(
			classifierOnlyDecision({ ...MIXED_ANSWERS, ...answer }, decode),
			(error: unknown) => error instanceof ClassifierDecisionError && error.kind === "answer",
		);
		assert.equal(decode.mock.calls.length, 0);
	});
}

function structuredOutputOnDecisionModel(
	decisionModel: string,
	registry: Partial<Parameters<typeof generateStructuredOutput>[0]["modelRegistry"]> = {},
	overrides: Partial<Parameters<typeof generateStructuredOutput>[0]> = {},
) {
	return generateStructuredOutput({
		...structuredOutputRequest(),
		settings: SettingsManager.inMemory({ decisionModel }),
		modelRegistry: {
			getAll: () => [decisionChatModel],
			streamSimple: vi.fn(() => messageStream(decisionMessage({ route: "review" }))),
			getClassifierModel: () => undefined,
			...registry,
		},
		...overrides,
	});
}

const CLASSIFIED_REVIEW = {
	api: decisionClassifier.api,
	provider: decisionClassifier.provider,
	model: decisionClassifier.id,
	answers: { route: { type: "choice" as const, choice: '"review"', probabilities: { '"review"': 1 }, confidence: 1 } },
	stopReason: "stop" as const,
	timestamp: 1,
};

test("structured output resolves a decision model registered as both chat and classifier as decide() does, classifier first (#4358)", async () => {
	const dispatch = vi.fn(() => messageStream(decisionMessage({ route: "review" })));
	const classify = vi.fn(async () => CLASSIFIED_REVIEW);
	const result = await structuredOutputOnDecisionModel("decision-test/classifier", {
		getAll: () => [decisionChatModel, { ...decisionChatModel, id: "classifier", name: "Chat twin" }],
		streamSimple: dispatch,
		getClassifierModel: () => decisionClassifier,
		classify,
	});
	assert.equal(result.model, "decision-test/classifier");
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(dispatch.mock.calls.length, 0);
});

test("structured output refuses an unregistered or malformed decision model with a typed error before any request (#4358)", async () => {
	const dispatch = vi.fn(() => messageStream(decisionMessage({ route: "review" })));
	await assert.rejects(
		structuredOutputOnDecisionModel("decision-test/missing", { streamSimple: dispatch }),
		(error: unknown) =>
			isDecisionModelUnavailableError(error) &&
			error.reason === "not-in-catalog" &&
			error.model === "decision-test/missing",
	);
	await assert.rejects(
		structuredOutputOnDecisionModel(" decision-test/chat", { streamSimple: dispatch }),
		(error: unknown) => isDecisionConfigError(error) && error.code === "invalid-setting",
	);
	assert.equal(dispatch.mock.calls.length, 0);
});

test("structured output on the decision model reports a provider failure as a DecisionProviderError (#4358)", async () => {
	await assert.rejects(
		structuredOutputOnDecisionModel(
			"decision-test/classifier",
			{
				getClassifierModel: () => decisionClassifier,
				classify: async () => ({
					...CLASSIFIED_REVIEW,
					answers: {},
					stopReason: "error" as const,
					errorMessage: "System One API error (503)",
				}),
			},
			{ currentModel: undefined },
		),
		(error: unknown) =>
			isDecisionProviderError(error) &&
			error.model === "decision-test/classifier" &&
			error.detail === "Structured output failed across 1 model candidate(s).",
	);
});

test("structured output on the decision model reports exhausted repairs as a DecisionOutputError (#4358)", async () => {
	const dispatch = vi.fn(() => messageStream(decisionMessage({ route: "maybe" })));
	await assert.rejects(
		structuredOutputOnDecisionModel("decision-test/chat", { streamSimple: dispatch }),
		(error: unknown) =>
			isDecisionOutputError(error) &&
			error.model === "decision-test/chat" &&
			/output repair exhausted after 4 attempts/.test(error.detail ?? ""),
	);
	assert.equal(dispatch.mock.calls.length, 4);
});

test("a cancelled structured output on the decision model keeps its cancellation, not a decision error (#4358)", async () => {
	const controller = new AbortController();
	await assert.rejects(
		structuredOutputOnDecisionModel(
			"decision-test/classifier",
			{
				getClassifierModel: () => decisionClassifier,
				classify: async () => {
					controller.abort(new Error("caller stopped"));
					throw new Error("request torn down");
				},
			},
			{ signal: controller.signal },
		),
		(error: unknown) => !isDecisionError(error) && error instanceof Error && /cancelled/.test(error.message),
	);
});

test("structured output that fails on the decision model falls back to the current chat model (#4358)", async () => {
	const dispatch = vi.fn(() => messageStream(decisionMessage({ route: "review" })));
	const classify = vi.fn(async () => ({ ...CLASSIFIED_REVIEW, answers: {} }));
	const result = await structuredOutputOnDecisionModel("decision-test/classifier", {
		streamSimple: dispatch,
		getClassifierModel: () => decisionClassifier,
		classify,
	});
	assert.equal(result.model, "decision-test/chat");
	assert.deepEqual(
		result.modelAttempts?.map((attempt) => attempt.model),
		["decision-test/classifier", "decision-test/chat"],
	);
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(dispatch.mock.calls.length, 1);
});

test("structured output on a decision model registered as both classifier and current chat model keeps the chat fallback (#4358)", async () => {
	const twin = { ...decisionClassifier, id: decisionChatModel.id, name: "Classifier twin" };
	const dispatch = vi.fn(() => messageStream(decisionMessage({ route: "review" })));
	const failingClassify = vi.fn(async () => ({ ...CLASSIFIED_REVIEW, answers: {} }));
	const afterFailure = await structuredOutputOnDecisionModel("decision-test/chat", {
		streamSimple: dispatch,
		getClassifierModel: () => twin,
		classify: failingClassify,
	});
	assert.equal(afterFailure.model, "decision-test/chat");
	assert.deepEqual(
		afterFailure.modelAttempts?.map((attempt) => attempt.model),
		["decision-test/chat", "decision-test/chat"],
	);
	assert.equal(failingClassify.mock.calls.length, 1);
	assert.equal(dispatch.mock.calls.length, 1);

	const freeFormDispatch = vi.fn(() => messageStream(decisionMessage({ route: "review", limit: 1 })));
	const unusedClassify = vi.fn(async () => CLASSIFIED_REVIEW);
	const freeForm = await structuredOutputOnDecisionModel(
		"decision-test/chat",
		{ streamSimple: freeFormDispatch, getClassifierModel: () => twin, classify: unusedClassify },
		{ schema: decisionSchema },
	);
	assert.equal(freeForm.model, "decision-test/chat");
	assert.equal(freeForm.modelAttempts?.[0]?.skipped, true);
	assert.equal(unusedClassify.mock.calls.length, 0);
	assert.equal(freeFormDispatch.mock.calls.length, 1);
});

test("structured output with its own model ignores a different configured decision model (#4358)", async () => {
	const dispatch = vi.fn(() => messageStream(decisionMessage({ route: "review" })));
	const classify = vi.fn(async () => CLASSIFIED_REVIEW);
	const result = await structuredOutputOnDecisionModel(
		"decision-test/classifier",
		{ streamSimple: dispatch, getClassifierModel: () => decisionClassifier, classify },
		{ model: "decision-test/chat" },
	);
	assert.equal(result.model, "decision-test/chat");
	assert.equal(result.modelAttempts, undefined);
	assert.equal(classify.mock.calls.length, 0);
	assert.equal(dispatch.mock.calls.length, 1);
});

test("an unresolvable structured output model whose ID reads like a candidate key still falls back to the current chat model (#4358)", async () => {
	const dispatch = vi.fn(() => messageStream(decisionMessage({ route: "review" })));
	const request = structuredOutputRequest();
	const result = await generateStructuredOutput({
		...request,
		model: "chat:decision-test/chat",
		modelRegistry: { ...request.modelRegistry, streamSimple: dispatch, getClassifierModel: () => undefined },
	});
	assert.equal(result.model, "decision-test/chat");
	assert.deepEqual(
		result.modelAttempts?.map((attempt) => attempt.model),
		["chat:decision-test/chat", "decision-test/chat"],
	);
	assert.equal(dispatch.mock.calls.length, 1);
});

test("an unconfigured structured decision names its missing model before inference (#4358)", async () => {
	const dispatch = vi.fn(() => messageStream(decisionMessage()));
	const { registry } = await registeredDecisionRuntime(dispatch);
	await assert.rejects(
		generateStructuredOutput({ ...structuredOutputRequest(), currentModel: undefined, modelRegistry: registry }),
		{ name: "Error", message: "Structured output requires model or currentModel." },
	);
	assert.equal(dispatch.mock.calls.length, 0);
});
