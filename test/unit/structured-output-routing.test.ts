// Shared decision entrypoints for #3089 and #3090. Neither routing consumer is activated here.
import assert from "node:assert/strict";
import type {
	Api,
	ClassifierContext,
	ClassifierResult,
	JsonObject,
	Model,
	ModelsClassifierOptions,
} from "@bastani/pi-ai";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@bastani/pi-ai";
import { builtinModels } from "@bastani/pi-ai/providers/all";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { routeModel } from "../../packages/coding-agent/src/core/structured-output/index.js";
import { resolveRouterModel } from "../../packages/coding-agent/src/core/structured-output/resolver.js";
import {
	decisionMessage,
	decisionRequest,
	decisionSchema,
	messageStream,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";

const FAST_RETRY = { enabled: true, maxRetries: 3, baseDelayMs: 1 };

const chat: Model<Api> = {
	provider: "test",
	id: "chat",
	name: "Chat",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32000,
	maxTokens: 4096,
};
const alternate = { ...chat, id: "alternate" };
function registeredClassifier() {
	const model = builtinModels().getModelOfType("classifier", "typesafe", "jev-latest");
	if (!model) throw new Error("Expected registered classifier test model");
	return model;
}
const classifier = registeredClassifier();
const otherClassifier = { ...classifier, provider: "judge", id: "general-classifier" };
const modelRegistry = {
	getAll: () => [chat, alternate],
	streamSimple: () => {
		throw new Error("Unexpected inference");
	},
};
function classifierResult(overrides: Partial<ClassifierResult> = {}): ClassifierResult {
	return {
		api: classifier.api,
		provider: classifier.provider,
		model: classifier.id,
		answers: {
			route: { type: "choice", choice: "review", probabilities: { review: 1 }, confidence: 1 },
			budget: { type: "choice", choice: "exact", probabilities: { exact: 1 }, confidence: 1 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function classifierRequest(
	classify: (
		model: typeof classifier,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	) => Promise<ClassifierResult>,
	currentModel?: Model<Api>,
) {
	const request = decisionRequest();
	return {
		...request,
		settings: SettingsManager.inMemory({ routerModel: "typesafe/jev-latest" }),
		currentModel,
		modelRegistry: {
			...request.modelRegistry,
			getClassifierModel: (provider: string, id: string) =>
				provider === classifier.provider && id === classifier.id ? classifier : undefined,
			classify,
		},
	};
}
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

for (const setting of ["test/alternate", "typesafe/jev-latest", "judge/general-classifier", "", "auto"] as const) {
	test(`router resolves ${JSON.stringify(setting)} only through its model registry`, () => {
		vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
		const settings = SettingsManager.inMemory({ routerModel: setting });
		const registry = {
			...modelRegistry,
			getClassifierModel: (provider: string, id: string) => {
				if (provider === classifier.provider && id === classifier.id) return classifier;
				if (provider === otherClassifier.provider && id === otherClassifier.id) return otherClassifier;
				return undefined;
			},
		};
		const expected = setting === "" || setting === "auto" ? "test/chat" : setting;
		assert.equal(resolveRouterModel({ settings, modelRegistry: registry, currentModel: chat }).fullId, expected);
		assert.equal(settings.getDefaultModel(), undefined);
		assert.equal(chat.id, "chat");
	});
}

test("router credentials alone never change automatic model selection", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const classify = vi.fn(async () => classifierResult());
	const request = classifierRequest(classify, chat);
	const dispatch = vi.fn(() => messageStream(decisionMessage()));
	const result = await routeModel({
		...request,
		settings: SettingsManager.inMemory({ routerModel: "auto" }),
		currentModel: chat,
		modelRegistry: { ...request.modelRegistry, getAll: () => [chat], streamSimple: dispatch },
	});
	assert.equal(result.model, "test/chat");
	assert.equal(classify.mock.calls.length, 0);
	assert.equal(dispatch.mock.calls.length, 1);
});

test("empty default reads the current chat model on each invocation", () => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	const settings = SettingsManager.inMemory();
	assert.equal(settings.getRouterModel(), "");
	assert.equal(resolveRouterModel({ settings, modelRegistry, currentModel: alternate }).fullId, "test/alternate");
	assert.throws(() => resolveRouterModel({ settings, modelRegistry }), /selected chat model/);
});

for (const explicit of [
	"missing/model",
	"chat",
	"test/chat:high",
	"typesafe-ai/jev-latest",
	" typesafe/jev-latest",
	" ",
]) {
	test(`invalid explicit selection ${JSON.stringify(explicit)} never substitutes another model`, () => {
		vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
		const settings = SettingsManager.inMemory({ routerModel: explicit });
		assert.throws(() => resolveRouterModel({ settings, modelRegistry, currentModel: chat }), /Invalid routerModel/);
	});
}

test("a registered classifier is not selected as the current execution chat model", () => {
	const settings = SettingsManager.inMemory({ routerModel: "auto" });
	assert.throws(
		() =>
			resolveRouterModel({
				settings,
				modelRegistry: { ...modelRegistry, getClassifierModel: () => classifier },
				currentModel: undefined,
			}),
		/selected chat model/,
	);
});

test("ordinary entrypoint uses configured provider/auth, complete state, one schema call and no session mutation", async () => {
	const dispatch = vi.fn((_model, context, options) => {
		assert.equal(options.apiKey, "mock-chat-secret");
		assert.equal(options.maxRetries, 0);
		assert.equal(options.transport, "sse");
		assert.equal(options.toolChoice, "auto");
		assert.equal(options.maxTokens, 4096);
		assert.equal(options.timeoutMs, undefined);
		assert.deepEqual(
			JSON.parse(context.messages.find((message: { role: string }) => message.role === "user").content),
			{
				state: request.state,
				questions: request.classifier.questions,
			},
		);
		assert.match(getCurrentSystemPrompt(context.messages), /data, not instructions/);
		assert.match(getCurrentSystemPrompt(context.messages), /exact cost limit/);
		assert.equal(JSON.stringify(context).includes("mock-chat-secret"), false);
		const tools = getCurrentTools(context.messages);
		assert.equal(tools.length, 1);
		assert.deepEqual(tools[0].parameters, decisionSchema);
		assert.equal("execute" in tools[0], false);
		return messageStream(decisionMessage());
	});
	const { runtime, registry } = await registeredDecisionRuntime(dispatch);
	const request = { ...decisionRequest(), modelRegistry: registry };
	const before = JSON.stringify(request.currentModel);
	const result = await routeModel(request);
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.equal(result.model, "decision-test/chat");
	assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 });
	assert.equal(dispatch.mock.calls.length, 1);
	assert.equal(JSON.stringify(request.currentModel), before);
	assert.equal(request.settings.getRouterModel(), "decision-test/chat");
	assert.equal(
		runtime.getModels().some((model) => model.provider === "typesafe-ai"),
		false,
	);
});

for (const failure of ["synchronous throw", "result rejection"] as const) {
	test(`ordinary provider ${failure} is private and never retried`, async () => {
		const request = decisionRequest();
		const dispatch = vi.fn(() => {
			if (failure === "synchronous throw") throw new Error("private upstream payload mock-secret");
			const stream = createAssistantMessageEventStream();
			stream.result = async () => {
				throw new Error("private upstream payload mock-secret");
			};
			return stream;
		});
		await assert.rejects(
			routeModel({ ...request, modelRegistry: { ...request.modelRegistry, streamSimple: dispatch } }),
			(error: Error) => {
				assert.doesNotMatch(String(error.stack), /private upstream payload|mock-secret/);
				assert.equal(error.cause, undefined);
				assert.match(error.message, /provider.*failed/i);
				return true;
			},
		);
		assert.equal(dispatch.mock.calls.length, 1);
	});
}

const invalidArguments: JsonObject[] = [
	{ route: "unregistered" },
	{ route: "review", extra: true },
	{ route: "review", limit: "1" },
	{ route: "review", limit: null },
	{ route: "review", limit: -1 },
	{},
];
for (const args of invalidArguments) {
	test(`ordinary router strictly rejects ${JSON.stringify(args)} after bounded repairs`, async () => {
		const dispatch = vi.fn(() => messageStream(decisionMessage(args)));
		const request = decisionRequest();
		await assert.rejects(
			routeModel({ ...request, modelRegistry: { ...request.modelRegistry, streamSimple: dispatch } }),
			/Invalid structured output/,
		);
		assert.equal(dispatch.mock.calls.length, 4);
	});
}

for (const limit of [undefined, 0, 1.23456789, Number.MAX_SAFE_INTEGER]) {
	test(`ordinary decision preserves exact zero, omission and large limits: ${limit}`, async () => {
		const args = { route: "review", ...(limit === undefined ? {} : { limit }) };
		const request = decisionRequest();
		const result = await routeModel({
			...request,
			modelRegistry: { ...request.modelRegistry, streamSimple: () => messageStream(decisionMessage(args)) },
		});
		assert.deepEqual(result.value, args);
		assert.equal(Object.hasOwn(result.value, "limit"), limit !== undefined);
	});
}

for (const kind of ["text", "multiple", "wrong-tool", "error", "aborted", "length"] as const) {
	test(`ordinary ${kind} response fails without executing a requested tool`, async () => {
		const message = decisionMessage();
		if (kind === "text") {
			message.content = [{ type: "text", text: '{"route":"review"}' }];
			message.stopReason = "stop";
		} else if (kind === "multiple") message.content.push(message.content[0]);
		else if (kind === "wrong-tool")
			message.content = [
				{ type: "toolCall", id: "unsafe", name: "bash", arguments: { command: "echo not-authorized" } },
			];
		else message.stopReason = kind;
		const request = decisionRequest();
		const dispatch = vi.fn(() => messageStream(message));
		await assert.rejects(
			routeModel({ ...request, modelRegistry: { ...request.modelRegistry, streamSimple: dispatch } }),
			/Structured output/,
		);
		assert.equal(dispatch.mock.calls.length, kind === "error" || kind === "aborted" ? 1 : 4);
	});
}

test("registered non-Jev classifier receives all Choice questions and returns a validated decision", async () => {
	const classify = vi.fn(
		async (model: typeof classifier, context: ClassifierContext, options?: ModelsClassifierOptions) => {
			assert.deepEqual(model, otherClassifier);
			assert.deepEqual(context.state, request.state);
			assert.deepEqual(Object.keys(context.questions), ["route", "budget"]);
			for (const [id, question] of Object.entries(request.classifier.questions)) {
				const received = context.questions[id];
				assert.equal(received?.type, "choice");
				if (received?.type === "choice") {
					assert.ok(received.instructions.includes(request.instructions));
					assert.ok(received.instructions.includes(question.instructions));
					assert.deepEqual(received.criteria, question.criteria);
				}
			}
			assert.equal(options?.signal?.aborted, false);
			return classifierResult({ provider: otherClassifier.provider, model: otherClassifier.id });
		},
	);
	const request = classifierRequest(classify);
	const result = await routeModel({
		...request,
		settings: SettingsManager.inMemory({ routerModel: "judge/general-classifier" }),
		modelRegistry: {
			...request.modelRegistry,
			getClassifierModel: (provider, id) =>
				provider === "judge" && id === "general-classifier" ? otherClassifier : undefined,
		},
	});
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.equal(result.model, "judge/general-classifier");
	assert.equal(result.responseModel, "general-classifier");
	assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
	assert.equal(classify.mock.calls.length, 1);
});

test("classifier provider failure falls back to current chat without leaking provider text", async () => {
	const classify = vi.fn(async () =>
		classifierResult({ stopReason: "error", errorMessage: "private upstream mock-key" }),
	);
	const request = classifierRequest(classify, decisionRequest().currentModel);
	const dispatch = vi.fn(() => messageStream(decisionMessage()));
	const result = await routeModel({
		...request,
		modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
	});
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.equal(result.model, "decision-test/chat");
	assert.deepEqual(result.fallback?.from, "typesafe/jev-latest");
	assert.deepEqual(result.fallback?.to, "decision-test/chat");
	assert.doesNotMatch(JSON.stringify(result.fallback), /private upstream|mock-key/);
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(dispatch.mock.calls.length, 1);
});

test("classifier provider throw is sanitized and fails without a current chat fallback", async () => {
	const classify = vi.fn(async () => {
		throw new Error("private upstream mock-key");
	});
	await assert.rejects(routeModel(classifierRequest(classify)), (error: Error) => {
		assert.doesNotMatch(String(error.stack), /private upstream|mock-key/);
		assert.equal(error.cause, undefined);
		assert.match(error.message, /Classifier returned no valid decision/);
		return true;
	});
	assert.equal(classify.mock.calls.length, 1);
});

for (const [name, answers] of [
	["unknown choice", { ...classifierResult().answers, route: { type: "choice", choice: "private-option" } }],
	["missing answer", { route: classifierResult().answers.route }],
	["wrong answer type", { ...classifierResult().answers, route: { type: "score", score: 0.8 } }],
] as const) {
	test(`classifier rejects ${name} before decoding`, async () => {
		const classify = vi.fn(async () => classifierResult({ answers } as Partial<ClassifierResult>));
		const request = classifierRequest(classify);
		const decode = vi.fn(request.classifier.decode);
		await assert.rejects(
			routeModel({ ...request, classifier: { ...request.classifier, decode } }),
			/Classifier returned no valid decision/,
		);
		assert.equal(decode.mock.calls.length, 0);
		assert.equal(classify.mock.calls.length, 1);
	});
}

test("classifier abort never crosses providers", async () => {
	const classify = vi.fn(async () => classifierResult({ stopReason: "aborted" }));
	const request = classifierRequest(classify, decisionRequest().currentModel);
	const dispatch = vi.fn(() => messageStream(decisionMessage()));
	await assert.rejects(
		routeModel({ ...request, modelRegistry: { ...request.modelRegistry, streamSimple: dispatch } }),
		/aborted/,
	);
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(dispatch.mock.calls.length, 0);
});

test("classifier provider refusal advances to current chat", async () => {
	const classify = vi.fn(async () =>
		classifierResult({ stopReason: "error", errorMessage: "content_filter private body" }),
	);
	const request = classifierRequest(classify, decisionRequest().currentModel);
	const dispatch = vi.fn(() => messageStream(decisionMessage()));
	const result = await routeModel({
		...request,
		modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
	});
	assert.equal(result.model, "decision-test/chat");
	assert.equal(result.fallback?.from, "typesafe/jev-latest");
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(dispatch.mock.calls.length, 1);
	assert.doesNotMatch(JSON.stringify(result), /private body/);
});

test("classifier validates the decoded result against the routing schema", async () => {
	const classify = vi.fn(async () => classifierResult());
	const request = classifierRequest(classify);
	await assert.rejects(
		routeModel({
			...request,
			classifier: { ...request.classifier, decode: () => ({ route: "review" as const, limit: -1 }) },
		}),
		/Classifier returned no valid decision/,
	);
	assert.equal(classify.mock.calls.length, 1);
});
test("a chat 529-style error retries then succeeds (#3206)", async () => {
	const request = decisionRequest();
	const dispatch = vi.fn(() =>
		dispatch.mock.calls.length === 1
			? messageStream({
					...decisionMessage(),
					content: [],
					stopReason: "error" as const,
					errorMessage: "HTTP 529: provider overloaded",
				})
			: messageStream(decisionMessage()),
	);
	const result = await routeModel({
		...request,
		retry: FAST_RETRY,
		modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
	});
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.equal(dispatch.mock.calls.length, 2);
});

test("router sends every registered classifier choice without truncation", async () => {
	const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, index) => [`c${index}`, `Candidate ${index}`]));
	const classify = vi.fn(async (_model: typeof classifier, context: ClassifierContext) => {
		assert.equal(context.questions.route?.type, "choice");
		if (context.questions.route?.type === "choice") {
			assert.deepEqual(context.questions.route.criteria, criteria);
		}
		return classifierResult({
			answers: { route: { type: "choice", choice: "c254", confidence: 1, probabilities: { c254: 1 } } },
		});
	});
	const request = classifierRequest(classify);
	const result = await routeModel({
		...request,
		classifier: {
			questions: { route: { instructions: "Select a matching candidate", criteria } },
			decode: (choices) => ({ route: choices.route === "c254" ? ("review" as const) : ("none" as const) }),
		},
	});
	assert.deepEqual(result.value, { route: "review" });
	assert.equal(classify.mock.calls.length, 1);
});

for (const kind of ["pre-cancel", "in-flight cancel"] as const) {
	test(`classifier ${kind} cannot accept a late result or decode it`, async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const late = Promise.withResolvers<ClassifierResult>();
		let requestSignal: AbortSignal | undefined;
		const classify = vi.fn(
			(_model: typeof classifier, _context: ClassifierContext, options?: ModelsClassifierOptions) => {
				requestSignal = options?.signal;
				started.resolve();
				return late.promise;
			},
		);
		const request = classifierRequest(classify, decisionRequest().currentModel);
		const decode = vi.fn(request.classifier.decode);
		const dispatch = vi.fn(() => messageStream(decisionMessage()));
		if (kind === "pre-cancel") controller.abort();
		const pending = routeModel({
			...request,
			modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
			classifier: { ...request.classifier, decode },
			signal: controller.signal,
		});
		const rejected = assert.rejects(pending, /cancel|abort/i);
		if (kind === "in-flight cancel") {
			await started.promise;
			controller.abort();
			assert.equal(requestSignal?.aborted, true);
			late.resolve(classifierResult());
		}
		await rejected;
		assert.equal(classify.mock.calls.length, kind === "pre-cancel" ? 0 : 1);
		assert.equal(decode.mock.calls.length, 0);
		assert.equal(dispatch.mock.calls.length, 0);
	});
}

test("independent overlapping decisions cannot share state, candidates or cancellation", async () => {
	const streams = [createAssistantMessageEventStream(), createAssistantMessageEventStream()];
	const controller = new AbortController();
	const request = decisionRequest();
	const contexts: string[] = [];
	const dispatch = vi.fn((_model, context) => {
		contexts.push(JSON.stringify(context));
		return streams[contexts.length - 1];
	});
	const registry = { ...request.modelRegistry, streamSimple: dispatch };
	const first = routeModel({
		...request,
		modelRegistry: registry,
		state: { task: "first task" },
		signal: controller.signal,
	});
	const rejected = assert.rejects(first, /cancelled/);
	const second = routeModel({ ...request, modelRegistry: registry, state: { task: "second task" } });
	controller.abort();
	streams[1].push({ type: "done", reason: "toolUse", message: decisionMessage({ route: "none" }) });
	await rejected;
	assert.deepEqual((await second).value, { route: "none" });
	streams[0].push({ type: "done", reason: "toolUse", message: decisionMessage() });
	assert.match(contexts[0], /first task/);
	assert.equal(contexts[0].includes("second task"), false);
	assert.match(contexts[1], /second task/);
	assert.equal(dispatch.mock.calls.length, 2);
});

test("model/effort pairs use one Choice and one closed union, preserving null versus off", async () => {
	const pairs = [
		{ model: "local/plain", effort: null },
		{ model: "remote/reasoning", effort: "off" },
	] as const;
	const schema = Type.Union([
		Type.Object({ model: Type.Literal(pairs[0].model), effort: Type.Null() }, { additionalProperties: false }),
		Type.Object(
			{ model: Type.Literal(pairs[1].model), effort: Type.Literal(pairs[1].effort) },
			{ additionalProperties: false },
		),
	]);
	for (const index of [0, 1]) {
		const classify = vi.fn(async (_model: typeof classifier, context: ClassifierContext) => {
			assert.deepEqual(Object.keys(context.questions), ["pair"]);
			return classifierResult({
				answers: {
					pair: {
						type: "choice",
						choice: `p${index}`,
						probabilities: { p0: index === 0 ? 1 : 0, p1: index === 1 ? 1 : 0 },
						confidence: 1,
					},
				},
			});
		});
		const request = classifierRequest(classify);
		const result = await routeModel({
			...request,
			schema,
			state: { task: "Select a low-cost model", pairs: [...pairs] },
			classifier: {
				questions: {
					pair: {
						instructions: "Choose one complete model and effort pair based on task evidence and cost.",
						criteria: {
							p0: "local/plain with no configurable effort",
							p1: "remote/reasoning with supported off effort",
						},
					},
				},
				decode: (choices) => (choices.pair === "p0" ? pairs[0] : pairs[1]),
			},
		});
		assert.deepEqual(result.value, pairs[index]);
		assert.equal(classify.mock.calls.length, 1);
	}
});

test("classifier abort during a rejected provider request never falls back or decodes", async () => {
	const controller = new AbortController();
	const started = Promise.withResolvers<void>();
	const classify = vi.fn(
		(_model: typeof classifier, _context: ClassifierContext, options?: ModelsClassifierOptions) =>
			new Promise<ClassifierResult>((_resolve, reject) => {
				options?.signal?.addEventListener(
					"abort",
					() => reject(new Error("private upstream payload mock-secret")),
					{ once: true },
				);
				started.resolve();
			}),
	);
	const request = classifierRequest(classify, decisionRequest().currentModel);
	const decode = vi.fn(request.classifier.decode);
	const dispatch = vi.fn(() => messageStream(decisionMessage()));
	const pending = routeModel({
		...request,
		modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
		classifier: { ...request.classifier, decode },
		signal: controller.signal,
	});
	const rejected = assert.rejects(pending, (error: Error) => {
		assert.match(error.message, /cancelled/);
		assert.doesNotMatch(String(error.stack), /private upstream payload|mock-secret/);
		return true;
	});
	await started.promise;
	controller.abort();
	await rejected;
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(dispatch.mock.calls.length, 0);
	assert.equal(decode.mock.calls.length, 0);
});
