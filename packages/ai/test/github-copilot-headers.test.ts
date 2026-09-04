import { describe, expect, test } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { buildCopilotDynamicHeaders, isRawCopilotToken } from "../src/api/github-copilot-headers.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModels } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};
const RAW_TOKEN = "github_pat_test_token";
const EXCHANGED_TOKEN = "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com";

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	return headers[name.toLowerCase()];
}

function response(body: string): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function anthropicResponse(): Response {
	return response(
		`${[
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
			})}`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
		].join("\n\n")}\n\n`,
	);
}

function completionsResponse(): Response {
	return response(
		`${[
			`data: ${JSON.stringify({
				id: "chatcmpl_test",
				object: "chat.completion.chunk",
				created: 1,
				model: "gpt-4.1",
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
			})}`,
			`data: ${JSON.stringify({
				id: "chatcmpl_test",
				object: "chat.completion.chunk",
				created: 1,
				model: "gpt-4.1",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			})}`,
			"data: [DONE]",
		].join("\n\n")}\n\n`,
	);
}

function responsesResponse(): Response {
	return response(
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}\n\n`,
	);
}

async function captureRequestHeaders(
	api: "anthropic-messages" | "openai-completions" | "openai-responses",
	apiKey: string | undefined,
	optionsHeaders?: Record<string, string>,
	modelIntegrationId?: string,
): Promise<Record<string, string>> {
	const baseModel = getModels("github-copilot").find((candidate) => candidate.api === api);
	if (!baseModel) throw new Error(`No ${api} models available through GitHub Copilot`);
	const model = modelIntegrationId
		? ({ ...baseModel, headers: { ...baseModel.headers, "Copilot-Integration-Id": modelIntegrationId } } as Model<
				"anthropic-messages" | "openai-completions" | "openai-responses"
			>)
		: baseModel;
	let captured: Record<string, string> | undefined;
	const fetchStub: typeof globalThis.fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		captured = Object.fromEntries(request.headers.entries());
		if (api === "anthropic-messages") return anthropicResponse();
		if (api === "openai-completions") return completionsResponse();
		return responsesResponse();
	};

	if (api === "anthropic-messages") {
		await streamAnthropic(model as Model<"anthropic-messages">, context, {
			apiKey,
			headers: optionsHeaders,
			fetch: fetchStub,
		}).result();
	} else if (api === "openai-completions") {
		await streamOpenAICompletions(model as Model<"openai-completions">, context, {
			apiKey,
			headers: optionsHeaders,
			fetch: fetchStub,
		}).result();
	} else {
		await streamOpenAIResponses(model as Model<"openai-responses">, context, {
			apiKey,
			headers: optionsHeaders,
			fetch: fetchStub,
		}).result();
	}

	expect(captured).toBeDefined();
	return captured!;
}

describe("GitHub Copilot token classification", () => {
	test.each([
		["github_pat_abc", true],
		["ghp_abc", true],
		["gho_abc", true],
		["ghu_abc", true],
		["arbitrary-token", true],
		["tid=abc;exp=123;proxy-ep=proxy.individual.githubcopilot.com", false],
		["prefix=abc;tid=abc;suffix=def", false],
		["", false],
		[undefined, false],
	] as const)("classifies %s as raw=%s", (token, expected) => {
		expect(isRawCopilotToken(token)).toBe(expected);
	});

	test("adds the raw-token integration id without exposing the credential", () => {
		const headers = buildCopilotDynamicHeaders({ messages: context.messages, hasImages: false, apiKey: RAW_TOKEN });
		expect(headers).toEqual({
			"X-Initiator": "user",
			"Openai-Intent": "conversation-edits",
			"Copilot-Integration-Id": "copilot-developer-cli",
		});
		expect(JSON.stringify(headers)).not.toContain(RAW_TOKEN);
	});

	test("does not add the integration id for exchanged or missing credentials", () => {
		for (const apiKey of [EXCHANGED_TOKEN, undefined]) {
			const headers = buildCopilotDynamicHeaders({ messages: context.messages, hasImages: false, apiKey });
			expect(headers).not.toHaveProperty("Copilot-Integration-Id");
		}
	});
});

describe.each(["anthropic-messages", "openai-completions", "openai-responses"] as const)(
	"Copilot headers for %s",
	(api) => {
		test("sends the developer CLI integration id for a raw GitHub token", async () => {
			const headers = await captureRequestHeaders(api, RAW_TOKEN);
			expect(headerValue(headers, "Copilot-Integration-Id")).toBe("copilot-developer-cli");
		});

		test("does not replace the OAuth integration id for an exchanged token", async () => {
			const headers = await captureRequestHeaders(api, EXCHANGED_TOKEN);
			expect(headerValue(headers, "Copilot-Integration-Id")).toBe("vscode-chat");
		});

		test("keeps a per-request integration id override", async () => {
			const headers = await captureRequestHeaders(api, RAW_TOKEN, {
				"Copilot-Integration-Id": "request-override",
			});
			expect(headerValue(headers, "Copilot-Integration-Id")).toBe("request-override");
		});

		test("keeps a provider/model integration id override", async () => {
			const headers = await captureRequestHeaders(api, RAW_TOKEN, undefined, "model-override");
			expect(headerValue(headers, "Copilot-Integration-Id")).toBe("model-override");
		});

		// Catalog and models.json headers are indistinguishable by provenance here,
		// so the builtin default is treated as replaceable.
		test("replaces a provider integration id that matches the builtin vscode-chat default", async () => {
			const headers = await captureRequestHeaders(api, RAW_TOKEN, undefined, "vscode-chat");
			expect(headerValue(headers, "Copilot-Integration-Id")).toBe("copilot-developer-cli");
		});

		test("per-request integration id overrides a provider vscode-chat default", async () => {
			const headers = await captureRequestHeaders(
				api,
				RAW_TOKEN,
				{ "Copilot-Integration-Id": "request-override" },
				"vscode-chat",
			);
			expect(headerValue(headers, "Copilot-Integration-Id")).toBe("request-override");
		});

		test("does not infer a raw token when authentication is supplied only by headers", async () => {
			const headers = await captureRequestHeaders(api, undefined, { Authorization: "Bearer supplied" });
			expect(headerValue(headers, "Copilot-Integration-Id")).toBe("vscode-chat");
		});
	},
);
