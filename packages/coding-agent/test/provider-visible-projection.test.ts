import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Api, Message, Model } from "@earendil-works/pi-ai/compat";
import { createProviderPayloadFitHook, FinalPayloadFitError, providerAwarePayloadTokenEstimate, ProviderPayloadRetryError, type PayloadFitState } from "../src/core/compaction/provider-payload-fit.ts";

const baseModel: Model<Api> = {
	id: "projection", name: "Projection", api: "openai-codex-responses", provider: "openai-codex",
	baseUrl: "https://example.com", reasoning: true, input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
};

describe("provider-visible input projection", () => {
	it("uses an explicit Responses-family projection and excludes output/transport-only fields", async () => {
		const visible = {
			instructions: "follow these instructions",
			input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
			tools: [{ type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
			tool_choice: "auto",
			text: { format: { type: "json_schema", name: "answer", schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
			reasoning: { effort: "high", summary: "auto" },
		};
		const first = await providerAwarePayloadTokenEstimate({
			...visible, max_output_tokens: 16, stream: true, store: false, prompt_cache_key: "routing-a",
		}, baseModel);
		const outputTransportChanged = await providerAwarePayloadTokenEstimate({
			...visible, max_output_tokens: 99_999, stream: false, store: true, prompt_cache_key: "routing-value-that-is-much-longer",
		}, baseModel);
		const visibleChanged = await providerAwarePayloadTokenEstimate({
			...visible, instructions: `${visible.instructions} with materially more context`,
			max_output_tokens: 16,
		}, baseModel);

		expect(first).toMatchObject({ confidence: "heuristic", source: "openai-responses-provider-visible-input" });
		expect(outputTransportChanged.tokens).toBe(first.tokens);
		expect(visibleChanged.tokens).toBeGreaterThan(first.tokens);
	});
	it.each([
		["openai-completions", { messages: [{ role: "user", content: "hi" }], tools: [{ function: { parameters: { type: "object" } } }], response_format: { type: "json_schema", json_schema: { schema: { type: "object" } } }, reasoning_effort: "high" }, "openai-chat-provider-visible-input"],
		["anthropic-messages", { system: "system", messages: [{ role: "user", content: "hi" }], tools: [{ input_schema: { type: "object" } }], tool_choice: { type: "auto" }, thinking: { type: "enabled", budget_tokens: 1_024 }, output_config: { effort: "high" } }, "anthropic-provider-visible-input"],
		["google-generative-ai", { contents: [{ role: "user", parts: [{ text: "hi" }] }], config: { systemInstruction: "system", tools: [{ functionDeclarations: [] }], toolConfig: { functionCallingConfig: { mode: "AUTO" } }, responseSchema: { type: "OBJECT" }, thinkingConfig: { thinkingBudget: 1_024 }, maxOutputTokens: 9_999 } }, "google-provider-visible-input"],
		["google-vertex", { contents: [{ role: "user", parts: [{ text: "hi" }] }], config: { responseJsonSchema: { type: "object" }, thinkingConfig: { thinkingLevel: "HIGH" } } }, "google-provider-visible-input"],
		["mistral-conversations", { messages: [{ role: "user", content: "hi" }], tools: [{ function: { parameters: { type: "object" } } }], toolChoice: "auto", promptMode: "reasoning", reasoningEffort: "high" }, "mistral-provider-visible-input"],
		["bedrock-converse-stream", { system: [{ text: "system" }], messages: [{ role: "user", content: [{ text: "hi" }] }], toolConfig: { tools: [{ toolSpec: { inputSchema: { json: { type: "object" } } } }] }, additionalModelRequestFields: { thinking: { type: "enabled" } }, inferenceConfig: { temperature: 0.3, maxTokens: 9_999 } }, "bedrock-provider-visible-input"],
	] as const)("projects explicit model-visible fields for %s", async (api, payload, source) => {
		const estimate = await providerAwarePayloadTokenEstimate(payload, { ...baseModel, api });
		expect(estimate).toMatchObject({ confidence: "heuristic", source });
		expect(estimate.tokens).toBeGreaterThan(16);
	});

	it("reports image/file projections as unavailable instead of treating encoded media as ordinary JSON", async () => {
		for (const block of [
			{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
			{ type: "input_file", file_data: "opaque-file-bytes" },
		]) {
			const estimate = await providerAwarePayloadTokenEstimate({ input: [{ role: "user", content: [block] }] }, baseModel);
			expect(estimate.confidence).toBe("unavailable");
			expect(estimate.source).toBe("openai-responses-provider-visible-input-media-unbounded");
		}
	});

	it("labels opaque custom payloads generically and leaves ordinary transport permissive", async () => {
		const cyclic: Record<string, unknown> = { messages: [{ role: "user", content: "hello" }] };
		cyclic.self = cyclic;
		const custom = { ...baseModel, api: "custom-opaque-api", contextWindow: 1 };
		const estimate = await providerAwarePayloadTokenEstimate(cyclic, custom);
		expect(estimate).toEqual({ tokens: 0, confidence: "unavailable", source: "generic-provider-payload-unavailable" });
		const state = { maxTokens: 0, finalPayloadProven: false };
		await expect(createProviderPayloadFitHook(custom, 1, state)(cyclic)).resolves.toBe(cyclic);
		expect(state.finalPayloadProven).toBe(true);
	});

	it("uses captured occupancy plus one suffix only for an exactly unchanged visible prefix", async () => {
		const historical = {
			instructions: "stable", input: [{ role: "user", content: [{ type: "input_text", text: "old" }] }],
			tools: [{ type: "function", name: "read", parameters: { type: "object" } }], text: { verbosity: "low" },
			reasoning: { effort: "high" }, max_output_tokens: 64,
		};
		const suffix = { role: "user", content: [{ type: "input_text", text: "compact now" }] };
		const prefix = {
			requestGeneration: 1,
			identity: { api: baseModel.api, provider: baseModel.provider, model: baseModel.id, baseUrl: baseModel.baseUrl },
			messages: [] as Message[], finalPayload: historical, providerInputTokens: 1_000,
		};
		const state: PayloadFitState & { countSource?: string } = { maxTokens: 0, finalPayloadProven: false };
		await createProviderPayloadFitHook(baseModel, 64, state, prefix)({ ...historical, input: [...historical.input, suffix] });

		expect(state).toMatchObject({
			countConfidence: "projection", countSource: "captured-provider-usage-plus-suffix",
		});
		expect(state.inputTokens).toBeGreaterThan(1_000);
	});

	it.each([
		["instructions", "changed instructions with additional context"],
		["tools", [{ type: "function", name: "changed_tool", parameters: { type: "object", properties: { value: { type: "string" } } } }]],
		["text", { format: { type: "json_schema", name: "changed", schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } } } }],
		["reasoning", { effort: "minimal", summary: "detailed" }],
	] as const)("restores captured %s when the generated candidate drifts outside the sequence", async (field, changed) => {
		const historical: Record<string, unknown> = {
			instructions: "stable", input: [{ role: "user", content: [{ type: "input_text", text: "old" }] }],
			tools: [{ type: "function", name: "read", parameters: { type: "object" } }], text: { verbosity: "low" },
			reasoning: { effort: "high" }, max_output_tokens: 64,
		};
		const prefix = {
			identity: { api: baseModel.api, provider: baseModel.provider, model: baseModel.id, baseUrl: baseModel.baseUrl },
			messages: [] as Message[], finalPayload: historical, providerInputTokens: 100,
		};
		const candidate = {
			...historical, [field]: changed,
			input: [...historical.input as unknown[], { role: "user", content: [{ type: "input_text", text: "suffix" }] }],
		};
		const state: PayloadFitState = { maxTokens: 0, finalPayloadProven: false };
		const returned = await createProviderPayloadFitHook(baseModel, 64, state, prefix)(candidate) as Record<string, unknown>;

		expect(returned[field]).toEqual(historical[field]);
		expect(returned[field]).not.toEqual(changed);
		expect(state).toMatchObject({ countConfidence: "projection", countSource: "captured-provider-usage-plus-suffix" });
	});

	it("fingerprints the exact post-hook transport and does not count output-only changes as smaller input", async () => {
		const payload = { messages: [{ role: "user", content: [{ type: "text", text: "same input" }] }], max_tokens: 999 };
		const state: PayloadFitState = { maxTokens: 0, finalPayloadProven: false };
		const returned = await createProviderPayloadFitHook({ ...baseModel, api: "anthropic-messages" }, 16, state)(structuredClone(payload)) as Record<string, unknown>;
		const finalFingerprint = createHash("sha256").update(JSON.stringify(returned)).digest("hex");

		expect(returned.max_tokens).toBe(16);
		expect(state.payloadFingerprint).toBe(finalFingerprint);
		const guard = {
			rejectedTransportFingerprints: new Set([state.payloadFingerprint!]),
			rejectedInputFingerprints: new Set([state.inputFingerprint!]),
			strictlySmallerThanInputBytes: state.inputBytes,
		};
		await expect(createProviderPayloadFitHook(
			{ ...baseModel, api: "anthropic-messages" }, 17, { maxTokens: 0, finalPayloadProven: false }, undefined, undefined, guard,
		)(structuredClone(payload))).rejects.toBeInstanceOf(ProviderPayloadRetryError);
	});

	it("accepts configured Responses output at 16 and 17 and rejects every exact 15-token boundary", async () => {
		const payload = { input: [{ role: "user", content: [{ type: "input_text", text: "small" }] }], max_output_tokens: 999 };
		const counter = async () => ({ tokens: 100, confidence: "exact" as const, source: "test-provider" });
		const responses = { ...baseModel, api: "openai-responses", contextWindow: 1_000, maxInputTokens: 900, maxTokens: 100 };
		for (const desired of [16, 17]) {
			const state: PayloadFitState = { maxTokens: 0, finalPayloadProven: false };
			const returned = await createProviderPayloadFitHook(responses, desired, state, undefined, counter)(structuredClone(payload)) as Record<string, unknown>;
			expect(returned.max_output_tokens, `configured desired output ${desired}`).toBe(desired);
			expect(state.finalPayloadProven).toBe(true);
		}
		for (const [label, candidateModel, desired] of [
			["configured reserve", responses, 15],
			["model max", { ...responses, maxTokens: 15 }, 100],
			["remaining context", { ...responses, contextWindow: 115 }, 100],
		] as const) {
			let failure: FinalPayloadFitError | undefined;
			try {
				await createProviderPayloadFitHook(candidateModel, desired, { maxTokens: 0, finalPayloadProven: false }, undefined, counter)(structuredClone(payload));
			} catch (error) {
				if (error instanceof FinalPayloadFitError) failure = error;
				else throw error;
			}
			expect(failure?.requestMaxTokens, label).toBe(15);
			expect(failure?.failure, label).toBe(label === "remaining context" ? "input_headroom" : "output_budget");
		}
	});

});
