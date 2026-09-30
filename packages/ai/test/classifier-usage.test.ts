import assert from "node:assert/strict";
import { test } from "vitest";
import { classify } from "../src/api/typesafe-system-one.ts";
import type { ClassifierModel } from "../src/types.ts";

const model: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: "jev",
	name: "Jev",
	provider: "typesafe",
	api: "typesafe-system-one",
	baseUrl: "https://example.com/v1",
	input: ["text"],
	contextWindow: 32000,
	cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
};

for (const malformed of [false, true]) {
	test(`classifier retains billed usage with ${malformed ? "malformed" : "valid"} answers`, async () => {
		const result = await classify(
			model,
			{
				state: {},
				questions: { ok: { type: "bool", instructions: "Approve?", criteria: { true: "yes", false: "no" } } },
			},
			{
				apiKey: "key",
				fetch: async () =>
					Response.json({
						answers: malformed ? {} : { ok: { type: "noul", noul: 1 } },
						usage: { input_tokens: 1000, output_tokens: 50 },
					}),
			},
		);
		assert.equal(result.stopReason, malformed ? "error" : "stop");
		assert.equal(result.usage?.input, 1000);
		assert.equal(result.usage?.output, 50);
		assert.equal(result.usage?.totalTokens, 1050);
		assert.equal(result.usage?.cost.total, 0.0025);
	});
}
