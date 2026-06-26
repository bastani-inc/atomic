import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { convertToLlm } from "../src/core/messages.ts";

function assistantWithToolCalls(ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `${id}.ts` } })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: `result for ${toolCallId}` }],
		isError: false,
		timestamp: 1,
	};
}

describe("convertToLlm tool-result repair", () => {
	test("keeps consecutive results paired with the previous assistant tool calls", () => {
		const converted = convertToLlm([
			assistantWithToolCalls(["call-a", "call-b"]),
			toolResult("call-a"),
			toolResult("call-b"),
		]);

		expect(converted.map((message) => message.role)).toEqual(["assistant", "toolResult", "toolResult"]);
	});

	test("drops orphaned tool results before provider serialization", () => {
		const converted = convertToLlm([
			{ role: "user", content: "hello", timestamp: 1 } as AgentMessage,
			toolResult("missing-call"),
			assistantWithToolCalls(["call-a"]),
			{ role: "user", content: "intervening user", timestamp: 1 } as AgentMessage,
			toolResult("call-a"),
		]);

		expect(converted.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
	});
});
