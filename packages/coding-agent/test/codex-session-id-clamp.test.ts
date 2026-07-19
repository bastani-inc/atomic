import type { Context, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";

function token(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400_000,
	maxTokens: 128_000,
};

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

afterEach(() => vi.restoreAllMocks());

describe("Pi v0.80.10 Codex session inheritance", () => {
	it("clamps Atomic session IDs to the transport's 64-character limit", async () => {
		const inheritedSessionId = `atomic-${"x".repeat(100)}`;
		let requestSessionId: string | null | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = input.toString();
			if (url.includes("api.github.com/repos/openai/codex/releases/latest")) {
				return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
			}
			if (url.includes("raw.githubusercontent.com/openai/codex/")) return new Response("PROMPT", { status: 200 });
			if (url === "https://chatgpt.com/backend-api/codex/responses") {
				requestSessionId = new Headers(init?.headers).get("session-id");
				const response = {
					type: "response.completed",
					response: {
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
					},
				};
				return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const result = streamSimple(model, context, {
			apiKey: token(),
			sessionId: inheritedSessionId,
			transport: "sse",
		});
		await result.result();

		expect(requestSessionId).toBe(inheritedSessionId.slice(0, 64));
		expect(requestSessionId).toHaveLength(64);
	});
});
