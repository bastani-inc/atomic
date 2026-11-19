import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	bindSubagentChildCards,
	clearSubagentChildTranscriptCache,
	subagentChildCardRecord,
	subagentChildTranscriptDetails,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import { collectGarbage } from "../helpers/collect-garbage.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

test("an explicitly expanded forked-child card reads its own displayed tool details and releases them on collapse (#5594)", async () => {
	const store = new MemorySessionStore();
	try {
		const owner = await SessionManager.create(store, process.cwd());
		const child = await SessionManager.create(store, process.cwd());
		const launch = await child.appendMessage({ role: "user", content: "inherited", timestamp: 1 });
		await child.appendMessage({ role: "user", content: "own task", timestamp: 2 });
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		await child.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private-thinking".repeat(90000), thinkingSignature: "s" },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "chosen" } },
			],
			provider: "anthropic",
			model: "test",
			api: "anthropic-messages",
			usage,
			stopReason: "toolUse",
			timestamp: 3,
		});
		await child.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "shown" }],
			details: { token: "a raw extension object" },
			timestamp: 4,
		});
		await child.appendCustomEntry("unrelated-private-data", { payload: "not part of any card".repeat(90000) });
		await child.appendCompaction("clear", null, 100, {
			strategy: "verbatim-lines",
			form: "cleared",
			promptVersion: 7,
			parameters: { query: "clear" },
			stats: {
				linesBefore: 1,
				linesDeleted: 1,
				linesKept: 0,
				rangeCount: 0,
				tokensBefore: 100,
				tokensAfter: 0,
				percentReduction: 100,
			},
		});
		await child.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			provider: "anthropic",
			model: "test",
			api: "anthropic-messages",
			usage,
			stopReason: "stop",
			timestamp: 5,
		});
		const childId = "expanded-fork-case",
			taskId = "card-task";
		await owner.appendCustomEntry("subagent-child", {
			version: 1,
			childId,
			index: 0,
			runId: "card-run",
			agent: "worker",
			cwd: process.cwd(),
			state: "terminal",
			terminalStatus: "completed",
			taskId,
			childSessionId: child.getSessionId(),
			owner: { kind: "session", sessionId: owner.getSessionId() },
			launchLeafId: launch,
			launchLeafSeq: 1,
			forked: true,
		});
		bindSubagentChildCards({ sessionManager: owner });
		const record = subagentChildCardRecord(childId, taskId)!;
		assert.ok(record);
		const opened = vi.spyOn(store, "readResume");
		const snapshot = vi.spyOn(store, "load");
		const card = {};
		const ref = await (async () => {
			const shown = await vi.waitFor(
				() => {
					const d = subagentChildTranscriptDetails(card, record);
					assert.ok(d);
					return d;
				},
				{ timeout: 10000, interval: 10 },
			);
			assert.deepEqual(shown, {
				prompt: "own task",
				result: "answer",
				lines: ["› own task", "→ read", "answer"],
				toolCalls: [
					{
						id: "call",
						name: "read",
						args: { path: "chosen" },
						resultContent: [{ type: "text", text: "shown" }],
						resultDetails: { token: "a raw extension object" },
						resultText: "shown",
						isError: false,
						completed: true,
					},
				],
			});
			return new WeakRef(shown.toolCalls[0]!.resultDetails as object);
		})();
		assert.equal(opened.mock.calls.length, 0, "opening the card opened a session runtime");
		assert.equal(snapshot.mock.calls.length, 0, "opening the card loaded a whole saved session");
		clearSubagentChildTranscriptCache(card);
		await collectGarbage();
		assert.equal(ref.deref(), undefined);
	} finally {
		await store.close();
	}
});
