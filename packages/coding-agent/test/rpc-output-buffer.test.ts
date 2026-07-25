import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { INTERACTIVE_ENGINE_MAX_FRAME_BYTES } from "../src/modes/interactive-engine/protocol.ts";
import { serializeBounded } from "../src/modes/rpc/rpc-output-buffer.ts";

const LARGE_RESULT = "r".repeat(20_000);
const SMALL_TOOL_RESULT = "small result that must survive bounding";
const TRANSPORT_LIMIT_ERROR = "RPC record exceeded the 1 MiB transport limit";

const USAGE: AssistantMessage["usage"] = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface JsonRecord {
	[key: string]: unknown;
}

function createToolResult(details: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool-call-1",
		toolName: "fixture-tool",
		content: [{ type: "text", text: SMALL_TOOL_RESULT }],
		details,
		isError: false,
		timestamp: 1,
	};
}

function createToolCallMessages(): AssistantMessage[] {
	return Array.from({ length: 16 }, (_, messageIndex) => ({
		role: "assistant" as const,
		content: Array.from({ length: 16 }, (_, toolCallIndex) => ({
			type: "toolCall" as const,
			id: `tool-${messageIndex}-${toolCallIndex}`,
			name: "fixture-tool",
			arguments: { payload: LARGE_RESULT },
		})),
		api: "anthropic-messages",
		provider: "fixture-provider",
		model: "fixture-model",
		usage: USAGE,
		stopReason: "toolUse" as const,
		timestamp: messageIndex + 1,
	}));
}

function createOneByteScalarFields(): Record<string, number> {
	const fields: Record<string, number> = {};
	for (let index = 0; index < 70_000; index += 1) {
		fields[`field_${index}`] = 0;
	}
	return fields;
}

function expectOversizedRaw(record: object): void {
	expect(Buffer.byteLength(JSON.stringify(record), "utf8")).toBeGreaterThan(INTERACTIVE_ENGINE_MAX_FRAME_BYTES);
}

function serializeAndParse(record: object): JsonRecord {
	const line = serializeBounded(record);
	expect(line.endsWith("\n")).toBe(true);
	expect(line.match(/\n/g)).toHaveLength(1);

	const payload = line.slice(0, -1);
	expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(INTERACTIVE_ENGINE_MAX_FRAME_BYTES);
	return JSON.parse(payload) as JsonRecord;
}

describe("serializeBounded aggregate-large RPC records", () => {
	test("keeps an aggregate-large toolResult lifecycle event structurally valid", () => {
		const stages = Array.from({ length: 78 }, (_, index) => ({ stage: index, result: LARGE_RESULT }));
		const record = {
			type: "message_start",
			message: createToolResult({ detail: { stages } }),
		};
		expectOversizedRaw(record);

		const serialized = serializeAndParse(record);
		expect(serialized.type).toBe("message_start");
		const message = serialized.message as { details: { detail: { stages: Array<{ result: string }> } } };
		expect(message).toMatchObject({
			role: "toolResult",
			toolCallId: "tool-call-1",
			toolName: "fixture-tool",
			content: [{ type: "text", text: SMALL_TOOL_RESULT }],
			isError: false,
			timestamp: 1,
		});
		expect(message.details.detail.stages.length).toBeGreaterThan(0);
		expect(message.details.detail.stages.length).toBeLessThan(stages.length);
		expect(message.details.detail.stages[0]?.result).toContain("[RPC payload truncated]");
	});

	test("keeps tool-call arguments as records during aggressive agent_end bounding", () => {
		const record = { type: "agent_end", messages: createToolCallMessages() };
		expectOversizedRaw(record);

		const serialized = serializeAndParse(record);
		expect(serialized.type).toBe("agent_end");
		const messages = serialized.messages as Array<{ content: Array<{ type: string; arguments: unknown }> }>;
		const retainedToolCalls = messages.flatMap((message) => message.content);
		expect(retainedToolCalls.length).toBeGreaterThan(0);
		expect(retainedToolCalls.every((toolCall) => toolCall.type === "toolCall")).toBe(true);
		expect(
			retainedToolCalls.every(
				(toolCall) =>
					typeof toolCall.arguments === "object" && toolCall.arguments !== null && !Array.isArray(toolCall.arguments),
			),
		).toBe(true);
	});

	describe("irreducible event records", () => {
		const irreduciblePayload = { fields: createOneByteScalarFields() };

		test.each([
			{
				recordType: "message_start",
				record: {
					type: "message_start",
					message: createToolResult({ irreduciblePayload }),
				},
			},
			{
				recordType: "extension_error",
				record: {
					type: "extension_error",
					extensionPath: "fixture-extension.ts",
					event: "agent_end",
					error: "fixture error",
					irreduciblePayload,
				},
			},
			{
				recordType: "extension_ui_request",
				record: {
					type: "extension_ui_request",
					id: "request-1",
					method: "input",
					title: "Fixture input",
					irreduciblePayload,
				},
			},
		])("$recordType overflow emits a matching transport_error", ({ recordType, record }) => {
			expectOversizedRaw(record);
			expect(serializeAndParse(record)).toEqual({
				type: "transport_error",
				recordType,
				error: TRANSPORT_LIMIT_ERROR,
			});
		});
	});

	test("fails an oversized correlated response under the original request id", () => {
		const record = {
			type: "response",
			id: "get-messages-1",
			command: "get_messages",
			success: true,
			data: { messages: createToolCallMessages() },
		};
		expectOversizedRaw(record);

		expect(serializeAndParse(record)).toEqual({
			type: "response",
			id: "get-messages-1",
			command: "get_messages",
			success: false,
			error: TRANSPORT_LIMIT_ERROR,
		});
	});
});
