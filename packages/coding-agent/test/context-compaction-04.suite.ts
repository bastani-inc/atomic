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
		it("promotes fully deleted multi-tool assistant entries", () => {
			resetIds();
			const firstToolCallId = "call_A|fc_a";
			const secondToolCallId = "call_B|fc_b";
			const task = entry(user("Task"));
			const assistantWithCalls = entry({
				...assistantText(""),
				content: [
					{ type: "toolCall", id: firstToolCallId, name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: secondToolCallId, name: "read", arguments: { path: "b.ts" } },
				],
				stopReason: "toolUse",
			});
			const firstResult = entry(toolResult(firstToolCallId, "old a"));
			const secondResult = entry(toolResult(secondToolCallId, "old b"));
			const entries: SessionEntry[] = [
				task,
				assistantWithCalls,
				firstResult,
				secondResult,
				entry(assistantText("old filler 1")),
				entry(assistantText("old filler 2")),
				entry(assistantText("old filler 3")),
				entry(assistantText("old filler 4")),
				entry(assistantText("old filler 5")),
			];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
	
			const validated = validateContextDeletionRequest(
				{
					deletions: [
						{ kind: "entry", entryId: firstResult.id },
						{ kind: "entry", entryId: secondResult.id },
					],
				},
				preparation.transcript,
			);
	
			expect(validated.deletedTargets).toEqual([
				{ kind: "entry", entryId: firstResult.id },
				{ kind: "entry", entryId: secondResult.id },
				{ kind: "entry", entryId: assistantWithCalls.id },
			]);
		});

		it("supports content-block logical deletion while retaining other blocks verbatim", () => {
			resetIds();
			const multi = entry({
				...assistantText(""),
				content: [
					{ type: "text", text: "obsolete block" },
					{ type: "text", text: "keep exact path packages/coding-agent/src/core/session-manager.ts" },
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
			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: multi.id, blockIndex: 0 }] },
				preparation.transcript,
			);
			expect(validated.stats.objectsDeleted).toBe(1);
			expect(validated.stats.objectsAfter).toBe(validated.stats.objectsBefore - 1);
			const rebuilt = buildSessionContext([...entries, contextEntry(validated.deletedTargets)]);
			const rebuiltMulti = rebuilt.messages.find(
				(message) => message.role === "assistant" && message !== multi.message && "content" in message,
			) as AssistantMessage | undefined;
	
			expect(rebuiltMulti?.content).toEqual([
				{ type: "text", text: "keep exact path packages/coding-agent/src/core/session-manager.ts" },
			]);
		});

		it("counts deleted image content blocks with image-sized token estimates", () => {
			resetIds();
			const imageTokenEstimate = 1200;
			const placeholderTokenEstimate = Math.ceil("[image]".length / 4);
			const task = entry(user("Task that must remain available while deleting an old image block"));
			const call = entry(assistantToolCall("image-tool-1"));
			const imageResult = entry(toolResultWithImage("image-tool-1", "retained image tool text"));
			const entries: SessionEntry[] = [
				task,
				call,
				imageResult,
				entry(assistantTextWithoutUsage("recent image operation 1")),
				entry(assistantTextWithoutUsage("recent image operation 2")),
				entry(assistantTextWithoutUsage("recent image operation 3")),
				entry(assistantTextWithoutUsage("recent image operation 4")),
				entry(assistantTextWithoutUsage("recent image operation 5")),
				entry(assistantTextWithoutUsage("recent image operation 6")),
			];
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
			const transcriptEntry = preparation.transcript.entries.find((item) => item.entryId === imageResult.id);
			const imageBlock = transcriptEntry?.contentBlocks.find((block) => block.blockIndex === 1);
	
			expect(transcriptEntry?.protected).toBe(false);
			expect(imageBlock).toEqual(expect.objectContaining({ type: "image", text: "[image]" }));
			expect(imageBlock!.tokenEstimate).toBe(imageTokenEstimate);
			expect(imageBlock!.tokenEstimate).toBeGreaterThan(placeholderTokenEstimate);
	
			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "content_block", entryId: imageResult.id, blockIndex: 1 }] },
				preparation.transcript,
			);
	
			expect(validated.stats.objectsDeleted).toBe(1);
			expect(validated.stats.tokensBefore).toBe(preparation.transcript.tokensBefore);
			expect(validated.stats.tokensAfter).toBe(preparation.transcript.tokensBefore - imageTokenEstimate);
			expect(validated.stats.tokensBefore - validated.stats.tokensAfter).toBe(imageTokenEstimate);
		});

		it("derives repeated compaction text and token estimates from retained blocks", () => {
			resetIds();
			const deletedText = "obsolete repeated compaction block ".repeat(20);
			const retainedText = "keep repeated compaction block packages/coding-agent/src/core/session-manager.ts";
			const task = entry(user("Task"));
			const multi = entry({
				...assistantText(""),
				content: [
					{ type: "text", text: deletedText },
					{ type: "text", text: retainedText },
				],
			});
			const priorDeletion = contextEntry([{ kind: "content_block", entryId: multi.id, blockIndex: 0 }]);
			const entries: SessionEntry[] = [
				task,
				multi,
				priorDeletion,
				entry(assistantText("recent 1")),
				entry(assistantText("recent 2")),
				entry(assistantText("recent 3")),
				entry(assistantText("recent 4")),
				entry(assistantText("recent 5")),
				entry(assistantText("recent 6")),
			];
	
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
	
			expect(preparation).toBeDefined();
			const repeatedEntry = preparation!.transcript.entries.find((item) => item.entryId === multi.id);
			expect(repeatedEntry).toBeDefined();
			expect(repeatedEntry!.contentBlocks).toEqual([
				expect.objectContaining({ blockIndex: 1, text: retainedText }),
			]);
			expect(repeatedEntry!.text).toContain(retainedText);
			expect(repeatedEntry!.text).not.toContain(deletedText);
			expect(repeatedEntry!.tokenEstimate).toBe(
				estimateTokens({ ...multi.message, content: [{ type: "text", text: retainedText }] } as AssistantMessage),
			);
			expect(repeatedEntry!.tokenEstimate).toBeLessThan(estimateTokens(multi.message));
		});

		it("ignores historical /compact summaries in context compaction transcript and stats", () => {
			resetIds();
			const staleSummary = "stale /compact summary that must not be active";
			const activeSummary =
				"Active /compact summary with current decision for packages/coding-agent/src/core/session-manager.ts";
			const preStale = entry(user("old task before stale compact"));
			const staleCompaction = compactionEntry(staleSummary, preStale.id, 111);
			const summarizedBetween = entry(assistantTextWithoutUsage("summarized context between stale and active compaction"));
			const firstKept = entry(user("first retained task from active compact"));
			const retainedBeforeCompact = entry(assistantTextWithoutUsage("retained assistant context before active compact"));
			const activeCompaction = compactionEntry(activeSummary, firstKept.id, 4096);
			const retainedAfterUser = entry(user("post compact retained user instruction"));
			const retainedAfterAssistant = entry(assistantTextWithoutUsage("post compact retained assistant response"));
			const entries: SessionEntry[] = [
				preStale,
				staleCompaction,
				summarizedBetween,
				firstKept,
				retainedBeforeCompact,
				activeCompaction,
				retainedAfterUser,
				retainedAfterAssistant,
			];
	
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
	
			expect(preparation).toBeDefined();
			const transcript = preparation!.transcript;
			const prompt = buildContextCompactionPrompt(transcript);
			expect(transcript.entries.map((item) => item.entryId)).toEqual([
				preStale.id,
				summarizedBetween.id,
				firstKept.id,
				retainedBeforeCompact.id,
				retainedAfterUser.id,
				retainedAfterAssistant.id,
			]);
			expect(transcript.entries.some((item) => item.entryType === "compaction")).toBe(false);
			expect(transcript.protectedEntryIds).not.toContain(activeCompaction.id);
			expect(prompt).not.toContain(activeSummary);
			expect(prompt).not.toContain(staleSummary);
	
			const rebuilt = buildSessionContext(entries);
			expect(transcript.entries.map((item) => item.message)).toEqual(rebuilt.messages);
	
			const rawObjectCount = transcript.entries.reduce((total, item) => total + 1 + item.contentBlocks.length, 0);
			const rawTokenCount = transcript.entries.reduce((total, item) => total + item.tokenEstimate, 0);
			const validated = validateContextDeletionRequest({ deletions: [] }, transcript);
	
			expect(transcript.tokensBefore).toBe(rawTokenCount);
			expect(validated.stats.objectsBefore).toBe(rawObjectCount);
			expect(validated.stats.tokensBefore).toBe(rawTokenCount);
			expect(validated.stats.objectsAfter).toBe(validated.stats.objectsBefore);
			expect(validated.stats.tokensAfter).toBe(validated.stats.tokensBefore);
			expect(() =>
				validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: activeCompaction.id }] }, transcript),
			).toThrow(/Unknown deletion target/);
		});

		it("requires raw task-bearing context because historical /compact summaries are inert", () => {
			resetIds();
			const activeSummary = "Active /compact summary preserving the user's summarized task and constraints";
			const preCompactUser = entry(user("raw task retained because legacy summaries are inert"));
			const firstKeptAssistant = entry(assistantTextWithoutUsage("assistant context kept by summary compaction"));
			const activeCompaction = compactionEntry(activeSummary, firstKeptAssistant.id, 2048);
			const oldDeletableAssistant = entry(assistantTextWithoutUsage("old non-user assistant context safe to delete"));
			const entries: SessionEntry[] = [
				preCompactUser,
				firstKeptAssistant,
				activeCompaction,
				oldDeletableAssistant,
				entry(assistantTextWithoutUsage("recent post-compact operation 1")),
				entry(assistantTextWithoutUsage("recent post-compact operation 2")),
				entry(assistantTextWithoutUsage("recent post-compact operation 3")),
				entry(assistantTextWithoutUsage("recent post-compact operation 4")),
				entry(assistantTextWithoutUsage("recent post-compact operation 5")),
			];
	
			const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
	
			expect(preparation).toBeDefined();
			const transcript = preparation!.transcript;
			expect(transcript.entries.some((item) => item.role === "user")).toBe(true);
			expect(transcript.entries.some((item) => item.entryId === activeCompaction.id)).toBe(false);
			expect(transcript.entries.find((item) => item.entryId === oldDeletableAssistant.id)?.protected).toBe(false);
	
			const validated = validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: oldDeletableAssistant.id }] },
				transcript,
			);
	
			expect(validated.deletedTargets).toEqual([{ kind: "entry", entryId: oldDeletableAssistant.id }]);
			expect(validated.protectedEntryIds).not.toContain(activeCompaction.id);
			expect(validated.stats.objectsDeleted).toBe(2);
		});

		it("treats only context compaction entries as compaction boundaries", () => {
			resetIds();
			const u1 = entry(user("task"));
			const compaction = compactionEntry("Existing /compact summary", u1.id, 1234);
			const logicalDeletion = contextEntry([]);
			const entries: SessionEntry[] = [u1, compaction, logicalDeletion];
	
			expect(getLatestCompactionBoundaryEntry(entries)).toBe(logicalDeletion);
		});

		it("treats historical summary /compact entries as inert when context_compaction entries are present", () => {
			resetIds();
			const u1 = entry(user("summarized task"));
			const a1 = entry(assistantText("summarized answer"));
			const u2 = entry(user("kept task"));
			const a2 = entry(assistantText("kept answer"));
			const logicalDeletion = contextEntry([{ kind: "entry", entryId: a2.id }]);
			const compaction = compactionEntry("Existing /compact summary", u2.id, 1234);
	
			const rebuilt = buildSessionContext([u1, a1, u2, a2, logicalDeletion, compaction]);
	
			expect(rebuilt.messages.map((message) => message.role)).not.toContain("compactionSummary");
			expect(rebuilt.messages).toContain(u1.message);
			expect(rebuilt.messages).toContain(a1.message);
			expect(rebuilt.messages).toContain(u2.message);
			expect(rebuilt.messages).not.toContain(a2.message);
		});
});
