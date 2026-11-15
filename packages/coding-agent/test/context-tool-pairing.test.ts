import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@bastani/atomic-ai/compat";
import { describe, expect, test } from "vitest";
import {
	assertToolPairingInvariant,
	assignMissingToolCallIds,
	findDuplicateToolCallIds,
	uniquifyToolCallIds,
} from "../src/core/context-tool-pairing.ts";
import { convertToLlm, deferMessagesInterleavedWithToolBatch, repairOrphanToolResults } from "../src/core/messages.ts";

function assistantWithToolCalls(ids: string[], timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
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
		timestamp,
	};
}

function toolResult(toolCallId: string, text = `result for ${toolCallId}`): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function toolCallIds(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) =>
		message.role === "assistant"
			? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
			: [],
	);
}

function resultPairs(messages: readonly AgentMessage[]): [string, string][] {
	return messages.flatMap((message): [string, string][] =>
		message.role === "toolResult"
			? [[message.toolCallId, message.content.map((block) => (block.type === "text" ? block.text : "")).join("")]]
			: [],
	);
}

describe("tool pairing invariant", () => {
	test("accepts distinct tool call ids across assistant turns", () => {
		const messages = [
			assistantWithToolCalls(["call-a", "call-b"]),
			assistantWithToolCalls(["call-c"]),
		] as AgentMessage[];

		expect(findDuplicateToolCallIds(messages)).toEqual([]);
		expect(() => assertToolPairingInvariant(messages)).not.toThrow();
	});

	test("reports a tool call id announced by more than one assistant message", () => {
		const duplicated = assistantWithToolCalls(["call-a"]);
		const messages = [duplicated, duplicated] as AgentMessage[];

		expect(findDuplicateToolCallIds(messages)).toEqual(["call-a"]);
		expect(() => assertToolPairingInvariant(messages)).toThrow(/call-a appears in more than one assistant message/);
	});

	test("names every offending id when several are duplicated", () => {
		const duplicated = assistantWithToolCalls(["call-a", "call-b"]);
		const messages = [duplicated, duplicated] as AgentMessage[];

		expect(findDuplicateToolCallIds(messages)).toEqual(["call-a", "call-b"]);
		expect(() => assertToolPairingInvariant(messages)).toThrow(
			/ids call-a, call-b appear in more than one assistant message/,
		);
	});

	test("ignores assistant messages excluded from context and malformed content", () => {
		const excluded = { ...assistantWithToolCalls(["call-a"]), excludeFromContext: true };
		const nullContent = { ...assistantWithToolCalls([]), content: null };
		const messages = [
			assistantWithToolCalls(["call-a"]),
			excluded,
			nullContent,
			{ role: "user", content: "hello", timestamp: 1 },
		] as unknown as AgentMessage[];

		expect(findDuplicateToolCallIds(messages)).toEqual([]);
	});
});

describe("tool call ids reused across assistant turns (#3243)", () => {
	const kimiTurns = (): AgentMessage[] => [
		{ role: "user", content: "run bash twice", timestamp: 1 },
		assistantWithToolCalls(["bash:0"], 10),
		toolResult("bash:0", "first"),
		assistantWithToolCalls(["bash:0", "read:1"], 20),
		toolResult("bash:0", "second"),
		toolResult("read:1", "third"),
		assistantWithToolCalls(["bash:0"], 30),
		toolResult("bash:0", "fourth"),
	];

	test("the guard accepts separate turns that reuse a Kimi tool call id", () => {
		expect(findDuplicateToolCallIds(kimiTurns())).toEqual([]);
		expect(() => assertToolPairingInvariant(kimiTurns())).not.toThrow();
	});

	test("the guard still rejects the same assistant turn carried twice (#2051)", () => {
		const copied = { ...assistantWithToolCalls(["call-a"], 10) };
		const messages = [assistantWithToolCalls(["call-a"], 10), toolResult("call-a"), copied] as AgentMessage[];

		expect(() => assertToolPairingInvariant(messages)).toThrow(/call-a appears in more than one assistant message/);
	});

	test("separate turns in the same millisecond with a reused id are not treated as a copy", () => {
		const first = assistantWithToolCalls(["bash:0"], 10);
		const second = { ...assistantWithToolCalls(["bash:0"], 10), usage: { ...first.usage, output: 7 } };
		const messages = [first, toolResult("bash:0", "first"), second, toolResult("bash:0", "second")] as AgentMessage[];

		expect(findDuplicateToolCallIds(messages)).toEqual([]);
		expect(resultPairs(convertToLlm(messages))).toEqual([
			["bash:0", "first"],
			["bash:0_2", "second"],
		]);
	});

	test("distinct provider response ids mark separate turns even when every other field matches", () => {
		const first = { ...assistantWithToolCalls(["bash:0"], 10), responseId: "resp-1" };
		const second = { ...assistantWithToolCalls(["bash:0"], 10), responseId: "resp-2" };
		const copy = { ...first };

		expect(findDuplicateToolCallIds([first, toolResult("bash:0"), second] as AgentMessage[])).toEqual([]);
		expect(findDuplicateToolCallIds([first, toolResult("bash:0"), copy] as AgentMessage[])).toEqual(["bash:0"]);
	});

	test("conversion renames reused ids per turn and keeps each result with its own call", () => {
		const converted = convertToLlm(kimiTurns());

		expect(toolCallIds(converted)).toEqual(["bash:0", "bash:0_2", "read:1", "bash:0_3"]);
		expect(resultPairs(converted)).toEqual([
			["bash:0", "first"],
			["bash:0_2", "second"],
			["read:1", "third"],
			["bash:0_3", "fourth"],
		]);
	});

	test("renamed ids stay stable as the conversation grows", () => {
		const shorter = kimiTurns().slice(0, 6);
		const longer = kimiTurns();

		expect(toolCallIds(convertToLlm(longer)).slice(0, 3)).toEqual(toolCallIds(convertToLlm(shorter)));
	});

	test("empty ids get unique ids paired with their results in call order", () => {
		const converted = convertToLlm([
			assistantWithToolCalls([""], 10),
			toolResult("", "first"),
			assistantWithToolCalls(["", ""], 20),
			toolResult("", "second"),
			toolResult("", "third"),
		]);

		expect(toolCallIds(converted)).toEqual(["call_1", "call_2", "call_2_1"]);
		expect(resultPairs(converted)).toEqual([
			["call_1", "first"],
			["call_2", "second"],
			["call_2_1", "third"],
		]);
	});

	test("a renamed id never collides with an id the model already used", () => {
		const converted = uniquifyToolCallIds([
			assistantWithToolCalls(["bash:0", "bash:0_2"], 10),
			assistantWithToolCalls(["bash:0"], 20),
		] as AgentMessage[]);

		expect(toolCallIds(converted)).toEqual(["bash:0", "bash:0_2", "bash:0_2_1"]);
	});

	test("context without reused ids is returned unchanged", () => {
		const messages = [assistantWithToolCalls(["call-a"], 10), toolResult("call-a")] as AgentMessage[];

		expect(uniquifyToolCallIds(messages)).toBe(messages);
	});

	test("the durable transcript is not mutated", () => {
		const messages = kimiTurns();
		const before = JSON.stringify(messages);

		convertToLlm(messages);

		expect(JSON.stringify(messages)).toBe(before);
	});
});

describe("tool calls with an empty id (#5056)", () => {
	test("finalized context keeps the result of each parallel empty-id call (#5056)", () => {
		const finalized = repairOrphanToolResults(
			deferMessagesInterleavedWithToolBatch([
				{ role: "user", content: "read both", timestamp: 1 },
				assistantWithToolCalls(["", ""], 10),
				toolResult("", "first"),
				toolResult("", "second"),
				{ role: "user", content: "next", timestamp: 30 },
			] as AgentMessage[]),
			{ repairTrailing: true },
		);

		expect(resultPairs(convertToLlm(finalized))).toEqual([
			["call_1", "first"],
			["call_1_1", "second"],
		]);
	});

	test("a tool call and result without any id are paired like empty ids (#5056)", () => {
		const call = assistantWithToolCalls(["x"], 10);
		const { id: _omitted, ...withoutId } = call.content[0] as { id: string };
		const result = toolResult("x", "only");
		const { toolCallId: _absent, ...resultWithoutId } = result;
		const converted = convertToLlm([
			{ ...call, content: [withoutId] },
			resultWithoutId,
			{ role: "user", content: "next", timestamp: 30 },
		] as AgentMessage[]);

		expect(toolCallIds(converted)).toEqual(["call_1"]);
		expect(resultPairs(converted)).toEqual([["call_1", "only"]]);
	});

	test("a message delivered between an empty-id call and its result does not take the call's id (#5056)", () => {
		const delivered = { role: "user", content: "delivered while running", timestamp: 15 } as AgentMessage;
		const kept = toolResult("kept", "second");
		const stray = toolResult("other", "stray");
		const uniquified = uniquifyToolCallIds([
			assistantWithToolCalls(["", "kept"], 10),
			delivered,
			toolResult("", "first"),
			kept,
			stray,
		] as AgentMessage[]);

		expect(uniquified[1]).toBe(delivered);
		expect(resultPairs(uniquified)).toEqual([
			["call_1", "first"],
			["kept", "second"],
			["other", "stray"],
		]);
		expect(uniquified[3]).toBe(kept);
		expect(uniquified[4]).toBe(stray);
	});

	test("well-paired context with text beside its tool calls is returned unchanged (#5056)", () => {
		const call = assistantWithToolCalls(["call-a"], 10);
		const messages = [
			{ ...call, content: [{ type: "text" as const, text: "reading" }, ...call.content] },
			toolResult("call-a"),
		] as AgentMessage[];

		expect(uniquifyToolCallIds(messages)).toBe(messages);
		expect(repairOrphanToolResults(messages)).toBe(messages);
	});

	test("a turn's calls without an id get the ids its later requests derive, before they run (#5056)", () => {
		const history = [assistantWithToolCalls(["a"], 10), toolResult("a")] as AgentMessage[];
		const turn = assistantWithToolCalls(["a", "", ""], 20);
		const { id: _omitted, ...withoutId } = turn.content[2] as { id: string };
		const content = [{ type: "text" as const, text: "running" }, turn.content[0], turn.content[1], withoutId];
		const message = { ...turn, content } as AgentMessage;
		const expected = toolCallIds(uniquifyToolCallIds([...history, message]).slice(-1));

		assignMissingToolCallIds(history, message);

		expect(toolCallIds([message])).toEqual(["a", "call_2", "call_2_1"]);
		expect(expected).toEqual(["a_2", "call_2", "call_2_1"]);
	});

	test("only an assistant turn's calls are given ids (#5056)", () => {
		const call = { type: "toolCall", id: "", name: "read", arguments: {} };
		const message = { role: "user", content: [call], timestamp: 1 } as unknown as AgentMessage;

		assignMissingToolCallIds([], message);

		expect(call.id).toBe("");
	});
});
