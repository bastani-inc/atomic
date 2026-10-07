import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { type BedrockOptions, stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";

interface BedrockThinkingPayload {
	additionalModelRequestFields?: {
		thinking?: {
			type: string;
			budget_tokens?: number;
			display?: string;
			block_binding?: { prefix_mismatch_behavior: string };
		};
		output_config?: { effort?: string };
		anthropic_beta?: string[];
		reasoning_effort?: string;
		reasoning?: { effort?: string };
	};
}

const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const ADAPTIVE_WITH_BINDING = {
	type: "adaptive",
	display: "summarized",
	block_binding: { prefix_mismatch_behavior: "drop_block" },
};

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

async function capturePayload(
	model: Model<"bedrock-converse-stream">,
	options?: BedrockOptions,
): Promise<BedrockThinkingPayload> {
	let capturedPayload: BedrockThinkingPayload | undefined;
	const s = streamBedrock(model, normalizeContext(makeContext()), {
		...options,
		reasoning: options?.reasoning ?? "high",
		onPayload: (payload) => {
			capturedPayload = payload as BedrockThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	for await (const event of s) {
		if (event.type === "error") {
			break;
		}
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}

	return capturedPayload;
}

describe("Bedrock thinking payload", () => {
	it("uses adaptive thinking for Claude Opus 4.8 when reasoning is enabled", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-8-v1",
			name: "Claude Opus 4.8 (Global)",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.8", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-8-v1",
			name: "Claude Opus 4.8 (Global)",
		};

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("uses adaptive thinking for Claude Fable 5 when reasoning is enabled", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5");

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("uses adaptive thinking for Claude Sonnet 5 when reasoning is enabled", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5");

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("uses adaptive thinking for Claude Opus 5 when reasoning is enabled", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5");

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5");

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Fable 5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5");

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
	});

	it("sends block_binding and the binding beta for Claude Opus 5.5 (#10324)", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5-5");

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it.each(["global.anthropic.claude-opus-4-6-v1", "global.anthropic.claude-sonnet-4-6"] as const)(
		"omits block_binding for %s (#10324)",
		async (modelId) => {
			const model = getModel("amazon-bedrock", modelId);

			const payload = await capturePayload(model);

			expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
		},
	);

	// Atomic generates three Bedrock inference-profile variants for Claude Fable 5.1, matching the
	// live models.dev catalog and Anthropic's Bedrock model-ID table. Each must send adaptive
	// thinking and honour the documented effort set. No `eu.` variant is published for this model.
	it.each([
		"anthropic.claude-fable-5-1",
		"global.anthropic.claude-fable-5-1",
		"us.anthropic.claude-fable-5-1",
	] as const)("uses adaptive thinking for Bedrock %s when reasoning is enabled", async (modelId) => {
		const model = getModel("amazon-bedrock", modelId);

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it.each([
		["low", "low"],
		["medium", "medium"],
		["high", "high"],
		["xhigh", "xhigh"],
		["max", "max"],
	] as const)("maps %s reasoning to effort=%s for Bedrock Claude Fable 5.1", async (reasoning, effort) => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1");

		const payload = await capturePayload(model, { reasoning });

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort });
	});

	it.each(["low", "medium", "high", "xhigh", "max"] as const)(
		"maps %s reasoning to reasoning_effort for Bedrock GPT-6-Astra",
		async (reasoning) => {
			const model = getModel("amazon-bedrock", "global.openai.gpt-6-astra");

			const payload = await capturePayload(model, { reasoning });

			expect(payload.additionalModelRequestFields).toEqual({ reasoning_effort: reasoning });
		},
	);

	it("never sends a thinking budget for Bedrock Claude Fable 5.1", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5-1");

		const payload = await capturePayload(model, { reasoning: "max" });

		expect(payload.additionalModelRequestFields?.thinking?.type).toBe("adaptive");
		expect(payload.additionalModelRequestFields?.thinking?.budget_tokens).toBeUndefined();
	});

	it("omits display for GovCloud model ids on non-adaptive Claude thinking", async () => {
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0",
			name: "Claude Sonnet 4.5 (GovCloud)",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);
	});

	it("omits display for GovCloud regions on adaptive Claude thinking", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-8-v1",
			name: "Claude Opus 4.8 (Global)",
		};

		const payload = await capturePayload(model, { region: "us-gov-west-1" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});
});

describe("Bedrock OpenAI reasoning payload", () => {
	it.each([
		["minimal", "low"],
		["low", "low"],
		["medium", "medium"],
		["high", "high"],
		["xhigh", "xhigh"],
		["max", "max"],
	] as const)("sends reasoning=%s as reasoning.effort=%s for GPT-6 and GPT-5.6 (#9331)", async (reasoning, effort) => {
		for (const id of ["global.openai.gpt-6-sol", "us.openai.gpt-6-luna", "global.openai.gpt-5.6-sol"] as const) {
			const payload = await capturePayload(getModel("amazon-bedrock", id), { reasoning });
			assert.deepEqual(payload.additionalModelRequestFields, { reasoning: { effort } }, id);
		}
	});

	it("sends reasoning.effort when only model.name identifies a GPT model", async () => {
		const model: Model<"bedrock-converse-stream"> = {
			...getModel("amazon-bedrock", "global.openai.gpt-6-sol"),
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "GPT-6 Sol",
		};
		const payload = await capturePayload(model, { reasoning: "medium" });
		assert.deepEqual(payload.additionalModelRequestFields, { reasoning: { effort: "medium" } });
	});

	it.each([
		["minimal", "low"],
		["low", "low"],
		["medium", "medium"],
		["high", "high"],
		["xhigh", "high"],
		["max", "high"],
	] as const)("sends reasoning=%s as flat reasoning_effort=%s for gpt-oss", async (reasoning, effort) => {
		const payload = await capturePayload(getModel("amazon-bedrock", "openai.gpt-oss-120b-1:0"), { reasoning });
		assert.deepEqual(payload.additionalModelRequestFields, { reasoning_effort: effort });
	});

	it("honors a custom GPT thinking-level mapping", async () => {
		const model: Model<"bedrock-converse-stream"> = {
			...getModel("amazon-bedrock", "global.openai.gpt-6-sol"),
			thinkingLevelMap: { high: "max" },
		};
		const payload = await capturePayload(model, { reasoning: "high" });
		assert.deepEqual(payload.additionalModelRequestFields, { reasoning: { effort: "max" } });
	});

	it("sends no reasoning fields when reasoning is off", async () => {
		let captured: BedrockThinkingPayload | undefined;
		const s = streamBedrock(getModel("amazon-bedrock", "global.openai.gpt-6-sol"), normalizeContext(makeContext()), {
			onPayload: (payload) => {
				captured = payload as BedrockThinkingPayload;
				throw new PayloadCaptured();
			},
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}
		assert.ok(captured);
		assert.equal(captured.additionalModelRequestFields, undefined);
	});
});

describe.skipIf(!hasBedrockCredentials())("Bedrock Claude max tokens E2E", () => {
	it("uses the model maxTokens cap instead of Bedrock's 4096-token default for adaptive Claude models", {
		retry: 2,
		timeout: 180000,
	}, async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			maxTokens: 6000,
		};

		const response = await streamBedrock(
			model,
			normalizeContext({
				systemPrompt: "You are a deterministic text generator. Follow the requested output format exactly.",
				messages: [
					{
						role: "user",
						content:
							"Output exactly 5200 repetitions of the token alpha, separated by single spaces. Do not number them. Do not use markdown. Do not add any other text.",
						timestamp: Date.now(),
					},
				],
			}),
			{ reasoning: "low" },
		).result();

		expect(response.stopReason, response.errorMessage).not.toBe("error");
		expect(response.usage.output).toBeGreaterThan(4096);
	});
});

describe("Application inference profile support", () => {
	it("uses adaptive thinking when model.name contains the model name but ARN does not", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Opus 4.6",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
	});

	it("injects cache points when model.name identifies a supported Claude model", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Sonnet 4.6",
		};

		let capturedPayload: any;
		const s = streamBedrock(
			model,
			normalizeContext({
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			}),
			{
				onPayload: (payload) => {
					capturedPayload = payload;
					throw new PayloadCaptured();
				},
			},
		);

		for await (const event of s) {
			if (event.type === "error") break;
		}

		// System prompt should have a cache point
		expect(capturedPayload.system).toHaveLength(2);
		expect(capturedPayload.system[1]).toHaveProperty("cachePoint");

		// Last user message should have a cache point
		const lastMsg = capturedPayload.messages[capturedPayload.messages.length - 1];
		const lastContent = lastMsg.content[lastMsg.content.length - 1];
		expect(lastContent).toHaveProperty("cachePoint");
	});

	it("falls back to fixed-budget thinking for non-adaptive Claude via model.name", async () => {
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Sonnet 4.5",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "enabled",
			budget_tokens: expect.any(Number),
		});
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);
	});
});
