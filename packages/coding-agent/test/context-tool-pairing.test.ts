import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { assertToolPairingInvariant, findDuplicateToolCallIds } from "../src/core/context-tool-pairing.ts";

function assistantWithToolCalls(ids: string[]): AssistantMessage {
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
		timestamp: 1,
	};
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
