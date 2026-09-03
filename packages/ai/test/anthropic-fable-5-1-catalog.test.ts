import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, getModels, getProviders } from "../src/compat.ts";
import type { Api, Context, Model } from "../src/types.ts";

/**
 * Catalog regressions for Claude Fable 5.1.
 *
 * Every value asserted here is published by Anthropic and mirrored by models.dev:
 * - https://platform.claude.com/docs/en/models/fable-5-1/overview
 * - https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1
 * - https://platform.claude.com/docs/en/build-with-claude/thinking
 *
 * 1M context, 128K max output, $10 input, $50 output, $12.50 5m cache write, $0.25 cache read,
 * always-on adaptive thinking, no temperature, and server-side fallback to Opus 4.8 / Opus 5.
 */

interface AnthropicFallbackPayload {
	fallbacks?: Array<{ model: string }>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

async function capturePayload(model: Model<"anthropic-messages">): Promise<AnthropicFallbackPayload> {
	let capturedPayload: AnthropicFallbackPayload | undefined;
	const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };

	const s = streamAnthropic({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicFallbackPayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Claude Fable 5.1 catalog metadata", () => {
	it("publishes the documented Anthropic limits, pricing, and capabilities", () => {
		const model = getModel("anthropic", "claude-fable-5-1");

		expect(model).toBeDefined();
		expect(model.id).toBe("claude-fable-5-1");
		expect(model.api).toBe("anthropic-messages");
		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(128_000);
		expect(model.reasoning).toBe(true);
		// PDF is a platform capability — "All active models support PDF processing" — routed
		// through the same vision path as images, so upstream metadata publishes it for every
		// Claude entry. Atomic advertises it only where a runtime can serialize a document block,
		// which for this model means the Anthropic Messages and Bedrock Converse paths.
		// https://platform.claude.com/docs/en/build-with-claude/pdf-support
		expect(model.input).toEqual(["text", "image", "pdf"]);
		expect(model.cost).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });
		expect(model.compat?.forceAdaptiveThinking).toBe(true);
		expect(model.compat?.supportsStrictTools).toBe(true);
		expect(model.compat?.supportsTemperature).toBe(false);
	});

	it("denies thinking off in the generated thinking level map", () => {
		const model = getModel("anthropic", "claude-fable-5-1");

		expect(model.thinkingLevelMap?.off).toBeNull();
		expect(model.thinkingLevelMap?.xhigh).toBe("xhigh");
		expect(model.thinkingLevelMap?.max).toBe("max");
	});

	// Fable 5.1 cache reads cost 0.025x base input, against 0.1x on Fable 5. This is the headline
	// pricing change between the two models and must never be mirrored from the predecessor.
	it("prices cache reads at a quarter of the Claude Fable 5 rate", () => {
		expect(getModel("anthropic", "claude-fable-5-1").cost.cacheRead).toBe(0.25);
		expect(getModel("anthropic", "claude-fable-5").cost.cacheRead).toBe(1);
	});

	it("carries provider-specific Bedrock pricing rather than mirrored Anthropic prices", () => {
		expect(getModel("amazon-bedrock", "anthropic.claude-fable-5-1").cost).toEqual({
			input: 10,
			output: 50,
			cacheRead: 0.25,
			cacheWrite: 12.5,
		});
		expect(getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1").cost).toEqual({
			input: 10,
			output: 50,
			cacheRead: 0.25,
			cacheWrite: 12.5,
		});
		// US-only inference carries a documented 1.1x premium on every rate.
		expect(getModel("amazon-bedrock", "us.anthropic.claude-fable-5-1").cost).toEqual({
			input: 11,
			output: 55,
			cacheRead: 0.275,
			cacheWrite: 13.75,
		});
	});

	// Sweeps every Fable entry rather than only IDs matching `claude-fable-5-1`, because a
	// provider "latest" alias can route to Fable 5.1 without naming it: OpenRouter's
	// `~anthropic/claude-fable-latest` carries Fable 5.1's $0.25 cache read against Fable 5's
	// $1.00. Both Fable generations share these limits, so the assertion holds for either.
	it("keeps the 1M/128K limits on every generated Fable mirror, aliases included", () => {
		const mirrors = getProviders()
			.flatMap((provider) => getModels(provider) as Model<Api>[])
			.filter((model) => /fable/i.test(model.id));

		expect(mirrors.length).toBeGreaterThan(0);
		// The `claude-fable-5-1` IDs specifically must be present, not just some Fable entry.
		expect(mirrors.some((model) => /claude-fable-5[-.]1/.test(model.id))).toBe(true);
		for (const model of mirrors) {
			expect(model.contextWindow, `${model.provider}/${model.id}`).toBe(1_000_000);
			expect(model.maxTokens, `${model.provider}/${model.id}`).toBe(128_000);
			expect(model.reasoning, `${model.provider}/${model.id}`).toBe(true);
		}
	});

	// models.dev publishes no `eu.` Bedrock inference profile for Claude Fable 5.1, even though
	// Claude Fable 5 has one. Generating one would be an invented mirror.
	it("does not invent Bedrock inference profiles that Anthropic has not published", () => {
		const bedrockIds = getModels("amazon-bedrock").map((model) => model.id);

		expect(bedrockIds).toContain("anthropic.claude-fable-5-1");
		expect(bedrockIds).toContain("global.anthropic.claude-fable-5-1");
		expect(bedrockIds).toContain("us.anthropic.claude-fable-5-1");
		expect(bedrockIds).not.toContain("eu.anthropic.claude-fable-5-1");
		// The predecessor's `eu.` profile is real and must stay.
		expect(bedrockIds).toContain("eu.anthropic.claude-fable-5");
	});
});

describe("Claude Fable 5.1 server-side fallback", () => {
	// Per-turn effort markers require fallback targets that support the same transport contract.
	// https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1
	it("advertises only the per-turn-effort-compatible fallback target", () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const allowed = model.compat?.allowedFallbackModels ?? [];

		expect(new Set(allowed.map((fallback) => fallback.model))).toEqual(new Set(["claude-opus-5"]));
		for (const fallback of allowed) {
			expect(fallback.provider).toBe("anthropic");
		}
	});

	it("sends those fallbacks on the request payload", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5-1"));

		expect(payload.fallbacks).toEqual([{ model: "claude-opus-5" }]);
	});
});
