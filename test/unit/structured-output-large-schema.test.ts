// Regression for #3090: full model/effort catalogs must retain strict pair validation.
import assert from "node:assert/strict";
import type { JsonObject } from "@bastani/pi-ai";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { inferRouterDecision } from "../../packages/coding-agent/src/core/structured-output/index.js";
import { decisionMessage, decisionRequest, messageStream } from "../helpers/structured-output.js";

const pairs = Array.from({ length: 1997 }, (_, index) => ({
	model: `provider/model-${index}`,
	effort: index % 2 === 0 ? "high" : "low",
}));
const schema = Type.Unsafe<{ model: string; effort: string }>({
	type: "object",
	properties: { model: Type.String(), effort: Type.Union([Type.String(), Type.Null()]) },
	required: ["model", "effort"],
	additionalProperties: false,
	anyOf: pairs.map((pair) =>
		Type.Object(
			{ model: Type.Literal(pair.model), effort: Type.Literal(pair.effort) },
			{ additionalProperties: false },
		),
	),
});

function requestFor(value: JsonObject) {
	const request = decisionRequest();
	const dispatch = vi.fn(() => messageStream(decisionMessage(value)));
	return {
		dispatch,
		request: {
			...request,
			schema,
			modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
			jev: {
				questions: { pair: { instructions: "Choose an eligible pair.", criteria: { last: "Last pair" } } },
				decode: () => pairs.at(-1)!,
			},
		},
	};
}

test("ordinary routing accepts the last exact pair in a 1997-candidate schema", async () => {
	const value = pairs.at(-1)!;
	const { request, dispatch } = requestFor(value);
	const result = await inferRouterDecision(request);
	assert.deepEqual(result.value, value);
	assert.equal(dispatch.mock.calls.length, 1);
});

for (const [name, value] of [
	["wrong model/effort pair", { ...pairs.at(-1)!, effort: "low" }],
	["unknown property", { ...pairs.at(-1)!, extra: true }],
	["missing required effort", { model: pairs.at(-1)!.model }],
	["null effort", { ...pairs.at(-1)!, effort: null }],
] as const) {
	test(`ordinary routing rejects ${name} against all 1997 candidates after bounded repairs without normalization`, async () => {
		const before = structuredClone(value);
		const { request, dispatch } = requestFor(value);
		await assert.rejects(inferRouterDecision(request), {
			name: "Error",
			message:
				"Invalid structured output: response does not match the decision schema. Routing output repair exhausted after 4 attempts.",
		});
		assert.equal(dispatch.mock.calls.length, 4);
		assert.deepEqual(value, before);
	});
}

for (const valid of [true, false]) {
	test(`Jev decoded output is ${valid ? "accepted" : "rejected"} against the full 1997-pair schema`, async () => {
		const value = { ...pairs.at(-1)!, effort: valid ? "high" : "low" };
		const { request, dispatch } = requestFor(value);
		request.settings = { getRouterModel: () => "typesafe-ai/jev-latest" };
		// No chat fallback: the Jev-side repair budget stays observable (#3206).
		request.currentModel = undefined;
		request.jev.decode = () => value;
		const fetch = vi.fn(async () =>
			Response.json({
				model: "jev-test",
				answers: { pair: { type: "choice", choice: "last", probabilities: { last: 1 }, confidence: 1 } },
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		);
		vi.stubEnv("TYPESAFE_API_KEY", "test-key");
		vi.stubGlobal("fetch", fetch);
		try {
			if (valid) assert.deepEqual((await inferRouterDecision(request)).value, value);
			else
				await assert.rejects(inferRouterDecision(request), {
					name: "Error",
					message:
						"Invalid structured output: response does not match the decision schema. Routing output repair exhausted after 4 attempts.",
				});
			assert.equal(fetch.mock.calls.length, valid ? 1 : 4);
			assert.equal(dispatch.mock.calls.length, 0);
		} finally {
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
		}
	});
}
