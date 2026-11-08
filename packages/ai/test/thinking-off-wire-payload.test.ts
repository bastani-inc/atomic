import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { recordGoogleThinkingOffFallback } from "../src/api/google-shared.ts";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, ThinkingLevel } from "../src/types.ts";
import type { AssistantMessageDiagnostic } from "../src/utils/diagnostics.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });

const CODEX_TOKEN = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
	"utf8",
).toString("base64")}.bbb`;

type WirePayload = Record<string, unknown> & {
	model?: string;
	speed?: string;
	thinking?: { type: string; display?: string };
	output_config?: { effort: string };
	messages?: Array<Record<string, unknown>>;
	input?: Array<Record<string, unknown>>;
	reasoning?: { effort: string; summary?: string };
	config?: { thinkingConfig?: Record<string, unknown> };
};

interface CapturedRequest {
	payload: WirePayload;
	reply: AssistantMessage;
	offFallbacks: AssistantMessageDiagnostic[];
}

function offline<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	return {
		...model,
		baseUrl: model.api === "azure-openai-responses" ? "http://127.0.0.1:9/openai/v1" : "http://127.0.0.1:9",
	};
}

function anthropicFastMode(model: Model<"anthropic-messages">): Model<"anthropic-messages"> {
	return {
		...model,
		id: `${model.id}-fast`,
		fastRoute: { baseModelId: model.id, upstreamModelId: model.id, speed: "fast" },
	};
}

async function captureRequest(model: Model<Api>, options: SimpleStreamOptions = {}): Promise<CapturedRequest> {
	let payload: WirePayload | undefined;
	const reply = await streamSimple(offline(model), context, {
		apiKey: model.api === "openai-codex-responses" ? CODEX_TOKEN : "test-key",
		...options,
		onPayload: (request) => {
			payload = request as WirePayload;
			throw new Error("payload captured");
		},
	}).result();
	if (!payload) throw new Error(`No payload captured: ${reply.errorMessage}`);
	const offFallbacks = (reply.diagnostics ?? []).filter((diagnostic) => diagnostic.type === "thinking_off_fallback");
	return { payload, reply, offFallbacks };
}

function offFallbackDiagnostic(thinkingLevel: ThinkingLevel, providerThinkingLevel: string) {
	return {
		type: "thinking_off_fallback",
		timestamp: expect.any(Number),
		details: { requestedThinkingLevel: "off", thinkingLevel, providerThinkingLevel },
	};
}

function thinkingFields(payload: WirePayload) {
	return {
		thinking: payload.thinking,
		output_config: payload.output_config,
		lastMessage: payload.messages?.at(-1),
	};
}

const opus55 = getModel("anthropic", "claude-opus-5-5");
const anthropicApiOpus55Fast = anthropicFastMode({ ...opus55, provider: "anthropic-api" });

describe("thinking off on the Anthropic Messages API (#4545)", () => {
	it.each([
		["anthropic/claude-opus-4-8", getModel("anthropic", "claude-opus-4-8")],
		["anthropic/claude-opus-5", getModel("anthropic", "claude-opus-5")],
		["anthropic/claude-sonnet-4-5", getModel("anthropic", "claude-sonnet-4-5")],
		["github-copilot/claude-haiku-4.5", getModel("github-copilot", "claude-haiku-4.5")],
		["github-copilot/claude-opus-4.8", getModel("github-copilot", "claude-opus-4.8")],
	])("sends thinking disabled with no effort for %s", async (_name, model) => {
		const { payload, reply, offFallbacks } = await captureRequest(model);

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
		expect(payload.messages?.at(-1)?.role).toBe("user");
		expect(reply.providerThinkingLevel).toBeUndefined();
		expect(offFallbacks).toEqual([]);
	});

	it.each([
		["anthropic/claude-opus-4-8-fast", anthropicFastMode(getModel("anthropic", "claude-opus-4-8"))],
		["anthropic/claude-opus-5-fast", anthropicFastMode(getModel("anthropic", "claude-opus-5"))],
	])("sends thinking disabled in fast mode for %s", async (_name, model) => {
		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload).toMatchObject({ model: model.fastRoute?.upstreamModelId, speed: "fast" });
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
		expect(payload.messages?.at(-1)?.role).toBe("user");
		expect(offFallbacks).toEqual([]);
	});

	it("runs anthropic-api/claude-opus-5-5-fast at its lowest effort, not the default high", async () => {
		const { payload, reply, offFallbacks } = await captureRequest(anthropicApiOpus55Fast);

		expect(payload).toMatchObject({ model: "claude-opus-5-5", speed: "fast" });
		expect(payload.thinking).toMatchObject({ type: "adaptive" });
		expect(payload.output_config).toEqual({ effort: "low" });
		expect(payload.messages?.at(-1)).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
		expect(reply.providerThinkingLevel).toBe("low");
		expect(offFallbacks).toEqual([offFallbackDiagnostic("low", "low")]);
	});

	it.each([
		["anthropic-api/claude-opus-5-5-fast", "low", anthropicApiOpus55Fast],
		["anthropic/claude-sonnet-5-5", "low", getModel("anthropic", "claude-sonnet-5-5")],
		["anthropic/claude-fable-5-1", "low", getModel("anthropic", "claude-fable-5-1")],
		["anthropic/claude-fable-5", "minimal", getModel("anthropic", "claude-fable-5")],
		["github-copilot/claude-opus-5.5", "low", getModel("github-copilot", "claude-opus-5.5")],
		["github-copilot/claude-fable-5", "minimal", getModel("github-copilot", "claude-fable-5")],
	] as const)("sends %s the same thinking request as its lowest level, %s", async (_name, level, model) => {
		const off = await captureRequest(model);
		const lowest = await captureRequest(model, { reasoning: level });

		expect(thinkingFields(off.payload)).toEqual(thinkingFields(lowest.payload));
		expect(off.payload.thinking).toMatchObject({ type: "adaptive", display: "summarized" });
		expect(off.payload.output_config).toEqual({ effort: "low" });
		expect(off.offFallbacks).toEqual([offFallbackDiagnostic(level, "low")]);
		expect(lowest.offFallbacks).toEqual([]);
	});

	it("drops temperature, as at its lowest level, when github-copilot/claude-fable-5 runs thinking off", async () => {
		const model = getModel("github-copilot", "claude-fable-5");
		const off = await captureRequest(model, { temperature: 0.2 });
		const low = await captureRequest(model, { temperature: 0.2, reasoning: "low" });

		expect(off.payload.thinking).toMatchObject({ type: "adaptive" });
		expect(off.payload).not.toHaveProperty("temperature");
		expect(low.payload).not.toHaveProperty("temperature");
	});

	it("leaves a budget-thinking model whose metadata denies off without a thinking field", async () => {
		const model: Model<"anthropic-messages"> = {
			...getModel("github-copilot", "claude-haiku-4.5"),
			thinkingLevelMap: { off: null, minimal: null },
		};

		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toBeUndefined();
		expect(offFallbacks).toEqual([]);
	});

	it("leaves the effort to the API when an adaptive request turns thinking on without one", async () => {
		let payload: WirePayload | undefined;
		await streamAnthropic(offline(getModel("github-copilot", "claude-opus-5.5")), context, {
			apiKey: "test-key",
			thinkingEnabled: true,
			onPayload: (request) => {
				payload = request as WirePayload;
				throw new Error("payload captured");
			},
		}).result();

		expect(payload?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload).not.toHaveProperty("output_config");
	});

	it.each([
		["medium", "medium"],
		["high", "high"],
		["xhigh", "xhigh"],
		["max", "max"],
	] as const)("keeps %s reasoning on claude-opus-5-5-fast at effort %s", async (reasoning, effort) => {
		const { payload, reply, offFallbacks } = await captureRequest(anthropicApiOpus55Fast, { reasoning });

		expect(payload.output_config).toEqual({ effort: "low" });
		expect(payload.messages?.at(-1)).toEqual({ role: "system", content: [], output_config: { effort } });
		expect(reply.providerThinkingLevel).toBe(effort);
		expect(offFallbacks).toEqual([]);
	});

	it.each([
		["low", "low"],
		["medium", "medium"],
		["high", "high"],
	] as const)("keeps %s reasoning on github-copilot/claude-opus-5.5 at effort %s", async (reasoning, effort) => {
		const { payload, offFallbacks } = await captureRequest(getModel("github-copilot", "claude-opus-5.5"), {
			reasoning,
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort });
		expect(offFallbacks).toEqual([]);
	});
});

describe("thinking off on the OpenAI Responses APIs (#4545)", () => {
	it.each([
		["openai/gpt-6-luna", getModel("openai", "gpt-6-luna")],
		["azure/gpt-6-luna", getModel("azure", "gpt-6-luna")],
		["github-copilot/gpt-6-luna", getModel("github-copilot", "gpt-6-luna")],
	])("sends the listed off effort none for %s", async (_name, model) => {
		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload.reasoning).toEqual({ effort: "none" });
		expect(offFallbacks).toEqual([]);
	});

	it.each([
		["openai/gpt-5", "minimal", "minimal", getModel("openai", "gpt-5")],
		["openai/o3", "low", "low", getModel("openai", "o3")],
		["xai/grok-4.5", "low", "low", getModel("xai", "grok-4.5")],
		["github-copilot/gpt-6.1-sol", "low", "low", getModel("github-copilot", "gpt-6.1-sol")],
		["github-copilot/gpt-5.3-codex", "minimal", "low", getModel("github-copilot", "gpt-5.3-codex")],
		["azure/gpt-6.1-sol", "low", "low", getModel("azure", "gpt-6.1-sol")],
		["openai-codex/gpt-6.1-sol", "minimal", "low", getModel("openai-codex", "gpt-6.1-sol")],
		["openai-codex/gpt-6-astra", "low", "low", getModel("openai-codex", "gpt-6-astra")],
	] as const)(
		"sends %s its lowest level, %s, at effort %s when it cannot disable reasoning",
		async (_name, level, effort, model) => {
			const off = await captureRequest(model);
			const lowest = await captureRequest(model, { reasoning: level });

			expect(off.payload.reasoning).toEqual({ effort, summary: "auto" });
			expect(off.payload.reasoning).toEqual(lowest.payload.reasoning);
			expect(off.payload.include).toEqual(lowest.payload.include);
			expect(off.offFallbacks).toEqual([offFallbackDiagnostic(level, effort)]);
			expect(lowest.offFallbacks).toEqual([]);
		},
	);

	it.each([
		["azure/gpt-5", getModel("azure", "gpt-5")],
		["azure/gpt-5.1", getModel("azure", "gpt-5.1")],
		["a custom model", { ...getModel("openai", "gpt-6.1-sol"), thinkingLevelMap: { off: null, minimal: null } }],
	])("keeps omitting reasoning for %s, whose map lists no effort to fall back to", async (_name, model) => {
		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload).not.toHaveProperty("reasoning");
		expect(offFallbacks).toEqual([]);
	});

	it("sends none to a reasoning model whose thinking map does not mention off", async () => {
		const model: Model<"openai-responses"> = { ...getModel("openai", "gpt-6-luna"), thinkingLevelMap: undefined };

		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload.reasoning).toEqual({ effort: "none" });
		expect(offFallbacks).toEqual([]);
	});

	it("sends no reasoning and records no fallback for a model whose map denies every level", async () => {
		const model: Model<"openai-responses"> = {
			...getModel("openai", "gpt-6-luna"),
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
		};

		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload).not.toHaveProperty("reasoning");
		expect(offFallbacks).toEqual([]);
	});

	it.each([
		["openai", () => streamOpenAIResponses(offline(getModel("openai", "gpt-6.1-sol")), context)],
		["azure", () => streamAzureOpenAIResponses(offline(getModel("azure", "gpt-6.1-sol")), context)],
		["openai-codex", () => streamOpenAICodexResponses(offline(getModel("openai-codex", "gpt-6.1-sol")), context)],
	] as const)("reports the missing %s API key for a request made without options", async (provider, request) => {
		const reply = await request().result();

		expect(reply.stopReason).toBe("error");
		expect(reply.errorMessage).toBe(`No API key for provider: ${provider}`);
	});

	it("sends a managed-effort model's lowest effort as its configuration update", async () => {
		const model = getModel("openai", "gpt-6.1-sol");
		const off = await captureRequest(model);
		const low = await captureRequest(model, { reasoning: "low" });

		expect(off.payload.input?.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "low" } });
		expect(off.payload.reasoning).toEqual(low.payload.reasoning);
		expect(off.payload.input?.at(-1)).toEqual(low.payload.input?.at(-1));
		expect(off.reply.providerThinkingLevel).toBe("low");
		expect(off.offFallbacks).toEqual([offFallbackDiagnostic("low", "low")]);
	});

	it.each(["none", undefined] as const)(
		"runs explicit Codex effort %s at the lowest effort when off is unsupported",
		async (reasoningEffort) => {
			let payload: WirePayload | undefined;
			const reply = await streamOpenAICodexResponses(offline(getModel("openai-codex", "gpt-6-astra")), context, {
				apiKey: CODEX_TOKEN,
				transport: "sse",
				reasoningEffort,
				onPayload: (request) => {
					payload = request as WirePayload;
					throw new Error("payload captured");
				},
			}).result();

			expect(payload?.reasoning).toEqual({ effort: "low", summary: "auto" });
			expect(reply.diagnostics).toContainEqual(offFallbackDiagnostic("low", "low"));
		},
	);

	it.each([
		["openai/gpt-5", "medium", "medium", getModel("openai", "gpt-5")],
		["openai/o3", "high", "high", getModel("openai", "o3")],
		["github-copilot/gpt-6-luna", "low", "low", getModel("github-copilot", "gpt-6-luna")],
		["xai/grok-4.5", "xhigh", "xhigh", getModel("xai", "grok-4.5")],
		["azure/gpt-6.1-sol", "medium", "medium", getModel("azure", "gpt-6.1-sol")],
		["openai-codex/gpt-6.1-sol", "high", "high", getModel("openai-codex", "gpt-6.1-sol")],
	] as const)("keeps %s at an explicit %s level, effort %s", async (_name, reasoning, effort, model) => {
		const { payload, offFallbacks } = await captureRequest(model, { reasoning });

		expect(payload.reasoning).toEqual({ effort, summary: "auto" });
		expect(offFallbacks).toEqual([]);
	});
});

describe("thinking off on the Google APIs (#4545)", () => {
	it.each([
		["google/gemini-3.8-flash", getModel("google", "gemini-3.8-flash"), "low", "LOW"],
		["google-vertex/gemini-3.8-flash", getModel("google-vertex", "gemini-3.8-flash"), "low", "LOW"],
		["google/gemini-3-flash-preview", getModel("google", "gemini-3-flash-preview"), "minimal", "MINIMAL"],
		["google-vertex/gemini-3.1-pro-preview", getModel("google-vertex", "gemini-3.1-pro-preview"), "low", "LOW"],
	] as const)("records %s running thinking off at its lowest level", async (_name, model, level, apiLevel) => {
		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload.config?.thinkingConfig).toEqual({ thinkingLevel: apiLevel });
		expect(offFallbacks).toEqual([offFallbackDiagnostic(level, apiLevel)]);
	});

	it.each([
		["google/gemini-2.5-flash", getModel("google", "gemini-2.5-flash")],
		["google-vertex/gemini-2.5-flash", getModel("google-vertex", "gemini-2.5-flash")],
	])("disables thinking with a zero budget for %s", async (_name, model) => {
		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
		expect(offFallbacks).toEqual([]);
	});

	it.each([
		["a level-based model whose map allows off", { ...getModel("google", "gemini-3.8-flash"), thinkingLevelMap: {} }],
		[
			"a budget-based model, which takes no thinking level, whose map denies off",
			{ ...getModel("google", "gemini-2.5-flash"), thinkingLevelMap: { off: null } },
		],
	])("keeps the zero thinking budget for %s", async (_case, model) => {
		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
		expect(offFallbacks).toEqual([]);
	});

	it("records no fallback for Google options that leave thinking unset", () => {
		const model = getModel("google", "gemini-3.8-flash");
		const reply = { diagnostics: undefined } as AssistantMessage;

		recordGoogleThinkingOffFallback(model, undefined, reply);
		recordGoogleThinkingOffFallback(model, {}, reply);

		expect(reply.diagnostics).toBeUndefined();
	});

	it.each([
		["google/gemini-3.8-flash", getModel("google", "gemini-3.8-flash")],
		["google-vertex/gemini-3.8-flash", getModel("google-vertex", "gemini-3.8-flash")],
	])("keeps an explicit low level on %s without a fallback diagnostic", async (_name, model) => {
		const { payload, offFallbacks } = await captureRequest(model, { reasoning: "low" });

		expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "LOW" });
		expect(offFallbacks).toEqual([]);
	});
});
