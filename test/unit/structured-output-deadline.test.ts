import assert from "node:assert/strict";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { SETTINGS_DEFAULTS } from "../../packages/coding-agent/src/core/settings-defaults.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { generateStructuredOutput, routeModel } from "../../packages/coding-agent/src/core/structured-output/index.js";
import { createStructuredOutputTool } from "../../packages/coding-agent/src/core/tools/structured-output.js";
import {
	classifierResult,
	decisionClassifier,
	decisionMessage,
	decisionModel,
	decisionRequest,
	structuredOutputRequest,
} from "../helpers/structured-output.js";
import { toolContext } from "../helpers/tool-context.js";

const DEADLINE_MS = 1_000;
const DEADLINE_ERROR = `Structured output decision exceeded its ${DEADLINE_MS}ms deadline; no decision was accepted.`;
const CANCELLED_ERROR = "Structured output cancelled; no decision was accepted.";
const NO_RETRY = { enabled: false, maxRetries: 0, baseDelayMs: 1 } as const;

type Stream = ModelRegistry["streamSimple"];
type Options = Parameters<Stream>[2];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
	vi.useRealTimers();
});

interface Outcome<T> {
	state: "pending" | "fulfilled" | "rejected";
	value?: T;
	error?: Error;
}

function observe<T>(promise: Promise<T>): Outcome<T> {
	const outcome: Outcome<T> = { state: "pending" };
	promise.then(
		(value) => {
			outcome.state = "fulfilled";
			outcome.value = value;
		},
		(error: Error) => {
			outcome.state = "rejected";
			outcome.error = error;
		},
	);
	return outcome;
}

function eventFor(message: AssistantMessage) {
	return message.stopReason === "error" || message.stopReason === "aborted"
		? ({ type: "error", reason: message.stopReason, error: message } as const)
		: ({ type: "done", reason: message.stopReason as "toolUse" | "stop" | "length", message } as const);
}

function answerAfter(afterMs: number, message: AssistantMessage, options?: Options) {
	const stream = createAssistantMessageEventStream();
	const timer = setTimeout(() => stream.push(eventFor(message)), afterMs);
	options?.signal?.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			stream.push(eventFor({ ...message, content: [], stopReason: "aborted" }));
		},
		{ once: true },
	);
	return stream;
}

function hang(options?: Options, honorsAbort = true) {
	const stream = createAssistantMessageEventStream();
	if (honorsAbort)
		options?.signal?.addEventListener(
			"abort",
			() => stream.push(eventFor({ ...decisionMessage(), content: [], stopReason: "aborted" })),
			{ once: true },
		);
	return stream;
}

function textMessage(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { ...decisionMessage(), content: [{ type: "text", text: "Thinking it over." }], stopReason };
}

function scripted(steps: ReadonlyArray<readonly [afterMs: number, message: AssistantMessage]>) {
	let call = 0;
	return vi.fn<Stream>((_model, _context, options) => {
		const [afterMs, message] = steps[Math.min(call++, steps.length - 1)];
		return answerAfter(afterMs, message, options);
	});
}

function chatRequest(streamSimple: Stream) {
	return {
		...structuredOutputRequest(),
		modelRegistry: { getAll: () => [decisionModel], streamSimple },
	};
}

function routerRequest(streamSimple: Stream) {
	const request = decisionRequest();
	return { ...request, modelRegistry: { ...request.modelRegistry, streamSimple } };
}

for (const honorsAbort of [true, false]) {
	test(`a generation that never settles${honorsAbort ? "" : " and ignores abort"} ends at the decision deadline, not at cancellation (#3806)`, async () => {
		const stream = vi.fn<Stream>((_model, _context, options) => hang(options, honorsAbort));
		const outcome = observe(
			generateStructuredOutput({
				...chatRequest(stream),
				timeoutMs: DEADLINE_MS,
				fallbackModels: ["decision-test/chat-2"],
				modelRegistry: {
					getAll: () => [decisionModel, { ...decisionModel, id: "chat-2" }],
					streamSimple: stream,
				},
			}),
		);

		await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
		assert.equal(outcome.state, "pending");
		await vi.advanceTimersByTimeAsync(1);

		assert.equal(outcome.state, "rejected");
		assert.equal(outcome.error?.message, `${DEADLINE_ERROR} Attempts: 1) still generating 1.0s.`);
		assert.doesNotMatch(outcome.error?.message ?? "", /cancel|abort/i);
		assert.equal(stream.mock.calls.length, 1, "the deadline must not advance to the next model candidate");
		assert.equal(stream.mock.calls[0][2]?.signal?.aborted, true, "the in-flight generation is cancelled");
	});
}

test("the deadline spans every repair attempt, not each attempt alone (#3806)", async () => {
	const stream = scripted([[400, textMessage("stop")]]);
	const outcome = observe(generateStructuredOutput({ ...chatRequest(stream), timeoutMs: DEADLINE_MS }));

	await vi.advanceTimersByTimeAsync(DEADLINE_MS);

	assert.equal(outcome.state, "rejected");
	assert.equal(
		outcome.error?.message,
		`${DEADLINE_ERROR} Attempts: 1) stopReason=stop 400ms; 2) stopReason=stop 400ms; 3) still generating 200ms.`,
	);
	assert.equal(stream.mock.calls.length, 3, "the fourth repair attempt never starts");
});

test("routing repairs share one deadline as well (#3806)", async () => {
	const stream = scripted([[400, textMessage("stop")]]);
	const outcome = observe(routeModel({ ...routerRequest(stream), timeoutMs: DEADLINE_MS }));

	await vi.advanceTimersByTimeAsync(DEADLINE_MS);

	assert.equal(outcome.state, "rejected");
	assert.match(outcome.error?.message ?? "", new RegExp(`^${DEADLINE_ERROR.replaceAll(".", "\\.")} Attempts: `));
	assert.equal(stream.mock.calls.length, 3);
});

test("the deadline spans model-candidate fallbacks and ends the chain (#3806)", async () => {
	const models = ["chat", "chat-2", "chat-3"].map((id) => ({ ...decisionModel, id }));
	const stream = vi.fn<Stream>((model, _context, options) =>
		model.id === "chat"
			? answerAfter(600, { ...textMessage("error"), errorMessage: "provider failure" }, options)
			: hang(options),
	);
	const outcome = observe(
		generateStructuredOutput({
			...chatRequest(stream),
			model: "decision-test/chat",
			fallbackModels: ["decision-test/chat-2"],
			currentModel: models[2],
			modelRegistry: { getAll: () => models, streamSimple: stream },
			retry: NO_RETRY,
			timeoutMs: DEADLINE_MS,
		}),
	);

	await vi.advanceTimersByTimeAsync(DEADLINE_MS);

	assert.equal(outcome.state, "rejected");
	assert.equal(
		outcome.error?.message,
		`${DEADLINE_ERROR} Attempts: 1) stopReason=error 600ms; 2) still generating 400ms.`,
	);
	assert.deepEqual(
		stream.mock.calls.map(([model]) => model.id),
		["chat", "chat-2"],
		"the current chat model is never reached once the deadline has passed",
	);
});

test("transport retries and their backoff count toward the deadline (#3806)", async () => {
	const stream = vi.fn<Stream>((_model, _context, options) =>
		answerAfter(0, { ...textMessage("error"), errorMessage: "429 Too Many Requests: rate limit exceeded" }, options),
	);
	const outcome = observe(
		generateStructuredOutput({
			...chatRequest(stream),
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 2_000 },
			timeoutMs: 5_000,
		}),
	);

	await vi.advanceTimersByTimeAsync(5_000);

	assert.equal(outcome.state, "rejected");
	assert.equal(
		outcome.error?.message,
		"Structured output decision exceeded its 5000ms deadline; no decision was accepted. Attempts: 1) still generating 5.0s.",
	);
	assert.equal(stream.mock.calls.length, 2, "the third retry would have started after the deadline");
});

test("a hung routing classifier ends at the deadline without switching to the chat model (#3806)", async () => {
	const chat = vi.fn<Stream>(() => {
		throw new Error("chat fallback must not run");
	});
	const classify = vi.fn(() => new Promise<never>(() => {}));
	const request = routerRequest(chat);
	const outcome = observe(
		routeModel({
			...request,
			settings: { getRouterModel: () => "decision-test/classifier" },
			modelRegistry: { ...request.modelRegistry, getClassifierModel: () => decisionClassifier, classify },
			timeoutMs: DEADLINE_MS,
		}),
	);

	await vi.advanceTimersByTimeAsync(DEADLINE_MS);

	assert.equal(outcome.state, "rejected");
	assert.match(outcome.error?.message ?? "", /^Structured output decision exceeded its 1000ms deadline/);
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(chat.mock.calls.length, 0);
});

test("the default deadline follows the httpIdleTimeoutMs setting and an explicit timeoutMs overrides it (#3806)", async () => {
	const settings = SettingsManager.inMemory({ routerModel: "decision-test/chat", httpIdleTimeoutMs: 2_000 });
	const stream = vi.fn<Stream>((_model, _context, options) => hang(options));

	const fromSetting = observe(routeModel({ ...routerRequest(stream), settings }));
	await vi.advanceTimersByTimeAsync(1_999);
	assert.equal(fromSetting.state, "pending");
	await vi.advanceTimersByTimeAsync(1);
	assert.equal(fromSetting.state, "rejected");
	assert.match(fromSetting.error?.message ?? "", /^Structured output decision exceeded its 2000ms deadline/);

	const overridden = observe(routeModel({ ...routerRequest(stream), settings, timeoutMs: 500 }));
	await vi.advanceTimersByTimeAsync(500);
	assert.equal(overridden.state, "rejected");
	assert.match(overridden.error?.message ?? "", /^Structured output decision exceeded its 500ms deadline/);
});

test("httpIdleTimeoutMs 0 disables the idle timeout, so the deadline falls back to the largest timer delay (#3806)", async () => {
	const settings = SettingsManager.inMemory({ routerModel: "decision-test/chat", httpIdleTimeoutMs: 0 });
	const stream = vi.fn<Stream>((_model, _context, options) => hang(options));
	const outcome = observe(routeModel({ ...routerRequest(stream), settings }));

	await vi.advanceTimersByTimeAsync(2_147_483_646);
	assert.equal(outcome.state, "pending");
	await vi.advanceTimersByTimeAsync(1);

	assert.equal(outcome.state, "rejected");
	assert.match(outcome.error?.message ?? "", /^Structured output decision exceeded its 2147483647ms deadline/);
});

test("a call with no reachable settings is bounded by the default httpIdleTimeoutMs (#3806)", async () => {
	const defaultMs = SETTINGS_DEFAULTS.httpIdleTimeoutMs;
	const stream = vi.fn<Stream>((_model, _context, options) => hang(options));
	const generated = observe(generateStructuredOutput(chatRequest(stream)));
	const routed = observe(
		routeModel({ ...routerRequest(stream), settings: { getRouterModel: () => "decision-test/chat" } }),
	);

	await vi.advanceTimersByTimeAsync(defaultMs - 1);
	assert.equal(generated.state, "pending");
	assert.equal(routed.state, "pending");
	await vi.advanceTimersByTimeAsync(1);

	for (const outcome of [generated, routed]) {
		assert.equal(outcome.state, "rejected");
		assert.match(outcome.error?.message ?? "", new RegExp(`^Structured output decision exceeded its ${defaultMs}ms`));
	}
});

for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "5000"]) {
	test(`timeoutMs ${String(timeoutMs)} is rejected before any inference (#3806)`, async () => {
		const stream = vi.fn<Stream>(() => {
			throw new Error("must not dispatch");
		});
		const invalid = timeoutMs as number;

		await assert.rejects(generateStructuredOutput({ ...chatRequest(stream), timeoutMs: invalid }), /timeoutMs/);
		await assert.rejects(routeModel({ ...routerRequest(stream), timeoutMs: invalid }), /timeoutMs/);
		assert.equal(stream.mock.calls.length, 0);
		assert.equal(vi.getTimerCount(), 0);
	});
}

test("a valid timeoutMs larger than the timer limit still bounds the decision at the limit (#3806)", async () => {
	const stream = vi.fn<Stream>((_model, _context, options) => hang(options));
	const outcome = observe(generateStructuredOutput({ ...chatRequest(stream), timeoutMs: Number.MAX_SAFE_INTEGER }));

	await vi.advanceTimersByTimeAsync(2_147_483_646);
	assert.equal(outcome.state, "pending");
	await vi.advanceTimersByTimeAsync(1);

	assert.equal(outcome.state, "rejected");
	assert.match(outcome.error?.message ?? "", /^Structured output decision exceeded its 2147483647ms deadline/);
});

test("an exhausted repair budget reports how each attempt ended and how long it took (#3806)", async () => {
	const stream = scripted([
		[1_502_000, textMessage("stop")],
		[90_000, textMessage("length")],
		[2_000, decisionMessage({ route: "nonsense" })],
		[100, textMessage("stop")],
	]);
	const outcome = observe(generateStructuredOutput({ ...chatRequest(stream), timeoutMs: 7_200_000 }));

	await vi.advanceTimersByTimeAsync(1_502_000 + 90_000 + 2_000 + 100);

	assert.equal(outcome.state, "rejected");
	assert.equal(
		outcome.error?.message,
		"Structured output requires one structured_output call. Structured output repair exhausted after 4 attempts. " +
			"Attempts: 1) stopReason=stop 25m02s; 2) stopReason=length 1m30s; 3) stopReason=toolUse 2.0s; 4) stopReason=stop 100ms.",
	);
	assert.equal(stream.mock.calls.length, 4);
});

test("routing exhaustion carries the same per-attempt record without private values (#3806)", async () => {
	const secret = "private-rejected-value";
	const stream = scripted([
		[10, decisionMessage({ route: secret })],
		[20, textMessage("length")],
		[30, decisionMessage({ route: secret })],
		[40, decisionMessage({ route: secret })],
	]);
	const outcome = observe(routeModel(routerRequest(stream)));

	await vi.advanceTimersByTimeAsync(100);

	assert.equal(outcome.state, "rejected");
	assert.match(
		outcome.error?.message ?? "",
		/^Invalid structured output: response does not match the decision schema\./,
	);
	assert.match(
		outcome.error?.message ?? "",
		/Routing output repair exhausted after 4 attempts\. Attempts: 1\) stopReason=toolUse 10ms; 2\) stopReason=length 20ms; 3\) stopReason=toolUse 30ms; 4\) stopReason=toolUse 40ms\.$/,
	);
	assert.doesNotMatch(outcome.error?.message ?? "", new RegExp(secret));
});

for (const entry of ["generateStructuredOutput", "routeModel"] as const) {
	test(`${entry}: a caller abort keeps its cancellation message, and the deadline timer is released (#3806)`, async () => {
		const controller = new AbortController();
		const stream = vi.fn<Stream>((_model, _context, options) => hang(options));
		const pending =
			entry === "routeModel"
				? routeModel({ ...routerRequest(stream), timeoutMs: 10 * DEADLINE_MS, signal: controller.signal })
				: generateStructuredOutput({
						...chatRequest(stream),
						timeoutMs: 10 * DEADLINE_MS,
						signal: controller.signal,
					});
		const outcome = observe(pending);

		await vi.advanceTimersByTimeAsync(100);
		controller.abort();
		await vi.advanceTimersByTimeAsync(0);

		assert.equal(outcome.state, "rejected");
		assert.equal(outcome.error?.message, CANCELLED_ERROR);
		assert.equal(vi.getTimerCount(), 0, "no deadline timer outlives the aborted call");
		assert.equal(stream.mock.calls[0][2]?.signal?.aborted, true);
	});
}

test("a decision that finishes in time releases its deadline timer (#3806)", async () => {
	const stream = scripted([[50, decisionMessage({ route: "review" })]]);
	const outcome = observe(generateStructuredOutput({ ...chatRequest(stream), timeoutMs: DEADLINE_MS }));

	await vi.advanceTimersByTimeAsync(50);

	assert.equal(outcome.state, "fulfilled");
	assert.deepEqual(outcome.value?.value, { route: "review" });
	assert.equal(vi.getTimerCount(), 0);
	await vi.advanceTimersByTimeAsync(10 * DEADLINE_MS);
	assert.equal(outcome.state, "fulfilled");
});

test("a finished classifier decision releases its deadline timer (#3806)", async () => {
	const request = routerRequest(() => {
		throw new Error("chat must not run");
	});
	const classify = vi.fn(async () => classifierResult());
	const outcome = observe(
		routeModel({
			...request,
			settings: { getRouterModel: () => "decision-test/classifier" },
			modelRegistry: { ...request.modelRegistry, getClassifierModel: () => decisionClassifier, classify },
			timeoutMs: DEADLINE_MS,
		}),
	);

	await vi.advanceTimersByTimeAsync(0);

	assert.equal(outcome.state, "fulfilled");
	assert.equal(vi.getTimerCount(), 0);
});

test("the structured_output tool bounds a decision by its timeoutMs option (#3806)", async () => {
	const stream = vi.fn<Stream>((_model, _context, options) => hang(options));
	const tool = createStructuredOutputTool({ schema: structuredOutputRequest().schema, timeoutMs: DEADLINE_MS });
	const outcome = observe(
		tool.execute(
			"call-1",
			{ instructions: "Pick a route.", state: { task: "Review" } },
			undefined,
			undefined,
			toolContext({
				model: decisionModel,
				modelRegistry: { getAll: () => [decisionModel], streamSimple: stream },
			} as never),
		),
	);

	await vi.advanceTimersByTimeAsync(DEADLINE_MS);

	assert.equal(outcome.state, "rejected");
	assert.match(outcome.error?.message ?? "", /^Structured output decision exceeded its 1000ms deadline/);
	assert.equal(stream.mock.calls.length, 1);
});

test("the structured_output tool takes its default deadline from the session's httpIdleTimeoutMs (#3806)", async () => {
	const stream = vi.fn<Stream>((_model, _context, options) => hang(options));
	const tool = createStructuredOutputTool({ schema: structuredOutputRequest().schema });
	const context = toolContext({
		model: decisionModel,
		modelRegistry: { getAll: () => [decisionModel], streamSimple: stream },
		getHttpIdleTimeoutMs: () => 2_500,
	} as never);
	const outcome = observe(
		tool.execute(
			"call-1",
			{ instructions: "Pick a route.", state: { task: "Review" } },
			undefined,
			undefined,
			context,
		),
	);

	await vi.advanceTimersByTimeAsync(2_499);
	assert.equal(outcome.state, "pending");
	await vi.advanceTimersByTimeAsync(1);

	assert.equal(outcome.state, "rejected");
	assert.match(outcome.error?.message ?? "", /^Structured output decision exceeded its 2500ms deadline/);
});
