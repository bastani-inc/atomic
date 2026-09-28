import assert from "node:assert/strict";
import type { ClassifierResult } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { routeExecutionModel } from "../../packages/coding-agent/src/core/execution-model-router.js";
import { generateStructuredOutput, routeModel } from "../../packages/coding-agent/src/core/structured-output/index.js";
import { chatRouter } from "../helpers/model-routing.js";
import {
	classifierResult,
	decisionClassifier,
	decisionMessage,
	decisionModel,
	decisionRequest,
	messageStream,
	structuredOutputRequest,
} from "../helpers/structured-output.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function routedClassifier(
	classify: () => Promise<ClassifierResult>,
	streamSimple = () => messageStream(decisionMessage()),
) {
	const request = decisionRequest();
	return {
		...request,
		settings: { getRouterModel: () => "decision-test/classifier" },
		modelRegistry: {
			getAll: () => [decisionModel],
			getClassifierModel: () => decisionClassifier,
			classify,
			streamSimple,
		},
	};
}

test("explicit registered classifier routes without invoking chat", async () => {
	const classify = vi.fn(async () => classifierResult());
	const chat = vi.fn(() => messageStream(decisionMessage()));
	const result = await routeModel(routedClassifier(classify, chat));
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.equal(result.model, "decision-test/classifier");
	assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
	assert.equal(chat.mock.calls.length, 0);
	assert.equal(classify.mock.calls.length, 1);
});

test("classifier runtime failure falls back to current chat once without leaking provider error", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubEnv("ATOMIC_MODEL_ROUTING_DEBUG", "1");
	const chat = vi.fn(() => messageStream(decisionMessage()));
	const result = await routeModel(
		routedClassifier(async () => {
			throw new Error("private-key-material");
		}, chat),
	);
	assert.equal(result.model, "decision-test/chat");
	assert.equal(result.fallback?.from, "decision-test/classifier");
	assert.equal(result.fallback?.reason, "Classifier returned no valid decision.");
	assert.equal(chat.mock.calls.length, 1);
	assert.equal(warning.mock.calls.length, 1);
	assert.doesNotMatch(JSON.stringify(result) + String(warning.mock.calls[0]?.[0]), /private-key-material/);
});

const invalidAnswers: Record<string, string>[] = [{ route: "invented", budget: "exact" }, { route: "review" }];
for (const answer of invalidAnswers) {
	test(`classifier invalid answer ${JSON.stringify(answer)} falls back to chat`, async () => {
		const result = await routeModel(routedClassifier(async () => classifierResult(answer)));
		assert.equal(result.model, "decision-test/chat");
		assert.equal(result.fallback?.reason, "Classifier returned no valid decision.");
	});
}

test("classifier failure without current chat model is reported without raw error", async () => {
	const request = routedClassifier(async () => {
		throw new Error("private-key-material");
	});
	await assert.rejects(routeModel({ ...request, currentModel: undefined }), (error: Error) => {
		assert.match(error.message, /Classifier returned no valid decision/);
		assert.doesNotMatch(String(error.stack), /private-key-material/);
		return true;
	});
});

test("classifier aborted result prevents chat fallback", async () => {
	const chat = vi.fn(() => messageStream(decisionMessage()));
	await assert.rejects(
		routeModel(routedClassifier(async () => ({ ...classifierResult(), stopReason: "aborted" }), chat)),
		/aborted; no fallback/,
	);
	assert.equal(chat.mock.calls.length, 0);
});

test("classifier provider refusal falls back to current chat once", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubEnv("ATOMIC_MODEL_ROUTING_DEBUG", "1");
	const chat = vi.fn(() => messageStream(decisionMessage()));
	const result = await routeModel(
		routedClassifier(
			async () => ({ ...classifierResult(), stopReason: "error", errorMessage: "Safety refusal private body" }),
			chat,
		),
	);
	assert.equal(result.model, "decision-test/chat");
	assert.equal(result.fallback?.from, "decision-test/classifier");
	assert.equal(chat.mock.calls.length, 1);
	assert.equal(warning.mock.calls.length, 1);
	assert.doesNotMatch(JSON.stringify(result) + String(warning.mock.calls[0]?.[0]), /private body/);
});

test("classifier overflow warning names the status and error type but not the body", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubEnv("ATOMIC_MODEL_ROUTING_DEBUG", "1");
	await routeModel(
		routedClassifier(async () => ({
			...classifierResult(),
			stopReason: "error",
			errorMessage: 'System One API error (400): {"detail":{"error_type":"max_tokens_exceeded","echo":"private"}}',
		})),
	);
	const message = String(warning.mock.calls[0]?.[0]);
	assert.match(message, /Classifier routing failed \(HTTP 400 max_tokens_exceeded\); falling back/);
	assert.doesNotMatch(message, /private/);
});

for (const succeeds of [true, false]) {
	test(`classifier failure gives chat three corrective retries: final success=${succeeds}`, async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const chat = vi.fn(() =>
			messageStream(decisionMessage({ route: succeeds && chat.mock.calls.length === 4 ? "review" : "invalid" })),
		);
		const pending = routeModel(routedClassifier(async () => ({ ...classifierResult(), answers: {} }), chat));
		if (succeeds) assert.equal((await pending).value.route, "review");
		else await assert.rejects(pending, /Chat fallback output repair exhausted after 4 attempts/);
		assert.equal(chat.mock.calls.length, 4);
	});
}

test("execution auto routing uses selected current chat even with classifier credentials", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
	const selection = { model: "decision-test/chat", effort: null };
	const dispatch = vi.fn(chatRouter());
	const available = [decisionModel];
	const result = await routeExecutionModel({
		ctx: {
			model: decisionModel,
			getRouterModel: () => "",
			modelRegistry: {
				getAll: () => available,
				getAvailable: () => available,
				containsConfiguredCredential: async () => false,
				streamSimple: dispatch,
			},
		},
		task: "Review a TypeScript change",
		agent: { name: "reviewer", description: "Review only" },
		constraints: [{ allowedModels: [selection.model] }],
	});
	assert.deepEqual(result.routerSelection, selection);
	assert.equal(result.modelOverride, selection.model);
	assert.equal(dispatch.mock.calls.length, 1);
	result.assertCurrent();
	available.length = 0;
	assert.throws(result.assertCurrent, /no longer eligible/);
});

test("structured-output SDK rejects obsolete classifier model IDs before dispatch", async () => {
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	await assert.rejects(
		generateStructuredOutput({
			...structuredOutputRequest(),
			currentModel: undefined,
			model: "typesafe-ai/jev-latest",
		}),
		/typesafe-ai\/jev-latest/,
	);
	assert.equal(transport.mock.calls.length, 0);
});
