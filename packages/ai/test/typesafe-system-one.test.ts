import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { classify } from "../src/api/typesafe-system-one.ts";
import { builtinModels, getBuiltinClassifierModels } from "../src/providers/all.js";
import type { ClassifierContext, ClassifierModel, ImageContent } from "../src/types.js";

const DANGER_ZONE_HEADERS = ["typesafe-danger-zone-long-context", "typesafe-danger-zone-images"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const png: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const jpeg: ImageContent = { type: "image", data: "data:image/jpeg;base64,/9j/4AAQSkZJRg==", mimeType: "image/jpeg" };

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: {
		model: string;
		state: Record<string, string | string[]>;
		assets?: Record<string, { type: string; format: string; data_base64: string }>;
	};
}

function capturingFetch(answers: object) {
	const requests: CapturedRequest[] = [];
	const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({
			url: String(input),
			headers: Object.fromEntries(new Headers(init?.headers)),
			body: JSON.parse(String(init?.body)) as CapturedRequest["body"],
		});
		return Response.json({ answers });
	});
	return { fetch, requests };
}

const model: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: "jev-latest",
	name: "Jev",
	api: "typesafe-system-one",
	provider: "typesafe",
	baseUrl: "https://api.typesafe.ai/v1/",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 64000,
};

const context: ClassifierContext = {
	state: { text: "The deployment succeeded, thank you." },
	questions: {
		category: {
			type: "choice",
			instructions: "Classify the message",
			criteria: { success: "Successful", failure: "Failed" },
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

const wireAnswers = {
	category: {
		type: "choice",
		choice: "success",
		probabilities: { success: 0.9, failure: 0.1 },
		confidence: 0.8,
	},
	satisfaction: { type: "score", score: 2, confidence: 0.7 },
	approved: { type: "noul", noul: 0.95 },
};

describe("TypeSafe System One", () => {
	it("maps public bool questions and answers to TypeSafe noul values", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body)) as {
				model: string;
				questions: Record<string, { type: string }>;
			};
			expect(payload.model).toBe("jev-latest");
			expect(payload.questions.category?.type).toBe("choice");
			expect(payload.questions.satisfaction?.type).toBe("score");
			expect(payload.questions.approved?.type).toBe("noul");
			// System One has no temperature field; the option is ignored.
			expect(payload).not.toHaveProperty("temperature");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
			return Response.json({ answers: wireAnswers });
		});

		const result = await classify(model, context, { apiKey: "secret", fetch, temperature: 1.5 });

		expect(fetch).toHaveBeenCalledOnce();
		expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.typesafe.ai/v1/systemone");
		expect(result.stopReason).toBe("stop");
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.95 });
		expect(result.answers.category).toMatchObject({ type: "choice", choice: "success" });
		expect(result.answers.satisfaction).toEqual({ type: "score", score: 2, confidence: 0.7 });
	});

	it("posts OpenRouter System One requests to its TypeSafe-compatible endpoint", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toMatchObject({ model: "typesafe/jev-1.13", state: context.state });
			return Response.json({ id: "gen-dec-1", provider: "TypeSafe", answers: wireAnswers, usage: { cost: 0.1 } });
		});
		const openRouterModel = {
			...model,
			id: "typesafe/jev-1.13",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		};

		const result = await classify(openRouterModel, context, { apiKey: "secret", fetch });

		expect(String(fetch.mock.calls[0]?.[0])).toBe("https://openrouter.ai/api/v1/systemone");
		expect(result.stopReason).toBe("stop");
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.95 });
	});

	it("rejects models for other classifier APIs", async () => {
		const fetch = vi.fn(async () => Response.json({ answers: wireAnswers }));
		const result = await classify({ ...model, api: "cloudflare-workers-ai-system-one" }, context, {
			apiKey: "secret",
			fetch,
		});

		expect(fetch).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Unsupported classifier API: cloudflare-workers-ai-system-one");
	});

	it("lists jev-latest and jev-1.14.0 with long context and image input", () => {
		const jev = getBuiltinClassifierModels("typesafe");
		assert.deepEqual(
			jev.map((entry) => entry.id),
			["jev-1.14.0", "jev-latest"],
		);
		for (const entry of jev) {
			assert.equal(entry.api, "typesafe-system-one");
			assert.equal(entry.contextWindow, 262000);
			assert.deepEqual(entry.input, ["text", "image"]);
		}
	});

	it.each(["jev-latest", "jev-1.14.0"])(
		"sends both Danger-Zone headers on every direct %s request, with and without images",
		async (id) => {
			const models = builtinModels();
			const jev = models.getModelOfType("classifier", "typesafe", id);
			assert(jev);
			const { fetch, requests } = capturingFetch(wireAnswers);

			const textOnly = await models.classify(jev, context, { apiKey: "secret", fetch });
			const withImage = await models.classify(jev, { ...context, images: [png] }, { apiKey: "secret", fetch });

			assert.equal(textOnly.stopReason, "stop", textOnly.errorMessage);
			assert.equal(withImage.stopReason, "stop", withImage.errorMessage);
			assert.equal(requests.length, 2);
			for (const request of requests) {
				assert.equal(request.url, "https://api.typesafe.ai/v1/systemone");
				assert.equal(request.body.model, id);
				for (const header of DANGER_ZONE_HEADERS) assert.equal(request.headers[header], "true");
			}
			assert.equal(requests[0]?.body.assets, undefined);
		},
	);

	it("sends images as base64 assets under fresh UUID references listed in state.images", async () => {
		const jev = getBuiltinClassifierModels("typesafe").find((entry) => entry.id === "jev-1.14.0");
		assert(jev);
		const { fetch, requests } = capturingFetch(wireAnswers);

		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await classify(jev, { ...context, images: [png, jpeg] }, { apiKey: "secret", fetch });
			assert.equal(result.stopReason, "stop", result.errorMessage);
		}

		const references = requests.map((request) => Object.keys(request.body.assets ?? {}));
		for (const [index, request] of requests.entries()) {
			const keys = references[index] ?? [];
			assert.equal(keys.length, 2);
			for (const key of keys) assert.match(key, UUID);
			assert.deepEqual(request.body.state, { ...context.state, images: keys });
			assert.deepEqual(Object.values(request.body.assets ?? {}), [
				{ type: "image", format: "png", data_base64: "iVBORw0KGgo=" },
				{ type: "image", format: "jpg", data_base64: "/9j/4AAQSkZJRg==" },
			]);
		}
		assert.equal(new Set(references.flat()).size, 4);
	});

	it("rejects image formats TypeSafe cannot read, and a state field that would hide the image references", async () => {
		const jev = getBuiltinClassifierModels("typesafe")[0];
		assert(jev);
		const { fetch } = capturingFetch(wireAnswers);

		const webp = await classify(
			jev,
			{ ...context, images: [{ type: "image", data: "UklGRg==", mimeType: "image/webp" }] },
			{ apiKey: "secret", fetch },
		);
		const collision = await classify(
			jev,
			{ ...context, state: { images: "user data" }, images: [png] },
			{ apiKey: "secret", fetch },
		);

		assert.equal(fetch.mock.calls.length, 0);
		assert.equal(webp.stopReason, "error");
		assert.equal(webp.errorMessage, "System One API accepts only PNG or JPEG images, got image/webp");
		assert.equal(collision.stopReason, "error");
		assert.match(collision.errorMessage ?? "", /rename that state field to send images/u);
	});

	it.each(["vercel-ai-gateway", "opencode"] as const)(
		"rejects images for text-only %s System One models and sends them no Danger-Zone headers",
		async (provider) => {
			const models = builtinModels();
			const gateway = getBuiltinClassifierModels(provider).find((entry) => entry.api === "typesafe-system-one");
			assert(gateway, `missing ${provider} System One classifier`);
			const { fetch, requests } = capturingFetch(wireAnswers);

			const textOnly = await models.classify(gateway, context, { apiKey: "secret", fetch });
			const withImage = await models.classify(gateway, { ...context, images: [png] }, { apiKey: "secret", fetch });

			assert.equal(textOnly.stopReason, "stop", textOnly.errorMessage);
			assert.equal(requests.length, 1);
			for (const header of DANGER_ZONE_HEADERS) assert.equal(requests[0]?.headers[header], undefined);
			assert.equal(withImage.stopReason, "error");
			assert.equal(withImage.errorMessage, `Model ${provider}/${gateway.id} does not accept image input`);
		},
	);

	it("sends the opt-in header only with images, and rejects text-only models before sending", async () => {
		const { fetch, requests } = capturingFetch(wireAnswers);
		const imageModel = { ...model, input: ["text", "image"] as ("text" | "image")[] };

		const withImage = await classify(imageModel, { ...context, images: [png] }, { apiKey: "secret", fetch });
		const withoutImage = await classify(imageModel, context, { apiKey: "secret", fetch });
		const textOnly = await classify(model, { ...context, images: [png] }, { apiKey: "secret", fetch });

		assert.equal(withImage.stopReason, "stop", withImage.errorMessage);
		assert.equal(requests[0]?.headers["typesafe-danger-zone-images"], "true");
		assert.equal(withoutImage.stopReason, "stop", withoutImage.errorMessage);
		assert.equal(requests[1]?.headers["typesafe-danger-zone-images"], undefined);
		assert.equal(requests[1]?.body.assets, undefined);
		assert.equal(requests.length, 2);
		assert.equal(textOnly.stopReason, "error");
		assert.equal(textOnly.errorMessage, "System One API does not support image input for jev-latest");
	});

	it("sends images to OpenRouter as image_url parts in the state, without assets or the opt-in header", async () => {
		const { fetch, requests } = capturingFetch(wireAnswers);
		const openRouterModel: ClassifierModel<"typesafe-system-one"> = {
			...model,
			id: "typesafe/jev-1.14",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: ["text", "image"],
		};

		const result = await classify(openRouterModel, { ...context, images: [png, jpeg] }, { apiKey: "secret", fetch });

		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(requests[0]?.body.state, [
			{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
			{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" } },
			context.state,
		]);
		assert.equal(requests[0]?.body.assets, undefined);
		assert.equal(requests[0]?.headers["typesafe-danger-zone-images"], undefined);
	});

	it.each([
		["OpenRouter behind a proxy", { provider: "openrouter", baseUrl: "https://proxy.example.com/v1" }],
		["a regional OpenRouter endpoint", { provider: "custom", baseUrl: "https://us.openrouter.ai/api/v1" }],
		[
			"a proxy declared through compat",
			{
				provider: "custom",
				baseUrl: "https://proxy.example.com/v1",
				compat: { imageInput: "state-image-urls" as const, sendImageOptInHeader: false },
			},
		],
	])("sends OpenRouter's image form to %s", async (_name, overrides) => {
		const { fetch, requests } = capturingFetch(wireAnswers);

		const result = await classify(
			{ ...model, id: "typesafe/jev-1.14", input: ["text", "image"], ...overrides },
			{ ...context, images: [png] },
			{ apiKey: "secret", fetch },
		);

		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(requests[0]?.body.state, [
			{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
			context.state,
		]);
		assert.equal(requests[0]?.body.assets, undefined);
		assert.equal(requests[0]?.headers["typesafe-danger-zone-images"], undefined);
	});

	it("lets compat override each detected image setting on its own", async () => {
		const { fetch, requests } = capturingFetch(wireAnswers);

		await classify(
			{ ...model, input: ["text", "image"], compat: { sendImageOptInHeader: false } },
			{ ...context, images: [png] },
			{ apiKey: "secret", fetch },
		);
		await classify(
			{ ...model, input: ["text", "image"], compat: { imageInput: "state-image-urls" } },
			{ ...context, images: [png] },
			{ apiKey: "secret", fetch },
		);

		assert.notEqual(requests[0]?.body.assets, undefined);
		assert.equal(requests[0]?.headers["typesafe-danger-zone-images"], undefined);
		assert.equal(requests[1]?.body.assets, undefined);
		assert.equal(requests[1]?.headers["typesafe-danger-zone-images"], "true");
	});

	it("merges headers case-insensitively and supports null suppression", async () => {
		const requests: Array<Record<string, string>> = [];
		const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			requests.push(Object.fromEntries(new Headers(init?.headers)));
			return Response.json({ answers: wireAnswers });
		});
		const modelWithHeaders = {
			...model,
			headers: { authorization: "Bearer model", "X-Source": "model" },
		};

		await classify(modelWithHeaders, context, {
			apiKey: "secret",
			fetch,
			headers: { Authorization: "Bearer request", "x-source": "request" },
		});
		await classify(modelWithHeaders, context, {
			apiKey: "secret",
			fetch,
			headers: { Authorization: null },
		});

		expect(requests[0]).toMatchObject({ authorization: "Bearer request", "x-source": "request" });
		expect(Object.keys(requests[0]).filter((name) => name.toLowerCase() === "authorization")).toHaveLength(1);
		expect(requests[1]).not.toHaveProperty("authorization");
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
			fetch: async () => Response.json({ answers: JSON.parse('{"__proto__":{"type":"noul","noul":0.75}}') }),
		});

		const serializedAnswers = JSON.parse(JSON.stringify(result.answers)) as Record<string, unknown>;
		expect(result.stopReason).toBe("stop");
		expect(Object.keys(result.answers)).toEqual(["__proto__"]);
		expect(Object.hasOwn(result.answers, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(result.answers, "__proto__")?.value).toEqual({
			type: "bool",
			probability: 0.75,
		});
		expect(Object.getOwnPropertyDescriptor(serializedAnswers, "__proto__")?.value).toEqual({
			type: "bool",
			probability: 0.75,
		});
	});

	it("reports request timeouts separately from caller cancellation", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			timeoutMs: 5,
			maxRetries: 0,
			fetch: async (_input, init) => {
				const signal = init?.signal;
				if (!signal) throw new Error("missing request signal");
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		});

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Request timed out after 5ms");
	});

	it("creates a fresh timeout for every retry attempt", async () => {
		const signals: AbortSignal[] = [];
		let attempt = 0;
		const result = await classify(model, context, {
			apiKey: "secret",
			timeoutMs: 1000,
			maxRetries: 1,
			fetch: async (_input, init) => {
				if (!(init?.signal instanceof AbortSignal)) throw new Error("missing request signal");
				signals.push(init.signal);
				attempt++;
				return attempt === 1
					? new Response("retry", { status: 500, headers: { "retry-after-ms": "0" } })
					: Response.json({ answers: wireAnswers });
			},
		});

		expect(result.stopReason).toBe("stop");
		expect(signals).toHaveLength(2);
		expect(signals[0]).not.toBe(signals[1]);
	});

	it("returns malformed responses as classifier errors", async () => {
		const result = await classify(model, context, {
			apiKey: "secret",
			fetch: async () => Response.json({ answers: {} }),
		});

		expect(result.stopReason).toBe("error");
		expect(result.answers).toEqual({});
		expect(result.errorMessage).toContain("did not return an answer for category");
	});
	it("rejects classifier answers outside the submitted criteria and probability bounds", async () => {
		const invalidAnswers = [
			{ category: { ...wireAnswers.category, choice: "unsubmitted" } },
			{ category: { ...wireAnswers.category, probabilities: { success: 1.2, failure: -0.2 } } },
			{ category: { ...wireAnswers.category, probabilities: { success: 0.9, failure: 0.1, unknown: 0 } } },
			{ category: { ...wireAnswers.category, confidence: 1.1 } },
			{ satisfaction: { ...wireAnswers.satisfaction, score: 3 } },
			{ satisfaction: { ...wireAnswers.satisfaction, score: -0.5 } },
			{ satisfaction: { ...wireAnswers.satisfaction, confidence: -0.1 } },
			{ approved: { ...wireAnswers.approved, noul: 1.1 } },
		];
		for (const patch of invalidAnswers) {
			const result = await classify(model, context, {
				apiKey: "secret",
				fetch: async () => Response.json({ answers: { ...wireAnswers, ...patch } }),
			});
			expect(result.stopReason).toBe("error");
			expect(result.answers).toEqual({});
		}
	});
});
