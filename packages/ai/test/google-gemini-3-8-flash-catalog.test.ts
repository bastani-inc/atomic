import { describe, expect, it } from "vitest";
import { getDisabledGoogleThinkingConfig, resolveGoogleThinkingLevel } from "../src/api/google-shared.ts";
import { streamSimple } from "../src/api/openai-completions.ts";
import { getModel, getModels, getProviders } from "../src/compat.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Api, Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * Catalog regressions for Gemini 3.8 Flash in the shipped, hydrated provider catalogs.
 *
 * Every Google-side value asserted here is published by Google and mirrored by models.dev
 * (GA, released 2026-09-02):
 * - https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash
 * - https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash
 * - https://deepmind.google/models/model-cards/gemini-3-8-flash/
 * 1,048,576 context, 65,536 max output, text/image/video/audio/pdf in, text out, thinking with
 * effort low | medium | high ("MINIMAL is unsupported for this model"), and $0.75 / $3.75 /
 * $0.075 cache read per million tokens.
 *
 * The GitHub Copilot assertions pin the current models.dev row. GitHub shipped the model in
 * Copilot on 2026-09-03:
 * - https://github.blog/changelog/2026-09-03-gemini-3-8-flash-is-now-available-in-github-copilot/
 *
 * These `getModel(...)` calls are also the compile-time proof of typed catalog lookup:
 * `getBuiltinModel` constrains the model id to `keyof (typeof MODELS)[TProvider]`, and this
 * package typechecks `test/**`, so an absent id fails the build rather than only the run.
 */

interface CapturedCompletionsPayload {
	model?: string;
	reasoning_effort?: string;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

async function captureCompletionsPayload(
	model: Model<"openai-completions">,
	reasoning: "low" | "medium" | "high",
): Promise<CapturedCompletionsPayload> {
	let capturedPayload: CapturedCompletionsPayload | undefined;
	const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };

	await streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, normalizeContext(context), {
		apiKey: "fake-key",
		reasoning,
		onPayload: (payload) => {
			capturedPayload = payload as CapturedCompletionsPayload;
			throw new PayloadCaptured();
		},
	}).result();

	if (!capturedPayload) throw new Error("Expected payload to be captured before request failure");
	return capturedPayload;
}

describe("Gemini 3.8 Flash Google catalogs", () => {
	it("publishes the documented Gemini API limits, pricing, and capabilities", () => {
		const model = getModel("google", "gemini-3.8-flash");

		expect(model).toBeDefined();
		expect(model.id).toBe("gemini-3.8-flash");
		expect(model.name).toBe("Gemini 3.8 Flash");
		expect(model.provider).toBe("google");
		expect(model.api).toBe("google-generative-ai");
		expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(1_048_576);
		expect(model.maxTokens).toBe(65_536);
		// `Model.input` advertises what Atomic can serialize on this API, not every modality
		// Google accepts, so the published five input modalities collapse to text+image.
		expect(model.input).toEqual(["text", "image"]);
		expect(model.cost).toEqual({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	});

	it("publishes the same model on Vertex under the plain, unprefixed model id", () => {
		const model = getModel("google-vertex", "gemini-3.8-flash");

		expect(model).toBeDefined();
		// Vertex names this model `gemini-3.8-flash`, with no `publishers/google/models/` prefix.
		expect(model.id).toBe("gemini-3.8-flash");
		expect(model.provider).toBe("google-vertex");
		expect(model.api).toBe("google-vertex");
		expect(model.baseUrl).toBe("https://{location}-aiplatform.googleapis.com");
		expect(model.reasoning).toBe(true);
		expect(model.contextWindow).toBe(1_048_576);
		expect(model.maxTokens).toBe(65_536);
		expect(model.input).toEqual(["text", "image"]);
		// Vertex accounts only cachedContentTokenCount as a cache read; there is no cache write price.
		expect(model.cost).toEqual({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	});

	// Google publishes exactly LOW | MEDIUM | HIGH for this model and says "MINIMAL is unsupported
	// for this model", and Gemini 3.x Flash always thinks, so `off` is denied too. Assert the
	// for this model. The upstream resolver now rejects unsupported mappings; disabling thinking
	// uses the lowest published level instead of sending an unsupported value.
	it("offers only the three thinking levels Google publishes", () => {
		for (const provider of ["google", "google-vertex"] as const) {
			const model = getModel(provider, "gemini-3.8-flash");

			expect(model.thinkingLevelMap?.off, provider).toBeNull();
			expect(model.thinkingLevelMap?.minimal, provider).toBeNull();
			expect(getSupportedThinkingLevels(model), provider).toEqual(["low", "medium", "high"]);
		}
	});

	// Google's own comparison table publishes MINIMAL for Gemini 3.5 and 3.6 Flash and drops it
	// from 3.7 onward, so the denial above must not have leaked into the older Flash entries.
	it("leaves the 3.5 and 3.6 Flash entries offering minimal", () => {
		for (const id of ["gemini-3.5-flash", "gemini-3.6-flash"] as const) {
			expect(getModel("google", id).thinkingLevelMap?.minimal, id).toBe("minimal");
			expect(getSupportedThinkingLevels(getModel("google", id)), id).toContain("minimal");
		}
	});

	it("resolves the published levels to Google's own thinking levels", () => {
		for (const provider of ["google", "google-vertex"] as const) {
			const model = getModel(provider, "gemini-3.8-flash") as Model<"google-generative-ai" | "google-vertex">;

			expect(
				getDisabledGoogleThinkingConfig(model, () => 1024),
				provider,
			).toEqual({ thinkingLevel: "LOW" });
			expect(resolveGoogleThinkingLevel(model, "low"), provider).toBe("low");
			expect(resolveGoogleThinkingLevel(model, "medium"), provider).toBe("medium");
			expect(resolveGoogleThinkingLevel(model, "high"), provider).toBe("high");
			// `xhigh`/`max` are unmapped for every Gemini entry and must stay rejected.
			expect(() => resolveGoogleThinkingLevel(model, "xhigh")).toThrow();
			expect(() => resolveGoogleThinkingLevel(model, "max")).toThrow();
		}
	});
});

describe("Gemini 3.8 Flash GitHub Copilot catalog", () => {
	it("routes through Copilot's OpenAI-compatible endpoint rather than Google's API", () => {
		const model = getModel("github-copilot", "gemini-3.8-flash");

		expect(model).toBeDefined();
		expect(model.id).toBe("gemini-3.8-flash");
		expect(model.name).toBe("Gemini 3.8 Flash");
		expect(model.provider).toBe("github-copilot");
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe("https://api.individual.githubcopilot.com");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
		expect(model.compat).toMatchObject({ supportsStore: false, supportsDeveloperRole: false });
	});

	it("carries the limits models.dev advertises", () => {
		const model = getModel("github-copilot", "gemini-3.8-flash");

		expect(model.contextWindow).toBe(1_000_000);
		expect(model.maxTokens).toBe(64_000);
		expect(model.cost).toEqual({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	});

	it("exposes the reasoning efforts models.dev advertises", () => {
		const model = getModel("github-copilot", "gemini-3.8-flash");

		expect(model.compat).toMatchObject({ supportsReasoningEffort: true });
		expect(model.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high"]);
	});

	// The models.dev effort metadata enables the OpenAI-compatible request field.
	it("sends the requested effort as reasoning_effort on the request payload", async () => {
		const payload = await captureCompletionsPayload(getModel("github-copilot", "gemini-3.8-flash"), "low");

		expect(payload.model).toBe("gemini-3.8-flash");
		expect(payload.reasoning_effort).toBe("low");
	});
});

describe("Gemini 3.8 Flash catalog coverage", () => {
	// Deliberately an invariant sweep, not a fixed mirror list: `be05f82112` replaced hard-coded
	// third-party pins in live-catalog tests after an opencode withdrawal turned six tests red for
	// reasons outside Atomic. Exact per-mirror values are pinned against a fixed models.dev /
	// OpenRouter / Vercel fixture in `test/generate-models-gemini-3-8-flash.test.ts` instead.
	it("is available on every built-in provider whose catalog advertises it", () => {
		const mirrors = getProviders()
			.flatMap((provider) => getModels(provider) as Model<Api>[])
			.filter((model) => /(^|\/)gemini-3\.8-flash(:|$)/.test(model.id));

		const providers = new Set(mirrors.map((model) => model.provider));
		// Named explicitly by the acceptance contract.
		expect(providers).toContain("google");
		expect(providers).toContain("google-vertex");
		expect(providers).toContain("github-copilot");

		for (const model of mirrors) {
			expect(model.reasoning, `${model.provider}/${model.id}`).toBe(true);
			expect(model.input, `${model.provider}/${model.id}`).toContain("text");
			expect(model.contextWindow, `${model.provider}/${model.id}`).toBeGreaterThan(0);
			expect(model.maxTokens, `${model.provider}/${model.id}`).toBeGreaterThan(0);
			// Every mirror that carries a thinking level map denies `off` and `minimal`, which is the
			// three-level claim the user-facing docs make. A mirror with no map at all — the Vercel AI
			// Gateway generates none for any of its `anthropic-messages` models — is the exception the
			// docs call out, so it is skipped here rather than pinned by provider name.
			if (model.thinkingLevelMap) {
				expect(getSupportedThinkingLevels(model), `${model.provider}/${model.id}`).toEqual([
					"low",
					"medium",
					"high",
				]);
			}
		}
	});
});
