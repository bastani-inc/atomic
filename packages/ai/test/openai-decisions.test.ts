import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { classify } from "../src/api/openai-decisions.ts";
import type { ClassifierContext, ClassifierModel, ImageContent } from "../src/types.ts";

const model: ClassifierModel<"openai-decisions"> = {
	type: "classifier",
	id: "gpt-6-luna",
	name: "GPT-6 Luna",
	api: "openai-decisions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	input: ["text", "image"],
	cost: {
		input: 0.1,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0 }],
	},
	contextWindow: 922000,
};

const context: ClassifierContext = {
	state: { text: "The deployment succeeded, thank you." },
	questions: {
		category: {
			type: "choice",
			instructions: "Classify the message",
			criteria: { success: "Successful", failure: "" },
		},
		satisfaction: {
			type: "score",
			instructions: "Score satisfaction",
			criteria: ["low", "neutral", "high"],
		},
		approved: {
			type: "bool",
			instructions: "Does the user approve?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

const wireAnswers = [
	{
		type: "choice",
		name: "category",
		choice: "success",
		probabilities: [
			{ value: "success", probability: 0.9 },
			{ value: "failure", probability: 0.1 },
		],
		confidence: 0.8,
	},
	{
		type: "score",
		name: "satisfaction",
		score: 1.8,
		probabilities: [
			{ value: 0, label: "low", probability: 0.05 },
			{ value: 1, label: "neutral", probability: 0.1 },
			{ value: 2, label: "high", probability: 0.85 },
		],
		confidence: 0.7,
	},
	{ type: "predicate", name: "approved", probability: 0.95 },
];

const wireUsage = {
	input_tokens: 164,
	input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
	output_tokens: 0,
	output_tokens_details: { reasoning_tokens: 0 },
	total_tokens: 164,
};

const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

describe("OpenAI Decisions", () => {
	it("maps questions to Decisions types and answers back by name", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({ model: "gpt-6-luna", answers: [...wireAnswers].reverse(), usage: wireUsage }),
		);

		const result = await classify(model, context, { apiKey: "secret", fetch, temperature: 1.5 });

		assert.equal(fetch.mock.calls.length, 1);
		const [url, init] = fetch.mock.calls[0]!;
		assert.equal(String(url), "https://api.openai.com/v1/decisions");
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret");
		assert.deepEqual(JSON.parse(String(init?.body)), {
			model: "gpt-6-luna",
			input: JSON.stringify(context.state),
			questions: [
				{
					type: "choice",
					name: "category",
					instructions: "Classify the message",
					choices: [{ value: "success", description: "Successful" }, { value: "failure" }],
				},
				{
					type: "score",
					name: "satisfaction",
					instructions: "Score satisfaction",
					levels: [{ label: "low" }, { label: "neutral" }, { label: "high" }],
				},
				{
					type: "predicate",
					name: "approved",
					instructions: "Does the user approve?\n\nTrue means: Approval\nFalse means: No approval",
				},
			],
		});
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.answers, {
			category: {
				type: "choice",
				choice: "success",
				probabilities: { success: 0.9, failure: 0.1 },
				confidence: 0.8,
			},
			satisfaction: { type: "score", score: 1.8, confidence: 0.7 },
			approved: { type: "bool", probability: 0.95 },
		});
		assert(result.usage);
		assert.deepEqual(
			{ input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead, totalTokens: result.usage.totalTokens },
			{ input: 164, output: 0, cacheRead: 0, totalTokens: 164 },
		);
		assert(Math.abs(result.usage.cost.total - 0.0000164) < 1e-12);
	});

	it("prices long-context requests at the long-context input rate", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers: wireAnswers, usage: { input_tokens: 300000, output_tokens: 0 } }),
		});

		assert(result.usage);
		assert(Math.abs(result.usage.cost.total - 0.06) < 1e-12);
	});

	it("sends images after the state in one user message", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
			Response.json({ answers: wireAnswers }),
		);

		const result = await classify(
			model,
			{ ...context, images: [image, { ...image, mimeType: "image/jpeg" }] },
			{
				apiKey: "secret",
				fetch,
			},
		);

		assert.equal(result.stopReason, "stop");
		assert.deepEqual(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).input, [
			{
				role: "user",
				content: [
					{ type: "input_text", text: JSON.stringify(context.state) },
					{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
					{ type: "input_image", image_url: "data:image/jpeg;base64,aW1hZ2U=" },
				],
			},
		]);
	});

	it("rejects more than 128 images before sending", async () => {
		const fetch = vi.fn(async () => Response.json({ answers: wireAnswers }));

		const result = await classify(
			model,
			{ ...context, images: Array.from({ length: 129 }, () => image) },
			{
				apiKey: "secret",
				fetch,
			},
		);

		assert.equal(fetch.mock.calls.length, 0);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /at most 128 images, got 129/);
	});

	it("fails the result when a question is refused and keeps the billed usage", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			fetch: async () =>
				Response.json({
					answers: [wireAnswers[0], wireAnswers[1], { type: "refusal", name: "approved" }],
					usage: wireUsage,
				}),
		});

		assert.equal(result.stopReason, "error");
		assert.deepEqual(result.answers, {});
		assert.equal(result.errorMessage, "OpenAI Decisions refused to answer approved");
		assert.equal(result.usage?.input, 164);
	});

	it("returns missing and mistyped answers as classifier errors", async () => {
		const missing = await classify(model, context, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers: wireAnswers.slice(0, 2) }),
		});
		const mistyped = await classify(model, context, {
			apiKey: "secret",
			fetch: async () =>
				Response.json({ answers: [wireAnswers[0], wireAnswers[1], { type: "score", name: "approved" }] }),
		});

		assert.equal(missing.stopReason, "error");
		assert.match(missing.errorMessage ?? "", /did not return an answer for approved/);
		assert.equal(mistyped.stopReason, "error");
		assert.match(mistyped.errorMessage ?? "", /did not return a predicate answer for approved/);
	});

	it("preserves prototype-sensitive question IDs in answers", async () => {
		const prototypeContext: ClassifierContext = {
			state: {},
			questions: JSON.parse(
				'{"__proto__":{"type":"bool","instructions":"Is this true?","criteria":{"true":"Yes","false":"No"}}}',
			),
		};
		const result = await classify(model, prototypeContext, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers: [{ type: "predicate", name: "__proto__", probability: 0.75 }] }),
		});

		assert.equal(result.stopReason, "stop");
		assert.equal(Object.hasOwn(result.answers, "__proto__"), true);
		assert.deepEqual(result.answers.__proto__, { type: "bool", probability: 0.75 });
	});

	it.each([
		["unknown choice", 0, { choice: "unknown" }],
		["inherited choice", 0, { choice: "toString" }],
		["unknown probability key", 0, { probabilities: [{ value: "unknown", probability: 0.5 }] }],
		["inherited probability key", 0, { probabilities: [{ value: "toString", probability: 0.5 }] }],
		["negative choice probability", 0, { probabilities: [{ value: "success", probability: -0.1 }] }],
		["excess choice probability", 0, { probabilities: [{ value: "success", probability: 1.1 }] }],
		["negative choice confidence", 0, { confidence: -0.1 }],
		["excess choice confidence", 0, { confidence: 1.1 }],
		["negative score", 1, { score: -0.1 }],
		["excess score", 1, { score: 2.1 }],
		["negative score confidence", 1, { confidence: -0.1 }],
		["excess score confidence", 1, { confidence: 1.1 }],
		["negative predicate probability", 2, { probability: -0.1 }],
		["excess predicate probability", 2, { probability: 1.1 }],
	] as const)("rejects %s and retains billed usage", async (_name, index, patch) => {
		const answers = wireAnswers.map((answer, i) => (i === index ? { ...answer, ...patch } : answer));
		const result = await classify(model, context, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers, usage: wireUsage }),
		});
		assert.equal(result.stopReason, "error");
		assert.deepEqual(result.answers, {});
		assert.equal(result.usage?.input, 164);
		assert.equal(result.usage?.totalTokens, 164);
	});

	it.each([0, 1])("accepts probability/confidence boundary %s and score boundaries", async (boundary) => {
		const result = await classify(model, context, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers: [
				{ ...wireAnswers[0], probabilities: [{ value: "success", probability: boundary }], confidence: boundary },
				{ ...wireAnswers[1], score: boundary * 2, confidence: boundary },
				{ ...wireAnswers[2], probability: boundary },
			] }),
		});
		assert.equal(result.stopReason, "stop");
		assert.deepEqual(result.answers, {
			category: { type: "choice", choice: "success", probabilities: { success: boundary }, confidence: boundary },
			satisfaction: { type: "score", score: boundary * 2, confidence: boundary },
			approved: { type: "bool", probability: boundary },
		});
	});

	it.each([
		["fetch", null], ["fetch", undefined],
		["onPayload", null], ["onPayload", undefined],
		["onResponse", null], ["onResponse", undefined],
	] as const)("normalizes %s throwing %s without rejecting", async (source, thrown) => {
		const result = await classify(model, context, {
			apiKey: "secret",
			maxRetries: 0,
			fetch: async () => {
				if (source === "fetch") throw thrown;
				return Response.json({ answers: wireAnswers });
			},
			onPayload: () => {
				if (source === "onPayload") throw thrown;
			},
			onResponse: () => {
				if (source === "onResponse") throw thrown;
			},
		});
		assert.equal(result.stopReason, "error");
		assert.deepEqual(result.answers, {});
		assert.equal(result.errorMessage, String(thrown));
	});

	it("does not retry gateway timeouts and explains them instead of returning the HTML page", async () => {
		const fetch = vi.fn(
			async () =>
				new Response("<!DOCTYPE html><html>Gateway time-out</html>", {
					status: 504,
					headers: { "retry-after-ms": "0" },
				}),
		);
		const result = await classify(model, context, { apiKey: "secret", fetch });

		assert.equal(fetch.mock.calls.length, 1);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /OpenAI Decisions error \(504\): the request timed out at the gateway/);
		assert.doesNotMatch(result.errorMessage ?? "", /<html>/);
	});

	it("still retries other server errors", async () => {
		let attempt = 0;
		const result = await classify(model, context, {
			apiKey: "secret",
			fetch: async () =>
				++attempt === 1
					? new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } })
					: Response.json({ answers: wireAnswers }),
		});

		assert.equal(attempt, 2);
		assert.equal(result.stopReason, "stop");
	});

	it("includes the API error body for other HTTP failures", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			maxRetries: 0,
			fetch: async () =>
				Response.json(
					{ error: { message: "Decision input exceeds the token limit.", type: "invalid_request_error" } },
					{ status: 400 },
				),
		});

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /OpenAI Decisions error \(400\)/);
		assert.match(result.errorMessage ?? "", /Decision input exceeds the token limit\./);
	});

	it("rejects models for other classifier APIs and missing API keys", async () => {
		const fetch = vi.fn(async () => Response.json({ answers: wireAnswers }));
		const otherApi = await classify({ ...model, api: "typesafe-system-one" }, context, { apiKey: "secret", fetch });
		const noKey = await classify(model, context, { fetch });

		assert.equal(fetch.mock.calls.length, 0);
		assert.match(otherApi.errorMessage ?? "", /Unsupported classifier API: typesafe-system-one/);
		assert.match(noKey.errorMessage ?? "", /No API key for provider: openai/);
	});
});
