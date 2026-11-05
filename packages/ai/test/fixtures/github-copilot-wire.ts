/**
 * Synthetic GitHub Copilot wire fixtures, one set per model family Copilot serves beyond OpenAI and Anthropic.
 *
 * Each shape follows what Atomic observed from Copilot in live calls: Gemini on Chat Completions (one chunk per
 * parallel tool call with complete JSON arguments and an `index`, `call_`-prefixed IDs, an opaque
 * `reasoning_opaque` value on the first tool-call chunk or on the final chunk, all-zero usage on intermediate chunks,
 * and a final usage whose top-level `reasoning_tokens` sits outside `completion_tokens`), Responses models
 * (parallel `function_call` items, `call-<uuid>-<n>` call IDs with long base64 item IDs on Grok, an encrypted
 * reasoning item on Grok and none on a synthetic vendor model, reasoning tokens in `output_tokens_details`). Kimi K3 was not
 * offered to the accounts used, so its fixture uses the Chat Completions shapes with argument deltas split mid-JSON
 * and readable `reasoning_text`, which Atomic's Chat Completions adapter also accepts. Every ID, opaque value, token
 * count and text here is invented.
 */

export type WireEvent = Record<string, unknown>;

/** A Server-Sent Events body; Chat Completions streams end with `[DONE]`. */
export function sseBody(events: readonly WireEvent[], options?: { readonly done?: boolean }): string {
	const lines = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
	if (options?.done !== false) lines.push("data: [DONE]\n\n");
	return lines.join("");
}

const ZERO_CHAT_USAGE = {
	completion_tokens: 0,
	prompt_tokens: 0,
	prompt_tokens_details: { cached_tokens: 0 },
	total_tokens: 0,
};

export function chatChunk(delta: WireEvent, options?: { finish?: string; usage?: WireEvent }): WireEvent {
	return {
		id: "chatcmpl-fixture",
		created: 1_700_000_000,
		model: "fixture",
		choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: options?.finish ?? null }],
		usage: options?.usage ?? ZERO_CHAT_USAGE,
	};
}

export const GEMINI_OPAQUE_REASONING = "c3ludGhldGljLW9wYXF1ZS1yZWFzb25pbmctMQ==";

/** Gemini: two parallel calls, the second with no arguments; the opaque reasoning rides on the first call's chunk. */
export const GEMINI_PARALLEL_TOOL_TURN: readonly WireEvent[] = [
	chatChunk({
		content: null,
		tool_calls: [
			{
				index: 0,
				id: "call_Rml4dHVyZUNhbGxPbmU",
				type: "function",
				function: { name: "get_weather", arguments: '{"city":"Paris"}' },
			},
		],
		reasoning_opaque: GEMINI_OPAQUE_REASONING,
	}),
	chatChunk({
		content: null,
		tool_calls: [
			{ index: 1, id: "call_Rml4dHVyZUNhbGxUd28", type: "function", function: { name: "ping", arguments: "{}" } },
		],
	}),
	chatChunk(
		{ content: null },
		{
			finish: "tool_calls",
			usage: {
				completion_tokens: 24,
				prompt_tokens: 38,
				prompt_tokens_details: { cached_tokens: 0 },
				total_tokens: 102,
				reasoning_tokens: 40,
			},
		},
	),
];

/** Gemini: text first, then the opaque reasoning on the final chunk with the finish reason. */
export const GEMINI_TEXT_TURN: readonly WireEvent[] = [
	chatChunk({ content: "Paris is " }),
	chatChunk({ content: "sunny." }),
	chatChunk(
		{ content: null, reasoning_opaque: "c3ludGhldGljLW9wYXF1ZS1yZWFzb25pbmctMg==" },
		{
			finish: "stop",
			usage: {
				completion_tokens: 8,
				prompt_tokens: 61,
				prompt_tokens_details: { cached_tokens: 0 },
				total_tokens: 91,
				reasoning_tokens: 22,
			},
		},
	),
];

/** Gemini's empty turn: only opaque reasoning, then a normal stop. */
export const GEMINI_EMPTY_TURN: readonly WireEvent[] = [
	chatChunk(
		{ content: null, reasoning_opaque: "c3ludGhldGljLW9wYXF1ZS1lbXB0eQ==" },
		{
			finish: "stop",
			usage: {
				completion_tokens: 0,
				prompt_tokens: 61,
				prompt_tokens_details: { cached_tokens: 0 },
				total_tokens: 75,
				reasoning_tokens: 14,
			},
		},
	),
];

/** Kimi on Chat Completions: readable reasoning, then two calls whose arguments arrive split mid-JSON. */
export const KIMI_SPLIT_ARGUMENTS_TOOL_TURN: readonly WireEvent[] = [
	chatChunk({ reasoning_text: "Two lookups are needed." }),
	chatChunk({
		tool_calls: [
			{ index: 0, id: "call_kimi_fixture_0", type: "function", function: { name: "get_weather", arguments: "" } },
		],
	}),
	chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }),
	chatChunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"Ro' } }] }),
	chatChunk({ tool_calls: [{ index: 0, function: { arguments: 'me"}' } }] }),
	chatChunk({ tool_calls: [{ index: 1, id: "call_kimi_fixture_1", type: "function", function: { name: "ping" } }] }),
	chatChunk(
		{},
		{
			finish: "tool_calls",
			usage: {
				completion_tokens: 30,
				prompt_tokens: 50,
				prompt_tokens_details: { cached_tokens: 10 },
				total_tokens: 80,
				completion_tokens_details: { reasoning_tokens: 12 },
			},
		},
	),
];

export const KIMI_TEXT_TURN: readonly WireEvent[] = [
	chatChunk({ content: "Rome is " }),
	chatChunk({ content: "mild." }),
	chatChunk(
		{},
		{
			finish: "stop",
			usage: {
				completion_tokens: 5,
				prompt_tokens: 70,
				prompt_tokens_details: { cached_tokens: 0 },
				total_tokens: 75,
				completion_tokens_details: { reasoning_tokens: 0 },
			},
		},
	),
];

/** A Chat Completions stream cut off before its finish reason. */
export const CHAT_TRUNCATED_TURN: readonly WireEvent[] = [chatChunk({ content: "Partial" })];

/** A Chat Completions stream that ends with a content-filter finish reason. */
export const CHAT_CONTENT_FILTER_TURN: readonly WireEvent[] = [
	chatChunk({ content: null }, { finish: "content_filter" }),
];

/** A Chat Completions in-stream error chunk after HTTP 200. */
export function chatErrorChunk(code: string, message: string): WireEvent {
	return { error: { code, message } };
}

const GROK_CALL_PREFIX = "call-0f1e2d3c-4b5a-4968-8776-655443322110";
export const GROK_ITEM_IDS = [
	"R3Jva0l0ZW1GaXh0dXJlT25l+/aGVsbG8vd29ybGQ+cGx1cw==",
	"R3Jva0l0ZW1GaXh0dXJlVHdv+/c2Vjb25kL2l0ZW0+cGx1cw==",
] as const;
export const GROK_ENCRYPTED_REASONING = "Z3Jvay1lbmNyeXB0ZWQtcmVhc29uaW5nLWZpeHR1cmU=";

function responsesUsage(input: number, output: number, reasoning: number, cached = 0): WireEvent {
	return {
		input_tokens: input,
		input_tokens_details: { cached_tokens: cached },
		output_tokens: output,
		output_tokens_details: { reasoning_tokens: reasoning },
		total_tokens: input + output,
	};
}

function functionCall(index: number, callId: string, itemId: string, name: string, args: string): WireEvent[] {
	const item = { type: "function_call", id: itemId, call_id: callId, name, arguments: "", status: "in_progress" };
	const deltas = args.length > 4 ? [args.slice(0, 4), args.slice(4)] : [args];
	return [
		{ type: "response.output_item.added", output_index: index, item },
		...deltas.map((delta) => ({
			type: "response.function_call_arguments.delta",
			output_index: index,
			item_id: itemId,
			delta,
		})),
		{ type: "response.function_call_arguments.done", output_index: index, item_id: itemId, arguments: args },
		{
			type: "response.output_item.done",
			output_index: index,
			item: { ...item, arguments: args, status: "completed" },
		},
	];
}

function reasoningItem(index: number, id: string, summary: string, encrypted: string): WireEvent[] {
	const item = { type: "reasoning", id, summary: [] };
	return [
		{ type: "response.output_item.added", output_index: index, item },
		{
			type: "response.reasoning_summary_text.delta",
			output_index: index,
			item_id: id,
			summary_index: 0,
			delta: summary,
		},
		{
			type: "response.output_item.done",
			output_index: index,
			item: { ...item, summary: [{ type: "summary_text", text: summary }], encrypted_content: encrypted },
		},
	];
}

function messageItem(index: number, id: string, text: string): WireEvent[] {
	const item = { type: "message", id, role: "assistant", status: "in_progress", content: [] };
	return [
		{ type: "response.output_item.added", output_index: index, item },
		{ type: "response.output_text.delta", output_index: index, item_id: id, content_index: 0, delta: text },
		{
			type: "response.output_item.done",
			output_index: index,
			item: { ...item, status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
		},
	];
}

function responseEnvelope(id: string, status: string, extra?: WireEvent): WireEvent {
	return { id, object: "response", status, output: [], ...extra };
}

function responsesTurn(id: string, body: readonly WireEvent[], usage: WireEvent): WireEvent[] {
	return [
		{ type: "response.created", response: responseEnvelope(id, "in_progress") },
		{ type: "response.in_progress", response: responseEnvelope(id, "in_progress") },
		...body,
		{ type: "response.completed", response: responseEnvelope(id, "completed", { usage }) },
	];
}

/** Grok: an encrypted reasoning item, then two parallel calls (the second with no arguments). */
export const GROK_PARALLEL_TOOL_TURN: readonly WireEvent[] = responsesTurn(
	"resp_grok_fixture_1",
	[
		...reasoningItem(0, "rs_grok_fixture", "Looking up weather and pinging.", GROK_ENCRYPTED_REASONING),
		...functionCall(1, `${GROK_CALL_PREFIX}-0`, GROK_ITEM_IDS[0], "get_weather", '{"city":"Paris"}'),
		...functionCall(2, `${GROK_CALL_PREFIX}-1`, GROK_ITEM_IDS[1], "ping", "{}"),
	],
	responsesUsage(1756, 44, 28, 1536),
);

export const GROK_TEXT_TURN: readonly WireEvent[] = responsesTurn(
	"resp_grok_fixture_2",
	[
		...reasoningItem(0, "rs_grok_fixture_2", "Summarizing.", "Z3Jvay1zZWNvbmQtcmVhc29uaW5n"),
		...messageItem(1, "msg_grok_fixture", "Paris is sunny; ping returned."),
	],
	responsesUsage(1800, 30, 12),
);

export const VENDOR_PARALLEL_TOOL_TURN: readonly WireEvent[] = responsesTurn(
	"resp_vendor_fixture_1",
	[
		...functionCall(0, "call_vendor_fixture_0", "fc_vendor_fixture_0", "get_weather", '{"city":"Rome"}'),
		...functionCall(1, "call_vendor_fixture_1", "fc_vendor_fixture_1", "ping", "{}"),
	],
	responsesUsage(900, 40, 0),
);

export const VENDOR_TEXT_TURN: readonly WireEvent[] = responsesTurn(
	"resp_vendor_fixture_2",
	[...messageItem(0, "msg_vendor_fixture", "Rome is mild.")],
	responsesUsage(950, 6, 0),
);

/** A Responses turn that completes with only a reasoning item: no text and no call. */
export const RESPONSES_EMPTY_TURN: readonly WireEvent[] = responsesTurn(
	"resp_empty_fixture",
	[...reasoningItem(0, "rs_empty_fixture", "", "ZW1wdHktcmVhc29uaW5n")],
	responsesUsage(500, 9, 9),
);

/** A Responses stream cut off before its terminal event. */
export const RESPONSES_TRUNCATED_TURN: readonly WireEvent[] = [
	{ type: "response.created", response: responseEnvelope("resp_cut_fixture", "in_progress") },
	...messageItem(0, "msg_cut_fixture", "Partial"),
];

/** A Responses turn the content filter cut short. */
export const RESPONSES_CONTENT_FILTER_TURN: readonly WireEvent[] = [
	{ type: "response.created", response: responseEnvelope("resp_filter_fixture", "in_progress") },
	{
		type: "response.incomplete",
		response: responseEnvelope("resp_filter_fixture", "incomplete", {
			incomplete_details: { reason: "content_filter" },
			usage: responsesUsage(400, 0, 0),
		}),
	},
];

/** A Responses in-stream error event after HTTP 200. */
export function responsesErrorEvents(code: string, message: string): WireEvent[] {
	return [
		{ type: "response.created", response: responseEnvelope("resp_error_fixture", "in_progress") },
		{ type: "error", code, message, param: null, sequence_number: 2 },
	];
}

/** A Responses `response.failed` terminal event carrying the provider's error code. */
export function responsesFailedEvents(code: string, message: string): WireEvent[] {
	return [
		{ type: "response.created", response: responseEnvelope("resp_failed_fixture", "in_progress") },
		{
			type: "response.failed",
			response: responseEnvelope("resp_failed_fixture", "failed", { error: { code, message } }),
		},
	];
}
