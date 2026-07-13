import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	type BranchSummaryEntry,
	buildSessionContext,
	type CompactionEntry,
	type ContextCompactionEntry,
	type ContextWindowChangeEntry,
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

function assistantToolCallMessage(toolCallId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "old.ts" } }],
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

function branchSummary(id: string, parentId: string | null, summary: string, fromId: string): BranchSummaryEntry {
	return { type: "branch_summary", id, parentId, timestamp: "2025-01-01T00:00:00Z", summary, fromId };
}

function thinkingLevel(id: string, parentId: string | null, level: string): ThinkingLevelChangeEntry {
	return { type: "thinking_level_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", thinkingLevel: level };
}

function contextWindow(id: string, parentId: string | null, value: number): ContextWindowChangeEntry {
	return { type: "context_window_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", contextWindow: value };
}

function modelChange(id: string, parentId: string | null, provider: string, modelId: string): ModelChangeEntry {
	return { type: "model_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", provider, modelId };
}
describe("buildSessionContext", () => {
	describe("trivial cases", () => {
		it("keeps non-thinking assistant whole-entry deletion filters active", () => {
			const task = msg("1", null, "user", "discard stale answer");
			const assistant = msg("2", "1", "assistant", "obsolete non-thinking answer");
			const staleCompaction = contextCompaction("3", "2", [{ kind: "entry", entryId: assistant.id }]);

			const ctx = buildSessionContext([task, assistant, staleCompaction]);

			expect(ctx.messages.map((message) => message.role)).toEqual(["user"]);
			expect(ctx.messages.some((message) => message.role === "assistant")).toBe(false);
		});
		it("omits paired tool results when stale signed-assistant blocks are filtered", () => {
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
			expect(ctx.messages.map((message) => message.role)).toEqual(["user"]);
			expect(JSON.stringify(ctx.messages)).not.toContain(toolCallId);
			expect(JSON.stringify(ctx.messages)).not.toContain("old file contents");
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
		it("drops paired results when persisted compaction removes only non-thinking tool calls", () => {
			const toolCallId = "toolu_split_call";
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
			]);

			const ctx = buildSessionContext([task, assistant, result, staleCompaction]);
			const rebuiltAssistant = ctx.messages.find(
				(message): message is AssistantMessage => message.role === "assistant",
			);

			expect(rebuiltAssistant?.content).toEqual([{ type: "text", text: "retain this note" }]);
			expect(ctx.messages.some((message) => message.role === "toolResult")).toBe(false);
		});
		it("drops paired results when persisted compaction removes only tool-call entries", () => {
			const toolCallId = "toolu_deleted_entry_call";
			const task = msg("1", null, "user", "inspect old file");
			const assistant = messageEntry("2", "1", {
				...assistantToolCallMessage(toolCallId),
				content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "old.ts" } }],
			});
			const result = messageEntry("3", "2", toolResultMessage(toolCallId, "old file contents"));
			const staleCompaction = contextCompaction("4", "3", [{ kind: "entry", entryId: assistant.id }]);

			const ctx = buildSessionContext([task, assistant, result, staleCompaction]);

			expect(ctx.messages.map((message) => message.role)).toEqual(["user"]);
		});
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
