import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
	inferRouterDecision,
	inferStructuredOutput,
} from "../../packages/coding-agent/src/core/structured-output/index.js";
import { type JevFixtureRequest, jevFixtureResponse } from "../helpers/jev-tournament.js";
import { decisionMessage, decisionRequest, messageStream } from "../helpers/structured-output.js";

// TypeSafe Jev 1.13 documents 64k tokens per request and 32k tokens for
// state plus the longest question. The implementation has no Jev tokenizer, so
// these byte ceilings are deliberately below those token limits and include the
// actual JSON request fields sent to `/v1/systemone`.
const CONSERVATIVE_STATE_AND_QUESTION_BYTES = 30_000;
const CONSERVATIVE_STATE_AND_ALL_BYTES = 48_000;

function serializedJevBytes(body: string): { total: number; stateAndLongestQuestion: number } {
	const request = JSON.parse(body) as JevFixtureRequest & { model?: string };
	return {
		total: Buffer.byteLength(body, "utf8"),
		stateAndLongestQuestion: Math.max(
			...Object.entries(request.questions).map(([id, question]) =>
				Buffer.byteLength(
					JSON.stringify({ model: request.model, state: request.state, questions: { [id]: question } }),
					"utf8",
				),
			),
		),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

test("Jev partitions fewer than 255 verbose candidates before dispatch without losing candidates", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const seen = new Set<string>();
	const transport = vi.fn(async (_url: string, init: RequestInit) => {
		const request = JSON.parse(String(init.body)) as JevFixtureRequest;
		const size = serializedJevBytes(String(init.body));
		assert.ok(size.stateAndLongestQuestion <= CONSERVATIVE_STATE_AND_QUESTION_BYTES);
		assert.ok(size.total <= CONSERVATIVE_STATE_AND_ALL_BYTES);
		for (const question of Object.values(request.questions)) {
			for (const key of Object.keys(question.criteria)) seen.add(key);
		}
		return Response.json(jevFixtureResponse(request));
	});
	vi.stubGlobal("fetch", transport);
	const original = decisionRequest();
	const result = await inferRouterDecision({
		...original,
		settings: { getRouterModel: () => "typesafe-ai/jev-latest" },
		jev: {
			questions: {
				route: {
					instructions: "Pick the best route",
					criteria: Object.fromEntries(
						Array.from({ length: 100 }, (_, i) => [`c${i}`, "Relevant candidate detail. ".repeat(40)]),
					),
				},
			},
			decode: () => ({ route: "review" as const }),
		},
	});
	assert.deepEqual(result.value, { route: "review" });
	assert.equal(seen.size, 100);
	assert.ok(transport.mock.calls.length > 1);
});

for (const task of ["x".repeat(36_000), "界".repeat(11_000)]) {
	for (const pinned of [false, true]) {
		test(`oversized ${Buffer.byteLength(task) === task.length ? "ASCII" : "multibyte"} state is preserved for fallback, pinned=${pinned}`, async () => {
			vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const transport = vi.fn();
			vi.stubGlobal("fetch", transport);
			const original = decisionRequest();
			const chat = vi.fn((_model, context) => {
				assert.equal(JSON.parse(context.messages[0].content).state.task, task);
				return messageStream(decisionMessage());
			});
			const request = {
				...original,
				state: { task },
				settings: { getRouterModel: () => (pinned ? "typesafe-ai/jev-latest" : "") },
				modelRegistry: { ...original.modelRegistry, streamSimple: chat },
			};
			// #3206: the pinned Jev context overflow falls back to chat too.
			const result = await inferRouterDecision(request);
			assert.equal(result.fallback?.to, "decision-test/chat");
			assert.match(result.fallback?.reason ?? "", /conservative input budget/);
			assert.equal(transport.mock.calls.length, 0);
			assert.equal(chat.mock.calls.length, 1);
			await assert.rejects(
				inferStructuredOutput({ ...request, model: { kind: "jev", fullId: "typesafe-ai/jev-latest" } }),
				/conservative input budget/,
			);
			assert.equal(chat.mock.calls.length, 1);
		});
	}
}

test("independent small questions are packed against the aggregate budget", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const original = decisionRequest();
	const seen = new Set<string>();
	const transport = vi.fn(async (_url: string, init: RequestInit) => {
		const body = String(init.body);
		const size = serializedJevBytes(body);
		assert.ok(size.total <= CONSERVATIVE_STATE_AND_ALL_BYTES);
		assert.ok(size.stateAndLongestQuestion <= CONSERVATIVE_STATE_AND_QUESTION_BYTES);
		const request = JSON.parse(body) as JevFixtureRequest;
		for (const id of Object.keys(request.questions)) seen.add(id);
		return Response.json(jevFixtureResponse(request));
	});
	vi.stubGlobal("fetch", transport);
	await inferRouterDecision({
		...original,
		settings: { getRouterModel: () => "typesafe-ai/jev-latest" },
		jev: {
			questions: Object.fromEntries(
				Array.from({ length: 12 }, (_, i) => [
					`q${i}`,
					{ instructions: "Assess this property", criteria: { yes: "detail ".repeat(1000), no: "not present" } },
				]),
			),
			decode: () => ({ route: "review" as const }),
		},
	});
	assert.equal(seen.size, 12);
	assert.ok(transport.mock.calls.length > 1);
});

test("a finalist context overflow preserves spent Jev usage and original candidates in chat fallback", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const original = decisionRequest();
	const criteria = Object.fromEntries(
		Array.from({ length: 8 }, (_, i) => [`c${i}`, i === 3 || i === 4 ? "short" : "x".repeat(7_500)]),
	);
	const transport = vi.fn(async (_url: string, init: RequestInit) =>
		Response.json(jevFixtureResponse(JSON.parse(String(init.body)) as JevFixtureRequest)),
	);
	vi.stubGlobal("fetch", transport);
	const chat = vi.fn((_model, context) => {
		assert.deepEqual(JSON.parse(context.messages[0].content).questions.route.criteria, criteria);
		return messageStream(decisionMessage());
	});
	const result = await inferRouterDecision({
		...original,
		settings: { getRouterModel: () => "" },
		modelRegistry: { ...original.modelRegistry, streamSimple: chat },
		jev: {
			questions: { route: { instructions: "Pick a route", criteria } },
			decode: () => ({ route: "review" as const }),
		},
	});
	assert.equal(transport.mock.calls.length, 1);
	assert.equal(chat.mock.calls.length, 1);
	assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 20 });
	assert.match(result.fallback?.reason ?? "", /conservative input budget/);
	assert.doesNotMatch(result.fallback?.reason ?? "", /not sent|no .*request|not truncated/i);
});

test("automatic Jev with no current chat fails closed on oversized state", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	await assert.rejects(
		inferRouterDecision({
			...decisionRequest(),
			currentModel: undefined,
			settings: { getRouterModel: () => "" },
			state: { task: "x".repeat(30_000) },
		}),
		/conservative input budget/,
	);
	assert.equal(transport.mock.calls.length, 0);
});

// PR #3129: four candidates fit even when five exceed the budget.
for (const pinned of [true, false]) {
	test(`four-candidate batches finish without chat fallback, pinned=${pinned}`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
		const seen = new Set<string>();
		const transport = vi.fn(async (_url: string, init: RequestInit) => {
			const request = JSON.parse(String(init.body)) as JevFixtureRequest;
			for (const question of Object.values(request.questions)) {
				assert.ok(Object.keys(question.criteria).length <= 4);
				for (const key of Object.keys(question.criteria)) seen.add(key);
			}
			return Response.json(jevFixtureResponse(request));
		});
		vi.stubGlobal("fetch", transport);
		const result = await inferRouterDecision({
			...decisionRequest(),
			settings: { getRouterModel: () => (pinned ? "typesafe-ai/jev-latest" : "") },
			jev: {
				questions: {
					route: {
						instructions: "Choose a route",
						criteria: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`c${i}`, "x".repeat(6_400)])),
					},
				},
				decode: () => ({ route: "review" as const }),
			},
		});
		assert.equal(result.fallback, undefined);
		assert.equal(seen.size, 5);
		assert.equal(transport.mock.calls.length, 2);
	});
}

test("a retained sentinel cannot cause a four-candidate tournament to repeat forever", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const transport = vi.fn(async (_url: string, init: RequestInit) =>
		Response.json(jevFixtureResponse(JSON.parse(String(init.body)) as JevFixtureRequest)),
	);
	vi.stubGlobal("fetch", transport);
	const result = await inferRouterDecision({
		...decisionRequest(),
		modelRegistry: { ...decisionRequest().modelRegistry, streamSimple: () => messageStream(decisionMessage()) },
		settings: { getRouterModel: () => "" },
		jev: {
			questions: {
				route: {
					instructions: "Choose a route",
					retainForFinal: "c3",
					criteria: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`c${i}`, "x".repeat(6_400)])),
				},
			},
			decode: () => ({ route: "review" as const }),
		},
	});
	assert.equal(transport.mock.calls.length, 1);
	assert.equal(result.fallback?.to, "decision-test/chat");
	assert.match(result.fallback?.reason ?? "", /conservative input budget/);
});
