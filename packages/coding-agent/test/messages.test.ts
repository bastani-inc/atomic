import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
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

describe("convertToLlm", () => {
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

	test("normalizes null and omitted assistant content without mutating durable messages", () => {
		const nullContent = { ...assistantWithToolCalls([]), content: null } as unknown as AgentMessage;
		const omittedContent = { ...assistantWithToolCalls([]) } as unknown as Record<string, unknown>;
		delete omittedContent.content;
		const durable = [nullContent, omittedContent as unknown as AgentMessage];
		const before = JSON.stringify(durable);

		expect(() => convertToLlm(durable)).not.toThrow();
		const converted = convertToLlm(durable);
		expect(converted).toHaveLength(2);
		expect(converted.map((message) => (message as { content?: unknown }).content)).toEqual([[], []]);
		expect(JSON.stringify(durable)).toBe(before);
	});
	test("preserves image data for image-only user and custom conversion", () => {
		const userImage = { type: "image" as const, data: "dXNlci1pbWFnZQ==", mimeType: "image/png" as const };
		const customImage = { type: "image" as const, data: "Y3VzdG9tLWltYWdl", mimeType: "image/jpeg" as const };
		const converted = convertToLlm([
			{ role: "user", content: [userImage], timestamp: 1 },
			{ role: "custom", customType: "image", content: [customImage], display: true, timestamp: 2 },
		] as AgentMessage[]);

		expect(converted).toEqual([
			{ role: "user", content: [userImage], timestamp: 1 },
			{ role: "user", content: [customImage], timestamp: 2 },
		]);
	});

	test("filters invisible siblings from mixed user and custom arrays without mutating durable input", () => {
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" as const };
		const text = { type: "text" as const, text: "visible text" };
		const future = { type: "audio", data: "future-provider-data" };
		const malformed = { data: "missing-type" };
		const invalidText = { type: "text", text: 42 };
		const whitespace = { type: "text", text: "  \n\t" };
		const durable = [
			{ role: "user", content: [image, malformed, invalidText, whitespace, text, future], timestamp: 1 },
			{
				role: "custom",
				customType: "mixed",
				content: [malformed, image, whitespace, future, invalidText],
				display: true,
				timestamp: 2,
			},
		] as unknown as AgentMessage[];
		const before = JSON.stringify(durable);

		expect(convertToLlm(durable)).toEqual([
			{ role: "user", content: [image, text, future], timestamp: 1 },
			{ role: "user", content: [image, future], timestamp: 2 },
		]);
		expect(JSON.stringify(durable)).toBe(before);
	});

	test("fails visible for unknown typed user-like blocks but omits malformed and blank blocks", () => {
		const futureBlock = { type: "audio", data: "future-provider-data" };
		const converted = convertToLlm([
			{ role: "user", content: [futureBlock], timestamp: 1 },
			{ role: "custom", customType: "future", content: [futureBlock], display: true, timestamp: 2 },
			{ role: "user", content: [{ data: "untyped" }], timestamp: 3 },
			{ role: "user", content: [{ type: "", data: "blank-type" }], timestamp: 4 },
			{ role: "user", content: [{ type: "text", text: "   " }], timestamp: 5 },
		] as unknown as AgentMessage[]);

		expect(converted).toEqual([
			{ role: "user", content: [futureBlock], timestamp: 1 },
			{ role: "user", content: [futureBlock], timestamp: 2 },
		]);
	});
});
