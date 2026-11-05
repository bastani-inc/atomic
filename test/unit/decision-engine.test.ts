import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { decide } from "../../packages/coding-agent/src/core/decision/decide.js";
import {
	DecisionProviderError,
	isDecisionProviderError,
	isDecisionTimeoutError,
} from "../../packages/coding-agent/src/core/decision/errors.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { generateStructuredOutput, routeModel } from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	carriedProviderFailure,
	withProviderFailure,
} from "../../packages/coding-agent/src/core/structured-output/provider-failure.js";
import type { StructuredDecisionQuestion } from "../../packages/coding-agent/src/core/structured-output/types.js";
import {
	choiceDecisionSchema,
	decisionChatModel,
	decisionClassifier,
	decisionMessage,
	decisionRequest,
	messageStream,
	registeredDecisionRuntime,
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
