import assert from "node:assert/strict";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { describe, it } from "vitest";
import { type AgentSessionEvent, createTranscript } from "../../../src/index.ts";

type AssistantContent = AssistantMessage["content"][number];

function assistant(content: AssistantContent[], stopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason,
		timestamp: 0,
	} as unknown as AssistantMessage;
}

function event(value: object): AgentSessionEvent {
	return value as AgentSessionEvent;
}

function update(partial: AssistantMessage, assistantMessageEvent: object): AgentSessionEvent {
	return event({ type: "message_update", message: partial, assistantMessageEvent });
}

describe("createTranscript (#3475)", () => {
	it("does not duplicate streamed text when the provider mutates the message_start partial (#3475)", () => {
		const transcript = createTranscript();
		const partial = assistant([]);
		transcript.apply(event({ type: "message_start", message: partial }));
		for (const delta of ["Hello", ", ", "world"]) {
			// The provider appends to its live partial before emitting each delta.
			if (partial.content.length === 0) partial.content.push({ type: "text", text: "" });
			(partial.content[0] as { text: string }).text += delta;
			transcript.apply(update(partial, { type: "text_delta", contentIndex: 0, delta }));
		}
		assert.deepEqual(transcript.parts(), [{ type: "text", text: "Hello, world" }]);

		transcript.apply(event({ type: "message_end", message: assistant([{ type: "text", text: "Hello, world" }]) }));
		assert.deepEqual(transcript.parts(), [{ type: "text", text: "Hello, world" }]);
	});

	it("skips redacted thinking and keeps visible thinking (#3475)", () => {
		const transcript = createTranscript();
		transcript.apply(
			event({
				type: "message_end",
				message: assistant([
					{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque", redacted: true },
					{ type: "thinking", thinking: "Plan the answer" },
					{ type: "text", text: "Answer" },
				]),
			}),
		);
		assert.deepEqual(transcript.parts(), [
			{ type: "thinking", thinking: "Plan the answer" },
			{ type: "text", text: "Answer" },
		]);
	});

	it("merges a tool call with its partial update and final error result (#3475)", () => {
		const transcript = createTranscript();
		const call = { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } } as const;
		const partial = assistant([]);
		transcript.apply(event({ type: "message_start", message: partial }));
		transcript.apply(update(partial, { type: "toolcall_end", contentIndex: 0, toolCall: call }));
		assert.deepEqual(transcript.parts(), [
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
		]);

		transcript.apply(event({ type: "message_end", message: assistant([call], "toolUse") }));
		transcript.apply(
			event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: call.arguments }),
		);
		transcript.apply(
			event({
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "bash",
				args: call.arguments,
				partialResult: { content: [{ type: "text", text: "a.txt" }], details: { lines: 1 } },
			}),
		);
		assert.deepEqual(transcript.parts()[0], {
			...call,
			result: { content: "a.txt", isError: false, isPartial: true },
		});

		transcript.apply(
			event({
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "bash",
				result: {
					content: [
						{ type: "text", text: "a.txt" },
						{ type: "text", text: "exit 1" },
					],
					details: {},
				},
				isError: true,
			}),
		);
		assert.deepEqual(transcript.parts(), [
			{ ...call, result: { content: "a.txt\nexit 1", isError: true, isPartial: false } },
		]);
	});

	it("reports details instead of content for tools that opt in (#3475)", () => {
		const transcript = createTranscript({ toolResult: (name) => (name === "todo" ? "details" : "content") });
		const todo = { type: "toolCall", id: "t", name: "todo", arguments: {} } as const;
		const read = { type: "toolCall", id: "r", name: "read", arguments: {} } as const;
		transcript.apply(event({ type: "message_end", message: assistant([todo, read], "toolUse") }));
		for (const call of [todo, read]) {
			transcript.apply(
				event({
					type: "tool_execution_end",
					toolCallId: call.id,
					toolName: call.name,
					result: { content: [{ type: "text", text: `${call.name} text` }], details: { items: [1] } },
					isError: false,
				}),
			);
		}
		assert.deepEqual(
			transcript.parts().map((part) => (part.type === "toolCall" ? part.result : undefined)),
			[
				{ details: { items: [1] }, isError: false, isPartial: false },
				{ content: "read text", isError: false, isPartial: false },
			],
		);
	});

	it("ignores events from nested tool calls (#3475)", () => {
		const transcript = createTranscript();
		const call = { type: "toolCall", id: "outer", name: "codemode", arguments: {} } as const;
		transcript.apply(event({ type: "message_end", message: assistant([call], "toolUse") }));
		transcript.apply(
			event({
				type: "tool_execution_end",
				toolCallId: "outer",
				toolName: "read",
				parentToolCallId: "outer",
				result: { content: [{ type: "text", text: "nested" }] },
				isError: false,
			}),
		);
		assert.deepEqual(transcript.parts(), [call]);
	});

	it("orders parts across multiple assistant messages (#3475)", () => {
		const transcript = createTranscript();
		const call = { type: "toolCall", id: "c", name: "read", arguments: { path: "a" } } as const;
		transcript.apply(event({ type: "message_start", message: assistant([]) }));
		transcript.apply(
			event({ type: "message_end", message: assistant([{ type: "text", text: "First" }, call], "toolUse") }),
		);
		transcript.apply(
			event({
				type: "tool_execution_end",
				toolCallId: "c",
				toolName: "read",
				result: { content: [{ type: "text", text: "data" }] },
				isError: false,
			}),
		);
		const toolResultMessage = { role: "toolResult", toolCallId: "c", toolName: "read", content: [], isError: false };
		transcript.apply(event({ type: "message_start", message: toolResultMessage }));
		transcript.apply(event({ type: "message_end", message: toolResultMessage }));
		const second = assistant([]);
		transcript.apply(event({ type: "message_start", message: second }));
		transcript.apply(update(second, { type: "text_start", contentIndex: 0 }));
		transcript.apply(update(second, { type: "text_delta", contentIndex: 0, delta: "Second" }));

		assert.deepEqual(transcript.parts(), [
			{ type: "text", text: "First" },
			{ ...call, result: { content: "data", isError: false, isPartial: false } },
			{ type: "text", text: "Second" },
		]);
	});

	it("returns parts that survive a JSON round trip (#3475)", () => {
		const transcript = createTranscript({ toolResult: () => "details" });
		const call = { type: "toolCall", id: "c", name: "bash", arguments: { command: "pwd" } } as const;
		transcript.apply(
			event({
				type: "message_end",
				message: assistant([{ type: "thinking", thinking: "hm" }, { type: "text", text: "Run" }, call], "toolUse"),
			}),
		);
		transcript.apply(
			event({
				type: "tool_execution_end",
				toolCallId: "c",
				toolName: "bash",
				result: { content: [{ type: "text", text: "/" }] },
				isError: false,
			}),
		);
		const parts = transcript.parts();
		assert.deepEqual(JSON.parse(JSON.stringify(parts)), parts);
		assert.deepEqual(parts[2], { ...call, result: { details: null, isError: false, isPartial: false } });
	});

	it("returns snapshots that callers cannot use to mutate the transcript (#3475)", () => {
		const transcript = createTranscript({ toolResult: () => "details" });
		const call = { type: "toolCall", id: "c", name: "todo", arguments: { items: ["a"] } };
		transcript.apply(event({ type: "message_end", message: assistant([call], "toolUse") }));
		transcript.apply(
			event({
				type: "tool_execution_end",
				toolCallId: "c",
				toolName: "todo",
				result: { content: [], details: { done: ["a"] } },
				isError: false,
			}),
		);
		const first = transcript.parts()[0] as {
			arguments: { items: string[] };
			result: { details: { done: string[] } };
		};
		first.arguments.items.push("mutated");
		first.result.details.done.push("mutated");
		assert.deepEqual(transcript.parts()[0], {
			...call,
			arguments: { items: ["a"] },
			result: { details: { done: ["a"] }, isError: false, isPartial: false },
		});
	});

	it("keeps a result that arrives before its tool call block and does not overwrite it on abort (#3475)", () => {
		const transcript = createTranscript();
		const done = { type: "toolCall", id: "done", name: "read", arguments: {} } as const;
		const pending = { type: "toolCall", id: "pending", name: "bash", arguments: {} } as const;
		transcript.apply(event({ type: "message_start", message: assistant([]) }));
		transcript.apply(
			event({
				type: "tool_execution_end",
				toolCallId: "done",
				toolName: "read",
				result: { content: [{ type: "text", text: "early" }] },
				isError: false,
			}),
		);
		transcript.apply(
			event({
				type: "message_end",
				message: { ...assistant([done, pending], "aborted"), errorMessage: "Request was aborted" },
			}),
		);
		assert.deepEqual(transcript.parts(), [
			{ ...done, result: { content: "early", isError: false, isPartial: false } },
			{ ...pending, result: { content: "Request was aborted", isError: true, isPartial: false } },
		]);
	});
});
