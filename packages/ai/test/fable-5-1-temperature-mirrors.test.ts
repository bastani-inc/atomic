import { describe, expect, it } from "vitest";
import { getFixtureModel } from "../../../test/helpers/catalog-model-fixtures.ts";
import { type BedrockOptions, stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModels, streamSimple } from "../src/compat.ts";
import type { AnthropicMessagesCompat, BedrockCompat, Context, Model, OpenAICompletionsCompat } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * Temperature suppression for Claude Fable 5.1 on the non-Anthropic-Messages mirrors.
 *
 * "On Claude Fable 5.1, Claude Mythos 5.1, Claude Fable 5, ... non-default `temperature`,
 * `top_p`, or `top_k` values return a 400 error on every request, regardless of whether thinking
 * is used." — https://platform.claude.com/docs/en/build-with-claude/thinking
 *
 * The Anthropic Messages path already honours `compat.supportsTemperature`; the Bedrock Converse
 * and OpenAI-completions paths emitted `temperature` unconditionally, so Claude Fable 5.1 on
 * Amazon Bedrock or OpenRouter still sent a field the model rejects. OpenRouter's own
 * `supported_parameters` for `anthropic/claude-fable-5.1` omits `temperature`, which corroborates
 * the restriction from a second, non-Anthropic source.
 *
 * The guard is scoped to Claude Fable 5.1 rather than to the whole Anthropic family: the broader
 * predicate matches 23 Bedrock and 10 OpenAI-completions entries, and every other model must keep
 * sending `temperature` exactly as before. The negative cases below pin that boundary.
 */

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
}

interface BedrockTemperaturePayload {
	inferenceConfig?: { temperature?: number; maxTokens?: number };
}

async function captureBedrockPayload(
	model: Model<"bedrock-converse-stream">,
	options?: BedrockOptions,
): Promise<BedrockTemperaturePayload> {
	let capturedPayload: BedrockTemperaturePayload | undefined;
	const s = streamBedrock(model, normalizeContext(makeContext()), {
		...options,
		onPayload: (payload) => {
			capturedPayload = payload as BedrockTemperaturePayload;
			throw new PayloadCaptured();
		},
	});

	for await (const event of s) {
		if (event.type === "error") break;
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}
	return capturedPayload;
}

interface CompletionsTemperaturePayload {
	temperature?: number;
}

async function captureCompletionsPayload(
	model: Model<"openai-completions">,
	temperature: number,
): Promise<CompletionsTemperaturePayload> {
	let capturedPayload: CompletionsTemperaturePayload | undefined;

	const s = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		apiKey: "fake-key",
		temperature,
		onPayload: (payload) => {
			capturedPayload = payload as CompletionsTemperaturePayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}
	return capturedPayload;
}

describe("Bedrock temperature suppression for Claude Fable", () => {
	it.for(["claude-fable-5", "claude-fable-5-1"])(
		"omits inferenceConfig.temperature for published %s profiles",
		async (version, { skip }) => {
			const profiles = getModels("amazon-bedrock").filter((model) => model.id.endsWith(`anthropic.${version}`));
			if (profiles.length === 0) return skip(`The generated Bedrock catalog has no ${version} profiles`);
			for (const model of profiles) {
				expect(model.compat?.supportsTemperature, model.id).toBe(false);
				for (const temperature of [0, 1]) {
					const payload = await captureBedrockPayload(model, { temperature });
					expect(payload.inferenceConfig?.temperature, model.id).toBeUndefined();
					expect(payload.inferenceConfig?.maxTokens, model.id).toBeDefined();
				}
			}
		},
	);

	it.for(["global.anthropic.claude-opus-5", "global.anthropic.claude-sonnet-5"])(
		"keeps inferenceConfig.temperature for %s",
		async (modelId, { skip }) => {
			const model = getModels("amazon-bedrock").find((candidate) => candidate.id === modelId);
			if (!model) return skip(`${modelId} is not in the generated Bedrock catalog`);
			expect(model.compat?.supportsTemperature).toBeUndefined();

			const payload = await captureBedrockPayload(model, { temperature: 0 });

			expect(payload.inferenceConfig?.temperature).toBe(0);
		},
	);
});

describe("OpenAI-completions temperature suppression for Claude Fable 5.1", () => {
	it("omits temperature for openrouter/anthropic/claude-fable-5.1:batch", async () => {
		const model = getFixtureModel("openrouter", "anthropic/claude-fable-5.1:batch");
		expect(model.compat?.supportsTemperature).toBe(false);

		expect((await captureCompletionsPayload(model, 0)).temperature).toBeUndefined();
		expect((await captureCompletionsPayload(model, 1)).temperature).toBeUndefined();
	});

	// The `~anthropic/claude-fable-latest` alias names no version, so a version-scoped rule could
	// not reach it — yet it carries Fable 5.1's $0.25 cache read and OpenRouter's own
	// `supported_parameters` for it omits `temperature`. The family match covers it.
	it("omits temperature for openrouter/anthropic/claude-fable-5:batch", async () => {
		const model = getFixtureModel("openrouter", "anthropic/claude-fable-5:batch");
		expect(model.compat?.supportsTemperature).toBe(false);

		expect((await captureCompletionsPayload(model, 0)).temperature).toBeUndefined();
	});

	// Upstream pi 44f6851b moved the `~anthropic/claude-*-latest` aliases onto Anthropic Messages, so the
	// alias no longer goes through the completions path above; its guard must hold there instead.
	it("suppresses temperature for the openrouter ~anthropic/claude-fable-latest alias on Anthropic Messages", () => {
		const model = getFixtureModel("openrouter", "~anthropic/claude-fable-latest");
		expect(model.api).toBe("anthropic-messages");
		expect(model.compat?.supportsTemperature).toBe(false);
	});

	it.each(["anthropic/claude-opus-5:batch", "anthropic/claude-sonnet-5:batch"] as const)(
		"keeps temperature for openrouter/%s",
		async (modelId) => {
			const model = getFixtureModel("openrouter", modelId);
			expect(model.compat?.supportsTemperature).toBeUndefined();

			expect((await captureCompletionsPayload(model, 0)).temperature).toBe(0);
		},
	);
});

describe("temperature suppression is scoped to the Claude Fable family", () => {
	// Deliberately family-scoped rather than model-scoped: Anthropic's sampling-parameter sentence
	// names Claude Fable 5 and Claude Fable 5.1 together, and the Anthropic Messages path already
	// suppressed both. It is *not* driven from provider metadata — 79 of OpenRouter's 419 models
	// omit `temperature` from `supported_parameters`, including the GPT-5 family.
	it("marks every generated Claude Fable entry on the two affected APIs", () => {
		const fableEntries = [...getModels("amazon-bedrock"), ...getModels("openrouter"), ...getModels("github-copilot")]
			.filter((model) => /claude-fable/.test(model.id))
			.map((model) => ({
				label: `${model.provider}/${model.id}`,
				// These providers emit `bedrock-converse-stream` and `openai-completions` entries for
				// Claude, plus OpenRouter's `anthropic-messages` alias; all three compat objects
				// declare the field.
				compat: model.compat as BedrockCompat | OpenAICompletionsCompat | AnthropicMessagesCompat | undefined,
			}));

		expect(fableEntries.length).toBeGreaterThan(0);
		for (const { label, compat } of fableEntries) {
			expect(compat?.supportsTemperature, label).toBe(false);
		}
	});

	it("leaves non-Fable models on those APIs untouched", () => {
		// The pre-existing Anthropic temperature predicate matches many more models on these two
		// APIs; widening to it would change request bodies for models unrelated to this work.
		expect(
			getFixtureModel("openrouter", "anthropic/claude-opus-4.8:batch").compat?.supportsTemperature,
		).toBeUndefined();
	});

	it("leaves the already-guarded Anthropic Messages entries as they were", () => {
		// These were suppressed before this change, by `isAnthropicTemperatureUnsupportedModel`.
		expect(getFixtureModel("anthropic", "claude-fable-5-1").compat?.supportsTemperature).toBe(false);
		expect(getFixtureModel("anthropic", "claude-fable-5").compat?.supportsTemperature).toBe(false);
	});
});
