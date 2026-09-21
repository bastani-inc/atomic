// #3090 / #3089: shared Jev overflow routing through the public decision API and fake HTTP transport.
import assert from "node:assert/strict";
import { Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { inferRouterDecision } from "../../packages/coding-agent/src/core/structured-output/index.js";
import { type JevFixtureRequest, jevFixtureResponse } from "../helpers/jev-tournament.js";
import { decisionRequest } from "../helpers/structured-output.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("small Jev questions reject oversized unchanged state before dispatch", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	const request = tournament(2);
	const state = { text: "x".repeat(128000) };
	const questions = { workflow: request.jev.questions.pick, budget: request.jev.questions.pick };
	const calls: JevFixtureRequest[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as JevFixtureRequest;
		calls.push(body);
		return Response.json(jevFixtureResponse(body));
	});
	await assert.rejects(
		inferRouterDecision({ ...request, state, jev: { ...request.jev, questions } }),
		/conservative input budget/,
	);
	assert.equal(calls.length, 0);
});

test("singleton Jev decoder receives an ordinary object", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) =>
		Response.json(jevFixtureResponse(JSON.parse(String(init.body)))),
	);
	const request = tournament(1);
	await inferRouterDecision({
		...request,
		jev: {
			...request.jev,
			decode: (choices) => {
				const ownMethod: unknown = Reflect.get(choices, "hasOwnProperty");
				assert.ok(typeof ownMethod === "function");
				assert.equal(ownMethod.call(choices, "pick"), true);
				assert.equal(Object.getPrototypeOf(choices), Object.prototype);
				return { ...choices };
			},
		},
	});
});

test("mixed Jev decoder preserves original question order and unusual keys", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) =>
		Response.json(jevFixtureResponse(JSON.parse(String(init.body)))),
	);
	const request = tournament(256);
	const criteria = Object.fromEntries([
		["__proto__", "Prototype"],
		["constructor", "Constructor"],
		["hasOwnProperty", "Own"],
		...Object.entries(request.jev.questions.pick.criteria),
	]);
	const questions = Object.fromEntries([
		["large", { instructions: "Choose", criteria }],
		["__proto__", { instructions: "Choose", criteria: { constructor: "Constructor" } }],
	]);
	const result = await inferRouterDecision({
		...request,
		jev: {
			questions,
			decode: (choices) => {
				assert.deepEqual(Object.keys(choices), Object.keys(questions));
				assert.equal(Object.getPrototypeOf(choices), Object.prototype);
				return { ...choices };
			},
		},
	});
	assert.equal(result.value.large, "__proto__");
	assert.equal(Object.getOwnPropertyDescriptor(result.value, "__proto__")?.value, "constructor");
});

test("Jev routes all 1997 original options through bounded batches and a shared final", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	const criteria = Object.fromEntries(Array.from({ length: 1997 }, (_, i) => [`key_${i}`, `Candidate ${i}`]));
	const calls: string[][][] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { questions: Record<string, { criteria: Record<string, string> }> };
		calls.push(Object.values(body.questions).map((q) => Object.keys(q.criteria)));
		return Response.json({
			model: "jev-test",
			usage: { input_tokens: 20, output_tokens: 10 },
			answers: Object.fromEntries(
				Object.entries(body.questions).map(([id, q]) => {
					const keys = Object.keys(q.criteria);
					assert.ok(keys.length <= 255);
					return [
						id,
						{
							type: "choice",
							choice: keys[0],
							confidence: 1,
							probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])),
						},
					];
				}),
			),
		});
	});
	const result = await inferRouterDecision({
		...decisionRequest(),
		settings: { getRouterModel: () => "typesafe-ai/jev-latest" },
		schema: Type.Object({ picked: Type.String() }),
		jev: {
			questions: { pick: { instructions: "Select a candidate", criteria } },
			decode: (choices) => ({ picked: choices.pick }),
		},
	});
	assert.equal(result.value.picked, "key_0");
	assert.deepEqual(calls.slice(0, -1).flat(2), Object.keys(criteria));
	assert.deepEqual(
		calls.at(-1)?.flat(),
		Array.from({ length: 8 }, (_, i) => [0, 1, 2].map((j) => `key_${i * 255 + j}`)).flat(),
	);
	assert.deepEqual(result.usage, { inputTokens: calls.length * 20, outputTokens: calls.length * 10 });
	assert.ok(calls.length >= 2);
});

test("mixed named questions cannot collide with tournament IDs", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`key_${i}`, `Candidate ${i}`]));
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const { questions } = JSON.parse(String(init.body)) as {
			questions: Record<string, { criteria: Record<string, string> }>;
		};
		return Response.json({
			model: "jev-test",
			usage: { input_tokens: 1, output_tokens: 1 },
			answers: Object.fromEntries(
				Object.entries(questions).map(([id, q]) => {
					const keys = Object.keys(q.criteria);
					return [
						id,
						{
							type: "choice",
							choice: keys[0],
							confidence: 1,
							probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])),
						},
					];
				}),
			),
		});
	});
	const result = await inferRouterDecision({
		...decisionRequest(),
		settings: { getRouterModel: () => "typesafe-ai/jev-latest" },
		schema: Type.Record(Type.String(), Type.String()),
		jev: {
			questions: {
				large: { instructions: "Select", criteria },
				q0: { instructions: "Preserve", criteria: { preserve: "Preserve budget" } },
			},
			decode: (choices) => ({ ...choices }),
		},
	});
	assert.deepEqual(result.value, { large: "key_0", q0: "preserve" });
});

test("retained final option participates originally but does not replace batch top three", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`key_${i}`, `Candidate ${i}`]));
	const calls: string[][][] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const { questions } = JSON.parse(String(init.body)) as {
			questions: Record<string, { criteria: Record<string, string> }>;
		};
		calls.push(Object.values(questions).map((q) => Object.keys(q.criteria)));
		return Response.json({
			model: "jev-test",
			usage: { input_tokens: 1, output_tokens: 1 },
			answers: Object.fromEntries(
				Object.entries(questions).map(([id, q]) => {
					const keys = Object.keys(q.criteria);
					const winner = calls.length === 1 ? keys[0] : "key_200";
					return [
						id,
						{
							type: "choice",
							choice: winner,
							confidence: 1,
							probabilities: Object.fromEntries(keys.map((k) => [k, k === winner ? 1 : 0])),
						},
					];
				}),
			),
		});
	});
	const result = await inferRouterDecision({
		...decisionRequest(),
		settings: { getRouterModel: () => "typesafe-ai/jev-latest" },
		schema: Type.Record(Type.String(), Type.String()),
		jev: {
			questions: { pick: { instructions: "Select", criteria, retainForFinal: "key_200" } },
			decode: (choices) => ({ ...choices }),
		},
	});
	assert.equal(result.value.pick, "key_200");
	assert.deepEqual(calls[0].flat(), Object.keys(criteria));
	assert.deepEqual(calls[1].flat(), ["key_0", "key_1", "key_2", "key_200", "key_255"]);
});

function tournament(count: number) {
	const criteria = Object.fromEntries(Array.from({ length: count }, (_, i) => [`key_${i}`, `Candidate ${i}`]));
	return {
		...decisionRequest(),
		settings: { getRouterModel: () => "typesafe-ai/jev-latest" },
		schema: Type.Record(Type.String(), Type.String()),
		jev: {
			questions: { pick: { instructions: "Select", criteria } },
			decode: vi.fn((choices: Readonly<Record<string, string>>) => ({ ...choices })),
		},
	};
}

for (const count of [0, 1, 255, 256, 22000]) {
	test(`Jev ${count} candidates terminate without dropping first-round participants`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
		const request = tournament(count);
		const calls: JevFixtureRequest[] = [];
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as JevFixtureRequest;
			calls.push(body);
			for (const q of Object.values(body.questions)) assert.ok(Object.keys(q.criteria).length <= 255);
			return Response.json(jevFixtureResponse(body));
		});
		if (!count) {
			await assert.rejects(inferRouterDecision(request), /nonempty/);
			assert.equal(calls.length, 0);
			return;
		}
		assert.equal((await inferRouterDecision(request)).value.pick, "key_0");
		const seen = new Set(
			calls.flatMap((call) => Object.values(call.questions).flatMap((q) => Object.keys(q.criteria))),
		);
		assert.deepEqual([...seen], Object.keys(request.jev.questions.pick.criteria));
		assert.ok(calls.length >= (count <= 255 ? 1 : count <= 1997 ? 2 : 3));
		assert.ok(calls.length <= Math.ceil(count / 255) + 3);
		assert.equal(request.jev.decode.mock.calls.length, 1);
	});
}

test("invalid retained key rejects before transport", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	const request = tournament(256);
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await assert.rejects(
		inferRouterDecision({
			...request,
			jev: { ...request.jev, questions: { pick: { ...request.jev.questions.pick, retainForFinal: "absent" } } },
		}),
		/retainForFinal/,
	);
	assert.equal(fetch.mock.calls.length, 0);
});

for (const failure of [
	"missing",
	"extra",
	"negative",
	"nonfinite",
	"winner",
	"missing-answer",
	"extra-answer",
	"http",
] as const) {
	test(`overflow ${failure} fails without partial decode after bounded output repair`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
		const request = tournament(256);
		const fetch = vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as JevFixtureRequest;
			const response = jevFixtureResponse(body);
			const answer = Object.values(response.answers)[0]!;
			const key = Object.keys(answer.probabilities)[0]!;
			if (failure === "missing") delete answer.probabilities[key];
			if (failure === "extra") answer.probabilities.absent = 0;
			if (failure === "negative") answer.probabilities[key] = -1;
			if (failure === "nonfinite") answer.probabilities[key] = NaN;
			if (failure === "winner") answer.choice = "absent";
			if (failure === "missing-answer") delete response.answers[Object.keys(response.answers)[0]!];
			if (failure === "extra-answer") response.answers.absent = answer;
			return failure === "http" ? new Response("private", { status: 422 }) : Response.json(response);
		});
		vi.stubGlobal("fetch", fetch);
		await assert.rejects(inferRouterDecision(request), /Malformed|HTTP 422/);
		assert.equal(fetch.mock.calls.length, failure === "http" ? 1 : 4);
		assert.equal(request.jev.decode.mock.calls.length, 0);
	});
}

for (const failure of ["cancel-before", "cancel-between", "cancel-pending", "provider"] as const) {
	test(`overflow ${failure} rejects the whole operation`, async () => {
		vi.useFakeTimers();
		vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
		const request = tournament(256);
		const controller = new AbortController();
		if (failure === "cancel-before") controller.abort();
		const fetch = vi.fn(async (_url: string, init: RequestInit) => {
			if (fetch.mock.calls.length === 2) {
				if (failure === "provider") return new Response("private", { status: 529 });
				return new Promise<Response>(() => {});
			}
			const body = JSON.parse(String(init.body)) as JevFixtureRequest;
			if (failure === "cancel-between") controller.abort();
			return Response.json(jevFixtureResponse(body));
		});
		vi.stubGlobal("fetch", fetch);
		const rejected = assert.rejects(
			inferRouterDecision({ ...request, signal: controller.signal }),
			/abort|cancel|HTTP 529/i,
		);
		await vi.advanceTimersByTimeAsync(120_000);
		if (failure === "cancel-pending") controller.abort();
		await rejected;
		assert.equal(request.jev.decode.mock.calls.length, 0);
		assert.equal(fetch.mock.calls.length, failure === "cancel-before" ? 0 : failure === "cancel-between" ? 1 : 2);
		vi.useRealTimers();
	});
}

test("context packing repeats unchanged state, limits compiled question bytes, and sums actual calls", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	const request = tournament(1000);
	request.state = { task: "x".repeat(4_000) };
	request.jev.questions.pick.criteria = Object.fromEntries(
		Object.keys(request.jev.questions.pick.criteria).map((key) => [key, "description ".repeat(200)]),
	);
	const calls: JevFixtureRequest[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as JevFixtureRequest;
		calls.push(body);
		assert.deepEqual(body.state, request.state);
		assert.ok(Buffer.byteLength(String(init.body)) <= 48_000);
		for (const [id, question] of Object.entries(body.questions))
			assert.ok(Buffer.byteLength(JSON.stringify({ state: body.state, questions: { [id]: question } })) <= 30_000);
		return Response.json(jevFixtureResponse(body));
	});
	const result = await inferRouterDecision(request);
	assert.equal(result.value.pick, "key_0");
	assert.ok(calls.length > 2);
	assert.deepEqual(result.usage, { inputTokens: calls.length * 20, outputTokens: calls.length * 10 });
	assert.equal(
		new Set(calls.flatMap((call) => Object.values(call.questions).flatMap((q) => Object.keys(q.criteria)))).size,
		1000,
	);
});

test("indivisible oversized state fails without transport or decode", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	const request = { ...tournament(1), state: { task: "x".repeat(300000) } };
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await assert.rejects(inferRouterDecision(request), /conservative input budget/);
	assert.equal(fetch.mock.calls.length, 0);
	assert.equal(request.jev.decode.mock.calls.length, 0);
});

test("minimum context batches still shrink with a retained option and singleton tails", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	const request = tournament(256);
	request.jev.questions.pick.criteria = Object.fromEntries(
		Object.keys(request.jev.questions.pick.criteria).map((key) => [key, "Relevant detail. ".repeat(210)]),
	);
	const calls: JevFixtureRequest[] = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as JevFixtureRequest;
		calls.push(body);
		return Response.json(jevFixtureResponse(body, (keys) => keys.find((key) => key !== "key_200") ?? keys[0]!));
	});
	await inferRouterDecision({
		...request,
		state: { task: "x".repeat(4_000) },
		jev: { ...request.jev, questions: { pick: { ...request.jev.questions.pick, retainForFinal: "key_200" } } },
	});
	const final = calls.at(-1)!.questions.pick;
	assert.ok(final);
	assert.ok(Object.keys(final.criteria).length <= 5);
	assert.ok(Object.hasOwn(final.criteria, "key_200"));
	assert.ok(calls.length < 200);
});

test("multiple overflowing questions preserve original keys independently", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	const request = tournament(256);
	const other = Object.fromEntries(
		Object.keys(request.jev.questions.pick.criteria).map((key) => [`other_${key}`, key]),
	);
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) =>
		Response.json(jevFixtureResponse(JSON.parse(String(init.body)) as JevFixtureRequest)),
	);
	const result = await inferRouterDecision({
		...request,
		jev: {
			...request.jev,
			questions: { ...request.jev.questions, q0: { instructions: "Choose separately", criteria: other } },
		},
	});
	assert.deepEqual(result.value, { pick: "key_0", q0: "other_key_0" });
});

test("Jev tournament rounds can finish beyond the former shared deadline", async () => {
	vi.useFakeTimers();
	vi.stubEnv("TYPESAFE_API_KEY", "fixture-key");
	const request = tournament(256);
	const fetch = vi.fn(async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as JevFixtureRequest;
		await new Promise((resolve) => setTimeout(resolve, 60_000));
		return Response.json(jevFixtureResponse(body));
	});
	vi.stubGlobal("fetch", fetch);
	const outcome = inferRouterDecision(request).then(
		(value) => value,
		(error: Error) => error,
	);
	await vi.advanceTimersByTimeAsync(600_000);
	const result = await outcome;
	assert.ok(!(result instanceof Error), String(result));
	assert.ok(fetch.mock.calls.length > 1);
	assert.equal(request.jev.decode.mock.calls.length, 1);
});
