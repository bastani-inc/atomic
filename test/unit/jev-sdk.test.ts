import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { routeExecutionModel } from "../../packages/coding-agent/src/core/execution-model-router.js";
import {
	inferRouterDecision,
	inferStructuredOutput,
} from "../../packages/coding-agent/src/core/structured-output/index.js";
import { decisionMessage, decisionModel, decisionRequest, messageStream } from "../helpers/structured-output.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

/** Real backoff sleeps are 2s/4s/8s; tests retry on immediate timers. */
const FAST_RETRY = { enabled: true, maxRetries: 3, baseDelayMs: 1 };

test("Jev reports a safe SDK error class, context-limit code and request ID without echoed input", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
	const transport = vi.fn(async () =>
		Response.json(
			{ detail: { error_type: "max_tokens_exceeded", message: "private task synthetic-secret" } },
			{ status: 400, headers: { "x-typesafe-request-id": "req_01a0bd0e1bee707eb03451aa08cbbfde" } },
		),
	);
	vi.stubGlobal("fetch", transport);
	await assert.rejects(
		inferRouterDecision({
			...decisionRequest(),
			currentModel: undefined,
			settings: { getRouterModel: () => "typesafe/jev-latest" },
		}),
		(error: Error) => {
			assert.match(error.message, /BadRequestError/);
			assert.match(error.message, /HTTP 400/);
			assert.match(error.message, /max_tokens_exceeded/);
			assert.match(error.message, /req_01a0bd0e1bee707eb03451aa08cbbfde/);
			assert.doesNotMatch(JSON.stringify(error) + error.stack, /private task|synthetic-secret/);
			assert.equal(error.cause, undefined);
			return true;
		},
	);
	assert.equal(transport.mock.calls.length, 1);
});

test("automatic Jev routing falls back once to the current chat model with visible diagnostics", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const transport = vi.fn(async () =>
		Response.json({ detail: { error_type: "max_tokens_exceeded" } }, { status: 400 }),
	);
	vi.stubGlobal("fetch", transport);
	const request = decisionRequest();
	const dispatch = vi.fn((_model, context, options) => {
		assert.equal(_model.id, request.currentModel?.id);
		assert.deepEqual(JSON.parse(context.messages[0].content), {
			state: request.state,
			questions: request.jev.questions,
		});
		assert.equal(options.maxRetries, 0);
		assert.equal(options.timeoutMs, undefined);
		return messageStream(decisionMessage());
	});
	const result = await inferRouterDecision({
		...request,
		settings: { getRouterModel: () => "" },
		modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
	});
	assert.equal(result.model, "decision-test/chat");
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.equal(result.fallback?.from, "typesafe/jev-latest");
	assert.match(result.fallback?.reason ?? "", /max_tokens_exceeded/);
	assert.equal(warning.mock.calls.length, 1);
	assert.match(
		String(warning.mock.calls[0][0]),
		/^Jev routing failed; falling back to current chat model decision-test\/chat/,
	);
	assert.doesNotMatch(String(warning.mock.calls[0][0]), /max_tokens_exceeded|TYPESAFE_API_KEY|synthetic-secret/);
	assert.equal(transport.mock.calls.length, 1);
	assert.equal(dispatch.mock.calls.length, 1);
});

for (const status of [400, 401, 403, 404, 422, 429, 500, 529]) {
	const transient = status === 429 || status >= 500;
	test(`SDK HTTP ${status} ${transient ? "retries transiently" : "fails once"} without logging and cannot override the endpoint (#3206)`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
		vi.stubEnv("TYPESAFE_BASE_URL", "https://untrusted.invalid");
		vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "unwanted-model");
		vi.stubEnv("TYPESAFE_LOG_LEVEL", "debug");
		const logs = ["debug", "info", "warn", "error"].map((level) =>
			vi.spyOn(console, level as "debug" | "info" | "warn" | "error").mockImplementation(() => {}),
		);
		const transport = vi.fn(async (url, init) => {
			assert.equal(url, "https://api.typesafe.ai/v1/systemone");
			assert.equal(init.redirect, "error");
			assert.equal(JSON.parse(init.body).model, "jev-latest");
			return Response.json(
				{ detail: { error_type: "private_input", message: "synthetic-secret" } },
				{
					status,
					headers: { "x-typesafe-request-id": "private_input" },
				},
			);
		});
		vi.stubGlobal("fetch", transport);
		await assert.rejects(
			inferStructuredOutput({
				...decisionRequest(),
				model: { kind: "jev", fullId: "typesafe/jev-latest" },
				retry: FAST_RETRY,
			}),
			(error: Error) => {
				assert.match(error.message, new RegExp(`HTTP ${status}`));
				assert.doesNotMatch(JSON.stringify(error) + error.stack, /private_input|synthetic-secret/);
				return true;
			},
		);
		assert.equal(transport.mock.calls.length, transient ? 4 : 1);
		assert.ok(logs.every((log) => log.mock.calls.length === 0));
	});
}

for (const invalid of [false, true]) {
	test(`chat fallback ${invalid ? "schema" : "correlated-field"} validation exhausts three corrective retries`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubGlobal("fetch", async () => Response.json({}, { status: 400 }));
		const request = decisionRequest();
		const dispatch = vi.fn(() =>
			messageStream(decisionMessage(invalid ? { route: "invented" } : { route: "review" })),
		);
		await assert.rejects(
			inferRouterDecision(
				{
					...request,
					settings: { getRouterModel: () => "" },
					modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
				},
				() => false,
			),
			/Chat fallback output repair exhausted after 4 attempts/,
		);
		assert.equal(dispatch.mock.calls.length, 4);
	});
}

test("failed fallback is not retried or replaced by another model (#3206)", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const transport = vi.fn(async () => Response.json({}, { status: 503 }));
	vi.stubGlobal("fetch", transport);
	const request = decisionRequest();
	const dispatch = vi.fn(() => {
		throw new Error("private provider failure");
	});
	await assert.rejects(
		inferRouterDecision({
			...request,
			retry: FAST_RETRY,
			settings: { getRouterModel: () => "" },
			modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
		}),
		/Structured output provider request failed/,
	);
	assert.equal(transport.mock.calls.length, 4);
	assert.equal(dispatch.mock.calls.length, 1);
});

test("without a current chat model the original Jev error is retained", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
	vi.stubGlobal("fetch", async () =>
		Response.json({ detail: { error_type: "max_tokens_exceeded" } }, { status: 400 }),
	);
	await assert.rejects(
		inferRouterDecision({
			...decisionRequest(),
			currentModel: undefined,
			settings: { getRouterModel: () => "" },
		}),
		/max_tokens_exceeded/,
	);
});

test("a cancellation delivered with the Jev error prevents fallback", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
	const controller = new AbortController();
	vi.stubGlobal("fetch", async () => {
		controller.abort();
		return Response.json({}, { status: 400 });
	});
	const request = decisionRequest();
	const dispatch = vi.fn(() => messageStream(decisionMessage()));
	await assert.rejects(
		inferRouterDecision({
			...request,
			settings: { getRouterModel: () => "" },
			signal: controller.signal,
			modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
		}),
		/cancelled/,
	);
	assert.equal(dispatch.mock.calls.length, 0);
});

test("chat fallback can complete after slow Jev inference without a shared deadline", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubGlobal("fetch", async () => {
		await new Promise((resolve) => setTimeout(resolve, 60_000));
		return Response.json({}, { status: 400 });
	});
	const request = decisionRequest();
	const dispatch = vi.fn((_model, _context, options) => {
		assert.equal(options.timeoutMs, undefined);
		const stream = messageStream(decisionMessage());
		stream.result = () => new Promise((resolve) => setTimeout(() => resolve(decisionMessage()), 60_000));
		return stream;
	});
	const pending = inferRouterDecision({
		...request,
		settings: { getRouterModel: () => "" },
		modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
	});
	await vi.advanceTimersByTimeAsync(120_000);
	assert.equal((await pending).value.route, "review");
	assert.equal(dispatch.mock.calls.length, 1);
	assert.equal(dispatch.mock.calls[0][2].signal.aborted, false);
});

test("oversized error bodies are bounded and fall back to chat (#3206)", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const cancelled = vi.fn();
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(1024 * 1024 + 1));
					},
					cancel: cancelled,
				}),
				{ status: 400 },
			),
	);
	const request = decisionRequest();
	const dispatch = vi.fn(() => messageStream(decisionMessage()));
	const result = await inferRouterDecision({
		...request,
		settings: { getRouterModel: () => "" },
		modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
	});
	assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
	assert.match(result.fallback?.reason ?? "", /1 MiB/);
	assert.equal(dispatch.mock.calls.length, 1);
	assert.equal(cancelled.mock.calls.length, 1);
	assert.equal(warning.mock.calls.length, 1);
	// Without a concrete chat model the bounded-read failure stays observable.
	await assert.rejects(
		inferRouterDecision({ ...request, currentModel: undefined, settings: { getRouterModel: () => "" } }),
		/1 MiB/,
	);
});

test("execution auto routing recovers from Jev context rejection and still checks catalog eligibility", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubGlobal("fetch", async () =>
		Response.json({ detail: { error_type: "max_tokens_exceeded" } }, { status: 400 }),
	);
	const selection = { model: "decision-test/chat", effort: null };
	const dispatch = vi.fn(() => messageStream(decisionMessage(selection)));
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

for (const succeeds of [true, false]) {
	test(`Jev falls back immediately and the chat fallback gets three corrective retries: final success=${succeeds} (#3206)`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "synthetic-secret");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const transport = vi.fn(async () =>
			Response.json({ model: "jev-latest", answers: {}, usage: { input_tokens: 20, output_tokens: 10 } }),
		);
		vi.stubGlobal("fetch", transport);
		const request = decisionRequest();
		const dispatch = vi.fn((_model, context) => {
			assert.equal(transport.mock.calls.length, 1);
			assert.equal(context.systemPrompt.includes("previous response failed"), dispatch.mock.calls.length > 1);
			assert.deepEqual(JSON.parse(context.messages[0].content), {
				state: request.state,
				questions: request.jev.questions,
			});
			return messageStream(
				decisionMessage({ route: succeeds && dispatch.mock.calls.length === 4 ? "review" : "invalid" }),
			);
		});
		const pending = inferRouterDecision({
			...request,
			settings: { getRouterModel: () => "" },
			modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
		});
		if (succeeds) {
			const result = await pending;
			assert.deepEqual(result.value, { route: "review" });
			assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 50 });
			assert.match(result.fallback?.reason ?? "", /choice_key/);
		} else await assert.rejects(pending, /Chat fallback output repair exhausted after 4 attempts/);
		assert.equal(transport.mock.calls.length, 1);
		assert.equal(dispatch.mock.calls.length, 4);
		assert.equal(warning.mock.calls.length, 1);
	});
}

test("structured-output SDK rejects obsolete Jev model IDs before dispatch", async () => {
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	await assert.rejects(
		inferStructuredOutput({ ...decisionRequest(), model: { kind: "jev", fullId: "typesafe-ai/jev-latest" } }),
		/Invalid Jev model/,
	);
	assert.equal(transport.mock.calls.length, 0);
});
