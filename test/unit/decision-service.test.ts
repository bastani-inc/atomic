import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { decide } from "../../packages/coding-agent/src/core/decision/decide.js";
import {
	DecisionConfigError,
	DecisionError,
	DecisionModelUnavailableError,
	DecisionOutputError,
	DecisionProviderError,
	DecisionRequestError,
	type DecisionRequestErrorReason,
	DecisionTimeoutError,
	findDecisionError,
	isDecisionConfigError,
	isDecisionError,
	isDecisionModelUnavailableError,
	isDecisionOutputError,
	isDecisionProviderError,
	isDecisionRequestError,
	isDecisionTimeoutError,
	isRetryableDecisionError,
	rehydrateDecisionError,
	serializeDecisionError,
} from "../../packages/coding-agent/src/core/decision/errors.js";
import type { DecisionQuestions, DecisionRequest } from "../../packages/coding-agent/src/core/decision/types.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	decisionChatModel,
	decisionMessage,
	messageStream,
	parseInferenceUserPayload,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";

const READINESS_QUESTIONS = {
	next_action: {
		type: "choice",
		instructions: "Move on or stay?",
		criteria: { advance: "Move on to the next stage.", stay: "Keep this stage open." },
	},
	reply_addresses_message: {
		type: "bool",
		instructions: "Does the reply fully address the user's message?",
		criteria: { true: "It does.", false: "It does not." },
	},
} as const satisfies DecisionQuestions;

const STATE = { user_message: "Use the blue theme.", stage_reply: "Applied the blue theme." };

function fixture(name: string): string {
	return readFileSync(new URL(`../fixtures/decision/${name}`, import.meta.url), "utf8");
}

/** A TypeSafe System One endpoint that replays a recorded wire response and keeps every request body. */
function recordedClassifier(...bodies: string[]) {
	const requests: Array<{ url: string; body: { model: string; state: unknown; questions: Record<string, unknown> } }> =
		[];
	const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
		return new Response(bodies[Math.min(requests.length - 1, bodies.length - 1)], {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	vi.stubGlobal("fetch", transport);
	return { transport, requests };
}

async function request<Q extends DecisionQuestions>(
	overrides: Partial<DecisionRequest<Q>> & Pick<DecisionRequest<Q>, "questions">,
	chat = vi.fn(() => messageStream(decisionMessage({ next_action: "advance", reply_addresses_message: true }))),
	decisionModel = "typesafe/jev-latest",
): Promise<{ request: DecisionRequest<Q>; chat: typeof chat }> {
	const { registry } = await registeredDecisionRuntime(chat);
	return {
		chat,
		request: {
			state: STATE,
			settings: SettingsManager.inMemory({ decisionModel }),
			modelRegistry: registry,
			currentModel: decisionChatModel,
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			...overrides,
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

test("a recorded classifier response answers Choice and yes/no questions with their probabilities (#4358)", async () => {
	const { requests } = recordedClassifier(fixture("typesafe-readiness-advance.json"));
	const { request: decision, chat } = await request({ questions: READINESS_QUESTIONS });
	const result = await decide(decision);
	assert.equal(result.source, "classifier");
	assert.equal(result.model, "typesafe/jev-latest");
	assert.equal(result.responseModel, "jev-latest");
	assert.equal(result.fallback, undefined);
	assert.deepEqual(result.answers.next_action, {
		type: "choice",
		choice: "advance",
		probabilities: { advance: 0.93, stay: 0.07 },
		confidence: 0.93,
	});
	assert.deepEqual(result.answers.reply_addresses_message, { type: "bool", value: true, probability: 0.91 });
	assert.equal(chat.mock.calls.length, 0);
	assert.equal(requests.length, 1);
	assert.match(requests[0]!.url, /\/systemone$/);
	assert.equal(requests[0]!.body.model, "jev-latest");
	assert.deepEqual(requests[0]!.body.state, STATE);
	assert.deepEqual(Object.keys(requests[0]!.body.questions), ["next_action", "reply_addresses_message"]);
	assert.equal((requests[0]!.body.questions.reply_addresses_message as { type: string }).type, "noul");
	assert.deepEqual((requests[0]!.body.questions.next_action as { criteria: object }).criteria, {
		advance: "Move on to the next stage.",
		stay: "Keep this stage open.",
	});
});

test("a recorded low-probability yes answers false, and a Score keeps the classifier's score and confidence", async () => {
	recordedClassifier(fixture("typesafe-readiness-stay.json"));
	const stay = await decide((await request({ questions: READINESS_QUESTIONS })).request);
	assert.deepEqual(stay.answers.reply_addresses_message, { type: "bool", value: false, probability: 0.22 });
	assert.equal(stay.answers.next_action.choice, "stay");
	vi.unstubAllGlobals();
	recordedClassifier(fixture("typesafe-score.json"));
	const scored = await decide(
		(
			await request({
				questions: {
					severity: { type: "score", instructions: "How severe?", criteria: ["none", "minor", "major"] },
				},
			})
		).request,
	);
	assert.deepEqual(scored.answers.severity, { type: "score", score: 1.6, confidence: 0.74 });
});

test("a chat decision model answers every question type without probabilities", async () => {
	const chat = vi.fn(() =>
		messageStream(decisionMessage({ next_action: "stay", reply_addresses_message: false, severity: 2 })),
	);
	const { request: decision } = await request(
		{
			questions: {
				...READINESS_QUESTIONS,
				severity: { type: "score", instructions: "How severe?", criteria: ["none", "minor", "major"] },
			},
		},
		chat,
		"",
	);
	const result = await decide(decision);
	assert.equal(result.source, "chat");
	assert.equal(result.model, "decision-test/chat");
	assert.deepEqual(result.answers, {
		next_action: { type: "choice", choice: "stay" },
		reply_addresses_message: { type: "bool", value: false },
		severity: { type: "score", score: 2 },
	});
	const [, context] = chat.mock.calls[0] as unknown as [unknown, Parameters<typeof parseInferenceUserPayload>[0]];
	assert.deepEqual(parseInferenceUserPayload(context).state, STATE);
});

test("a failed classifier falls back to the current chat model, which answers without probabilities", async () => {
	const transport = vi.fn(async () => new Response("unavailable", { status: 503 }));
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	vi.stubGlobal("fetch", transport);
	const { request: decision, chat } = await request({ questions: READINESS_QUESTIONS });
	const result = await decide(decision);
	assert.equal(result.source, "chat");
	assert.equal(result.model, "decision-test/chat");
	assert.deepEqual(result.fallback, {
		from: "typesafe/jev-latest",
		to: "decision-test/chat",
		reason: "Classifier returned no valid decision.",
	});
	assert.deepEqual(result.answers.next_action, { type: "choice", choice: "advance" });
	assert.equal(chat.mock.calls.length, 1);
});

test("requireProbabilities refuses a chat decision model before any request", async () => {
	const transport = vi.fn<typeof fetch>();
	vi.stubGlobal("fetch", transport);
	const { request: decision, chat } = await request(
		{ questions: READINESS_QUESTIONS, requireProbabilities: true },
		undefined,
		"",
	);
	await assert.rejects(decide(decision), (error: unknown) => {
		assert.ok(isDecisionModelUnavailableError(error));
		assert.equal(error.reason, "no-probabilities");
		assert.equal(error.model, "decision-test/chat");
		assert.equal(error.retryable, false);
		return true;
	});
	assert.equal(chat.mock.calls.length, 0);
	assert.equal(transport.mock.calls.length, 0);
});

test("requireProbabilities never falls back to chat: a failed classifier request is a provider failure", async () => {
	const transport = vi.fn(async () => new Response("unavailable", { status: 503 }));
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	vi.stubGlobal("fetch", transport);
	const { request: decision, chat } = await request({ questions: READINESS_QUESTIONS, requireProbabilities: true });
	await assert.rejects(decide(decision), (error: unknown) => {
		assert.ok(isDecisionProviderError(error));
		assert.equal(error.model, "typesafe/jev-latest");
		assert.equal(error.retryable, false);
		assert.equal(error.providerCode, undefined);
		assert.match(error.detail ?? "", /HTTP 503/);
		return true;
	});
	assert.equal(chat.mock.calls.length, 0);
});

test("a classifier rate limit is a retryable provider failure that keeps its status and retry hint", async () => {
	const transport = vi.fn(
		async () =>
			new Response(JSON.stringify({ error: { message: "slow down" } }), {
				status: 429,
				headers: { "retry-after": "7" },
			}),
	);
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	vi.stubGlobal("fetch", transport);
	const { request: decision } = await request({ questions: READINESS_QUESTIONS, requireProbabilities: true });
	const error = await decide(decision).then(
		() => undefined,
		(failure: unknown) => failure,
	);
	assert.ok(isDecisionProviderError(error));
	assert.equal(error.providerStatus, 429);
	assert.equal(error.providerCode, "rate_limit_exceeded");
	assert.equal(error.retryable, true);
	assert.equal(isRetryableDecisionError(new Error("wrapper", { cause: error })), true);
});

test("a classifier answer that misses a question is invalid output, not a provider failure", async () => {
	recordedClassifier(JSON.stringify({ model: "jev-latest", answers: { next_action: { type: "noul", noul: 0.5 } } }));
	const { request: decision } = await request({ questions: READINESS_QUESTIONS, requireProbabilities: true });
	await assert.rejects(decide(decision), (error: unknown) => {
		assert.ok(isDecisionProviderError(error) || isDecisionOutputError(error));
		return true;
	});
});

test("a chat answer that never satisfies the questions is invalid output after repairs", async () => {
	const chat = vi.fn(() => messageStream(decisionMessage({ next_action: "maybe", reply_addresses_message: true })));
	const { request: decision } = await request({ questions: READINESS_QUESTIONS }, chat, "");
	await assert.rejects(decide(decision), (error: unknown) => {
		assert.ok(isDecisionOutputError(error));
		assert.equal(error.model, "decision-test/chat");
		assert.match(error.detail ?? "", /repair exhausted after 4 attempts/);
		return true;
	});
	assert.equal(chat.mock.calls.length, 4);
});

test("an explicit model decides instead of decisionModel", async () => {
	const transport = vi.fn<typeof fetch>();
	vi.stubGlobal("fetch", transport);
	const { request: decision, chat } = await request({ questions: READINESS_QUESTIONS, model: "decision-test/chat" });
	const result = await decide(decision);
	assert.equal(result.model, "decision-test/chat");
	assert.equal(result.source, "chat");
	assert.equal(chat.mock.calls.length, 1);
	assert.equal(transport.mock.calls.length, 0);
});

test("the deadline bounds the whole decision and names the phase it stopped", async () => {
	const chat = vi.fn(() => createAssistantMessageEventStream());
	const { request: decision } = await request({ questions: READINESS_QUESTIONS, deadline: 30 }, chat, "");
	const started = Date.now();
	await assert.rejects(decide(decision), (error: unknown) => {
		assert.ok(isDecisionTimeoutError(error), String(error));
		assert.equal(error.timeoutMs, 30);
		assert.equal(error.phase, "chat");
		assert.equal(error.retryable, true);
		assert.ok(error.elapsedMs >= 25);
		return true;
	});
	assert.ok(Date.now() - started < 5_000);
});

test("cancellation rejects with the caller's reason, never a decision error", async () => {
	const controller = new AbortController();
	const reason = new Error("caller stopped");
	const chat = vi.fn(() => {
		controller.abort(reason);
		return createAssistantMessageEventStream();
	});
	const { request: decision } = await request({ questions: READINESS_QUESTIONS, signal: controller.signal }, chat, "");
	await assert.rejects(decide(decision), (error: unknown) => error === reason);
	const aborted = new AbortController();
	aborted.abort(reason);
	await assert.rejects(decide({ ...decision, signal: aborted.signal }), (error: unknown) => error === reason);
});

const INVALID_REQUESTS: ReadonlyArray<
	readonly [string, Partial<DecisionRequest<DecisionQuestions>>, string, DecisionRequestErrorReason]
> = [
	["empty state", { state: {} }, "state", "invalid-state"],
	["array state", { state: [] as unknown as DecisionRequest["state"] }, "state", "invalid-state"],
	["non-finite state", { state: { value: Number.NaN } }, "state", "invalid-state"],
	["credential in state", { state: { token: "Bearer abcdefghijklmnop" } }, "state", "credential-in-state"],
	["no questions", { questions: {} }, "questions", "no-questions"],
	[
		"choice without options",
		{ questions: { pick: { type: "choice", instructions: "Pick", criteria: {} } } },
		"questions.pick",
		"invalid-question",
	],
	[
		"bool without a meaning for false",
		{ questions: { yes: { type: "bool", instructions: "Yes?", criteria: { true: "yes", false: " " } } } },
		"questions.yes",
		"invalid-question",
	],
	[
		"score with one level",
		{ questions: { grade: { type: "score", instructions: "Grade", criteria: ["only"] } } },
		"questions.grade",
		"invalid-question",
	],
	[
		"question without instructions",
		{ questions: { pick: { type: "choice", instructions: "", criteria: { a: "A" } } } },
		"questions.pick",
		"invalid-question",
	],
	["blank instructions", { instructions: "  " }, "instructions", "invalid-instructions"],
	["zero deadline", { deadline: 0 }, "deadline", "invalid-deadline"],
	["fractional deadline", { deadline: 1.5 }, "deadline", "invalid-deadline"],
	["auto model", { model: "auto" }, "model", "invalid-model"],
	["untrimmed model", { model: " decision-test/chat" }, "model", "invalid-model"],
];

for (const [label, overrides, field, reason] of INVALID_REQUESTS) {
	test(`a request with ${label} is refused before any model is asked`, async () => {
		const transport = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", transport);
		const { request: decision, chat } = await request({ questions: READINESS_QUESTIONS });
		await assert.rejects(decide({ ...decision, ...overrides }), (error: unknown) => {
			assert.ok(isDecisionRequestError(error));
			assert.equal(error.field, field);
			assert.equal(error.reason, reason);
			assert.equal(error.code, "invalid-request");
			assert.equal(error.retryable, false);
			return true;
		});
		assert.equal(chat.mock.calls.length, 0);
		assert.equal(transport.mock.calls.length, 0);
	});
}

test("an unknown decisionModel and a missing chat model are unavailable, and an invalid one is a config error", async () => {
	const { request: decision } = await request({ questions: READINESS_QUESTIONS }, undefined, "missing/model");
	await assert.rejects(
		decide(decision),
		(error: unknown) =>
			isDecisionModelUnavailableError(error) && error.reason === "not-in-catalog" && error.model === "missing/model",
	);
	await assert.rejects(
		decide({ ...decision, settings: SettingsManager.inMemory(), currentModel: undefined }),
		(error: unknown) => isDecisionModelUnavailableError(error) && error.reason === "no-chat-model",
	);
	await assert.rejects(
		decide({ ...decision, settings: { getDecisionModel: () => " padded" } }),
		(error: unknown) =>
			isDecisionConfigError(error) && error.code === "invalid-setting" && error.source === "settings",
	);
});

const ERRORS: readonly DecisionError[] = [
	new DecisionConfigError({ code: "renamed-setting", source: "settings", field: "routerModel", scope: "project" }),
	new DecisionConfigError({ code: "invalid-setting", source: "sdk", field: "decisionModel" }),
	new DecisionRequestError({ field: "questions.pick", reason: "invalid-question" }),
	new DecisionModelUnavailableError({ reason: "not-in-catalog", model: "a/b" }),
	new DecisionTimeoutError({ timeoutMs: 100, elapsedMs: 101, phase: "classifier", attempts: "Attempts: 1)." }),
	new DecisionOutputError({ model: "a/b", detail: "no answer" }),
	new DecisionProviderError({
		model: "a/b",
		providerStatus: 429,
		providerCode: "rate_limit_exceeded",
		retryAfterMs: 5,
		detail: "rate limit",
	}),
	new DecisionProviderError({}, { cause: new DecisionTimeoutError({ timeoutMs: 1, elapsedMs: 1, phase: "chat" }) }),
];

for (const error of ERRORS) {
	test(`${error.name} (${error.code}) survives a process boundary with its class, fields and cause`, () => {
		const wire = JSON.parse(JSON.stringify(serializeDecisionError(error)));
		const restored = rehydrateDecisionError(wire);
		assert.equal(restored.constructor, error.constructor);
		assert.equal(restored.name, error.name);
		assert.equal(restored.code, error.code);
		assert.equal(restored.message, error.message);
		assert.equal(restored.hint, error.hint);
		assert.equal(restored.retryable, error.retryable);
		assert.deepEqual(restored.fields(), error.fields());
		assert.equal(isDecisionError(restored), true);
		assert.equal(isDecisionError({ ...wire }), true);
		if (error.cause !== undefined) {
			assert.equal((restored.cause as DecisionError).name, (error.cause as DecisionError).name);
			assert.deepEqual((restored.cause as DecisionError).fields(), (error.cause as DecisionError).fields());
		}
	});
}

test("guards recognize plain structural errors from another realm and reject other shapes", () => {
	const structural = (name: string, code: string) => ({ name, code, message: "m" });
	assert.equal(isDecisionConfigError(structural("DecisionConfigError", "renamed-setting")), true);
	assert.equal(isDecisionConfigError(structural("DecisionConfigError", "invalid-setting")), true);
	assert.equal(isDecisionConfigError(structural("DecisionConfigError", "timeout")), false);
	assert.equal(isDecisionRequestError(structural("DecisionRequestError", "invalid-request")), true);
	assert.equal(
		isDecisionModelUnavailableError(structural("DecisionModelUnavailableError", "model-unavailable")),
		true,
	);
	assert.equal(isDecisionTimeoutError(structural("DecisionTimeoutError", "timeout")), true);
	assert.equal(isDecisionOutputError(structural("DecisionOutputError", "invalid-output")), true);
	assert.equal(isDecisionProviderError(structural("DecisionProviderError", "provider-failure")), true);
	assert.equal(isDecisionProviderError(structural("DecisionProviderError", "timeout")), false);
	assert.equal(isDecisionError(structural("DecisionError", "timeout")), true);
	assert.equal(isDecisionError(structural("OtherError", "timeout")), false);
	assert.equal(isDecisionError(structural("DecisionError", "other")), false);
	assert.equal(isDecisionError({ name: "DecisionError" }), false);
	assert.equal(isDecisionError(null), false);
	assert.equal(isDecisionError("DecisionError"), false);
});

test("an unknown error name rehydrates into the family base keeping its name and code", () => {
	const restored = rehydrateDecisionError({
		name: "DecisionFutureError",
		code: "timeout",
		message: "later",
		hint: "wait",
		retryable: false,
		fields: {},
		cause: { name: "TypeError", message: "inner" },
	});
	assert.equal(restored.constructor, DecisionError);
	assert.equal(restored.name, "DecisionFutureError");
	assert.equal(restored.code, "timeout");
	assert.equal((restored.cause as Error).name, "TypeError");
	assert.equal((restored.cause as Error).message, "inner");
});

test("findDecisionError walks a bounded cause chain", () => {
	const inner = new DecisionOutputError({ model: "a/b" });
	assert.equal(findDecisionError(new Error("a", { cause: new Error("b", { cause: inner }) })), inner);
	let deep: Error = inner;
	for (let depth = 0; depth < 8; depth++) deep = new Error(`wrap ${depth}`, { cause: deep });
	assert.equal(findDecisionError(deep), undefined);
	assert.equal(findDecisionError(undefined), undefined);
	assert.equal(isRetryableDecisionError(new Error("plain")), false);
});

test("the renamed-setting error renders its message and hint once (UX contract)", () => {
	const error = new DecisionConfigError({
		code: "renamed-setting",
		source: "settings",
		field: "routerModel",
		scope: "global",
	});
	assert.equal(
		error.message,
		'Renamed setting: "routerModel" in global settings.json (renamed-setting). Rename "routerModel" to "decisionModel" in your global settings.json.',
	);
	assert.equal(error.hint, 'Rename "routerModel" to "decisionModel" in your global settings.json.');
});
