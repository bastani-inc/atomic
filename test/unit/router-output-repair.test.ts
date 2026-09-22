import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	inferRouterDecision,
	inferStructuredOutput,
} from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	decisionMessage,
	decisionModel,
	decisionRequest,
	jevResponse,
	messageStream,
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
	const result = await inferRouterDecision(request);
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
	await inferRouterDecision(request);
	assert.equal(count, 4);
	count = 0;
	request.modelRegistry.streamSimple = () => {
		count++;
		return messageStream(decisionMessage({}));
	};
	await assert.rejects(inferRouterDecision(request), /exhausted after 4 attempts/);
	assert.equal(count, 4);
});

test("general structured output remains one shot", async () => {
	const request = decisionRequest();
	const stream = vi.fn(() => messageStream(decisionMessage({})));
	request.modelRegistry.streamSimple = stream;
	await assert.rejects(
		inferStructuredOutput({
			...request,
			model: { kind: "chat", fullId: "decision-test/chat", model: decisionModel },
		}),
		/No repair request/,
	);
	assert.equal(stream.mock.calls.length, 1);
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
			inferRouterDecision({ ...request, ...(failure === "input" ? { state: {} } : {}) }),
			(error) => !String(error).includes("private-provider-error"),
		);
		assert.equal(stream.mock.calls.length, failure === "input" ? 0 : 1);
	});

// PR #3118: provider probabilities need not sum to one to use the returned choice.
test.each([0, 0.5, 0.999, 1.001, 1.5, 2])("Jev accepts total probability %s without repair", async (mass) => {
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-key");
	const response = jevResponse();
	response.answers.route.probabilities.review = mass / 2;
	response.answers.route.probabilities.none = mass / 2;
	const fetch = vi.fn(async () => Response.json(response));
	vi.stubGlobal("fetch", fetch);
	const result = await inferRouterDecision({ ...decisionRequest(), settings: SettingsManager.inMemory() });
	assert.equal(result.value.route, "review");
	assert.equal(fetch.mock.calls.length, 1);
});

// #3206: missing probabilities and probability drift are advisory and decode
// without repair; only an unknown choice or malformed JSON triggers repair.
for (const kind of ["missing", "probability"] as const)
	test(`Jev accepts ${kind} output without repair (#3206)`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "synthetic-key");
		const bad = jevResponse();
		if (kind === "missing") Reflect.deleteProperty(bad.answers.route, "probabilities");
		if (kind === "probability") bad.answers.route.probabilities.none = -1;
		const fetch = vi.fn(async () => Response.json(bad));
		vi.stubGlobal("fetch", fetch);
		const result = await inferRouterDecision({ ...decisionRequest(), settings: SettingsManager.inMemory() });
		assert.equal(result.value.route, "review");
		assert.equal(fetch.mock.calls.length, 1);
	});

for (const kind of ["choice", "json"] as const)
	test(`Jev repairs ${kind} output without changing criteria`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "synthetic-key");
		const bad = jevResponse();
		if (kind === "choice") bad.answers.route.choice = "absent";
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(kind === "json" ? new Response("invalid") : Response.json(bad))
			.mockImplementation(async () => Response.json(jevResponse()));
		vi.stubGlobal("fetch", fetch);
		// No chat fallback: repairs run on Jev only without a current chat model (#3206).
		const request = { ...decisionRequest(), currentModel: undefined, settings: SettingsManager.inMemory() };
		const result = await inferRouterDecision(request);
		assert.equal(result.value.route, "review");
		assert.equal(fetch.mock.calls.length, 2);
		const first = JSON.parse(fetch.mock.calls[0][1].body);
		const second = JSON.parse(fetch.mock.calls[1][1].body);
		assert.deepEqual(first.state, second.state);
		assert.deepEqual(first.questions.route.criteria, second.questions.route.criteria);
		assert.match(second.questions.route.instructions, /previous response failed output validation/);
		assert.deepEqual(result.usage, {
			inputTokens: kind === "json" ? 20 : 40,
			outputTokens: kind === "json" ? 10 : 20,
		});
	});

test("pinned Jev HTTP authentication failure does not retry and stays fatal without a chat model (#3206)", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-key");
	const fetch = vi.fn(async () => new Response("private", { status: 401 }));
	vi.stubGlobal("fetch", fetch);
	await assert.rejects(
		inferRouterDecision({
			...decisionRequest(),
			currentModel: undefined,
			settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
		}),
		/HTTP 401/,
	);
	assert.equal(fetch.mock.calls.length, 1);
});

test("cancellation after invalid output prevents repair", async () => {
	const controller = new AbortController();
	const request = decisionRequest();
	const stream = vi.fn(() => {
		controller.abort();
		return messageStream(decisionMessage({}));
	});
	request.modelRegistry.streamSimple = stream;
	await assert.rejects(inferRouterDecision({ ...request, signal: controller.signal }), /cancelled/);
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
	const result = inferRouterDecision(request);
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
	const result = await inferRouterDecision(request, (value) => value.route === "review");
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
	await inferRouterDecision({
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
			const result = await inferRouterDecision({
				...request,
				modelRegistry: { ...request.modelRegistry, streamSimple: stream },
			});
			assert.equal(result.value.route, "review");
			assert.equal(stream.mock.calls.length, valid ? 1 : 2);
		} finally {
			clock.mockRestore();
		}
	});

test("slow Jev auth can start transport after the former deadline", async () => {
	let now = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
	const fetch = vi.fn(async () => Response.json(jevResponse()));
	vi.stubGlobal("fetch", fetch);
	try {
		const request = decisionRequest();
		const result = await inferRouterDecision({
			...request,
			settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
			modelRegistry: {
				...request.modelRegistry,
				getProviderAuth: async () => {
					now = 60_000;
					return { auth: { apiKey: "synthetic-key" } };
				},
			},
		});
		assert.equal(result.value.route, "review");
		assert.equal(fetch.mock.calls.length, 1);
	} finally {
		clock.mockRestore();
	}
});
