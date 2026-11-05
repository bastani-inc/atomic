import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@bastani/pi-ai";
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
	inferenceRequestTools,
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
	assert.deepEqual(
		(requests[0]!.body.questions.reply_addresses_message as { type: string; criteria: object }).criteria,
		{ true: "It does.", false: "It does not." },
	);
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
		assert.ok(error.cause instanceof Error);
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
		assert.ok(error.cause instanceof Error);
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
		assert.ok(error.elapsedMs >= 25 && error.elapsedMs < 5_000);
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

type ScreeningRegistry = DecisionRequest["modelRegistry"];

function screening(registry: ScreeningRegistry, screen: (text: string) => Promise<boolean>): ScreeningRegistry {
	return Object.assign(Object.create(registry) as ScreeningRegistry, { containsConfiguredCredential: screen });
}

async function pendingScreen(overrides: Partial<DecisionRequest<typeof READINESS_QUESTIONS>> = {}) {
	const transport = vi.fn<typeof fetch>();
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	vi.stubGlobal("fetch", transport);
	const { request: decision, chat } = await request({ questions: READINESS_QUESTIONS, ...overrides });
	const screen = vi.fn((_text: string) => new Promise<boolean>(() => {}));
	return {
		transport,
		chat,
		screen,
		decision: { ...decision, modelRegistry: screening(decision.modelRegistry, screen) },
	};
}

test("screening state for configured credentials counts against the deadline, before any model is asked (#4358)", async () => {
	vi.useFakeTimers();
	const { transport, chat, screen, decision } = await pendingScreen({ deadline: 20 });
	const outcome = decide(decision).then(
		() => undefined,
		(error: unknown) => error,
	);
	await vi.advanceTimersByTimeAsync(20);
	const error = await outcome;
	assert.ok(isDecisionTimeoutError(error), String(error));
	assert.equal(error.timeoutMs, 20);
	assert.equal(error.phase, "resolve");
	assert.deepEqual(screen.mock.calls, [[JSON.stringify(STATE)]]);
	assert.equal(transport.mock.calls.length, 0);
	assert.equal(chat.mock.calls.length, 0);
});

test("cancelling while configured credentials are screened rejects with the caller's reason", async () => {
	const controller = new AbortController();
	const reason = new Error("paused");
	const { transport, chat, screen, decision } = await pendingScreen({ signal: controller.signal });
	const outcome = decide(decision);
	await vi.waitFor(() => assert.equal(screen.mock.calls.length, 1));
	controller.abort(reason);
	await assert.rejects(outcome, (error: unknown) => error === reason);
	assert.equal(transport.mock.calls.length, 0);
	assert.equal(chat.mock.calls.length, 0);
});

test("state without configured credentials is screened once before the model answers (#4358)", async () => {
	const { requests } = recordedClassifier(fixture("typesafe-readiness-advance.json"));
	const { request: decision, chat } = await request({ questions: READINESS_QUESTIONS });
	const screen = vi.fn(async (_text: string) => false);
	const result = await decide({ ...decision, modelRegistry: screening(decision.modelRegistry, screen) });
	assert.equal(result.source, "classifier");
	assert.equal(result.answers.next_action.choice, "advance");
	assert.deepEqual(screen.mock.calls, [[JSON.stringify(STATE)]]);
	assert.equal(requests.length, 1);
	assert.equal(chat.mock.calls.length, 0);
});

test("state changed by the caller while credentials are screened never reaches the model (#4358)", async () => {
	const { requests } = recordedClassifier(fixture("typesafe-readiness-advance.json"));
	const { request: decision } = await request({ questions: READINESS_QUESTIONS });
	const shared = { ...STATE };
	let release: (found: boolean) => void = () => {};
	const screen = vi.fn((_text: string) => new Promise<boolean>((resolve) => (release = resolve)));
	const outcome = decide({ ...decision, state: shared, modelRegistry: screening(decision.modelRegistry, screen) });
	await vi.waitFor(() => assert.equal(screen.mock.calls.length, 1));
	shared.user_message = "Bearer sk-abcdefghijklmnopqrstuvwxyz";
	release(false);
	await outcome;
	assert.deepEqual(screen.mock.calls, [[JSON.stringify(STATE)]]);
	assert.equal(requests.length, 1);
	assert.deepEqual(requests[0]!.body.state, STATE);
	assert.ok(!JSON.stringify(requests[0]).includes("Bearer"));
});

test("questions changed by the caller while credentials are screened keep the asked types in the answers (#4358)", async () => {
	const { requests } = recordedClassifier(fixture("typesafe-readiness-advance.json"));
	const { request: decision } = await request({ questions: READINESS_QUESTIONS });
	const shared = structuredClone(READINESS_QUESTIONS);
	let release: (found: boolean) => void = () => {};
	const screen = vi.fn((_text: string) => new Promise<boolean>((resolve) => (release = resolve)));
	const outcome = decide({ ...decision, questions: shared, modelRegistry: screening(decision.modelRegistry, screen) });
	await vi.waitFor(() => assert.equal(screen.mock.calls.length, 1));
	Object.assign(shared.reply_addresses_message, { type: "score", criteria: ["Not at all.", "Fully."] });
	Object.assign(shared.next_action, { type: "bool", criteria: { true: "Move on.", false: "Stay." } });
	release(false);
	const result = await outcome;
	assert.equal(requests.length, 1);
	assert.equal((requests[0]!.body.questions.reply_addresses_message as { type: string }).type, "noul");
	assert.deepEqual(result.answers.reply_addresses_message, { type: "bool", value: true, probability: 0.91 });
	assert.deepEqual(result.answers.next_action, {
		type: "choice",
		choice: "advance",
		probabilities: { advance: 0.93, stay: 0.07 },
		confidence: 0.93,
	});
});

test("state with a configured credential, or a failed screen, is refused before any model is asked", async () => {
	const { transport, chat, decision } = await pendingScreen();
	await assert.rejects(
		decide({ ...decision, modelRegistry: screening(decision.modelRegistry, async () => true) }),
		(error: unknown) =>
			isDecisionRequestError(error) && error.field === "state" && error.reason === "credential-in-state",
	);
	const failure = new Error("credential store unavailable");
	await assert.rejects(
		decide({
			...decision,
			modelRegistry: screening(decision.modelRegistry, async () => {
				throw failure;
			}),
		}),
		(error: unknown) => {
			assert.ok(isDecisionProviderError(error), String(error));
			assert.equal(error.cause, failure);
			assert.equal(error.detail, "configured-credential screening failed before any model was asked");
			assert.doesNotMatch(error.message, /credential store unavailable/);
			return true;
		},
	);
	assert.equal(transport.mock.calls.length, 0);
	assert.equal(chat.mock.calls.length, 0);
});

const cyclic: Record<string, unknown> = { a: 1 };
cyclic.self = cyclic;
const asQuestions = (value: unknown) => value as DecisionQuestions;
const asState = (value: unknown) => value as DecisionRequest["state"];

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
	["empty model", { model: "" }, "model", "invalid-model"],
	["non-string model", { model: 7 as unknown as string }, "model", "invalid-model"],
	["null state", { state: asState(null) }, "state", "invalid-state"],
	["text state", { state: asState("state") }, "state", "invalid-state"],
	["cyclic state", { state: asState(cyclic) }, "state", "invalid-state"],
	["infinite number", { state: { value: Number.POSITIVE_INFINITY } }, "state", "invalid-state"],
	["undefined value", { state: asState({ value: undefined }) }, "state", "invalid-state"],
	["function value", { state: asState({ value: () => 1 }) }, "state", "invalid-state"],
	["class instance", { state: asState({ when: new Date(0) }) }, "state", "invalid-state"],
	["one invalid value among valid ones", { state: { ok: "yes", bad: Number.NaN } }, "state", "invalid-state"],
	["two-space bearer token", { state: { header: "Bearer  abcdefgh" } }, "state", "credential-in-state"],
	["private key", { state: { key: "-----BEGIN PRIVATE KEY-----" } }, "state", "credential-in-state"],
	["RSA private key", { state: { key: "-----BEGIN RSA PRIVATE KEY-----" } }, "state", "credential-in-state"],
	["GitHub token", { state: { token: "ghp_abcdefghijklmnop" } }, "state", "credential-in-state"],
	["fine-grained token", { state: { token: "github_pat_abcdefghijklmnop" } }, "state", "credential-in-state"],
	["secret key", { state: { token: "sk-abcdefghijklmnop" } }, "state", "credential-in-state"],
	["null questions", { questions: asQuestions(null) }, "questions", "no-questions"],
	["text questions", { questions: asQuestions("questions") }, "questions", "no-questions"],
	[
		"a blank question ID",
		{ questions: { " ": { type: "choice", instructions: "Pick", criteria: { a: "A" } } } },
		"questions. ",
		"invalid-question",
	],
	["a null question", { questions: asQuestions({ pick: null }) }, "questions.pick", "invalid-question"],
	[
		"an unknown question type",
		{ questions: asQuestions({ pick: { type: "multi", instructions: "Pick", criteria: { a: "A" } } }) },
		"questions.pick",
		"invalid-question",
	],
	[
		"choice with null criteria",
		{ questions: asQuestions({ pick: { type: "choice", instructions: "Pick", criteria: null } }) },
		"questions.pick",
		"invalid-question",
	],
	[
		"choice with text criteria",
		{ questions: asQuestions({ pick: { type: "choice", instructions: "Pick", criteria: "a" } }) },
		"questions.pick",
		"invalid-question",
	],
	[
		"choice with a blank option key",
		{ questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "A", " ": "Blank" } } } },
		"questions.pick",
		"invalid-question",
	],
	[
		"choice with an undescribed option",
		{ questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "A", b: " " } } } },
		"questions.pick",
		"invalid-question",
	],
	[
		"bool without criteria",
		{ questions: asQuestions({ yes: { type: "bool", instructions: "Yes?" } }) },
		"questions.yes",
		"invalid-question",
	],
	[
		"bool without a meaning for true",
		{ questions: { yes: { type: "bool", instructions: "Yes?", criteria: { true: "", false: "no" } } } },
		"questions.yes",
		"invalid-question",
	],
	[
		"score without a level list",
		{ questions: asQuestions({ grade: { type: "score", instructions: "Grade", criteria: "low" } }) },
		"questions.grade",
		"invalid-question",
	],
	[
		"score with a blank level",
		{ questions: { grade: { type: "score", instructions: "Grade", criteria: ["low", " ", "high"] } } },
		"questions.grade",
		"invalid-question",
	],
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

test("valid unusual state is accepted: shared references, null prototypes, nested arrays and short bearer text", async () => {
	const shared = { label: "same" };
	const bare = Object.assign(Object.create(null) as Record<string, string>, { key: "value" });
	const chat = vi.fn(() => messageStream(decisionMessage({ next_action: "stay", reply_addresses_message: true })));
	const { request: decision } = await request({ questions: READINESS_QUESTIONS }, chat, "");
	for (const state of [
		{ first: shared, second: shared },
		{ bare },
		{
			rows: [
				[1, 2],
				[null, true],
			],
		},
		{ header: "Bearer abc" },
		{ note: "sk-short" },
	]) {
		const result = await decide({ ...decision, state: state as unknown as DecisionRequest["state"] });
		assert.equal(result.answers.next_action.choice, "stay");
	}
	assert.equal(chat.mock.calls.length, 5);
});

test("the chat model receives one described schema property per question", async () => {
	const chat = vi.fn(() =>
		messageStream(decisionMessage({ next_action: "advance", reply_addresses_message: true, severity: 2 })),
	);
	const { request: decision } = await request(
		{
			questions: {
				...READINESS_QUESTIONS,
				severity: { type: "score", instructions: "How severe?", criteria: ["none", "minor", "major"] },
			},
			instructions: "Judge the reply.",
		},
		chat,
		"",
	);
	const result = await decide(decision);
	assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10 });
	const [, context] = chat.mock.calls[0] as unknown as [unknown, Parameters<typeof inferenceRequestTools>[0]];
	const parameters = (
		inferenceRequestTools(context)[0] as unknown as {
			parameters: { properties: Record<string, object>; additionalProperties?: boolean };
		}
	).parameters;
	assert.equal(parameters.additionalProperties, false);
	assert.deepEqual(parameters?.properties, {
		next_action: {
			type: "string",
			enum: ["advance", "stay"],
			description: "Move on or stay? advance: Move on to the next stage.; stay: Keep this stage open..",
		},
		reply_addresses_message: {
			type: "boolean",
			description: "Does the reply fully address the user's message? true: It does.; false: It does not..",
		},
		severity: {
			type: "integer",
			minimum: 0,
			maximum: 2,
			description: "How severe? 0: none; 1: minor; 2: major.",
		},
	});
	assert.match(String(getCurrentSystemPrompt(context.messages as never)), /Judge the reply\./);
	const defaults = await decide({ ...decision, instructions: undefined });
	assert.equal(defaults.source, "chat");
	const [, defaultContext] = chat.mock.calls[1] as unknown as [unknown, Parameters<typeof inferenceRequestTools>[0]];
	assert.match(
		String(getCurrentSystemPrompt(defaultContext.messages as never)),
		/Answer each question about `state`\./,
	);
});

test("a yes probability of exactly one half answers yes, and the classifier's own answers are kept", async () => {
	recordedClassifier(
		JSON.stringify({
			model: "jev-latest",
			answers: {
				next_action: {
					type: "choice",
					choice: "stay",
					probabilities: { advance: 0.4, stay: 0.6 },
					confidence: 0.6,
				},
				reply_addresses_message: { type: "noul", noul: 0.5 },
			},
		}),
	);
	const result = await decide((await request({ questions: READINESS_QUESTIONS })).request);
	assert.deepEqual(result.answers.reply_addresses_message, { type: "bool", value: true, probability: 0.5 });
});

test("a classifier answer of the wrong type is invalid output when only a classifier may answer", async () => {
	const { registry } = await registeredDecisionRuntime(vi.fn());
	const classifier = registry.getClassifierModel("typesafe", "jev-latest");
	assert.ok(classifier);
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	for (const answers of [
		{ next_action: { type: "bool", probability: 0.9 }, reply_addresses_message: { type: "bool", probability: 0.9 } },
		{
			next_action: { type: "choice", choice: "advance", probabilities: {}, confidence: 1 },
			reply_addresses_message: { type: "choice", choice: "true", probabilities: {}, confidence: 1 },
		},
		{
			next_action: { type: "choice", choice: "advance", probabilities: {}, confidence: 1 },
			reply_addresses_message: { type: "bool", probability: Number.NaN },
		},
	]) {
		const classify = vi.fn(async () => ({
			api: classifier.api,
			provider: classifier.provider,
			model: "jev-latest",
			answers,
			stopReason: "stop" as const,
			timestamp: 1,
		}));
		await assert.rejects(
			decide({
				state: STATE,
				questions: READINESS_QUESTIONS,
				requireProbabilities: true,
				settings: SettingsManager.inMemory({ decisionModel: "typesafe/jev-latest" }),
				modelRegistry: {
					getAll: () => [decisionChatModel],
					streamSimple: vi.fn(),
					getClassifierModel: () => classifier,
					classify: classify as never,
				},
				currentModel: decisionChatModel,
				retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
			}),
			(error: unknown) =>
				isDecisionOutputError(error) &&
				error.model === "typesafe/jev-latest" &&
				error.detail === "Classifier returned no valid decision.",
		);
	}
	const scored = vi.fn(async () => ({
		api: classifier.api,
		provider: classifier.provider,
		model: "jev-latest",
		answers: { severity: { type: "score", score: Number.POSITIVE_INFINITY, confidence: 1 } },
		stopReason: "stop" as const,
		timestamp: 1,
	}));
	await assert.rejects(
		decide({
			state: STATE,
			questions: { severity: { type: "score", instructions: "How severe?", criteria: ["low", "high"] } },
			requireProbabilities: true,
			settings: SettingsManager.inMemory({ decisionModel: "typesafe/jev-latest" }),
			modelRegistry: {
				getAll: () => [decisionChatModel],
				streamSimple: vi.fn(),
				getClassifierModel: () => classifier,
				classify: scored as never,
			},
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
		}),
		(error: unknown) => isDecisionOutputError(error),
	);
});

test("the deadline defaults to the httpIdleTimeoutMs setting, and retry settings reach the request", async () => {
	const chat = vi.fn(() => createAssistantMessageEventStream());
	const { request: decision } = await request({ questions: READINESS_QUESTIONS }, chat, "");
	const settings = SettingsManager.inMemory({ decisionModel: "" });
	settings.getHttpIdleTimeoutMs = () => 25;
	await assert.rejects(
		decide({ ...decision, settings }),
		(error: unknown) => isDecisionTimeoutError(error) && error.timeoutMs === 25,
	);
	const failing = vi.fn(() => {
		throw new Error("connection refused");
	});
	const { request: retried } = await request({ questions: READINESS_QUESTIONS }, failing as never, "");
	const retrySettings = SettingsManager.inMemory({
		decisionModel: "",
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
	});
	await assert.rejects(decide({ ...retried, settings: retrySettings, retry: undefined }), (error: unknown) =>
		isDecisionProviderError(error),
	);
	assert.equal(failing.mock.calls.length, 2);
});

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
			isDecisionConfigError(error) &&
			error.code === "invalid-setting" &&
			error.source === "settings" &&
			error.field === "decisionModel",
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

test("serialization cannot introduce unchecked credentials or hide a snapshot failure (#4358)", async () => {
	for (const mode of ["credential", "failure"] as const) {
		const credential = `Bearer sk-${"s".repeat(32)}`;
		const failure = new Error("snapshot getter failed");
		let reads = 0;
		const state = {
			get message() {
				reads += 1;
				if (reads <= 2) return "ordinary state";
				if (mode === "failure") throw failure;
				return credential;
			},
		};
		const { requests } = recordedClassifier(fixture("typesafe-readiness-advance.json"));
		const { request: decision, chat } = await request({ questions: READINESS_QUESTIONS, state });
		await decide(decision).then(
			(result) => assert.equal(result.answers.next_action.choice, "advance"),
			(error: unknown) => {
				assert.ok(isDecisionRequestError(error));
				assert.equal(error.field, "state");
				assert.equal(error.reason, mode === "failure" ? "invalid-state" : "credential-in-state");
				if (mode === "failure") assert.equal(error.cause, failure);
			},
		);
		for (const sent of requests) assert.doesNotMatch(JSON.stringify(sent.body.state), /Bearer/);
		assert.equal(chat.mock.calls.length, 0);
	}
});
