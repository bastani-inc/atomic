import assert from "node:assert/strict";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { describe, it } from "vitest";
import { createForkedSession } from "../src/core/session-fork.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function turn(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Look first.", thinkingSignature: "sig" },
			{ type: "toolCall", id: "call-ls", name: "bash", arguments: { command: "ls" } },
		],
		api: "anthropic-messages",
		provider: "github-copilot",
		model: "claude-opus-5.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

async function fork(source: SessionManager): Promise<string[]> {
	const leaf = source.getLeafId()!;
	const inherited = source.buildSessionContext().messages.length;
	await createForkedSession(source, leaf, () => "answered by the fork");
	return source
		.buildSessionContext()
		.messages.slice(inherited)
		.map((message) => (message.role === "toolResult" ? message.toolCallId : message.role));
}

describe("createForkedSession answers only the calls a request still holds open (#5481)", () => {
	it("answers the open call of a last turn that ended in a tool call", async () => {
		const source = SessionManager.inMemory();
		await source.appendMessage({ role: "user", content: "List the files.", timestamp: Date.now() });
		await source.appendMessage(turn("toolUse"));

		assert.deepEqual(await fork(source), ["call-ls"]);
	});

	for (const stopReason of ["aborted", "error"] as const) {
		it(`appends nothing for the calls of a last turn that ${stopReason === "aborted" ? "was aborted" : "failed"}`, async () => {
			// Requests leave such a turn out, so a result for its call would answer a tool call the provider never sees.
			const source = SessionManager.inMemory();
			await source.appendMessage({ role: "user", content: "List the files.", timestamp: Date.now() });
			await source.appendMessage(turn(stopReason));

			assert.deepEqual(await fork(source), []);
		});
	}

	it("appends nothing for calls a later user turn left behind", async () => {
		// The calls are earlier history, which every request already repairs; the fork only completes the last turn.
		const source = SessionManager.inMemory();
		await source.appendMessage({ role: "user", content: "List the files.", timestamp: Date.now() });
		await source.appendMessage(turn("toolUse"));
		await source.appendMessage({ role: "user", content: "Never mind, stop.", timestamp: Date.now() });

		assert.deepEqual(await fork(source), []);
	});
});
