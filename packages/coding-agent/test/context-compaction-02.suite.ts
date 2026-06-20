import { describe, expect, it } from "vitest";
import {
	resetIds,
	user,
	assistantText,
	assistantTextWithoutUsage,
	assistantTextWithTotalUsage,
	bashExecution,
	excludedBashExecution,
	excludedCustomAgentMessage,
	assistantToolCall,
	toolResult,
	toolResultWithImage,
	entry,
	customMessageEntry,
	contextEntry,
	compactionEntry,
	buildContextCompactionPrompt,
	CompactableTranscript,
	contextCompact,
	createContextDeletionTool,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	prepareContextCompaction,
	validateContextDeletionRequest,
	buildSessionContext,
	CompactionEntry,
	ContextCompactionEntry,
	CustomMessageEntry,
	getLatestCompactionBoundaryEntry,
	SessionEntry,
	SessionMessageEntry,
	fauxAssistantMessage,
	registerFauxProvider,
	AssistantMessage,
	ToolResultMessage,
} from "./context-compaction-helpers.js";

describe("context compaction", () => {
		it("rejects last-two context deletion with an explicit recent-context error", () => {
			resetIds();
			const recentTarget = entry(assistantText("recent target should be guarded"));
			const entries: SessionEntry[] = [
				entry(user("Task remains available")),
				entry(assistantText("old deletable context")),
				entry(assistantText("older filler 1")),
				entry(assistantText("older filler 2")),
				recentTarget,
				entry(assistantText("recent 2")),
			];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
	
			expect(preparation.transcript.entries.find((item) => item.entryId === recentTarget.id)?.protected).toBe(true);
			expect(() =>
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: recentTarget.id }] }, preparation.transcript),
			).toThrow(/Cannot delete recent context entry/);
		});

		it("uses custom preserve_recent when marking recent context", () => {
			resetIds();
			const olderTarget = entry(assistantText("older target outside custom recent window"));
			const recentTarget = entry(assistantText("recent target inside custom recent window"));
			const entries: SessionEntry[] = [
				entry(user("Task remains available")),
				olderTarget,
				entry(assistantText("middle filler")),
				recentTarget,
				entry(assistantText("recent 2")),
				entry(assistantText("recent 3")),
			];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 3 })!;
	
			expect(preparation.parameters.preserve_recent).toBe(3);
			expect(preparation.transcript.entries.find((item) => item.entryId === olderTarget.id)?.protected).toBe(false);
			expect(preparation.transcript.entries.find((item) => item.entryId === recentTarget.id)?.protected).toBe(true);
			expect(() =>
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: recentTarget.id }] }, preparation.transcript),
			).toThrow(/last 3 context entries/);
		});

		it("repairs deletion requests that would orphan tool calls or results", () => {
			resetIds();
			const combinedToolCallId = "call_7SZEC0NytS60tNYbfx3iV93P|fc_0f290ffb56102ac9016a262e88c10c819aa3fe84e1e79aa20f";
			const entries: SessionEntry[] = [
				entry(user("Task")),
				entry(assistantToolCall(combinedToolCallId)),
				entry(toolResult(combinedToolCallId, "tool output")),
				entry(assistantText("old filler 1")),
				entry(assistantText("old filler 2")),
				entry(assistantText("old filler 3")),
				entry(assistantText("old filler 4")),
				entry(assistantText("old filler 5")),
			];
			const callEntry = entries[1] as SessionMessageEntry;
			const resultEntry = entries[2] as SessionMessageEntry;
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
	
			const callValidated = validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: callEntry.id }] },
				preparation.transcript,
			);
			expect(callValidated.deletedTargets).toEqual([
				{ kind: "entry", entryId: callEntry.id },
				{ kind: "entry", entryId: resultEntry.id },
			]);
	
			const resultValidated = validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: resultEntry.id }] },
				preparation.transcript,
			);
			expect(resultValidated.deletedTargets).toEqual([
				{ kind: "entry", entryId: resultEntry.id },
				{ kind: "entry", entryId: callEntry.id },
			]);
		});

		it("promotes paired tool-result deletion to whole-entry deletion for older thinking-bearing assistants", () => {
			resetIds();
			const combinedToolCallId = "call_7SZEC0NytS60tNYbfx3iV93P|fc_0f290ffb56102ac9016a262e88c10c819aa3fe84e1e79aa20f";
			const task = entry(user("Task"));
			const assistantWithThinkingAndCall = entry({
				...assistantText(""),
				content: [
					{ type: "thinking", thinking: "tool-call reasoning must remain indexed", thinkingSignature: "sig-thinking" },
					{ type: "toolCall", id: combinedToolCallId, name: "read", arguments: { path: "old.ts" } },
				],
				stopReason: "toolUse",
			} as unknown as AssistantMessage);
			const result = entry(toolResult(combinedToolCallId, "redundant old file contents"));
			const entries: SessionEntry[] = [
				task,
				assistantWithThinkingAndCall,
				result,
				entry(assistantText("old filler 1")),
				entry(assistantText("old filler 2")),
				entry(assistantText("old filler 3")),
				entry(assistantText("old filler 4")),
				entry(assistantText("old filler 5")),
			];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
	
			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: result.id }] },
				preparation.transcript,
			);
			expect(validated.deletedTargets).toEqual([
				{ kind: "entry", entryId: result.id },
				{ kind: "entry", entryId: assistantWithThinkingAndCall.id },
			]);
		});

		it("rejects content-block deletion requests that would remove every block from an entry", () => {
			resetIds();
			const multi = entry({
				...assistantText(""),
				content: [
					{ type: "text", text: "obsolete block 1" },
					{ type: "text", text: "obsolete block 2" },
				],
			});
			const entries: SessionEntry[] = [
				entry(user("Task")),
				multi,
				entry(assistantText("recent 1")),
				entry(assistantText("recent 2")),
				entry(assistantText("recent 3")),
				entry(assistantText("recent 4")),
				entry(assistantText("recent 5")),
				entry(assistantText("recent 6")),
			];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
	
			expect(() =>
				validateContextDeletionRequest(
					{
						deletions: [
							{ kind: "content_block", entryId: multi.id, blockIndex: 0 },
							{ kind: "content_block", entryId: multi.id, blockIndex: 1 },
						],
					},
					preparation.transcript,
				),
			).toThrow(/every content block/);
		});

		it("allows whole-entry deletion for older thinking-bearing assistants but rejects partial content-block deletions", () => {
			resetIds();
			const task = entry(user("Task must remain available"));
			const sensitiveAssistant = entry({
				...assistantText(""),
				content: [
					{ type: "text", text: "stale visible assistant text" },
					{ type: "thinking", thinking: "private thinking must remain", thinkingSignature: "sig-thinking" },
					{ type: "redacted_thinking", data: "opaque-redacted-payload" },
				],
			} as unknown as AssistantMessage);
			const safeAssistant = entry({
				...assistantText(""),
				content: [
					{ type: "text", text: "obsolete text block" },
					{ type: "text", text: "retained text block" },
				],
			});
			const entries: SessionEntry[] = [
				task,
				sensitiveAssistant,
				safeAssistant,
				entry(assistantText("recent 1")),
				entry(assistantText("recent 2")),
				entry(assistantText("recent 3")),
				entry(assistantText("recent 4")),
				entry(assistantText("recent 5")),
				entry(assistantText("recent 6")),
			];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
			const sensitiveEntry = preparation.transcript.entries.find((item) => item.entryId === sensitiveAssistant.id)!;
	
			expect(sensitiveEntry.protected).toBe(false);
			expect(sensitiveEntry.contentBlocks.map((block) => block.type)).toEqual(["text", "thinking", "redacted_thinking"]);
			for (const blockIndex of [0, 1, 2]) {
				expect(() =>
					validateContextDeletionRequest(
						{ deletions: [{ kind: "content_block", entryId: sensitiveAssistant.id, blockIndex }] },
						preparation.transcript,
					),
				).toThrow(/retained assistant messages containing thinking\/redacted_thinking content blocks are all-or-nothing/);
			}
			const entryValidated = validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: sensitiveAssistant.id }] },
				preparation.transcript,
			);
			expect(entryValidated.deletedTargets).toEqual([{ kind: "entry", entryId: sensitiveAssistant.id }]);
	
			const safeValidated = validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: safeAssistant.id, blockIndex: 0 }] },
				preparation.transcript,
			);
			expect(safeValidated.deletedTargets).toEqual([{ kind: "content_block", entryId: safeAssistant.id, blockIndex: 0 }]);
		});

		it("rejects deleting any content block in a retained thinking-bearing assistant message", () => {
			resetIds();
			const task = entry(user("Task must remain available"));
			const latestAssistant = entry({
				...assistantText(""),
				content: [
					{ type: "text", text: "latest visible text" },
					{ type: "thinking", thinking: "latest thinking must remain", thinkingSignature: "sig-thinking" },
					{ type: "redacted_thinking", data: "opaque-redacted-payload" },
				],
			} as unknown as AssistantMessage);
			const preparation = prepareContextCompaction([task, latestAssistant], DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!;
	
			expect(() =>
				validateContextDeletionRequest(
					{ deletions: [{ kind: "content_block", entryId: latestAssistant.id, blockIndex: 0 }] },
					preparation.transcript,
				),
			).toThrow(/retained assistant messages containing thinking\/redacted_thinking content blocks are all-or-nothing/);
			expect(() =>
				validateContextDeletionRequest(
					{ deletions: [{ kind: "content_block", entryId: latestAssistant.id, blockIndex: 1 }] },
					preparation.transcript,
				),
			).toThrow(/retained assistant messages containing thinking\/redacted_thinking content blocks are all-or-nothing/);
			expect(() =>
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: latestAssistant.id }] }, preparation.transcript),
			).toThrow(/latest assistant message.*thinking\/redacted_thinking/);
		});

		it("rejects content-block deletion from older retained thinking assistants", () => {
			resetIds();
			const task = entry(user("Task must remain available"));
			const olderThinkingAssistant = entry({
				...assistantText(""),
				content: [
					{ type: "text", text: "older visible text" },
					{ type: "thinking", thinking: "older thinking becomes latest", thinkingSignature: "sig-thinking" },
				],
			} as unknown as AssistantMessage);
			const newerAssistant = entry(assistantText("newer assistant to delete"));
			const entries: SessionEntry[] = [task, olderThinkingAssistant, newerAssistant];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 0 })!;
	
			expect(() =>
				validateContextDeletionRequest(
					{
						deletions: [
							{ kind: "content_block", entryId: olderThinkingAssistant.id, blockIndex: 0 },
							{ kind: "entry", entryId: newerAssistant.id },
						],
					},
					preparation.transcript,
				),
			).toThrow(/retained assistant messages containing thinking\/redacted_thinking content blocks are all-or-nothing/);
		});
});
