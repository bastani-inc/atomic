import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import type {
	AssistantMessage,
	Context,
	FetchFunction,
	Message,
	Model,
	TextContent,
	ThinkingContent,
} from "../src/types.ts";

/**
 * Preserved-thinking regressions for mid-conversation model switches.
 *
 * Anthropic binds each thinking block to the model that produced it and, on Claude Fable 5.1, to
 * the conversation prefix it was produced from:
 * - https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 * - https://platform.claude.com/docs/en/build-with-claude/thinking#preserved-thinking
 *
 * Two rules drive everything below.
 *
 * 1. The *model* check is adjudicated by the API and always drops, never errors: "A block that
 *    fails the model check is always dropped." Fable 5.1 reads every earlier Claude model's
 *    blocks; no earlier model reads Fable 5.1's. Clients should "Send every assistant turn
 *    exactly as you received it, thinking blocks included, and let the API decide."
 * 2. The *conversation* check runs on Fable 5.1 and rejects a replay behind a changed prefix with
 *    a 400, unless the request opts into `prefix_mismatch_behavior: "drop_block"` behind the
 *    `thinking-binding-controls-2026-08-01` beta header.
 */

interface AnthropicThinkingPayload {
	thinking?: {
		type: string;
		display?: string;
		budget_tokens?: number;
		block_binding?: { prefix_mismatch_behavior?: string };
	};
	output_config?: { effort?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return { messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] };
}

async function capturePayloadAndHeaders(
	model: Model<"anthropic-messages">,
	options?: { reasoning?: "low" | "medium" | "high" | "xhigh" | "max" },
): Promise<{ payload: AnthropicThinkingPayload; betaHeader: string }> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	let betaHeader = "";

	const s = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, makeContext(), {
		apiKey: "fake-key",
		...(options?.reasoning ? { reasoning: options.reasoning } : {}),
		// Parameters are contextually typed by `FetchFunction`; naming DOM types such as
		// `RequestInfo` here would not compile, because the package builds with `lib: ["ES2022"]`
		// and `types: ["node"]` and has no DOM lib.
		fetch: (async (_input, init) => {
			const headers = new Headers(init?.headers);
			betaHeader = headers.get("anthropic-beta") ?? "";
			throw new PayloadCaptured();
		}) as FetchFunction,
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}
	return { payload: capturedPayload, betaHeader };
}

function signedThinking(text: string, signature: string): ThinkingContent {
	return { type: "thinking", thinking: text, thinkingSignature: signature };
}

function assistantTurn(provider: string, modelId: string, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: provider as AssistantMessage["provider"],
		model: modelId,
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

/** A conversation whose assistant turn was produced by `sourceModelId`, with a tool round trip. */
function historyFrom(sourceModelId: string): Message[] {
	return [
		{ role: "user", content: "Double 21.", timestamp: Date.now() },
		assistantTurn("anthropic", sourceModelId, [
			signedThinking("The user wants 21 doubled.", "sig-abc123"),
			{ type: "text", text: "Let me compute that." },
			{ type: "toolCall", id: "toolu_1", name: "double_number", arguments: { value: 21 } },
		]),
		{
			role: "toolResult",
			toolCallId: "toolu_1",
			toolName: "double_number",
			content: [{ type: "text", text: "42" }],
			isError: false,
			timestamp: Date.now(),
		},
		{ role: "user", content: "Thanks.", timestamp: Date.now() },
	];
}

function thinkingBlocks(messages: Message[]): ThinkingContent[] {
	return messages
		.filter((msg): msg is AssistantMessage => msg.role === "assistant")
		.flatMap((msg) => msg.content.filter((block): block is ThinkingContent => block.type === "thinking"));
}

function textBlocks(messages: Message[]): TextContent[] {
	return messages
		.filter((msg): msg is AssistantMessage => msg.role === "assistant")
		.flatMap((msg) => msg.content.filter((block): block is TextContent => block.type === "text"));
}

describe("preserved thinking across mid-conversation model switches", () => {
	// Direction 1: another Claude model -> Claude Fable 5.1. Fable 5.1 reads every earlier Claude
	// model's blocks, so the reasoning must survive the switch instead of being flattened to text.
	it("replays an earlier Claude model's signed thinking unchanged when switching up to Fable 5.1", () => {
		const target = getModel("anthropic", "claude-fable-5-1");
		const result = transformMessages(historyFrom("claude-opus-5"), target);

		const thinking = thinkingBlocks(result);
		expect(thinking).toHaveLength(1);
		expect(thinking[0].thinkingSignature).toBe("sig-abc123");
		expect(thinking[0].thinking).toBe("The user wants 21 doubled.");
		// The reasoning must not be duplicated into visible assistant text.
		expect(textBlocks(result).map((block) => block.text)).toEqual(["Let me compute that."]);
	});

	// Direction 2: Claude Fable 5.1 -> an earlier Claude model. The earlier model cannot read
	// Fable 5.1's blocks, but the API drops them itself, unbilled and without an error. The client
	// passes them back unchanged rather than rewriting the transcript.
	it("replays Fable 5.1 signed thinking unchanged when switching down to an earlier Claude model", () => {
		const target = getModel("anthropic", "claude-opus-5");
		const result = transformMessages(historyFrom("claude-fable-5-1"), target);

		const thinking = thinkingBlocks(result);
		expect(thinking).toHaveLength(1);
		expect(thinking[0].thinkingSignature).toBe("sig-abc123");
		expect(textBlocks(result).map((block) => block.text)).toEqual(["Let me compute that."]);
	});

	it("keeps assistant text and tool-use/tool-result coherence across a switch in both directions", () => {
		for (const [sourceModelId, targetModelId] of [
			["claude-opus-5", "claude-fable-5-1"],
			["claude-fable-5-1", "claude-opus-5"],
		] as const) {
			const result = transformMessages(historyFrom(sourceModelId), getModel("anthropic", targetModelId));

			const assistant = result.find((msg): msg is AssistantMessage => msg.role === "assistant");
			expect(assistant, `${sourceModelId} -> ${targetModelId}`).toBeDefined();
			const toolCalls = assistant!.content.filter((block) => block.type === "toolCall");
			expect(toolCalls, `${sourceModelId} -> ${targetModelId}`).toHaveLength(1);
			expect(textBlocks(result).map((b) => b.text)).toEqual(["Let me compute that."]);

			const toolResults = result.filter((msg) => msg.role === "toolResult");
			expect(toolResults, `${sourceModelId} -> ${targetModelId}`).toHaveLength(1);
			// Exactly one tool result, matching the single tool call: no synthetic filler inserted.
			expect(toolResults[0]).toMatchObject({ toolCallId: "toolu_1" });
		}
	});

	// The capability is explicit generated metadata, not a global Anthropic-compatible heuristic.
	// A provider that is not documented to adjudicate signatures keeps the old flattening behavior.
	it("does not replay foreign thinking to providers without the delegation capability", () => {
		// opencode zen rides `anthropic-messages` but is not documented to adjudicate signatures,
		// so it never receives the capability. Uses Claude Fable 5 rather than 5.1 because a
		// third-party mirror of a specific version can disappear from its provider's catalog.
		const target = getModel("opencode", "claude-fable-5");
		expect(target.compat?.delegatesThinkingModelBinding).toBeUndefined();

		const history = historyFrom("claude-opus-5").map((msg) =>
			msg.role === "assistant" ? { ...msg, provider: "opencode" as AssistantMessage["provider"] } : msg,
		);
		const result = transformMessages(history, target);

		expect(thinkingBlocks(result)).toHaveLength(0);
		// Degrades to the pre-existing behavior rather than losing the content entirely.
		expect(textBlocks(result).map((block) => block.text)).toEqual([
			"The user wants 21 doubled.",
			"Let me compute that.",
		]);
	});

	it("does not replay thinking across providers", () => {
		const target = getModel("anthropic", "claude-fable-5-1");
		const history = historyFrom("claude-fable-5-1").map((msg) =>
			msg.role === "assistant" ? { ...msg, provider: "opencode" as AssistantMessage["provider"] } : msg,
		);
		const result = transformMessages(history, target);

		expect(thinkingBlocks(result)).toHaveLength(0);
	});
});

describe("Fable 5.1 prefix-mismatch handling", () => {
	it("sends the block-binding beta header and drop_block on a reasoning turn", async () => {
		const { payload, betaHeader } = await capturePayloadAndHeaders(getModel("anthropic", "claude-fable-5-1"), {
			reasoning: "high",
		});

		expect(betaHeader).toContain("thinking-binding-controls-2026-08-01");
		expect(payload.thinking?.type).toBe("adaptive");
		expect(payload.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
	});

	// The header alone leaves `prefix_mismatch_behavior` at its `"error"` default, which is the
	// 400 this feature exists to avoid. `streamSimple` sets `thinkingEnabled: false` whenever no
	// reasoning level is requested, so a no-reasoning turn must still carry the field or the
	// session fails on exactly the prefix change the beta was sent to absorb.
	it("sends drop_block on a no-reasoning turn, where the header would otherwise be inert", async () => {
		const { payload, betaHeader } = await capturePayloadAndHeaders(getModel("anthropic", "claude-fable-5-1"));

		expect(betaHeader).toContain("thinking-binding-controls-2026-08-01");
		expect(payload.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
		// Omitting `thinking` and sending `{type: "adaptive"}` are equivalent on this model, and
		// leaving `display` absent keeps the API's `"omitted"` default that omission produced.
		expect(payload.thinking?.type).toBe("adaptive");
		expect(payload.thinking?.display).toBeUndefined();
		expect(payload.thinking?.budget_tokens).toBeUndefined();
		expect(payload.output_config).toBeUndefined();
	});

	it.each(["low", "medium", "high", "xhigh", "max"] as const)(
		"keeps drop_block alongside effort=%s",
		async (reasoning) => {
			const { payload } = await capturePayloadAndHeaders(getModel("anthropic", "claude-fable-5-1"), { reasoning });

			expect(payload.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
			expect(payload.output_config).toEqual({ effort: reasoning });
		},
	);

	it.each(["claude-fable-5", "claude-opus-5", "claude-sonnet-4-5"] as const)(
		"does not opt %s into the conversation check, on reasoning or no-reasoning turns",
		async (modelId) => {
			for (const options of [undefined, { reasoning: "high" as const }]) {
				const { payload, betaHeader } = await capturePayloadAndHeaders(getModel("anthropic", modelId), options);

				expect(betaHeader).not.toContain("thinking-binding-controls-2026-08-01");
				expect(payload.thinking?.block_binding).toBeUndefined();
			}
		},
	);

	// Never merged onto `thinking.type: "disabled"`; the docs scope `block_binding` to the
	// `adaptive` and `enabled` shapes only.
	it("does not attach block_binding to a disabled-thinking payload", async () => {
		const { payload } = await capturePayloadAndHeaders(getModel("anthropic", "claude-sonnet-4-5"));

		expect(payload.thinking).toEqual({ type: "disabled" });
	});
});

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: { create: () => ({ asResponse: async () => response }) },
	} as unknown as Anthropic;
}

interface Transformation {
	type: string;
	path: string;
	reason: string;
}

function eventsWithInputTransformations(
	transformations: Transformation[] | undefined,
	deltaTransformations?: Transformation[],
): Array<{ event: string; data: string }> {
	const message: Record<string, unknown> = {
		id: "msg_test",
		model: "claude-fable-5-1",
		usage: { input_tokens: 10, output_tokens: 0 },
	};
	if (transformations) message.input_transformations = transformations;
	const messageDelta: Record<string, unknown> = {
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 10, output_tokens: 2 },
	};
	if (deltaTransformations) messageDelta.input_transformations = deltaTransformations;
	return [
		{ event: "message_start", data: JSON.stringify({ type: "message_start", message }) },
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{ event: "message_delta", data: JSON.stringify(messageDelta) },
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
}

describe("dropped thinking blocks are observable", () => {
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

	it("records dropped blocks reported in input_transformations as a diagnostic", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const response = createSseResponse(
			eventsWithInputTransformations([
				{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
				{ type: "thinking_dropped", path: "messages.3.content.0", reason: "model_binding_mismatch" },
			]),
		);
		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		// The request still succeeded: safe degradation, not a broken session.
		expect(result.stopReason).toBe("stop");
		const diagnostic = result.diagnostics?.find((d) => d.type === "anthropic_input_transformations");
		expect(diagnostic).toBeDefined();
		expect(diagnostic?.details?.droppedBlockCount).toBe(2);
		expect(diagnostic?.details?.reasons).toEqual(["prefix_binding_mismatch", "model_binding_mismatch"]);
		expect(diagnostic?.details?.paths).toEqual(["messages.1.content.0", "messages.3.content.0"]);
	});

	it("records no diagnostic when the API reports no transformations", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const response = createSseResponse(eventsWithInputTransformations(undefined));
		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		expect(result.diagnostics?.some((d) => d.type === "anthropic_input_transformations") ?? false).toBe(false);
	});

	it("records no diagnostic for an empty input_transformations array", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const response = createSseResponse(eventsWithInputTransformations([]));
		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		expect(result.diagnostics?.some((d) => d.type === "anthropic_input_transformations") ?? false).toBe(false);
	});

	// "After a mid-stream server-side fallback, the final `message_delta` event carries the array
	// again with the serving model's entries."
	// https://platform.claude.com/docs/en/build-with-claude/thinking
	// Reachable for Claude Fable 5.1 specifically, because its generated metadata supplies
	// `fallbacks` and the provider sends the server-side-fallback beta for it.
	it("records dropped blocks reported only on the final message_delta", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const response = createSseResponse(
			eventsWithInputTransformations(undefined, [
				{ type: "thinking_dropped", path: "messages.2.content.0", reason: "model_binding_mismatch" },
			]),
		);
		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		expect(result.stopReason).toBe("stop");
		const diagnostic = result.diagnostics?.find((d) => d.type === "anthropic_input_transformations");
		expect(diagnostic).toBeDefined();
		expect(diagnostic?.details?.droppedBlockCount).toBe(1);
		expect(diagnostic?.details?.reasons).toEqual(["model_binding_mismatch"]);
		expect(diagnostic?.details?.paths).toEqual(["messages.2.content.0"]);
	});

	// Both events can report, and the delta's entries describe the serving model rather than
	// repeating `message_start`'s, so both are recorded rather than de-duplicated away.
	it("records both reports when message_start and message_delta each carry entries", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const response = createSseResponse(
			eventsWithInputTransformations(
				[{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" }],
				[{ type: "thinking_dropped", path: "messages.3.content.0", reason: "model_binding_mismatch" }],
			),
		);
		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		const diagnostics = result.diagnostics?.filter((d) => d.type === "anthropic_input_transformations") ?? [];
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics[0].details?.paths).toEqual(["messages.1.content.0"]);
		expect(diagnostics[1].details?.paths).toEqual(["messages.3.content.0"]);
	});

	// The empty-array guard is the de-duplication rule: an ordinary turn omits the field on the
	// delta, and a nothing-dropped turn sends an empty array. Neither may add a second entry.
	it("adds no second diagnostic when the delta reports an empty array", async () => {
		const model = getModel("anthropic", "claude-fable-5-1");
		const response = createSseResponse(
			eventsWithInputTransformations(
				[{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" }],
				[],
			),
		);
		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		const diagnostics = result.diagnostics?.filter((d) => d.type === "anthropic_input_transformations") ?? [];
		expect(diagnostics).toHaveLength(1);
	});
});
