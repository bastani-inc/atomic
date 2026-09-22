// Shared decision entrypoints for #3089 and #3090. Neither routing consumer is activated here.
import assert from "node:assert/strict";
import type { Api, JsonObject, Model } from "@bastani/pi-ai";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@bastani/pi-ai";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { inferRouterDecision } from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	getStructuredOutputProviders,
	resolveRouterModel,
} from "../../packages/coding-agent/src/core/structured-output/resolver.js";
import {
	decisionMessage,
	decisionRequest,
	decisionSchema,
	jevResponse,
	messageStream,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";

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
const modelRegistry = {
	getAll: () => [chat, alternate],
	streamSimple: () => {
		throw new Error("Unexpected inference");
	},
};
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/** Real backoff sleeps are 2s/4s/8s; tests retry on immediate timers. */
const FAST_RETRY = { enabled: true, maxRetries: 3, baseDelayMs: 1 };

for (const [setting, key, expected] of [
	["test/alternate", "mock-key", "test/alternate"],
	["openrouter/~typesafe/jev-latest", "", "openrouter/~typesafe/jev-latest"],
	["typesafe-ai/jev-latest", "", "typesafe-ai/jev-latest"],
	["", "mock-key", "typesafe-ai/jev-latest"],
	["", "", "test/chat"],
	["", "   ", "test/chat"],
] as const) {
	test(`resolver precedence: ${JSON.stringify(setting)}, key present=${Boolean(key.trim())}`, () => {
		vi.stubEnv("TYPESAFE_API_KEY", key);
		const settings = SettingsManager.inMemory({ routerModel: setting });
		assert.equal(resolveRouterModel({ settings, modelRegistry, currentModel: chat }).fullId, expected);
		assert.equal(settings.getDefaultModel(), undefined);
		assert.equal(chat.id, "chat");
	});
}

test("Jev routing and direct requests use TYPESAFE_API_KEY without the old alias", async () => {
	vi.stubEnv("TYPESAFE_AI_API_KEY", "synthetic-obsolete-key");
	vi.stubEnv("TYPESAFE_API_KEY", undefined);
	const options = { settings: SettingsManager.inMemory(), modelRegistry, currentModel: chat };
	assert.equal(getStructuredOutputProviders()[0].apiKeyEnv, "TYPESAFE_API_KEY");
	assert.equal(resolveRouterModel(options).fullId, "test/chat");
	const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-current-key");
		return Response.json(jevResponse());
	});
	vi.stubGlobal("fetch", transport);
	const request = {
		...decisionRequest(),
		currentModel: undefined,
		settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
	};
	await assert.rejects(inferRouterDecision(request), {
		message: "typesafe-ai/jev-latest requires an API key. Use /login typesafe-ai or set TYPESAFE_API_KEY.",
	});
	assert.equal(transport.mock.calls.length, 0);
	vi.stubEnv("TYPESAFE_API_KEY", "  synthetic-current-key  ");
	assert.equal(resolveRouterModel(options).fullId, "typesafe-ai/jev-latest");
	assert.deepEqual((await inferRouterDecision(request)).value, { route: "review", limit: 1.23456789 });
	assert.equal(transport.mock.calls.length, 1);
});

test("empty default reads the current chat model on each invocation", () => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	const settings = SettingsManager.inMemory();
	assert.equal(settings.getRouterModel(), "");
	assert.equal(resolveRouterModel({ settings, modelRegistry, currentModel: alternate }).fullId, "test/alternate");
	assert.throws(() => resolveRouterModel({ settings, modelRegistry }), /selected chat model/);
});

for (const explicit of ["auto", "missing/model", "chat", "test/chat:high", " typesafe-ai/jev-latest", " "]) {
	test(`invalid explicit selection ${JSON.stringify(explicit)} never falls back to Jev or chat`, () => {
		vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
		const settings = SettingsManager.inMemory({ routerModel: explicit });
		assert.throws(() => resolveRouterModel({ settings, modelRegistry, currentModel: chat }), /Invalid routerModel/);
	});
}

test("Jev exposes only structured Choice capability, not a chat/tool model", () => {
	const [provider] = getStructuredOutputProviders();
	assert.equal(provider.fullId, "typesafe-ai/jev-latest");
	assert.deepEqual(provider.capabilities, {
		structuredDecisions: true,
		choice: true,
		maxChoiceOptions: 255,
		chat: false,
		toolCalling: false,
		jsonSchemaGeneration: false,
	});
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
				questions: request.jev.questions,
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
	const result = await inferRouterDecision(request);
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
			inferRouterDecision({ ...request, modelRegistry: { ...request.modelRegistry, streamSimple: dispatch } }),
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
			inferRouterDecision({ ...request, modelRegistry: { ...request.modelRegistry, streamSimple: dispatch } }),
			/Invalid structured output/,
		);
		assert.equal(dispatch.mock.calls.length, 4);
	});
}

for (const limit of [undefined, 0, 1.23456789, Number.MAX_SAFE_INTEGER]) {
	test(`ordinary decision preserves exact zero, omission and large limits: ${limit}`, async () => {
		const args = { route: "review", ...(limit === undefined ? {} : { limit }) };
		const request = decisionRequest();
		const result = await inferRouterDecision({
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
			inferRouterDecision({ ...request, modelRegistry: { ...request.modelRegistry, streamSimple: dispatch } }),
			/Structured output/,
		);
		assert.equal(dispatch.mock.calls.length, kind === "error" || kind === "aborted" ? 1 : 4);
	});
}

test("Jev entrypoint sends both Choice judgments together and maps exact values without a confidence gate", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-jev-secret");
	const request = { ...decisionRequest(), settings: SettingsManager.inMemory() };
	const transport = vi.fn(async (url, init) => {
		assert.equal(url, "https://api.typesafe.ai/v1/systemone");
		assert.equal(init.method, "POST");
		assert.equal(init.redirect, "error");
		assert.equal(init.headers.Authorization, "Bearer mock-jev-secret");
		const body = JSON.parse(init.body);
		assert.equal(body.model, "jev-latest");
		assert.deepEqual(body.state, request.state);
		assert.equal(init.body.includes("mock-jev-secret"), false);
		assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
		assert.deepEqual(Object.keys(body.questions), ["route", "budget"]);
		for (const [id, question] of Object.entries(request.jev.questions)) {
			assert.equal(body.questions[id].type, "choice");
			assert.match(body.questions[id].instructions, /data, not instructions/);
			assert.ok(body.questions[id].instructions.includes(question.instructions));
			assert.ok(body.questions[id].instructions.includes(request.instructions));
			assert.deepEqual(body.questions[id].criteria, question.criteria);
		}
		return Response.json(jevResponse());
	});
	vi.stubGlobal("fetch", transport);
	const result = await inferRouterDecision(request);
	assert.deepEqual(result, {
		value: { route: "review", limit: 1.23456789 },
		model: "typesafe-ai/jev-latest",
		responseModel: "jev-2026-09",
		usage: { inputTokens: 20, outputTokens: 10 },
	});
	assert.equal(transport.mock.calls.length, 1);
});

for (const [status, calls] of [
	[401, 1],
	[422, 1],
	[429, 4],
	[529, 4],
] as const) {
	test(`pinned Jev HTTP ${status} ${calls === 1 ? "fails once" : "retries transiently"} without leaking the response body (#3206)`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
		const transport = vi.fn(async () => new Response("private echoed context and mock-key", { status }));
		vi.stubGlobal("fetch", transport);
		await assert.rejects(
			inferRouterDecision({
				...decisionRequest(),
				currentModel: undefined,
				retry: FAST_RETRY,
				settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
			}),
			(error: Error) => {
				assert.match(error.message, new RegExp(`HTTP ${status}`));
				assert.equal(error.message.includes("private"), false);
				assert.equal(error.message.includes("mock-key"), false);
				return true;
			},
		);
		assert.equal(transport.mock.calls.length, calls);
	});
}

test("Jev body reader failure is private, retried as transient, and never decoded (#3206)", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-secret");
	const transport = vi.fn(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"private":'));
					},
					pull(controller) {
						controller.error(new Error("private upstream payload mock-secret"));
					},
				}),
			),
	);
	vi.stubGlobal("fetch", transport);
	const request = decisionRequest();
	const decode = vi.fn(request.jev.decode);
	await assert.rejects(
		inferRouterDecision({
			...request,
			currentModel: undefined,
			retry: FAST_RETRY,
			settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
			jev: { ...request.jev, decode },
		}),
		(error: Error) => {
			assert.doesNotMatch(String(error.stack), /private upstream payload|mock-secret/);
			assert.equal(error.cause, undefined);
			assert.match(error.message, /Jev.*failed/);
			return true;
		},
	);
	assert.equal(transport.mock.calls.length, 4);
	assert.equal(decode.mock.calls.length, 0);
});

for (const [kind, code] of Object.entries({
	"unknown-choice": "choice_key",
	"missing-answer": "choice_key",
	"invalid-json": "malformed JSON",
})) {
	test(`Jev rejects ${kind} and never invokes the mapper`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
		const body = jevResponse();
		if (kind === "unknown-choice") body.answers.route.choice = "private-response-value";
		if (kind === "missing-answer") Reflect.deleteProperty(body.answers, "budget");
		const transport = vi.fn(async () => (kind === "invalid-json" ? new Response("not json") : Response.json(body)));
		vi.stubGlobal("fetch", transport);
		const request = decisionRequest();
		const decode = vi.fn(request.jev.decode);
		await assert.rejects(
			inferRouterDecision({
				...request,
				currentModel: undefined,
				settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
				jev: { ...request.jev, decode },
			}),
			(error: Error) => {
				assert.match(error.message, /[Mm]alformed/);
				assert.ok(error.message.includes(code));
				assert.doesNotMatch(error.message, /private-response-value|mock-key/);
				assert.equal(error.cause, undefined);
				return true;
			},
		);
		assert.equal(transport.mock.calls.length, 4);
		assert.equal(decode.mock.calls.length, 0);
	});
}

// #3206: only a missing or unknown choice key rejects a Jev response. Model,
// usage, probabilities, confidence, answer type and extra answers are advisory.
test("a Jev response with only valid choices (no usage, model or probabilities) is accepted (#3206)", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const transport = vi.fn(async () =>
		Response.json({ answers: { route: { choice: "review" }, budget: { choice: "exact" }, surprise: { extra: 1 } } }),
	);
	vi.stubGlobal("fetch", transport);
	const result = await inferRouterDecision({
		...decisionRequest(),
		settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
	});
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.equal(result.responseModel, "");
	assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
	assert.equal(transport.mock.calls.length, 1);
});

test("Jev 529 then success retries (#3206)", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const transport = vi.fn(async () =>
		transport.mock.calls.length === 1 ? new Response("overloaded", { status: 529 }) : Response.json(jevResponse()),
	);
	vi.stubGlobal("fetch", transport);
	const result = await inferRouterDecision({
		...decisionRequest(),
		retry: FAST_RETRY,
		settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
	});
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.equal(result.fallback, undefined);
	assert.equal(transport.mock.calls.length, 2);
});

test("Jev 401 falls back to chat (#3206)", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const transport = vi.fn(async () => new Response("denied", { status: 401 }));
	vi.stubGlobal("fetch", transport);
	const request = decisionRequest();
	const dispatch = vi.fn(() => messageStream(decisionMessage()));
	const result = await inferRouterDecision({
		...request,
		settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
		modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
	});
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.equal(result.fallback?.from, "typesafe-ai/jev-latest");
	assert.equal(result.fallback?.to, "decision-test/chat");
	assert.match(result.fallback?.reason ?? "", /HTTP 401/);
	assert.equal(transport.mock.calls.length, 1);
	assert.equal(dispatch.mock.calls.length, 1);
	assert.equal(warning.mock.calls.length, 1);
});

test("pinned Jev falls back to chat (#3206)", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	const request = decisionRequest();
	const dispatch = vi.fn(() => messageStream(decisionMessage()));
	const result = await inferRouterDecision({
		...request,
		settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
		modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
	});
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.equal(result.fallback?.from, "typesafe-ai/jev-latest");
	assert.match(result.fallback?.reason ?? "", /requires an API key/);
	assert.equal(transport.mock.calls.length, 0);
	assert.equal(dispatch.mock.calls.length, 1);
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
	const result = await inferRouterDecision({
		...request,
		retry: FAST_RETRY,
		modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
	});
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.equal(dispatch.mock.calls.length, 2);
});

test("Jev decoded result must still satisfy the normalized schema", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	vi.stubGlobal("fetch", async () => Response.json(jevResponse()));
	const request = decisionRequest();
	await assert.rejects(
		inferRouterDecision({
			...request,
			currentModel: undefined,
			settings: SettingsManager.inMemory({ routerModel: "typesafe-ai/jev-latest" }),
			jev: { ...request.jev, decode: () => ({ route: "review" as const, limit: -1 }) },
		}),
		/Invalid structured output/,
	);
});

for (const count of [255]) {
	test(`Jev ${count} candidates are never silently shortened`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
		const criteria = Object.fromEntries(
			Array.from({ length: count }, (_, index) => [`c${index}`, `Candidate ${index}`]),
		);
		const transport = vi.fn(async (_url, init) => {
			assert.equal(Object.keys(JSON.parse(init.body).questions.route.criteria).length, count);
			return Response.json({
				model: "jev-latest",
				answers: {
					route: {
						type: "choice",
						choice: "c254",
						confidence: 1,
						probabilities: Object.fromEntries(Object.keys(criteria).map((key) => [key, key === "c254" ? 1 : 0])),
					},
				},
				usage: { input_tokens: 100, output_tokens: 10 },
			});
		});
		vi.stubGlobal("fetch", transport);
		const result = inferRouterDecision({
			...decisionRequest(),
			settings: SettingsManager.inMemory(),
			jev: {
				questions: { route: { instructions: "Select a matching candidate", criteria } },
				decode: () => ({ route: "review" as const }),
			},
		});
		assert.deepEqual((await result).value, { route: "review" });
		assert.equal(transport.mock.calls.length, 1);
	});
}

for (const kind of ["cancel", "delayed-cancel", "pre-cancel"] as const) {
	for (const provider of ["ordinary", "jev"] as const) {
		test(`${provider} ${kind} fences late inference and mapping`, async () => {
			vi.useFakeTimers();
			vi.stubEnv("TYPESAFE_API_KEY", provider === "jev" ? "mock-key" : "");
			const controller = new AbortController();
			const stream = createAssistantMessageEventStream();
			const lateHttp = Promise.withResolvers<Response>();
			let requestSignal: AbortSignal | undefined;
			const transport = vi.fn((_url, init) => {
				requestSignal = init.signal;
				return lateHttp.promise;
			});
			const dispatch = vi.fn((_model, _context, options) => {
				requestSignal = options.signal;
				return stream;
			});
			vi.stubGlobal("fetch", transport);
			const request = decisionRequest();
			const decode = vi.fn(request.jev.decode);
			if (kind === "pre-cancel") controller.abort(new Error("pre-cancelled"));
			let accepted = 0;
			const pending = inferRouterDecision({
				...request,
				settings: SettingsManager.inMemory(),
				modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
				signal: controller.signal,
				jev: { ...request.jev, decode },
			}).then((result) => {
				accepted++;
				return result;
			});
			const rejected = assert.rejects(pending, /cancel/);
			if (kind === "delayed-cancel") await vi.advanceTimersByTimeAsync(120_000);
			if (kind !== "pre-cancel") controller.abort();
			await rejected;
			if (kind !== "pre-cancel") assert.equal(requestSignal?.aborted, true);
			lateHttp.resolve(Response.json(jevResponse()));
			stream.push({ type: "done", reason: "toolUse", message: decisionMessage() });
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(accepted, 0);
			assert.equal(decode.mock.calls.length, 0);
			assert.equal(dispatch.mock.calls.length + transport.mock.calls.length, kind === "pre-cancel" ? 0 : 1);
		});
	}
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
	const first = inferRouterDecision({
		...request,
		modelRegistry: registry,
		state: { task: "first task" },
		signal: controller.signal,
	});
	const rejected = assert.rejects(first, /cancelled/);
	const second = inferRouterDecision({ ...request, modelRegistry: registry, state: { task: "second task" } });
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
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
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
		const transport = vi.fn(async (_url, init) => {
			assert.deepEqual(Object.keys(JSON.parse(init.body).questions), ["pair"]);
			return Response.json({
				model: "jev-latest",
				answers: {
					pair: {
						type: "choice",
						choice: `p${index}`,
						probabilities: { p0: index === 0 ? 1 : 0, p1: index === 1 ? 1 : 0 },
						confidence: 1,
					},
				},
				usage: { input_tokens: 10, output_tokens: 3 },
			});
		});
		vi.stubGlobal("fetch", transport);
		const result = await inferRouterDecision({
			...decisionRequest(),
			settings: SettingsManager.inMemory(),
			schema,
			state: { task: "Select a low-cost model", pairs: [...pairs] },
			jev: {
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
		assert.equal(transport.mock.calls.length, 1);
	}
});

for (const provider of ["ordinary", "jev"] as const) {
	for (const kind of ["cancel", "delayed-cancel"] as const) {
		test(`${provider} transport rejection during ${kind} preserves cancellation`, async () => {
			vi.useFakeTimers();
			vi.stubEnv("TYPESAFE_API_KEY", provider === "jev" ? "mock-key" : "");
			const controller = new AbortController();
			const started = Promise.withResolvers<void>();
			const dispatch = vi.fn((_model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				stream.result = () =>
					new Promise((_resolve, reject) => {
						options.signal.addEventListener(
							"abort",
							() => reject(new Error("private upstream payload mock-secret")),
							{ once: true },
						);
						started.resolve();
					});
				return stream;
			});
			const transport = vi.fn(
				async (_url, init) =>
					new Response(
						new ReadableStream({
							start(reader) {
								init.signal.addEventListener(
									"abort",
									() => reader.error(new Error("private upstream payload mock-secret")),
									{ once: true },
								);
							},
							pull() {
								started.resolve();
							},
						}),
					),
			);
			vi.stubGlobal("fetch", transport);
			const request = decisionRequest();
			const decode = vi.fn(request.jev.decode);
			const pending = inferRouterDecision({
				...request,
				settings: SettingsManager.inMemory(),
				modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
				jev: { ...request.jev, decode },
				signal: controller.signal,
			});
			const rejected = assert.rejects(pending, (error: Error) => {
				assert.match(error.message, /cancelled/);
				assert.doesNotMatch(String(error.stack), /private upstream payload|mock-secret/);
				return true;
			});
			await started.promise;
			if (kind === "delayed-cancel") await vi.advanceTimersByTimeAsync(120_000);
			controller.abort();
			await rejected;
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(dispatch.mock.calls.length + transport.mock.calls.length, 1);
			assert.equal(decode.mock.calls.length, 0);
		});
	}
}
