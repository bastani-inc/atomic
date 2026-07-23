import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai/compat";
import { stream as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { restoreAnthropicReplayThinkingBlocks } from "../src/core/anthropic-thinking-guard.ts";
import { convertToLlm } from "../src/core/messages.ts";

function anthropicModel(): Model<Api> {
	return {
		id: "claude-opus-4.8",
		name: "Claude Opus 4.8",
		provider: "github-copilot",
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.test",
		contextWindow: 1_000_000,
		maxTokens: 4096,
		input: ["text", "image"],
		output: ["text"],
		reasoning: "high",
	} as Model<Api>;
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "github-copilot",
		model: "claude-opus-4.8",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function anthropicDoneResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-opus-4.8",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		},
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("restoreAnthropicReplayThinkingBlocks", () => {
	it("restores signed thinking text byte-for-byte after provider sanitization", () => {
		const sourceThinking = "exact thinking with unpaired surrogate \ud800 preserved";
		const sourceMessages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: 0 },
			assistantMessage([
				{ type: "thinking", thinking: sourceThinking, thinkingSignature: "sig-1" },
				{ type: "text", text: "Visible response" },
			]),
		];
		const payload = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "continue" }] },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "exact thinking with replacement � preserved", signature: "sig-1" },
						{ type: "text", text: "Visible response" },
					],
				},
			],
		};

		const restored = restoreAnthropicReplayThinkingBlocks(payload, sourceMessages, anthropicModel());

		expect(restored).toEqual({
			messages: [
				{ role: "user", content: [{ type: "text", text: "continue" }] },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: sourceThinking, signature: "sig-1" },
						{ type: "text", text: "Visible response" },
					],
				},
			],
		});
	});

	it("reinserts signed empty thinking dropped by the provider", () => {
		const sourceMessages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "resume" }], timestamp: 0 },
			assistantMessage([
				{ type: "thinking", thinking: "", thinkingSignature: "sig-empty" },
				{ type: "text", text: "Still visible" },
			]),
		];
		const payload = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "resume" }] },
				{ role: "assistant", content: [{ type: "text", text: "Still visible" }] },
			],
		};

		const restored = restoreAnthropicReplayThinkingBlocks(payload, sourceMessages, anthropicModel());

		expect(restored).toEqual({
			messages: [
				{ role: "user", content: [{ type: "text", text: "resume" }] },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "", signature: "sig-empty" },
						{ type: "text", text: "Still visible" },
					],
				},
			],
		});
	});

	it("restores redacted thinking after payload hooks modify it", () => {
		const sourceMessages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "next" }], timestamp: 0 },
			assistantMessage([
				{ type: "thinking", thinking: "", thinkingSignature: "opaque-redacted", redacted: true },
				{ type: "toolCall", id: "toolu_123", name: "read", arguments: { path: "README.md" } },
			]),
		];
		const payload = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "next" }] },
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "mutated" },
						{ type: "tool_use", id: "toolu_123", name: "read", input: { path: "README.md" } },
					],
				},
			],
		};

		const restored = restoreAnthropicReplayThinkingBlocks(payload, sourceMessages, anthropicModel());

		expect(restored).toEqual({
			messages: [
				{ role: "user", content: [{ type: "text", text: "next" }] },
				{
					role: "assistant",
					content: [
						{ type: "redacted_thinking", data: "opaque-redacted" },
						{ type: "tool_use", id: "toolu_123", name: "read", input: { path: "README.md" } },
					],
				},
			],
		});
	});

	it("captures the production Anthropic request shape for native and raw-redacted signed stages", async () => {
		const durableMessages = [
			{ role: "user", content: [{ type: "text", text: "inspect" }], timestamp: 0 },
			assistantMessage([
				{ type: "thinking", thinking: "first exact bytes", thinkingSignature: "sig-first-exact" },
				{ type: "toolCall", id: "toolu_turn", name: "read", arguments: { path: "a.ts" } },
			]),
			{
				role: "toolResult",
				toolCallId: "toolu_turn",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 2,
			},
			assistantMessage([{ type: "redacted_thinking", data: "opaque-second-exact" }] as never),
		] as Message[];
		const durableBefore = JSON.stringify(durableMessages);
		const sourceMessages = convertToLlm(durableMessages as never);
		let capturedPayload: { messages?: unknown[] } | undefined;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedPayload = JSON.parse(await new Response(init?.body).text()) as { messages?: unknown[] };
			return anthropicDoneResponse();
		});

		try {
			const model = anthropicModel();
			const result = streamAnthropicMessages(
				model as Model<"anthropic-messages">,
				{ systemPrompt: "", messages: sourceMessages },
				{
					apiKey: "credential-free-test-key",
					onPayload: (payload) => restoreAnthropicReplayThinkingBlocks(payload, sourceMessages, model),
				},
			);
			await result.result();
		} finally {
			fetchSpy.mockRestore();
		}

		expect(capturedPayload?.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "inspect" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "first exact bytes", signature: "sig-first-exact" },
					{ type: "tool_use", id: "toolu_turn", name: "read", input: { path: "a.ts" } },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_turn", content: "result", is_error: false }] },
			{
				role: "assistant",
				content: [{ type: "redacted_thinking", data: "opaque-second-exact" }],
			},
		]);
		expect(JSON.stringify(durableMessages)).toBe(durableBefore);
	});

	it("keeps a raw-redacted-only assistant in the captured request", async () => {
		const durableMessages = [
			{ role: "user", content: [{ type: "text", text: "resume" }], timestamp: 0 },
			assistantMessage([{ type: "redacted_thinking", data: "opaque-only-exact" }] as never),
		] as Message[];
		const sourceMessages = convertToLlm(durableMessages as never);
		let capturedPayload: { messages?: unknown[] } | undefined;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedPayload = JSON.parse(await new Response(init?.body).text()) as { messages?: unknown[] };
			return anthropicDoneResponse();
		});
		try {
			const model = anthropicModel();
			const result = streamAnthropicMessages(
				model as Model<"anthropic-messages">,
				{ systemPrompt: "", messages: sourceMessages },
				{
					apiKey: "credential-free-test-key",
					onPayload: (payload) => restoreAnthropicReplayThinkingBlocks(payload, sourceMessages, model),
				},
			);
			await result.result();
		} finally {
			fetchSpy.mockRestore();
		}
		expect(capturedPayload?.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "resume" }] },
			{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque-only-exact" }] },
		]);
	});

	it("keeps signed-empty and raw-redacted assistant ordinals aligned", async () => {
		const durableMessages = [
			{ role: "user", content: [{ type: "text", text: "first" }], timestamp: 0 },
			assistantMessage([{ type: "thinking", thinking: "", thinkingSignature: "sig-empty-first" }]),
			{ role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 },
			assistantMessage([{ type: "redacted_thinking", data: "opaque-second" }] as never),
		] as Message[];
		const durableBefore = JSON.stringify(durableMessages);
		const sourceMessages = convertToLlm(durableMessages as never);
		let capturedPayload: { messages?: unknown[] } | undefined;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedPayload = JSON.parse(await new Response(init?.body).text()) as { messages?: unknown[] };
			return anthropicDoneResponse();
		});
		try {
			const model = anthropicModel();
			const result = streamAnthropicMessages(
				model as Model<"anthropic-messages">,
				{ systemPrompt: "", messages: sourceMessages },
				{
					apiKey: "credential-free-test-key",
					onPayload: (payload) => restoreAnthropicReplayThinkingBlocks(payload, sourceMessages, model),
				},
			);
			await result.result();
		} finally {
			fetchSpy.mockRestore();
		}
		expect(capturedPayload?.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-empty-first" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] },
			{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque-second" }] },
		]);
		expect(JSON.stringify(durableMessages)).toBe(durableBefore);
	});

	it("keeps unsigned thinking as text before a later raw-redacted assistant", async () => {
		const durableMessages = [
			{ role: "user", content: [{ type: "text", text: "first" }], timestamp: 0 },
			assistantMessage([{ type: "thinking", thinking: "unsigned first reasoning", thinkingSignature: "" }]),
			{ role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 },
			assistantMessage([{ type: "redacted_thinking", data: "opaque-second-only" }] as never),
		] as Message[];
		const sourceMessages = convertToLlm(durableMessages as never);
		let capturedPayload: { messages?: unknown[] } | undefined;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedPayload = JSON.parse(await new Response(init?.body).text()) as { messages?: unknown[] };
			return anthropicDoneResponse();
		});
		try {
			const model = anthropicModel();
			const result = streamAnthropicMessages(
				model as Model<"anthropic-messages">,
				{ systemPrompt: "", messages: sourceMessages },
				{
					apiKey: "credential-free-test-key",
					onPayload: (payload) => restoreAnthropicReplayThinkingBlocks(payload, sourceMessages, model),
				},
			);
			await result.result();
		} finally {
			fetchSpy.mockRestore();
		}

		expect(capturedPayload?.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "first" }] },
			{ role: "assistant", content: [{ type: "text", text: "unsigned first reasoning" }] },
			{ role: "user", content: [{ type: "text", text: "second" }] },
			{ role: "assistant", content: [{ type: "redacted_thinking", data: "opaque-second-only" }] },
		]);
		expect(JSON.stringify(capturedPayload).match(/opaque-second-only/g)).toHaveLength(1);
	});

	it("fails closed when emitting source and payload assistant counts differ", () => {
		const sourceMessages: Message[] = [
			assistantMessage([{ type: "thinking", thinking: "first exact", thinkingSignature: "sig-first" }]),
			assistantMessage([{ type: "thinking", thinking: "second exact", thinkingSignature: "sig-second" }]),
		];
		const payload = {
			messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "sanitized", signature: "sig-first" }] }],
		};

		const restored = restoreAnthropicReplayThinkingBlocks(payload, sourceMessages, anthropicModel());

		expect(restored).toBe(payload);
	});

	it("fails closed when a source assistant non-thinking shape does not match its payload ordinal", () => {
		const sourceMessages: Message[] = [
			assistantMessage([
				{ type: "thinking", thinking: "exact", thinkingSignature: "sig-exact" },
				{ type: "text", text: "expected text" },
			]),
		];
		const payload = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "sanitized", signature: "sig-exact" },
						{ type: "tool_use", id: "wrong", name: "read", input: {} },
					],
				},
			],
		};

		const restored = restoreAnthropicReplayThinkingBlocks(payload, sourceMessages, anthropicModel());

		expect(restored).toBe(payload);
	});

	it("skips non-emitting error assistants without shifting the payload ordinal", () => {
		const failed = {
			...assistantMessage([{ type: "thinking", thinking: "failed exact", thinkingSignature: "sig-failed" }]),
			stopReason: "error",
		} as AssistantMessage;
		const valid = assistantMessage([
			{ type: "thinking", thinking: "valid exact", thinkingSignature: "sig-valid" },
			{ type: "text", text: "visible" },
		]);
		const payload = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "sanitized", signature: "sig-valid" },
						{ type: "text", text: "visible" },
					],
				},
			],
		};

		const restored = restoreAnthropicReplayThinkingBlocks(payload, [failed, valid], anthropicModel());

		expect(restored).toEqual({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "valid exact", signature: "sig-valid" },
						{ type: "text", text: "visible" },
					],
				},
			],
		});
	});

	it("leaves cross-model assistant thinking converted by the provider unchanged", () => {
		const crossModelAssistant = {
			...assistantMessage([{ type: "thinking", thinking: "old thinking", thinkingSignature: "sig-old" }]),
			model: "claude-sonnet-4.5",
		};
		const payload = {
			messages: [{ role: "assistant", content: [{ type: "text", text: "old thinking" }] }],
		};

		const restored = restoreAnthropicReplayThinkingBlocks(payload, [crossModelAssistant], anthropicModel());

		expect(restored).toBe(payload);
	});
});
