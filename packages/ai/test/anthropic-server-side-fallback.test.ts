import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, FallbackContent, Message, Model } from "../src/types.ts";

/**
 * Mid-stream server-side fallback.
 *
 * When a classifier declines partway through a response, Anthropic retries on a fallback model
 * within the same stream and marks the handoff: "The open content block closes, and the
 * `fallback` block (an ordinary `content_block_start` and `content_block_stop` pair with no
 * deltas) marks the boundary… `message_start` already named the requested model, so read the
 * serving model from the `fallback` block's `to.model`."
 *
 * The marker is not decorative. On the next turn: "Keep it exactly where it appeared. The API uses
 * its position to validate the thinking blocks around it, so a request that echoes thinking blocks
 * from both sides of the boundary is rejected if the block is omitted or moved." Thinking,
 * redacted thinking, and client-side tool calls *before* the final marker must be dropped; text
 * and everything after it is kept.
 * https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
 *
 * This matters on this branch specifically because Claude Fable 5.1 is generated with
 * `allowedFallbackModels`, so Atomic sends `fallbacks` and can receive these boundaries — and
 * because the branch also enabled cross-model thinking replay, which is exactly what the rejection
 * rule above governs.
 */

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: { create: () => ({ asResponse: async () => response }) },
	} as unknown as Anthropic;
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

interface CapturedBlock {
	type: string;
	tool_use_id?: string;
	from?: { model?: string };
	to?: { model?: string };
}
interface CapturedPayload {
	messages?: Array<{ role: string; content: CapturedBlock[] }>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

/** Capture the request body Atomic would send for a given history. */
async function capturePayload(model: Model<"anthropic-messages">, messages: Message[]): Promise<CapturedPayload> {
	let capturedPayload: CapturedPayload | undefined;

	const s = streamAnthropic(
		{ ...model, baseUrl: "http://127.0.0.1:9" },
		{ messages },
		{
			apiKey: "fake-key",
			onPayload: (payload) => {
				capturedPayload = payload as CapturedPayload;
				throw new PayloadCaptured();
			},
		},
	);

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}
	return capturedPayload;
}

interface UsageIteration {
	type: string;
	model: string;
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

/** The same stream, with a `usage.iterations` record on the final `message_delta`. */
function eventsWithIterations(iterations: UsageIteration[]): Array<{ event: string; data: string }> {
	return midOutputFallbackEvents().map((entry) => {
		if (entry.event !== "message_delta") return entry;
		const parsed = JSON.parse(entry.data);
		parsed.usage = { ...parsed.usage, iterations };
		return { event: entry.event, data: JSON.stringify(parsed) };
	});
}

/** A stream that starts on Fable 5.1, declines mid-output, and finishes on Opus 5. */
function midOutputFallbackEvents(): Array<{ event: string; data: string }> {
	return [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					model: "claude-fable-5-1",
					usage: { input_tokens: 1_000_000, output_tokens: 0 },
				},
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "Partial" },
			}),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		// The boundary: a start/stop pair with no deltas.
		{
			event: "content_block_start",
			data: JSON.stringify({
				type: "content_block_start",
				index: 1,
				content_block: {
					type: "fallback",
					from: { model: "claude-fable-5-1" },
					to: { model: "claude-opus-5" },
				},
			}),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 2,
				delta: { type: "text_delta", text: " answer" },
			}),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 2 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 1_000_000, output_tokens: 0 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
}

describe("mid-output server-side fallback", () => {
	it("records the boundary marker in place rather than dropping it", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(midOutputFallbackEvents())),
		}).result();

		expect(result.stopReason).toBe("stop");
		// The marker sits between the declining model's text and the serving model's text, which is
		// the position the API validates thinking blocks against.
		expect(result.content.map((block) => block.type)).toEqual(["text", "fallback", "text"]);
		expect(result.content[1]).toEqual({
			type: "fallback",
			fromModel: "claude-fable-5-1",
			toModel: "claude-opus-5",
		});
	});

	it("re-attributes the response to the serving model", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(midOutputFallbackEvents())),
		}).result();

		// `message_start` named the requested model; only the fallback block names the serving one.
		expect(result.model).toBe("claude-opus-5");
	});

	it("prices the returned message at the serving model's rates", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const opus = model.compat?.allowedFallbackModels?.find((f) => f.model === "claude-opus-5");
		expect(opus, "expected Opus 5 among the generated fallback targets").toBeDefined();
		// The two models are priced differently, which is what makes this assertion meaningful.
		expect(opus?.cost.input).not.toBe(model.cost.input);

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(midOutputFallbackEvents())),
		}).result();

		// 1M input tokens at Opus 5's rate, not Claude Fable 5.1's.
		expect(result.usage.cost.input).toBeCloseTo(opus!.cost.input, 10);
		expect(result.usage.cost.input).not.toBeCloseTo(model.cost.input, 10);
	});

	// Two paths that already worked and must keep working: `message_start` names the serving model
	// when the decline happens before any output, and on a sticky-routed later turn there is no
	// fallback block at all.
	it("leaves a turn with no fallback block attributed to the model that message_start named", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const events = midOutputFallbackEvents().filter((e) => !e.data.includes('"type":"fallback"'));
		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(events)),
		}).result();

		expect(result.model).toBe("claude-fable-5-1");
		expect(result.usage.cost.input).toBeCloseTo(model.cost.input, 10);
	});

	// "Every attempt that produced output… is billed separately at the rates of the model that ran
	// it… The top-level `usage` counts describe only the attempt that produced the returned
	// message." The `fallback_message` entry *is* that attempt, so adding it again would double
	// count; the declining `message` entry is the one the top-level usage omits.
	it("bills an earlier attempt that produced output before declining", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const withoutIterations = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(midOutputFallbackEvents())),
		}).result();

		const withIterations = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(
				createSseResponse(
					eventsWithIterations([
						{ type: "message", model: "claude-fable-5-1", input_tokens: 0, output_tokens: 1_000_000 },
						{ type: "fallback_message", model: "claude-opus-5", input_tokens: 1_000_000, output_tokens: 0 },
					]),
				),
			),
		}).result();

		// 1M output tokens at Claude Fable 5.1's output rate, added on top of the serving attempt.
		const expectedExtra = model.cost.output;
		expect(withIterations.usage.cost.output - withoutIterations.usage.cost.output).toBeCloseTo(expectedExtra, 10);
		expect(withIterations.usage.cost.total - withoutIterations.usage.cost.total).toBeCloseTo(expectedExtra, 10);
	});

	// "An attempt that declined before producing any output is not billed: its tokens are reported
	// on its `usage.iterations` entry but not charged."
	it("does not bill an attempt that declined before producing output", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const baseline = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(midOutputFallbackEvents())),
		}).result();

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(
				createSseResponse(
					eventsWithIterations([
						{ type: "message", model: "claude-fable-5-1", input_tokens: 1_000_000, output_tokens: 0 },
						{ type: "fallback_message", model: "claude-opus-5", input_tokens: 1_000_000, output_tokens: 0 },
					]),
				),
			),
		}).result();

		expect(result.usage.cost.total).toBeCloseTo(baseline.usage.cost.total, 10);
	});

	// The serving attempt is already priced from the top-level usage; counting its `iterations`
	// entry as well would bill it twice.
	it("does not double-count the serving attempt", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const baseline = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(midOutputFallbackEvents())),
		}).result();

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(
				createSseResponse(
					eventsWithIterations([
						{ type: "fallback_message", model: "claude-opus-5", input_tokens: 1_000_000, output_tokens: 500 },
					]),
				),
			),
		}).result();

		expect(result.usage.cost.total).toBeCloseTo(baseline.usage.cost.total, 10);
	});

	// A one-hour cache write bills at 2x base input, not at the five-minute write rate. The
	// serving attempt already read `cache_creation` from `message_start`; the earlier attempts
	// read it from their own `usage.iterations` entry, and without it an hour-long write on a
	// declining attempt was charged as if it were a five-minute one.
	it.each([
		["one-hour", { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 }, "long"],
		["five-minute", { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1_000_000 }, "short"],
	] as const)("prices an earlier attempt's %s cache write at its own rate", async (_label, split, kind) => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const baseline = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(midOutputFallbackEvents())),
		}).result();

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(
				createSseResponse(
					eventsWithIterations([
						{
							type: "message",
							model: "claude-fable-5-1",
							output_tokens: 1,
							cache_creation_input_tokens: 1_000_000,
							cache_creation: split,
						},
					]),
				),
			),
		}).result();

		const added = result.usage.cost.cacheWrite - baseline.usage.cost.cacheWrite;
		// 1M tokens: 2 x $10 input = $20.00 for the hour rate, $12.50 for the five-minute rate.
		const expected = kind === "long" ? model.cost.input * 2 : model.cost.cacheWrite;
		expect(added).toBeCloseTo(expected, 10);
	});

	// A mixed split must charge each portion at its own rate rather than all of it at either one.
	it("prices a mixed cache-write split proportionally", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const baseline = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(createSseResponse(midOutputFallbackEvents())),
		}).result();

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(
				createSseResponse(
					eventsWithIterations([
						{
							type: "message",
							model: "claude-fable-5-1",
							output_tokens: 1,
							cache_creation_input_tokens: 1_000_000,
							cache_creation: { ephemeral_1h_input_tokens: 400_000, ephemeral_5m_input_tokens: 600_000 },
						},
					]),
				),
			),
		}).result();

		const added = result.usage.cost.cacheWrite - baseline.usage.cost.cacheWrite;
		// 400k at 2 x $10 + 600k at $12.50 = $8.00 + $7.50 = $15.50.
		const expected = (model.cost.input * 2 * 400_000 + model.cost.cacheWrite * 600_000) / 1_000_000;
		expect(added).toBeCloseTo(expected, 10);
		// Neither single-rate answer, which is what pins the aggregate-minus-1h arithmetic.
		expect(added).not.toBeCloseTo(model.cost.input * 2, 10);
		expect(added).not.toBeCloseTo(model.cost.cacheWrite, 10);
	});
});

function fallbackBlock(): FallbackContent {
	return { type: "fallback", fromModel: "claude-fable-5-1", toModel: "claude-opus-5" };
}

/** An assistant turn straddling a fallback boundary, with reasoning and a tool call on each side. */
function straddlingTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "declining model reasoning", thinkingSignature: "sig-before" },
			{ type: "text", text: "Partial" },
			{ type: "toolCall", id: "toolu_before", name: "double_number", arguments: { value: 1 } },
			fallbackBlock(),
			{ type: "thinking", thinking: "serving model reasoning", thinkingSignature: "sig-after" },
			{ type: "text", text: " answer" },
			{ type: "toolCall", id: "toolu_after", name: "double_number", arguments: { value: 2 } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function replay(): Message[] {
	return transformMessages(
		[
			{ role: "user", content: "Double 1 and 2.", timestamp: Date.now() },
			straddlingTurn(),
			{
				role: "toolResult",
				toolCallId: "toolu_after",
				toolName: "double_number",
				content: [{ type: "text", text: "4" }],
				isError: false,
				timestamp: Date.now(),
			},
		],
		getModel("anthropic", "claude-fable-5-1"),
	);
}

describe("replaying a turn that straddles a fallback boundary", () => {
	it("keeps the marker and drops only the pre-boundary reasoning and tool call", () => {
		const assistant = replay().find((msg): msg is AssistantMessage => msg.role === "assistant");
		expect(assistant).toBeDefined();

		// Echoing thinking from both sides of the marker is rejected by the API, so the earlier
		// model's reasoning and its unexecuted tool call are dropped while the marker stays in
		// place and everything after it survives.
		expect(assistant!.content.map((block) => block.type)).toEqual([
			"text",
			"fallback",
			"thinking",
			"text",
			"toolCall",
		]);
	});

	it("keeps the marker's position relative to the text it separates", () => {
		const content = replay().find((msg): msg is AssistantMessage => msg.role === "assistant")!.content;
		const markerIndex = content.findIndex((block) => block.type === "fallback");

		expect(content[markerIndex - 1]).toMatchObject({ type: "text", text: "Partial" });
		expect(content[markerIndex + 1]).toMatchObject({ type: "thinking" });
		expect(content[markerIndex]).toEqual(fallbackBlock());
	});

	it("keeps the post-boundary reasoning that the serving model produced", () => {
		const content = replay().find((msg): msg is AssistantMessage => msg.role === "assistant")!.content;
		const thinking = content.filter((block) => block.type === "thinking");

		expect(thinking).toHaveLength(1);
		expect(thinking[0]).toMatchObject({ thinkingSignature: "sig-after" });
	});

	it("keeps both sides' visible text", () => {
		const content = replay().find((msg): msg is AssistantMessage => msg.role === "assistant")!.content;

		expect(content.filter((block) => block.type === "text").map((block) => block.text)).toEqual([
			"Partial",
			" answer",
		]);
	});

	// A turn with no boundary must be untouched by any of this.
	it("changes nothing for a turn without a fallback block", () => {
		const turn = straddlingTurn();
		turn.content = turn.content.filter((block) => block.type !== "fallback");
		turn.model = "claude-fable-5-1";

		const result = transformMessages([turn], getModel("anthropic", "claude-fable-5-1"));
		const assistant = result.find((msg): msg is AssistantMessage => msg.role === "assistant");

		expect(assistant!.content.map((block) => block.type)).toEqual([
			"thinking",
			"text",
			"toolCall",
			"thinking",
			"text",
			"toolCall",
		]);
	});
});

/**
 * Keeping the marker in `transformMessages` output is only half the job — it has to reach the
 * wire. The replay pass drops the pre-boundary thinking; if the serializer then dropped the
 * marker too, the request would carry thinking from one side of a boundary that is no longer
 * marked, which is the shape Anthropic rejects. These assert the captured request body.
 */
describe("the fallback marker reaches the request body", () => {
	it("serializes the marker at its original position", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5-1"), [
			{ role: "user", content: "Double 1 and 2.", timestamp: Date.now() },
			straddlingTurn(),
			{
				role: "toolResult",
				toolCallId: "toolu_after",
				toolName: "double_number",
				content: [{ type: "text", text: "4" }],
				isError: false,
				timestamp: Date.now(),
			},
		]);

		const assistant = payload.messages?.find((message) => message.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant!.content.map((block) => block.type)).toEqual([
			"text",
			"fallback",
			"thinking",
			"text",
			"tool_use",
		]);
		expect(assistant!.content[1]).toEqual({
			type: "fallback",
			from: { model: "claude-fable-5-1" },
			to: { model: "claude-opus-5" },
		});
	});

	// Dropping the pre-boundary `tool_use` leaves its `tool_result` with nothing to match, and
	// Anthropic rejects an unmatched `tool_result`. Both must go together.
	it("drops the tool result belonging to a dropped pre-boundary tool call", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5-1"), [
			{ role: "user", content: "Double 1 and 2.", timestamp: Date.now() },
			straddlingTurn(),
			{
				role: "toolResult",
				toolCallId: "toolu_before",
				toolName: "double_number",
				content: [{ type: "text", text: "2" }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "toolu_after",
				toolName: "double_number",
				content: [{ type: "text", text: "4" }],
				isError: false,
				timestamp: Date.now(),
			},
		]);

		const toolResultIds = (payload.messages ?? [])
			.flatMap((message) => message.content)
			.filter((block) => block.type === "tool_result")
			.map((block) => block.tool_use_id);

		// The surviving post-boundary call keeps its result; the dropped one takes its result with it.
		expect(toolResultIds).toEqual(["toolu_after"]);
		// And no synthetic filler was invented for the call that was removed.
		expect(toolResultIds).not.toContain("toolu_before");
	});
});
