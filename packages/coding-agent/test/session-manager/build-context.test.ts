import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type BranchSummaryEntry,
	buildSessionContext,
	type CompactionEntry,
	type ContextCompactionEntry,
	type ModelChangeEntry,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "../../src/core/session-manager.ts";

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: "2025-01-01T00:00:00Z", message };
}

function msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	if (role === "user") {
		return messageEntry(id, parentId, { role, content: text, timestamp: 1 });
	}
	return messageEntry(id, parentId, {
		role,
		content: [{ type: "text", text }],
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
		stopReason: "stop",
		timestamp: 1,
	});
}

function compaction(id: string, parentId: string | null, summary: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 1000,
	};
}

function contextCompaction(
	id: string,
	parentId: string | null,
	deletedTargets: ContextCompactionEntry["deletedTargets"],
): ContextCompactionEntry {
	return {
		type: "context_compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		promptVersion: 1,
		deletedTargets,
		protectedEntryIds: [],
		stats: {
			objectsBefore: 0,
			objectsAfter: 0,
			objectsDeleted: deletedTargets.length,
			tokensBefore: 0,
			tokensAfter: 0,
			percentReduction: 0,
		},
	};
}

function toolResultMessage(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function branchSummary(id: string, parentId: string | null, summary: string, fromId: string): BranchSummaryEntry {
	return { type: "branch_summary", id, parentId, timestamp: "2025-01-01T00:00:00Z", summary, fromId };
}

function thinkingLevel(id: string, parentId: string | null, level: string): ThinkingLevelChangeEntry {
	return { type: "thinking_level_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", thinkingLevel: level };
}

function modelChange(id: string, parentId: string | null, provider: string, modelId: string): ModelChangeEntry {
	return { type: "model_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", provider, modelId };
}

describe("buildSessionContext", () => {
	describe("trivial cases", () => {
		it("empty entries returns empty context", () => {
			const ctx = buildSessionContext([]);
			expect(ctx.messages).toEqual([]);
			expect(ctx.thinkingLevel).toBe("off");
			expect(ctx.model).toBeNull();
		});

		it("single user message", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello")];
			const ctx = buildSessionContext(entries);
			expect(ctx.messages).toHaveLength(1);
			expect(ctx.messages[0].role).toBe("user");
		});

		it("simple conversation", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				msg("2", "1", "assistant", "hi there"),
				msg("3", "2", "user", "how are you"),
				msg("4", "3", "assistant", "great"),
			];
			const ctx = buildSessionContext(entries);
			expect(ctx.messages).toHaveLength(4);
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		});

		it("tracks thinking level changes", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				thinkingLevel("2", "1", "high"),
				msg("3", "2", "assistant", "thinking hard"),
			];
			const ctx = buildSessionContext(entries);
			expect(ctx.thinkingLevel).toBe("high");
			expect(ctx.messages).toHaveLength(2);
		});

		it("tracks model from assistant message", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello"), msg("2", "1", "assistant", "hi")];
			const ctx = buildSessionContext(entries);
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-test" });
		});

		it("tracks model from model change entry", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				modelChange("2", "1", "openai", "gpt-4"),
				msg("3", "2", "assistant", "hi"),
			];
			const ctx = buildSessionContext(entries);
			// Assistant message overwrites model change
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-test" });
		});
	});

	describe("with legacy type:compaction entries (archival/inert)", () => {
		it("legacy compaction entry is ignored — all messages included without summary", () => {
			// Old sessions may contain type:"compaction" entries on disk.
			// These are now archival only: no compactionSummary message is injected,
			// and they do not act as a context boundary.
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "response1"),
				msg("3", "2", "user", "second"),
				msg("4", "3", "assistant", "response2"),
				compaction("5", "4", "Summary of first two turns", "3"),
				msg("6", "5", "user", "third"),
				msg("7", "6", "assistant", "response3"),
			];
			const ctx = buildSessionContext(entries);

			// All 6 real messages are included; no compactionSummary injected.
			expect(ctx.messages).toHaveLength(6);
			expect(ctx.messages.every((m) => m.role !== "compactionSummary")).toBe(true);
			expect((ctx.messages[0] as any).content).toBe("first");
			expect((ctx.messages[2] as any).content).toBe("second");
			expect((ctx.messages[4] as any).content).toBe("third");
		});

		it("multiple legacy compaction entries are all inert", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "a"),
				msg("2", "1", "assistant", "b"),
				compaction("3", "2", "First summary", "1"),
				msg("4", "3", "user", "c"),
				msg("5", "4", "assistant", "d"),
				compaction("6", "5", "Second summary", "4"),
				msg("7", "6", "user", "e"),
			];
			const ctx = buildSessionContext(entries);

			// All 5 real messages are included; no compactionSummary injected.
			expect(ctx.messages).toHaveLength(5);
			expect(ctx.messages.every((m) => m.role !== "compactionSummary")).toBe(true);
		});
	});

	describe("with branches", () => {
		it("follows path to specified leaf", () => {
			// Tree:
			//   1 -> 2 -> 3 (branch A)
			//         \-> 4 (branch B)
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "response"),
				msg("3", "2", "user", "branch A"),
				msg("4", "2", "user", "branch B"),
			];

			const ctxA = buildSessionContext(entries, "3");
			expect(ctxA.messages).toHaveLength(3);
			expect((ctxA.messages[2] as any).content).toBe("branch A");

			const ctxB = buildSessionContext(entries, "4");
			expect(ctxB.messages).toHaveLength(3);
			expect((ctxB.messages[2] as any).content).toBe("branch B");
		});

		it("includes branch summary in path", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "response"),
				msg("3", "2", "user", "abandoned path"),
				branchSummary("4", "2", "Summary of abandoned work", "3"),
				msg("5", "4", "user", "new direction"),
			];
			const ctx = buildSessionContext(entries, "5");

			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[2] as any).summary).toContain("Summary of abandoned work");
			expect((ctx.messages[3] as any).content).toBe("new direction");
		});

		it("complex tree with multiple branches and legacy compaction (inert)", () => {
			// Tree:
			//   1 -> 2 -> 3 -> 4 -> legacyCompaction(5) -> 6 -> 7 (main path)
			//              \-> 8 -> 9 (abandoned branch)
			//                    \-> branchSummary(10) -> 11 (resumed from 3)
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "r1"),
				msg("3", "2", "user", "q2"),
				msg("4", "3", "assistant", "r2"),
				compaction("5", "4", "Compacted history", "3"),
				msg("6", "5", "user", "q3"),
				msg("7", "6", "assistant", "r3"),
				// Abandoned branch from 3
				msg("8", "3", "user", "wrong path"),
				msg("9", "8", "assistant", "wrong response"),
				// Branch summary resuming from 3
				branchSummary("10", "3", "Tried wrong approach", "9"),
				msg("11", "10", "user", "better approach"),
			];

			// Main path to 7: legacy compaction entry is inert — all 6 real messages
			// (1,2,3,4,6,7) are included with no compactionSummary injected.
			const ctxMain = buildSessionContext(entries, "7");
			expect(ctxMain.messages).toHaveLength(6);
			expect(ctxMain.messages.every((m) => m.role !== "compactionSummary")).toBe(true);
			expect((ctxMain.messages[0] as any).content).toBe("start");
			expect((ctxMain.messages[2] as any).content).toBe("q2");
			expect((ctxMain.messages[4] as any).content).toBe("q3");
			expect((ctxMain.messages[5] as any).content[0].text).toBe("r3");

			// Branch path to 11: 1,2,3 + branch_summary + 11
			const ctxBranch = buildSessionContext(entries, "11");
			expect(ctxBranch.messages).toHaveLength(5);
			expect((ctxBranch.messages[0] as any).content).toBe("start");
			expect((ctxBranch.messages[1] as any).content[0].text).toBe("r1");
			expect((ctxBranch.messages[2] as any).content).toBe("q2");
			expect((ctxBranch.messages[3] as any).summary).toContain("Tried wrong approach");
			expect((ctxBranch.messages[4] as any).content).toBe("better approach");
		});
	});

	describe("with context_compaction entries", () => {
		it("applies old whole-entry deletion filters for non-latest thinking-bearing assistants", () => {
			const assistantContent = [
				{ type: "text", text: "visible text before thinking" },
				{ type: "thinking", thinking: "old thinking may be evicted", thinkingSignature: "sig-thinking" },
				{ type: "redacted_thinking", data: "opaque-redacted-payload" },
				{ type: "text", text: "visible text after thinking" },
			];
			const task = msg("1", null, "user", "keep task-bearing transcript intact");
			const oldAssistant = messageEntry("2", "1", {
				role: "assistant",
				content: assistantContent,
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
				stopReason: "stop",
				timestamp: 1,
			} as unknown as AssistantMessage);
			const latestAssistant = msg("3", "2", "assistant", "latest assistant remains");
			const compactionEntry = contextCompaction("4", "3", [{ kind: "entry", entryId: oldAssistant.id }]);

			const ctx = buildSessionContext([task, oldAssistant, latestAssistant, compactionEntry]);

			expect(ctx.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect((ctx.messages[1] as AssistantMessage).content).toEqual((latestAssistant.message as AssistantMessage).content);
		});

		it("restores old thinking content-block deletion filters when a newer assistant exists", () => {
			const oldAssistantContent = [
				{ type: "text", text: "keep old visible text" },
				{ type: "thinking", thinking: "old thinking may be evicted", thinkingSignature: "sig-old" },
				{ type: "text", text: "keep old trailing text" },
			];
			const task = msg("1", null, "user", "keep task-bearing transcript intact");
			const oldAssistant = messageEntry("2", "1", {
				role: "assistant",
				content: oldAssistantContent,
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
				stopReason: "stop",
				timestamp: 1,
			} as unknown as AssistantMessage);
			const latestAssistant = msg("3", "2", "assistant", "latest assistant remains");
			const compactionEntry = contextCompaction("4", "3", [
				{ kind: "content_block", entryId: oldAssistant.id, blockIndex: 1 },
			]);

			const ctx = buildSessionContext([task, oldAssistant, latestAssistant, compactionEntry]);
			const rebuiltOldAssistant = ctx.messages.find(
				(message): message is AssistantMessage =>
					message.role === "assistant" && Array.isArray(message.content) &&
					message.content.some((block) => block.type === "text" && block.text === "keep old visible text"),
			);

			expect(rebuiltOldAssistant?.content).toEqual(oldAssistantContent);
			expect(ctx.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
		});

		it("preserves paired tool results when restoring a partially filtered latest thinking-bearing assistant", () => {
			const toolCallId = "toolu_restored_latest_thinking_call";
			const assistantContent = [
				{ type: "thinking", thinking: "latest tool-use thinking must remain", thinkingSignature: "sig-tool-thinking" },
				{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "old.ts" } },
				{ type: "text", text: "read the old file" },
			];
			const task = msg("1", null, "user", "inspect old file");
			const assistant = messageEntry("2", "1", {
				role: "assistant",
				content: assistantContent,
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
			} as unknown as AssistantMessage);
			const result = messageEntry("3", "2", toolResultMessage(toolCallId, "old file contents"));
			const staleCompaction = contextCompaction("4", "3", [
				{ kind: "content_block", entryId: assistant.id, blockIndex: 0 },
				{ kind: "entry", entryId: result.id },
				{ kind: "content_block", entryId: result.id, blockIndex: 0 },
			]);

			const ctx = buildSessionContext([task, assistant, result, staleCompaction]);
			const rebuiltAssistant = ctx.messages.find(
				(message): message is AssistantMessage => message.role === "assistant",
			);
			const rebuiltResult = ctx.messages.find(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);

			expect(ctx.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
			expect(rebuiltAssistant?.content).toEqual(assistantContent);
			expect(rebuiltResult?.toolCallId).toBe(toolCallId);
			expect(rebuiltResult?.content).toEqual([{ type: "text", text: "old file contents" }]);
		});

		it("keeps paired tool results when later stale compactions try whole-entry deletion", () => {
			const toolCallId = "toolu_later_whole_result_filter";
			const assistantContent = [
				{ type: "thinking", thinking: "tool-use thinking must remain", thinkingSignature: "sig-tool-thinking" },
				{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "old.ts" } },
				{ type: "text", text: "read the old file" },
			];
			const task = msg("1", null, "user", "inspect old file");
			const assistant = messageEntry("2", "1", {
				role: "assistant",
				content: assistantContent,
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
			} as unknown as AssistantMessage);
			const result = messageEntry("3", "2", toolResultMessage(toolCallId, "old file contents"));
			const partialLatestCompaction = contextCompaction("4", "3", [
				{ kind: "content_block", entryId: assistant.id, blockIndex: 0 },
			]);
			const laterStaleResultDeletion = contextCompaction("5", "4", [
				{ kind: "entry", entryId: result.id },
			]);

			const ctx = buildSessionContext([task, assistant, result, partialLatestCompaction, laterStaleResultDeletion]);
			const rebuiltResult = ctx.messages.find(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);

			expect(ctx.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
			expect(rebuiltResult?.toolCallId).toBe(toolCallId);
			expect(rebuiltResult?.content).toEqual([{ type: "text", text: "old file contents" }]);
		});

		it("keeps later valid content-block deletion filters for restored paired tool results", () => {
			const toolCallId = "toolu_later_valid_result_filter";
			const assistantContent = [
				{ type: "thinking", thinking: "tool-use thinking must remain", thinkingSignature: "sig-tool-thinking" },
				{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "old.ts" } },
				{ type: "text", text: "read the old file" },
			];
			const task = msg("1", null, "user", "inspect old file");
			const assistant = messageEntry("2", "1", {
				role: "assistant",
				content: assistantContent,
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
			} as unknown as AssistantMessage);
			const result = messageEntry("3", "2", {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [
					{ type: "text", text: "delete me later" },
					{ type: "text", text: "keep me" },
				],
				isError: false,
				timestamp: 1,
			} as ToolResultMessage);
			const staleCompaction = contextCompaction("4", "3", [
				{ kind: "content_block", entryId: assistant.id, blockIndex: 0 },
				{ kind: "entry", entryId: result.id },
			]);
			const laterValidCompaction = contextCompaction("5", "4", [
				{ kind: "content_block", entryId: result.id, blockIndex: 0 },
			]);

			const ctx = buildSessionContext([task, assistant, result, staleCompaction, laterValidCompaction]);
			const rebuiltAssistant = ctx.messages.find(
				(message): message is AssistantMessage => message.role === "assistant",
			);
			const rebuiltResult = ctx.messages.find(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);

			expect(ctx.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
			expect(rebuiltAssistant?.content).toEqual(assistantContent);
			expect(rebuiltResult?.toolCallId).toBe(toolCallId);
			expect(rebuiltResult?.content).toEqual([{ type: "text", text: "keep me" }]);
		});

		it("keeps non-thinking assistant whole-entry deletion filters active", () => {
			const task = msg("1", null, "user", "discard stale answer");
			const assistant = msg("2", "1", "assistant", "obsolete non-thinking answer");
			const staleCompaction = contextCompaction("3", "2", [{ kind: "entry", entryId: assistant.id }]);

			const ctx = buildSessionContext([task, assistant, staleCompaction]);

			expect(ctx.messages.map((message) => message.role)).toEqual(["user"]);
			expect(ctx.messages.some((message) => message.role === "assistant")).toBe(false);
		});

		it("preserves paired tool results when stale thinking assistant content-block filters are skipped", () => {
			const toolCallId = "toolu_stale_thinking_call";
			const assistantContent = [
				{ type: "thinking", thinking: "private thinking must remain indexed", thinkingSignature: "sig-thinking" },
				{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "old.ts" } },
				{ type: "text", text: "visible answer" },
			];
			const task = msg("1", null, "user", "inspect old file");
			const assistant = messageEntry("2", "1", {
				role: "assistant",
				content: assistantContent,
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
			} as unknown as AssistantMessage);
			const result = messageEntry("3", "2", toolResultMessage(toolCallId, "old file contents"));
			const staleCompaction = contextCompaction("4", "3", [
				{ kind: "content_block", entryId: assistant.id, blockIndex: 0 },
				{ kind: "entry", entryId: result.id },
				{ kind: "content_block", entryId: result.id, blockIndex: 0 },
			]);

			const ctx = buildSessionContext([task, assistant, result, staleCompaction]);
			const rebuiltAssistant = ctx.messages.find(
				(message): message is AssistantMessage => message.role === "assistant",
			);
			const rebuiltResult = ctx.messages.find(
				(message): message is ToolResultMessage => message.role === "toolResult",
			);

			expect(rebuiltAssistant?.content).toEqual(assistantContent);
			expect(rebuiltResult?.toolCallId).toBe(toolCallId);
			expect(rebuiltResult?.content).toEqual([{ type: "text", text: "old file contents" }]);
		});

		it("keeps non-thinking assistant persisted tool-call deletion behavior unchanged", () => {
			const toolCallId = "toolu_non_thinking_call";
			const task = msg("1", null, "user", "inspect old file");
			const assistant = messageEntry("2", "1", {
				role: "assistant",
				content: [
					{ type: "text", text: "retain this note" },
					{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "old.ts" } },
				],
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
			} as AssistantMessage);
			const result = messageEntry("3", "2", toolResultMessage(toolCallId, "old file contents"));
			const staleCompaction = contextCompaction("4", "3", [
				{ kind: "content_block", entryId: assistant.id, blockIndex: 1 },
				{ kind: "entry", entryId: result.id },
			]);

			const ctx = buildSessionContext([task, assistant, result, staleCompaction]);
			const rebuiltAssistant = ctx.messages.find(
				(message): message is AssistantMessage => message.role === "assistant",
			);

			expect(rebuiltAssistant?.content).toEqual([{ type: "text", text: "retain this note" }]);
			expect(ctx.messages.some((message) => message.role === "toolResult")).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("uses last entry when leafId not found", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello"), msg("2", "1", "assistant", "hi")];
			const ctx = buildSessionContext(entries, "nonexistent");
			expect(ctx.messages).toHaveLength(2);
		});

		it("handles orphaned entries gracefully", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				msg("2", "missing", "assistant", "orphan"), // parent doesn't exist
			];
			const ctx = buildSessionContext(entries, "2");
			// Should only get the orphan since parent chain is broken
			expect(ctx.messages).toHaveLength(1);
		});
	});
});
