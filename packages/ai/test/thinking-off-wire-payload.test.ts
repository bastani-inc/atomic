import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamAzureOpenAIResponses } from "../src/api/azure-openai-responses.ts";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { recordGoogleThinkingOffFallback } from "../src/api/google-shared.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { stream as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import type {
	Api,
	AssistantMessage,
	Model,
	OpenAICompletionsCompat,
	SimpleStreamOptions,
	ThinkingLevel,
	ThinkingLevelMap,
} from "../src/types.ts";
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
	reasoning_effort?: string;
	reasoningEffort?: string;
	promptMode?: string;
	config?: { thinkingConfig?: Record<string, unknown> };
	additionalModelRequestFields?: Record<string, unknown>;
	inferenceConfig?: Record<string, unknown>;
	enable_thinking?: boolean;
	chat_template_kwargs?: Record<string, unknown>;
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
		["azure/gpt-5.1", getModel("azure", "gpt-5.1")],
		["azure/gpt-5.5", getModel("azure", "gpt-5.5")],
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
		["azure/gpt-5", "minimal", "minimal", getModel("azure", "gpt-5")],
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

	it("keeps omitting reasoning for a model whose map lists no effort to fall back to", async () => {
		const model = { ...getModel("openai", "gpt-6.1-sol"), thinkingLevelMap: { off: null, minimal: null } };

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
		["azure/gpt-5.1", "minimal", "minimal", getModel("azure", "gpt-5.1")],
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

	it("keeps the zero thinking budget for a level-based model whose map allows off", async () => {
		const model = { ...getModel("google", "gemini-3.8-flash"), thinkingLevelMap: {} };

		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
		expect(offFallbacks).toEqual([]);
	});

	it("records no fallback for Google options that leave thinking unset", () => {
		const model = getModel("google", "gemini-3.8-flash");
		const reply = { diagnostics: undefined } as AssistantMessage;

		recordGoogleThinkingOffFallback(model, undefined, reply, () => 128);
		recordGoogleThinkingOffFallback(model, {}, reply, () => 128);

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

async function captureStream(
	request: (onPayload: (payload: unknown) => never) => { result(): Promise<AssistantMessage> },
): Promise<CapturedRequest> {
	let payload: WirePayload | undefined;
	const reply = await request((captured) => {
		payload = captured as WirePayload;
		throw new Error("payload captured");
	}).result();
	if (!payload) throw new Error(`No payload captured: ${reply.errorMessage}`);
	const offFallbacks = (reply.diagnostics ?? []).filter((diagnostic) => diagnostic.type === "thinking_off_fallback");
	return { payload, reply, offFallbacks };
}

describe("thinking off on Bedrock Converse (#4552)", () => {
	const claudeLowEffort = { thinking: { type: "adaptive" }, output_config: { effort: "low" } };

	it.each([
		["anthropic.claude-fable-5", "minimal", claudeLowEffort, getModel("amazon-bedrock", "anthropic.claude-fable-5")],
		[
			"us.anthropic.claude-fable-5",
			"minimal",
			claudeLowEffort,
			getModel("amazon-bedrock", "us.anthropic.claude-fable-5"),
		],
		[
			"eu.anthropic.claude-fable-5",
			"minimal",
			claudeLowEffort,
			getModel("amazon-bedrock", "eu.anthropic.claude-fable-5"),
		],
		[
			"global.anthropic.claude-fable-5",
			"minimal",
			claudeLowEffort,
			getModel("amazon-bedrock", "global.anthropic.claude-fable-5"),
		],
		["anthropic.claude-fable-5-1", "low", claudeLowEffort, getModel("amazon-bedrock", "anthropic.claude-fable-5-1")],
		[
			"us.anthropic.claude-fable-5-1",
			"low",
			claudeLowEffort,
			getModel("amazon-bedrock", "us.anthropic.claude-fable-5-1"),
		],
		[
			"global.anthropic.claude-fable-5-1",
			"low",
			claudeLowEffort,
			getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1"),
		],
		["openai.gpt-6-astra", "low", { reasoning_effort: "low" }, getModel("amazon-bedrock", "openai.gpt-6-astra")],
		[
			"us.openai.gpt-6-astra",
			"low",
			{ reasoning_effort: "low" },
			getModel("amazon-bedrock", "us.openai.gpt-6-astra"),
		],
		[
			"global.openai.gpt-6-astra",
			"low",
			{ reasoning_effort: "low" },
			getModel("amazon-bedrock", "global.openai.gpt-6-astra"),
		],
		["openai.gpt-6.1-sol", "low", { reasoning: { effort: "low" } }, getModel("amazon-bedrock", "openai.gpt-6.1-sol")],
		[
			"us.openai.gpt-6.1-sol",
			"low",
			{ reasoning: { effort: "low" } },
			getModel("amazon-bedrock", "us.openai.gpt-6.1-sol"),
		],
		[
			"global.openai.gpt-6.1-sol",
			"low",
			{ reasoning: { effort: "low" } },
			getModel("amazon-bedrock", "global.openai.gpt-6.1-sol"),
		],
	] as const)(
		"sends amazon-bedrock/%s its lowest level, %s, when it cannot disable thinking",
		async (_id, level, fields, model) => {
			const off = await captureRequest(model);
			const lowest = await captureRequest(model, { reasoning: level });

			expect(off.payload.additionalModelRequestFields).toMatchObject(fields);
			expect(off.payload.additionalModelRequestFields).toEqual(lowest.payload.additionalModelRequestFields);
			expect(off.offFallbacks).toEqual([offFallbackDiagnostic(level, "low")]);
			expect(lowest.offFallbacks).toEqual([]);
		},
	);

	it.each([
		[
			"global.openai.gpt-6-sol",
			{ reasoning: { effort: "none" } },
			getModel("amazon-bedrock", "global.openai.gpt-6-sol"),
		],
		["global.openai.gpt-5.6-sol", undefined, getModel("amazon-bedrock", "global.openai.gpt-5.6-sol")],
		["us.anthropic.claude-opus-4-8", undefined, getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8")],
	] as const)(
		"keeps the off request of amazon-bedrock/%s, which can turn thinking off",
		async (_id, fields, model) => {
			const { payload, offFallbacks } = await captureRequest(model);

			expect(payload.additionalModelRequestFields).toEqual(fields);
			expect(offFallbacks).toEqual([]);
		},
	);

	it("leaves a budget-thinking Claude model whose map denies off without thinking fields, as the Anthropic API does", async () => {
		const model: Model<"bedrock-converse-stream"> = {
			...getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
			thinkingLevelMap: { off: null },
		};

		const { payload, offFallbacks } = await captureRequest(model, { maxTokens: 800 });

		expect(payload.additionalModelRequestFields).toBeUndefined();
		expect(payload.inferenceConfig).toEqual({ maxTokens: 800 });
		expect(offFallbacks).toEqual([]);
	});

	it("records no fallback for a model whose lowest level sends no thinking fields", async () => {
		const model: Model<"bedrock-converse-stream"> = {
			...getModel("amazon-bedrock", "deepseek.v3.2"),
			thinkingLevelMap: { off: null },
		};

		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload.additionalModelRequestFields).toBeUndefined();
		expect(offFallbacks).toEqual([]);
	});

	it("runs a low-level request without a reasoning level at the lowest level", async () => {
		const { payload, offFallbacks } = await captureStream((onPayload) =>
			streamBedrock(offline(getModel("amazon-bedrock", "us.openai.gpt-6-astra")), context, {
				apiKey: "test-key",
				onPayload,
			}),
		);

		expect(payload.additionalModelRequestFields).toEqual({ reasoning_effort: "low" });
		expect(offFallbacks).toEqual([offFallbackDiagnostic("low", "low")]);
	});

	it.each([
		["low", "low"],
		["medium", "medium"],
		["high", "high"],
	] as const)("keeps an explicit %s level on Bedrock GPT-6 Astra at effort %s", async (reasoning, effort) => {
		const { payload, offFallbacks } = await captureRequest(getModel("amazon-bedrock", "us.openai.gpt-6-astra"), {
			reasoning,
		});

		expect(payload.additionalModelRequestFields).toEqual({ reasoning_effort: effort });
		expect(offFallbacks).toEqual([]);
	});
});

describe("thinking off on the OpenAI Chat Completions API (#4552)", () => {
	it.each([
		[
			"openrouter/openai/gpt-5.1-codex",
			"low",
			{ reasoning: { effort: "low" } },
			getModel("openrouter", "openai/gpt-5.1-codex"),
		],
		[
			"openrouter/openai/gpt-5.2-pro",
			"medium",
			{ reasoning: { effort: "medium" } },
			getModel("openrouter", "openai/gpt-5.2-pro"),
		],
		[
			"openrouter/openai/gpt-5-pro",
			"high",
			{ reasoning: { effort: "high" } },
			getModel("openrouter", "openai/gpt-5-pro"),
		],
		[
			"openrouter/google/gemini-3.5-flash",
			"minimal",
			{ reasoning: { effort: "minimal" } },
			getModel("openrouter", "google/gemini-3.5-flash"),
		],
		["ant-ling/Ring-2.6-1T", "high", { reasoning: { effort: "high" } }, getModel("ant-ling", "Ring-2.6-1T")],
		[
			"zai/glm-5.3",
			"low",
			{ thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "low" },
			getModel("zai", "glm-5.3"),
		],
		[
			"qwen-token-plan/glm-5.3",
			"low",
			{ enable_thinking: true, reasoning_effort: "low" },
			getModel("qwen-token-plan", "glm-5.3"),
		],
		[
			"opencode-go/deepseek-v4.1-flash",
			"low",
			{ thinking: { type: "enabled" }, reasoning_effort: "low" },
			getModel("opencode-go", "deepseek-v4.1-flash"),
		],
		["baseten/zai-org/GLM-5.3", "low", { reasoning_effort: "low" }, getModel("baseten", "zai-org/GLM-5.3")],
		["cerebras/gpt-oss-120b", "low", { reasoning_effort: "low" }, getModel("cerebras", "gpt-oss-120b")],
		[
			"github-copilot/gemini-3.8-flash",
			"low",
			{ reasoning_effort: "low" },
			getModel("github-copilot", "gemini-3.8-flash"),
		],
		["opencode-go/kimi-k3", "max", { reasoning_effort: "max" }, getModel("opencode-go", "kimi-k3")],
		["openrouter/openai/o3", "minimal", { reasoning: { effort: "minimal" } }, getModel("openrouter", "openai/o3")],
		[
			"openrouter/google/gemini-2.5-pro",
			"minimal",
			{ reasoning: { effort: "minimal" } },
			getModel("openrouter", "google/gemini-2.5-pro"),
		],
	] as const)(
		"sends %s its lowest level, %s, when it cannot disable thinking",
		async (_name, level, fields, model) => {
			const off = await captureRequest(model);
			const lowest = await captureRequest(model, { reasoning: level });

			expect(off.payload).toMatchObject(fields);
			expect(off.payload).toEqual(lowest.payload);
			expect(off.offFallbacks).toEqual([offFallbackDiagnostic(level, level)]);
			expect(lowest.offFallbacks).toEqual([]);
		},
	);

	it.each([
		["moonshotai/kimi-k2.7-code", getModel("moonshotai", "kimi-k2.7-code")],
		[
			"a model on the default format whose map lists no effort",
			{ ...getModel("cerebras", "gpt-oss-120b"), thinkingLevelMap: { off: null } },
		],
	])("keeps omitting reasoning for %s, whose map lists no effort to fall back to", async (_name, model) => {
		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload).not.toHaveProperty("reasoning");
		expect(payload).not.toHaveProperty("reasoning_effort");
		expect(payload).not.toHaveProperty("thinking");
		expect(offFallbacks).toEqual([]);
	});

	function withThinkingFormat(
		thinkingFormat: NonNullable<OpenAICompletionsCompat["thinkingFormat"]>,
		thinkingLevelMap: ThinkingLevelMap,
		compat: OpenAICompletionsCompat = {},
	): Model<"openai-completions"> {
		const model = getModel("cerebras", "gpt-oss-120b");
		return { ...model, thinkingLevelMap, compat: { ...model.compat, ...compat, thinkingFormat } };
	}

	it.each([
		["qwen", {}, ["enable_thinking"], false],
		["zai", {}, ["thinking"], { type: "disabled" }],
		["qwen-chat-template", {}, ["chat_template_kwargs", "enable_thinking"], false],
		["together", {}, ["reasoning"], { enabled: false }],
		[
			"chat-template",
			{ chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } },
			["chat_template_kwargs"],
			{ enable_thinking: false },
		],
	] as const)(
		"sends the %s format's disabled thinking toggle only to a model that can disable thinking",
		async (thinkingFormat, compat, togglePath, disabled) => {
			const canDisable = await captureRequest(withThinkingFormat(thinkingFormat, {}, compat));
			const cannotDisable = await captureRequest(withThinkingFormat(thinkingFormat, { off: null }, compat));

			expect(canDisable.payload).toHaveProperty([...togglePath], disabled);
			expect(cannotDisable.payload).not.toHaveProperty([...togglePath]);
			expect(cannotDisable.offFallbacks).toEqual([]);
		},
	);

	it("sends an OpenRouter model the effort its map gives its lowest level", async () => {
		const model = { ...getModel("openrouter", "openai/o3"), thinkingLevelMap: { off: null, minimal: "low" } };

		const off = await captureRequest(model);
		const minimal = await captureRequest(model, { reasoning: "minimal" });

		expect(off.payload.reasoning).toEqual({ effort: "low" });
		expect(off.payload).toEqual(minimal.payload);
		expect(off.offFallbacks).toEqual([offFallbackDiagnostic("minimal", "low")]);
	});

	it("keeps sending the off effort to a model that can disable reasoning", async () => {
		const { payload, offFallbacks } = await captureRequest(getModel("openrouter", "openai/gpt-5.1"));

		expect(payload.reasoning).toEqual({ effort: "none" });
		expect(offFallbacks).toEqual([]);
	});

	it("runs a low-level request without a reasoning effort at the lowest listed level", async () => {
		const { payload, offFallbacks } = await captureStream((onPayload) =>
			streamOpenAICompletions(offline(getModel("openrouter", "openai/gpt-5.1-codex")), context, {
				apiKey: "test-key",
				onPayload,
			}),
		);

		expect(payload.reasoning).toEqual({ effort: "low" });
		expect(offFallbacks).toEqual([offFallbackDiagnostic("low", "low")]);
	});

	it.each([
		["medium", "medium"],
		["high", "high"],
	] as const)(
		"keeps an explicit %s level on openrouter/openai/gpt-5.1-codex at effort %s",
		async (reasoning, effort) => {
			const { payload, offFallbacks } = await captureRequest(getModel("openrouter", "openai/gpt-5.1-codex"), {
				reasoning,
			});

			expect(payload.reasoning).toEqual({ effort });
			expect(offFallbacks).toEqual([]);
		},
	);
});

describe("thinking off on the Mistral API (#4552)", () => {
	it.each([
		["mistral/mistral-large-4", getModel("mistral", "mistral-large-4")],
		["mistral/mistral-large-4-0-8", getModel("mistral", "mistral-large-4-0-8")],
		["mistral/zai-glm-5-3", getModel("mistral", "zai-glm-5-3")],
		["mistral/zai-glm-5-3-flash", getModel("mistral", "zai-glm-5-3-flash")],
	])("sends %s its lowest listed level, low, when it cannot disable thinking", async (_name, model) => {
		const off = await captureRequest(model);
		const low = await captureRequest(model, { reasoning: "low" });

		expect(off.payload.reasoningEffort).toBe("low");
		expect(off.payload).toEqual(low.payload);
		expect(off.offFallbacks).toEqual([offFallbackDiagnostic("low", "low")]);
		expect(low.offFallbacks).toEqual([]);
	});

	it("keeps sending the off effort to a model that can disable reasoning", async () => {
		const { payload, offFallbacks } = await captureRequest(getModel("mistral", "mistral-medium-3.5"));

		expect(payload.reasoningEffort).toBe("none");
		expect(offFallbacks).toEqual([]);
	});

	it("keeps a prompt-mode reasoning model's off request without reasoning fields", async () => {
		const { payload, offFallbacks } = await captureRequest(getModel("mistral", "magistral-medium-latest"));

		expect(payload).not.toHaveProperty("promptMode");
		expect(payload).not.toHaveProperty("reasoningEffort");
		expect(offFallbacks).toEqual([]);
	});

	it("runs a low-level request without a reasoning setting at the lowest listed level", async () => {
		const { payload, offFallbacks } = await captureStream((onPayload) =>
			streamMistral(offline(getModel("mistral", "mistral-large-4")), context, { apiKey: "test-key", onPayload }),
		);

		expect(payload.reasoningEffort).toBe("low");
		expect(offFallbacks).toEqual([offFallbackDiagnostic("low", "low")]);
	});

	it("leaves a low-level request that sets a prompt mode unchanged", async () => {
		const { payload, offFallbacks } = await captureStream((onPayload) =>
			streamMistral(offline(getModel("mistral", "mistral-large-4")), context, {
				apiKey: "test-key",
				promptMode: "reasoning",
				onPayload,
			}),
		);

		expect(payload.promptMode).toBe("reasoning");
		expect(payload).not.toHaveProperty("reasoningEffort");
		expect(offFallbacks).toEqual([]);
	});
});

describe("thinking off on Azure OpenAI deployments (#4552)", () => {
	it.each([
		["azure/gpt-5-pro", "high", getModel("azure", "gpt-5-pro")],
		["azure/gpt-5.2-pro", "medium", getModel("azure", "gpt-5.2-pro")],
		["azure/gpt-5.4-pro", "medium", getModel("azure", "gpt-5.4-pro")],
		["azure/gpt-5.3-codex-spark", "low", getModel("azure", "gpt-5.3-codex-spark")],
		["azure/o1", "low", getModel("azure", "o1")],
		["azure/o1-pro", "low", getModel("azure", "o1-pro")],
		["azure/o3", "low", getModel("azure", "o3")],
		["azure/o3-mini", "low", getModel("azure", "o3-mini")],
		["azure/o3-pro", "low", getModel("azure", "o3-pro")],
		["azure/o4-mini", "low", getModel("azure", "o4-mini")],
		["azure/gpt-realtime-2.1", "minimal", getModel("azure", "gpt-realtime-2.1")],
	] as const)("sends %s its lowest listed level, %s, instead of none or no effort", async (_name, level, model) => {
		const off = await captureRequest(model);
		const lowest = await captureRequest(model, { reasoning: level });

		expect(off.payload.reasoning).toEqual({ effort: level, summary: "auto" });
		expect(off.payload.reasoning).toEqual(lowest.payload.reasoning);
		expect(off.payload.include).toEqual(lowest.payload.include);
		expect(off.offFallbacks).toEqual([offFallbackDiagnostic(level, level)]);
		expect(lowest.offFallbacks).toEqual([]);
	});

	it.each([
		["azure/o3", "low", getModel("azure", "o3")],
		["azure/o3", "high", getModel("azure", "o3")],
		["azure/gpt-5-pro", "high", getModel("azure", "gpt-5-pro")],
		["azure/gpt-5.2-pro", "xhigh", getModel("azure", "gpt-5.2-pro")],
	] as const)("keeps %s at an explicit %s level", async (_name, reasoning, model) => {
		const { payload, offFallbacks } = await captureRequest(model, { reasoning });

		expect(payload.reasoning).toEqual({ effort: reasoning, summary: "auto" });
		expect(offFallbacks).toEqual([]);
	});

	it("falls back past unlisted levels to the lowest level whose effort the map lists", async () => {
		const model = { ...getModel("openai", "gpt-6.1-sol"), thinkingLevelMap: { off: null, medium: "medium" } };

		const { payload, offFallbacks } = await captureRequest(model);

		expect(payload.reasoning).toEqual({ effort: "medium", summary: "auto" });
		expect(offFallbacks).toEqual([offFallbackDiagnostic("medium", "medium")]);
	});

	it("gives the Azure catalog the OpenAI off entry without masking other levels", () => {
		expect(getModel("azure", "o3").thinkingLevelMap).toEqual({
			off: null,
			low: "low",
			medium: "medium",
			high: "high",
		});
		expect(getModel("azure", "gpt-5-pro").thinkingLevelMap).toEqual({ off: null, high: "high" });
		expect(getModel("azure", "gpt-5.1").thinkingLevelMap).not.toHaveProperty("minimal");
	});
});

describe("thinking off on budget-thinking Gemini models (#4552)", () => {
	it.each([
		["google/gemini-2.5-pro", "minimal", 128, getModel("google", "gemini-2.5-pro")],
		["google-vertex/gemini-2.5-pro", "minimal", 128, getModel("google-vertex", "gemini-2.5-pro")],
		["google/gemini-pro-latest", "low", -1, getModel("google", "gemini-pro-latest")],
		[
			"google/gemini-2.5-flash-lite whose map denies off",
			"minimal",
			512,
			{ ...getModel("google", "gemini-2.5-flash-lite"), thinkingLevelMap: { off: null } },
		],
		[
			"google-vertex/gemini-2.5-flash-lite whose map denies off",
			"minimal",
			128,
			{ ...getModel("google-vertex", "gemini-2.5-flash-lite"), thinkingLevelMap: { off: null } },
		],
	] as const)("runs %s at its lowest level's budget, %s, %d tokens", async (_name, level, budget, model) => {
		const off = await captureRequest(model);
		const lowest = await captureRequest(model, { reasoning: level });

		expect(off.payload.config?.thinkingConfig).toEqual({ thinkingBudget: budget });
		expect(lowest.payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: budget });
		expect(off.offFallbacks).toEqual([offFallbackDiagnostic(level, String(budget))]);
		expect(lowest.offFallbacks).toEqual([]);
	});

	it("denies off for Gemini 2.5 Pro only, in the catalog", () => {
		expect(getModel("google", "gemini-2.5-pro").thinkingLevelMap).toEqual({ off: null });
		expect(getModel("google-vertex", "gemini-2.5-pro").thinkingLevelMap).toEqual({ off: null });
		expect(getModel("google", "gemini-2.5-flash").thinkingLevelMap).toBeUndefined();
	});

	it.each([
		["low", 2048],
		["high", 32768],
	] as const)("keeps an explicit %s level on google/gemini-2.5-pro at budget %d", async (reasoning, budget) => {
		const { payload, offFallbacks } = await captureRequest(getModel("google", "gemini-2.5-pro"), { reasoning });

		expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: budget });
		expect(offFallbacks).toEqual([]);
	});
});
