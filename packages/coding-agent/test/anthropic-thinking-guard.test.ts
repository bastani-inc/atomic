import { describe, expect, it } from "vitest";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai/compat";
import { restoreAnthropicReplayThinkingBlocks } from "../src/core/anthropic-thinking-guard.ts";

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
