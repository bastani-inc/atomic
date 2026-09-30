import assert from "node:assert/strict";
import { test } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

for (const apiKey of ["chatgpt-access-token", "sk-api-key"] as const) {
	test(`direct OpenAI ${apiKey.startsWith("sk-") ? "API key retains" : "ChatGPT omits"} unsupported fields`, async () => {
		const base = getModel("openai", "gpt-6.1-sol")!;
		const model = {
			...base,
			compat: { ...base.compat, supportsLongCacheRetention: true, supportsExplicitPromptCacheMode: false },
		};
		let captured: Record<string, unknown> | undefined;
		await stream(model, normalizeContext({ messages: [] }), {
			apiKey,
			maxTokens: 128,
			temperature: 0.2,
			cacheRetention: "long",
			sessionId: "test-session",
			onPayload: (payload) => {
				captured = payload as Record<string, unknown>;
				throw new Error("captured");
			},
		}).result();
		assert.ok(captured);
		if (apiKey.startsWith("sk-")) {
			assert.equal(captured.max_output_tokens, 128);
			assert.equal(captured.temperature, 0.2);
			assert.equal(captured.prompt_cache_retention, "24h");
		} else {
			assert.equal(captured.max_output_tokens, undefined);
			assert.equal(captured.temperature, undefined);
			assert.equal(captured.prompt_cache_retention, undefined);
			assert.equal(captured.prompt_cache_options, undefined);
		}
		assert.equal(captured.prompt_cache_key, "test-session");
	});
}
