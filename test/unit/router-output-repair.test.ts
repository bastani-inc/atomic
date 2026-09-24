import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { generateStructuredOutput, routeModel } from "../../packages/coding-agent/src/core/structured-output/index.js";
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
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

test("router repairs invalid chat output with sanitized feedback and aggregates usage", async () => {
	const request = decisionRequest();
	const stream = vi
		.fn<typeof request.modelRegistry.streamSimple>()
		.mockImplementationOnce(() => messageStream(decisionMessage({ route: "private-invalid-output" })))
		.mockImplementation(() => messageStream(decisionMessage()));
	request.modelRegistry.streamSimple = stream;
	const result = await routeModel(request);
	assert.equal(result.value.route, "review");
	assert.equal(stream.mock.calls.length, 2);
	assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 20 });
	assert.match(stream.mock.calls[1][1].systemPrompt!, /previous response failed output validation/);
	assert.doesNotMatch(JSON.stringify(stream.mock.calls[1]), /private-invalid-output/);
	assert.equal(stream.mock.calls[1][2]?.maxRetries, 0);
	assert.equal(stream.mock.calls[0][2]?.signal, stream.mock.calls[1][2]?.signal);
});

test("router accepts fourth attempt and exhausts after four invalid answers", async () => {
	const request = decisionRequest();
	let count = 0;
	request.modelRegistry.streamSimple = () => messageStream(decisionMessage(++count === 4 ? { route: "review" } : {}));
	await routeModel(request);
	assert.equal(count, 4);
	count = 0;
	request.modelRegistry.streamSimple = () => {
		count++;
		return messageStream(decisionMessage({}));
	};
	await assert.rejects(routeModel(request), /exhausted after 4 attempts/);
	assert.equal(count, 4);
});

test("general structured output repairs invalid output three times on a single candidate", async () => {
	const stream = vi.fn(() => messageStream(decisionMessage({})));
	await assert.rejects(
		generateStructuredOutput({
			...structuredOutputRequest(),
			currentModel: undefined,
			model: "decision-test/chat",
			modelRegistry: { getAll: () => [decisionModel], streamSimple: stream },
		}),
		/Structured output/,
	);
	assert.equal(stream.mock.calls.length, 4);
});

for (const failure of ["transport", "input", "provider"] as const)
	test(`router does not retry ${failure}`, async () => {
		const request = decisionRequest();
		const stream = vi.fn(() => {
			if (failure === "transport") throw new Error("private-provider-error");
			return messageStream({ ...decisionMessage(), stopReason: "error" });
		});
		request.modelRegistry.streamSimple = stream;
		await assert.rejects(
			routeModel({ ...request, ...(failure === "input" ? { state: {} } : {}) }),
			(error) => !String(error).includes("private-provider-error"),
		);
		assert.equal(stream.mock.calls.length, failure === "input" ? 0 : 1);
	});

test.each([0, 0.5, 0.999, 1.001, 1.5, 2])(
	"classifier accepts choice regardless of probability sum %s",
	async (mass) => {
		const request = decisionRequest();
		const classify = vi.fn(async () => {
			const result = classifierResult();
			const route = result.answers.route;
			if (route?.type !== "choice") throw new Error("Expected a Choice answer");
			return {
				...result,
				answers: {
					...result.answers,
					route: {
						...route,
						probabilities: { none: mass / 2, review: mass / 2 },
					},
				},
			};
		});
		const result = await routeModel({
			...request,
			settings: SettingsManager.inMemory({ routerModel: "decision-test/classifier" }),
			modelRegistry: { ...request.modelRegistry, getClassifierModel: () => decisionClassifier, classify },
		});
		assert.equal(result.value.route, "review");
		assert.equal(classify.mock.calls.length, 1);
	},
);

test("classifier invalid choice fails without retry when no chat fallback exists", async () => {
	const request = decisionRequest();
	const classify = vi.fn(async () => classifierResult({ route: "absent", budget: "exact" }));
	await assert.rejects(
		routeModel({
			...request,
			currentModel: undefined,
			settings: SettingsManager.inMemory({ routerModel: "decision-test/classifier" }),
			modelRegistry: { ...request.modelRegistry, getClassifierModel: () => decisionClassifier, classify },
		}),
		/Classifier returned no valid decision/,
	);
	assert.equal(classify.mock.calls.length, 1);
});

test("cancellation after invalid output prevents repair", async () => {
	const controller = new AbortController();
	const request = decisionRequest();
	const stream = vi.fn(() => {
		controller.abort();
		return messageStream(decisionMessage({}));
	});
	request.modelRegistry.streamSimple = stream;
	await assert.rejects(routeModel({ ...request, signal: controller.signal }), /cancelled/);
	assert.equal(stream.mock.calls.length, 1);
});

test("routing repairs can complete after the former 30-second deadline", async () => {
	vi.useFakeTimers();
	const request = decisionRequest();
	let count = 0;
	request.modelRegistry.streamSimple = () => {
		const response = decisionMessage(++count === 1 ? {} : { route: "review" });
		const stream = messageStream(response);
		stream.result = () => new Promise((resolve) => setTimeout(() => resolve(response), 20_000));
		return stream;
	};
	const result = routeModel(request);
	const completed = result.then(
		(value) => value,
		(error: Error) => error,
	);
	await vi.advanceTimersByTimeAsync(40_000);
	assert.deepEqual(await completed, {
		value: { route: "review" },
		model: "decision-test/chat",
		responseModel: "chat",
		usage: { inputTokens: 40, outputTokens: 20 },
	});
	assert.equal(count, 2);
});

test("correlated model effort validation participates in repairs", async () => {
	const request = decisionRequest();
	const stream = vi
		.fn()
		.mockImplementationOnce(() => messageStream(decisionMessage({ route: "none" })))
		.mockImplementation(() => messageStream(decisionMessage({ route: "review" })));
	request.modelRegistry.streamSimple = stream;
	const result = await routeModel(request, (value) => value.route === "review");
	assert.equal(result.value.route, "review");
	assert.equal(stream.mock.calls.length, 2);
});

test("repairs retain the original state, schema, model and router selection", async () => {
	const request = decisionRequest();
	const state = { ...request.state };
	const originalState = JSON.stringify(request.state);
	const models = [{ ...decisionModel }];
	const getAll = vi.fn(() => models);
	const stream = vi.fn<typeof request.modelRegistry.streamSimple>((model, context) => {
		assert.equal(model.id, "chat");
		assert.equal(JSON.stringify(JSON.parse(String(context.messages[0].content)).state), originalState);
		if (stream.mock.calls.length === 1) {
			models[0].id = "changed";
			state.task = "changed private task";
			return messageStream(decisionMessage({}));
		}
		return messageStream(decisionMessage());
	});
	await routeModel({
		...request,
		state,
		modelRegistry: { ...request.modelRegistry, getAll, streamSimple: stream },
	});
	assert.equal(getAll.mock.calls.length, 1);
	assert.equal(stream.mock.calls.length, 2);
});

for (const valid of [false, true])
	test(`elapsed time does not reject synchronous ${valid ? "valid" : "invalid"} output`, async () => {
		let now = 0;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			const request = decisionRequest();
			const stream = vi.fn(() => {
				now += 60_000;
				return messageStream(decisionMessage(valid || stream.mock.calls.length > 1 ? { route: "review" } : {}));
			});
			const result = await routeModel({
				...request,
				modelRegistry: { ...request.modelRegistry, streamSimple: stream },
			});
			assert.equal(result.value.route, "review");
			assert.equal(stream.mock.calls.length, valid ? 1 : 2);
		} finally {
			clock.mockRestore();
		}
	});

test("slow classifier request can finish after the former deadline", async () => {
	let now = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
	const request = decisionRequest();
	const classify = vi.fn(async () => {
		now = 60_000;
		return classifierResult();
	});
	try {
		const result = await routeModel({
			...request,
			settings: SettingsManager.inMemory({ routerModel: "decision-test/classifier" }),
			modelRegistry: { ...request.modelRegistry, getClassifierModel: () => decisionClassifier, classify },
		});
		assert.equal(result.value.route, "review");
		assert.equal(classify.mock.calls.length, 1);
	} finally {
		clock.mockRestore();
	}
});
