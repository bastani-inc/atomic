import { afterEach, describe, expect, it } from "vitest";
import {
	userMessage,
	assistantMessage,
	recentAssistantEntries,
	createTranscript,
	createProtectedTranscript,
	createContentBlockTranscript,
	createProtectedContentBlockTranscript,
	createProtectedToolBlockTranscript,
	createAssistantThinkingBlockTranscript,
	createAssistantThinkingSiblingTranscript,
	buildContextCompactionPrompt,
	CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT,
	contextCompact,
	createContextDeletionTool,
	DEFAULT_COMPACTION_SETTINGS,
	CompactableTranscript,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	Context,
	StreamOptions,
} from "./context-compaction-deletion-tool-helpers.js";

describe("context compaction deletion tools", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

		it("returns a protected-tool-block correction when exact deletion would orphan a tool result", async () => {
			const controller = createContextDeletionTool(createProtectedToolBlockTranscript());
	
			const result = await controller.tool.execute("toolu_delete_protected_tool_result", {
				deletions: [{ kind: "entry", entryId: "entry-tool-result" }],
			});
	
			expect(result.terminate).toBe(false);
			expect(result.details.error).toMatch(/protected tool block/i);
			expect(result.details.error).toMatch(/Choose another/i);
			expect(result.details.deletedTargets).toEqual([]);
			expect(controller.getDeletionRequest().deletions).toEqual([]);
		});

		it("grep deletion can remove older assistant thinking blocks", async () => {
			const blockController = createContextDeletionTool(createAssistantThinkingBlockTranscript());
	
			const blockResult = await blockController.grepTool.execute("toolu_thinking_block_grep", {
				pattern: "single thinking sentinel",
				target: "content_block",
			});
	
			expect(blockResult.terminate).toBe(false);
			expect(blockResult.details.error).toBeUndefined();
			expect(blockResult.details.matches).toEqual([expect.objectContaining({ entryId: "entry-thinking", target: "entry" })]);
			expect(blockResult.details.skipped).toEqual([]);
			expect(blockController.getDeletionRequest().deletions).toEqual([{ kind: "entry", entryId: "entry-thinking" }]);
	
			const entryController = createContextDeletionTool(createAssistantThinkingBlockTranscript());
			const entryResult = await entryController.grepTool.execute("toolu_thinking_entry_grep", {
				pattern: "single thinking sentinel",
				target: "entry",
			});
	
			expect(entryResult.details.matches).toEqual([expect.objectContaining({ entryId: "entry-thinking", target: "entry" })]);
			expect(entryResult.details.skipped).toEqual([]);
			expect(entryController.getDeletionRequest().deletions).toEqual([{ kind: "entry", entryId: "entry-thinking" }]);
		});

		it("grep deletion skips content-block matches in older assistant thinking-bearing entries", async () => {
			const controller = createContextDeletionTool(createAssistantThinkingSiblingTranscript());
	
			const result = await controller.grepTool.execute("toolu_thinking_sibling_grep", {
				pattern: "visible sibling sentinel",
				target: "content_block",
			});
	
			expect(result.terminate).toBe(false);
			expect(result.details.error).toBeUndefined();
			expect(result.details.matches).toEqual([]);
			expect(result.details.skipped).toEqual([
				expect.objectContaining({
					entryId: "entry-thinking-sibling",
					target: "content_block",
					blockIndex: 0,
					reason: "protected_block",
				}),
			]);
			expect(controller.getDeletionRequest().deletions).toEqual([]);
	
			const entryController = createContextDeletionTool(createAssistantThinkingSiblingTranscript());
			const entryResult = await entryController.grepTool.execute("toolu_thinking_sibling_entry_grep", {
				pattern: "visible sibling sentinel",
				target: "entry",
			});
	
			expect(entryResult.details.error).toBeUndefined();
			expect(entryResult.details.matches).toEqual([
				expect.objectContaining({ entryId: "entry-thinking-sibling", target: "entry" }),
			]);
			expect(entryResult.details.skipped).toEqual([]);
			expect(entryController.getDeletionRequest().deletions).toEqual([
				{ kind: "entry", entryId: "entry-thinking-sibling" },
			]);
		});

		it("keeps maxMatches scoped to a single grep tool call without imposing a cumulative cap", async () => {
			const task = userMessage("Keep enough task context.");
			const bulkEntries = Array.from({ length: 60 }, (_unused, index) => {
				const batch = index < 30 ? "alpha" : "beta";
				const text = `bulk ${batch} stale grep target ${index}`;
				const message = assistantMessage(text);
				return {
					entryId: `entry-bulk-${index}`,
					entryType: "message" as const,
					role: "assistant" as const,
					text,
					tokenEstimate: 4,
					protected: false,
					contentBlocks: [],
					message,
					toolCallIds: [],
				};
			});
			const recentEntries = recentAssistantEntries("entry-bulk-recent");
			const transcript: CompactableTranscript = {
				entries: [
					{
						entryId: "entry-user",
						entryType: "message",
						role: "user",
						text: "Keep enough task context.",
						tokenEstimate: 6,
						protected: true,
						contentBlocks: [],
						message: task,
						toolCallIds: [],
					},
					...bulkEntries,
					...recentEntries,
				],
				protectedEntryIds: ["entry-user", ...recentEntries.map((entry) => entry.entryId)],
				tokensBefore:
					6 +
					bulkEntries.reduce((total, entry) => total + entry.tokenEstimate, 0) +
					recentEntries.reduce((total, entry) => total + entry.tokenEstimate, 0),
				settings: DEFAULT_COMPACTION_SETTINGS,
			};
			const cappedController = createContextDeletionTool(transcript);
			const cappedResult = await cappedController.grepTool.execute("toolu_grep_capped", {
				pattern: "stale grep target",
				target: "entry",
				maxMatches: 10,
			});
	
			expect(cappedResult.terminate).toBe(false);
			expect(cappedResult.details.skipped).toEqual([expect.objectContaining({ reason: "max_matches_exceeded" })]);
			expect(cappedController.getDeletionRequest().deletions).toEqual([]);
	
			const controller = createContextDeletionTool(transcript);
			const alpha = await controller.grepTool.execute("toolu_grep_alpha", {
				pattern: "bulk alpha stale grep target",
				target: "entry",
				maxMatches: 30,
			});
			const beta = await controller.grepTool.execute("toolu_grep_beta", {
				pattern: "bulk beta stale grep target",
				target: "entry",
				maxMatches: 30,
			});
	
			expect(alpha.details.error).toBeUndefined();
			expect(beta.details.error).toBeUndefined();
			expect(alpha.details.matches).toHaveLength(30);
			expect(beta.details.matches).toHaveLength(30);
			expect(controller.getDeletionRequest().deletions).toHaveLength(60);
		});

		it("reports expectedMatchCount guardrail mismatches without applying matches", async () => {
			const expectedController = createContextDeletionTool(createTranscript());
			const expectedResult = await expectedController.grepTool.execute("toolu_grep_expected", {
				pattern: "Old",
				target: "entry",
				expectedMatchCount: 3,
			});
	
			expect(expectedResult.terminate).toBe(false);
			expect(expectedResult.details.skipped).toEqual([
				expect.objectContaining({ reason: "expected_match_count_mismatch" }),
			]);
			expect(expectedController.getDeletionRequest().deletions).toEqual([]);
		});

		it("reports already-deleted content-block promotions as entry targets", async () => {
			const controller = createContextDeletionTool(createContentBlockTranscript());
	
			const first = await controller.grepTool.execute("toolu_single_first", {
				pattern: "single",
				target: "content_block",
			});
			const second = await controller.grepTool.execute("toolu_single_second", {
				pattern: "single",
				target: "content_block",
			});
	
			expect(first.details.matches).toEqual([expect.objectContaining({ entryId: "entry-single", target: "entry" })]);
			expect(second.details.skipped).toEqual([
				expect.objectContaining({ entryId: "entry-single", target: "entry", reason: "already_deleted" }),
			]);
			expect(controller.getDeletionRequest().deletions).toEqual([{ kind: "entry", entryId: "entry-single" }]);
		});

		it("keeps protected entries undeletable during compaction", async () => {
			const controller = createContextDeletionTool(createProtectedTranscript());
	
			const result = await controller.tool.execute("toolu_delete_old_user", {
				deletions: [{ kind: "entry", entryId: "entry-old-user" }],
			});
	
			expect(result.terminate).toBe(false);
			expect(result.details.error).toMatch(/entry-old-user is protected/);
			expect(result.details.error).toMatch(/Choose another/i);
			expect(controller.getDeletionRequest().deletions).toEqual([]);
		});

		it("returns a clear self-correction error for non-deletable thinking content blocks", async () => {
			const latestThinking = {
				...assistantMessage(""),
				content: [
					{ type: "text", text: "latest visible text" },
					{ type: "thinking", thinking: "latest thinking must stay", thinkingSignature: "sig-latest" },
				],
			};
			const transcript: CompactableTranscript = {
				entries: [
					{
						entryId: "entry-user",
						entryType: "message",
						role: "user",
						text: "Task remains available.",
						tokenEstimate: 6,
						protected: true,
						contentBlocks: [],
						message: userMessage("Task remains available."),
						toolCallIds: [],
					},
					{
						entryId: "entry-latest-thinking",
						entryType: "message",
						role: "assistant",
						text: "latest visible text\nlatest thinking must stay",
						tokenEstimate: 8,
						protected: false,
						contentBlocks: [
							{
								entryId: "entry-latest-thinking",
								blockIndex: 0,
								type: "text",
								text: "latest visible text",
								tokenEstimate: 4,
								protected: false,
							},
							{
								entryId: "entry-latest-thinking",
								blockIndex: 1,
								type: "thinking",
								text: "latest thinking must stay",
								tokenEstimate: 4,
								protected: false,
							},
						],
						message: latestThinking,
						toolCallIds: [],
					},
				],
				protectedEntryIds: ["entry-user"],
				tokensBefore: 14,
				settings: DEFAULT_COMPACTION_SETTINGS,
			};
			const controller = createContextDeletionTool(transcript, { preserve_recent: 0 });
	
			const result = await controller.tool.execute("toolu_delete_latest_thinking_block", {
				deletions: [{ kind: "content_block", entryId: "entry-latest-thinking", blockIndex: 1 }],
			});
	
			expect(result.terminate).toBe(false);
			expect(result.details.error).toMatch(/thinking\/redacted_thinking block in a retained assistant message/);
			expect(result.details.error).toMatch(/all-or-nothing/);
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(/corrected tool call/);
			expect(controller.getDeletionRequest().deletions).toEqual([]);
		});
});
