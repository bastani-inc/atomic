import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Api, Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface SamplingPayload {
	temperature?: number;
	top_p?: number;
	top_k?: number;
	min_p?: number;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

function makeCompletionsModel(overrides?: Partial<Model<"openai-completions">>): Model<"openai-completions"> {
	return {
		id: "custom-model",
		name: "Custom Model",
		api: "openai-completions",
		provider: "custom-provider",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}

function makeAnthropicModel(): Model<"anthropic-messages"> {
	return {
		id: "vendor--claude",
		name: "Vendor Proxy Claude",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

async function capturePayload(model: Model<Api>, options?: SimpleStreamOptions): Promise<SamplingPayload> {
	let capturedPayload: SamplingPayload | undefined;

	const s = streamSimple(model, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as SamplingPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("sampling params", () => {
	it("merges stream-option sampling params into the request body", async () => {
		const payload = await capturePayload(makeCompletionsModel(), {
			samplingParams: { top_p: 0.95, top_k: 0, min_p: 0 },
		});

		expect(payload.top_p).toBe(0.95);
		expect(payload.top_k).toBe(0);
		expect(payload.min_p).toBe(0);
	});

	it("omits sampling params when neither options nor model set them", async () => {
		const payload = await capturePayload(makeCompletionsModel());

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
	});

	it("applies model-level sampling params", async () => {
		const payload = await capturePayload(makeCompletionsModel({ samplingParams: { temperature: 1, top_p: 0.95 } }));

		expect(payload.temperature).toBe(1);
		expect(payload.top_p).toBe(0.95);
	});

	it("merges stream-option keys over model-level keys", async () => {
		const payload = await capturePayload(makeCompletionsModel({ samplingParams: { top_p: 0.95, min_p: 0.05 } }), {
			samplingParams: { top_p: 0.5 },
		});

		expect(payload.top_p).toBe(0.5);
		expect(payload.min_p).toBe(0.05);
	});

	it("overrides named request fields", async () => {
		const payload = await capturePayload(makeCompletionsModel(), {
			temperature: 0,
			samplingParams: { temperature: 1 },
		});

		expect(payload.temperature).toBe(1);
	});

	it("is ignored by non-OpenAI-compatible APIs", async () => {
		const payload = await capturePayload(makeAnthropicModel(), {
			samplingParams: { top_p: 0.9, top_k: 40 },
		});

		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
	});
});

/**
 * Claude Fable 5.1 returns a 400 for non-default `temperature`, `top_p`, or `top_k` on every
 * request. https://platform.claude.com/docs/en/build-with-claude/thinking
 *
 * `samplingParams` is documented as merged last so its keys override the named request fields,
 * which means it reopened the very parameters the named-field guard closes. The strip therefore
 * runs *after* the merge: reordering would invert the documented precedence for every model on
 * this adapter, and a pre-merge guard would miss `Model.samplingParams`, which `simple-options`
 * folds into the same object. `top_p` and `top_k` are never named fields on this adapter, so
 * `samplingParams` is their only route to the wire.
 */
describe("restricted sampling params on models that reject them", () => {
	const restrictedModel = () => makeCompletionsModel({ compat: { supportsTemperature: false } });

	it("strips temperature, top_p, and top_k from stream-option samplingParams", async () => {
		const payload = await capturePayload(restrictedModel(), {
			samplingParams: { temperature: 1, top_p: 0.9, top_k: 5, min_p: 0.1 },
		});

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
		// Only the three restricted keys are dropped; the escape hatch still works for the rest.
		expect(payload.min_p).toBe(0.1);
	});

	// `Model.samplingParams` reaches the request through the same merged object, so a guard placed
	// before the merge would have missed this path entirely.
	it("strips them when they come from Model.samplingParams", async () => {
		const payload = await capturePayload(
			makeCompletionsModel({
				compat: { supportsTemperature: false },
				samplingParams: { temperature: 0.7, top_p: 0.5, top_k: 40 },
			}),
		);

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
	});

	it("strips a named temperature that samplingParams tried to reopen", async () => {
		const payload = await capturePayload(restrictedModel(), {
			temperature: 0,
			samplingParams: { temperature: 1 },
		});

		expect(payload.temperature).toBeUndefined();
	});

	// Positive control: precedence and the escape hatch are unchanged for every other model.
	it("leaves samplingParams alone on a model without the restriction", async () => {
		const payload = await capturePayload(makeCompletionsModel(), {
			temperature: 0,
			samplingParams: { temperature: 1, top_p: 0.9, top_k: 5 },
		});

		expect(payload.temperature).toBe(1);
		expect(payload.top_p).toBe(0.9);
		expect(payload.top_k).toBe(5);
	});

	it("strips them for the generated OpenRouter Claude Fable 5.1 entry", async () => {
		const model = getModel("openrouter", "anthropic/claude-fable-5.1");
		expect(model.compat?.supportsTemperature).toBe(false);

		const payload = await capturePayload(
			{ ...model, baseUrl: "http://127.0.0.1:9/v1" },
			{
				samplingParams: { temperature: 1, top_p: 0.9, top_k: 5 },
			},
		);

		expect(payload.temperature).toBeUndefined();
		expect(payload.top_p).toBeUndefined();
		expect(payload.top_k).toBeUndefined();
	});
});
