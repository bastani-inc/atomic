import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { getModel, getModels, streamSimple } from "../src/compat.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { githubCopilotProvider } from "../src/providers/github-copilot.ts";

const MODEL_ID = "gpt-6.1-sol";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

describe("GitHub Copilot GPT-6.1 Sol", () => {
	it("registers one canonical Copilot Responses model with provider-published limits and efforts", () => {
		const entries = getModels("github-copilot").filter((model) => model.id === MODEL_ID);
		assert.equal(entries.length, 1);
		const model = entries[0];
		assert.equal(model.provider, "github-copilot");
		assert.equal(model.api, "openai-responses");
		assert.equal(model.baseUrl, "https://api.individual.githubcopilot.com");
		assert.equal(model.contextWindow, 1_050_000);
		assert.equal(model.maxTokens, 128_000);
		assert.equal(model.reasoning, true);
		assert.deepEqual(getSupportedThinkingLevels(model), EFFORTS);
		assert.equal(model.thinkingLevelMap?.off, null);
		assert.equal(model.thinkingLevelMap?.minimal, null);
		assert.equal(
			getModels("github-copilot").some((candidate) => candidate.id === "gpt-6-sol-1"),
			false,
		);
	});

	it("respects account-advertised availability for the canonical identity", () => {
		const provider = githubCopilotProvider();
		const models = provider.getModels();
		const credential = { type: "oauth" as const, access: "copilot-test", refresh: "unused", expires: 0 };
		const available = provider.filterModels?.(models, { ...credential, availableModelIds: [MODEL_ID] });
		assert.deepEqual(
			available?.map((model) => model.id),
			[MODEL_ID],
		);
		const unavailable = provider.filterModels?.(models, { ...credential, availableModelIds: [] });
		assert.equal(
			unavailable?.some((model) => model.id === MODEL_ID),
			false,
		);
	});

	it.each(EFFORTS)("sends canonical Copilot Responses identity and %s effort without a Codex tier", async (effort) => {
		const model = getModel("github-copilot", MODEL_ID);
		let request: Request | undefined;
		const result = await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
				reasoning: effort,
				maxTokens: 128_000,
				fetch: async (input, init) => {
					request = input instanceof Request ? input : new Request(input, init);
					return new Response(
						`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`,
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					);
				},
			},
		).result();
		assert.equal(result.stopReason, "stop");
		assert(request);
		assert.equal(request.url, "https://api.individual.githubcopilot.com/responses");
		assert.equal(request.headers.get("Copilot-Integration-Id"), "vscode-chat");
		const payload = JSON.parse(await request.text()) as {
			model: string;
			reasoning: { effort: string };
			max_output_tokens: number;
			service_tier?: string;
		};
		assert.equal(payload.model, MODEL_ID);
		assert.equal(payload.reasoning.effort, effort);
		assert.equal(payload.max_output_tokens, 128_000);
		assert.equal(payload.service_tier, undefined);
	});
});
