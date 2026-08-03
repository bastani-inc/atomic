/**
 * P4 probe — the inherited raw-stop-reason batch (upstream `926eb15c`,
 * `637737ca`, `23cb385b`, `5a53f086`, `e5ef8d06`, `fe1c9b6d`).
 *
 * Upstream now surfaces an *unmapped* terminal reason as a provider error
 * instead of a successful stop. That is the change this repository inherits and
 * does not own. The risk it carries is the opposite direction: a raw reason that
 * previously mapped to a successful stop must still map to one. A probe that
 * only asserted the new error would pass just as happily if every provider had
 * started erroring on `end_turn`.
 *
 * So each case drives the real pi-ai stream over a canned provider response and
 * asserts the *mapped* reason and the absence of an error message. The final
 * case in each family asserts the inherited behaviour itself, which is also what
 * proves the success cases are discriminating rather than vacuous.
 */

import assert from "node:assert/strict";
import { stream as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamGoogleGenerativeAi } from "@earendil-works/pi-ai/api/google-generative-ai";
import { stream as streamOpenAiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import type { Api, AssistantMessage, Context, Model, StopReason } from "@earendil-works/pi-ai/compat";
import { afterEach, test, vi } from "vitest";

afterEach(() => {
	vi.restoreAllMocks();
});

const CONTEXT: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
};

function model<TApi extends Api>(api: TApi, baseUrl: string): Model<TApi> {
	return {
		id: `${api}-probe`,
		name: `${api} probe`,
		provider: "stop-reason-probe",
		api,
		baseUrl,
		contextWindow: 10_000,
		maxTokens: 1_000,
		input: ["text"],
		output: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as unknown as Model<TApi>;
}

function sseResponse(frames: string[]): Response {
	return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Answer every request in one case with the same canned provider body. */
function respondWith(body: () => Response): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => body());
}

function anthropicBody(rawStopReason: string, withToolCall = false): Response {
	const content = withToolCall
		? [
				{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read" } },
				{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
				{ type: "content_block_stop", index: 0 },
			]
		: [
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
				{ type: "content_block_stop", index: 0 },
			];
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg",
				type: "message",
				role: "assistant",
				content: [],
				model: "probe",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		},
		...content,
		{
			type: "message_delta",
			delta: { stop_reason: rawStopReason, stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
	return sseResponse(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
}

function openAiCompletionsBody(rawFinishReason: string, withToolCall = false): Response {
	const first = withToolCall
		? {
				id: "1",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{ index: 0, id: "t1", type: "function", function: { name: "read", arguments: "{}" } },
							],
						},
						finish_reason: null,
					},
				],
			}
		: { id: "1", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] };
	const last = {
		id: "1",
		choices: [{ index: 0, delta: {}, finish_reason: rawFinishReason }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
	return sseResponse([...[first, last].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"]);
}

function googleBody(rawFinishReason: string): Response {
	const chunks = [
		{ candidates: [{ index: 0, content: { parts: [{ text: "ok" }] } }] },
		{
			candidates: [{ index: 0, content: { parts: [] }, finishReason: rawFinishReason }],
			usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
		},
	];
	return sseResponse(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`));
}

/**
 * Raw terminal reasons that reached a *successful* stop before the batch, with
 * the mapped reason each one must still produce. `pause_turn` and
 * `stop_sequence` are the load-bearing rows: they are the reasons a mapper is
 * most likely to drop into its new unmapped-is-an-error default.
 */
const ANTHROPIC_SUCCESSES: ReadonlyArray<readonly [string, StopReason, boolean]> = [
	["end_turn", "stop", false],
	["max_tokens", "length", false],
	["pause_turn", "stop", false],
	["stop_sequence", "stop", false],
	["tool_use", "toolUse", true],
];

const OPENAI_COMPLETIONS_SUCCESSES: ReadonlyArray<readonly [string, StopReason, boolean]> = [
	["stop", "stop", false],
	["end", "stop", false],
	["length", "length", false],
	["tool_calls", "toolUse", true],
	["function_call", "toolUse", true],
];

const GOOGLE_SUCCESSES: ReadonlyArray<readonly [string, StopReason]> = [
	["STOP", "stop"],
	["MAX_TOKENS", "length"],
];

function assertSucceeded(message: AssistantMessage, expected: StopReason, label: string): void {
	assert.equal(message.stopReason, expected, `${label} must still map to ${expected}`);
	assert.equal(message.errorMessage, undefined, `${label} must not carry a provider error message`);
}

test("anthropic-messages terminal reasons that succeeded before still succeed", async () => {
	for (const [raw, expected, withToolCall] of ANTHROPIC_SUCCESSES) {
		respondWith(() => anthropicBody(raw, withToolCall));
		const result = await streamAnthropicMessages(model("anthropic-messages", "https://anthropic.probe"), CONTEXT, {
			apiKey: "probe-key",
		}).result();
		assertSucceeded(result, expected, `anthropic ${raw}`);
		vi.restoreAllMocks();
	}
});

test("an unmapped anthropic-messages reason is a provider error, not a silent stop", async () => {
	respondWith(() => anthropicBody("reason_invented_after_this_release"));
	const result = await streamAnthropicMessages(model("anthropic-messages", "https://anthropic.probe"), CONTEXT, {
		apiKey: "probe-key",
	}).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /reason_invented_after_this_release/u);
});

test("openai-completions finish reasons that succeeded before still succeed", async () => {
	for (const [raw, expected, withToolCall] of OPENAI_COMPLETIONS_SUCCESSES) {
		respondWith(() => openAiCompletionsBody(raw, withToolCall));
		const result = await streamOpenAiCompletions(model("openai-completions", "https://openai.probe/v1"), CONTEXT, {
			apiKey: "probe-key",
		}).result();
		assertSucceeded(result, expected, `openai-completions ${raw}`);
		vi.restoreAllMocks();
	}
});

test("an unmapped openai-completions finish reason is a provider error", async () => {
	respondWith(() => openAiCompletionsBody("finish_reason_invented_after_this_release"));
	const result = await streamOpenAiCompletions(model("openai-completions", "https://openai.probe/v1"), CONTEXT, {
		apiKey: "probe-key",
	}).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /finish_reason_invented_after_this_release/u);
});

test("google-generative-ai finish reasons that succeeded before still succeed", async () => {
	for (const [raw, expected] of GOOGLE_SUCCESSES) {
		respondWith(() => googleBody(raw));
		const result = await streamGoogleGenerativeAi(
			model("google-generative-ai", "https://google.probe/v1beta"),
			CONTEXT,
			{ apiKey: "probe-key" },
		).result();
		assertSucceeded(result, expected, `google ${raw}`);
		vi.restoreAllMocks();
	}
});

/**
 * The Google mapper reaches a terminal state for a safety block and reports it
 * as an error. That is the pre-existing shape, not the new batch — asserting it
 * here keeps the success rows above from being read as "google never errors".
 */
test("a google safety block stays a provider error with the raw reason attached", async () => {
	respondWith(() => googleBody("SAFETY"));
	const result = await streamGoogleGenerativeAi(
		model("google-generative-ai", "https://google.probe/v1beta"),
		CONTEXT,
		{
			apiKey: "probe-key",
		},
	).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /SAFETY/u);
});
