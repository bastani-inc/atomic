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
import { createAssistantThinkingBlockTranscript, createAssistantThinkingSiblingTranscript } from "./context-compaction-deletion-tool-thinking-helpers.js";

describe("context compaction deletion tools", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

		it("searches and reads transcript slices without mutating deletion state", async () => {
			const controller = createContextDeletionTool(createTranscript());
	
			const search = await controller.searchTool.execute("toolu_search", {
				pattern: "Old",
				target: "entry",
				maxMatches: 5,
				contextChars: 20,
			});
			const read = await controller.readEntryTool.execute("toolu_read", {
				entryId: "entry-old-1",
				offset: 0,
				maxChars: 8,
			});
	
			expect(search.terminate).toBe(false);
			expect(search.details.matches.map((match) => match.entryId)).toEqual(["entry-old-1", "entry-old-2"]);
			expect(read.terminate).toBe(false);
			expect(read.details.text).toBe("Old sear");
			expect(read.details.truncatedAfter).toBe(true);
			expect(controller.getDeletionRequest().deletions).toEqual([]);
		});

		it("allows parallel tool execution while serializing shared deletion state", async () => {
			const controller = createContextDeletionTool(createTranscript());
	
			expect(controller.tool.executionMode).toBe("parallel");
			expect(controller.grepTool.executionMode).toBe("parallel");
			expect(controller.searchTool.executionMode).toBe("parallel");
			expect(controller.readEntryTool.executionMode).toBe("parallel");
	
			const [first, second] = await Promise.all([
				controller.tool.execute("toolu_delete_1", {
					deletions: [{ kind: "entry", entryId: "entry-old-1" }],
				}),
				controller.tool.execute("toolu_delete_2", {
					deletions: [{ kind: "entry", entryId: "entry-old-2" }],
				}),
			]);
	
			expect(first.terminate).toBe(false);
			expect(second.terminate).toBe(false);
			expect(controller.getDeletionRequest().deletions).toEqual([
				{ kind: "entry", entryId: "entry-old-1" },
				{ kind: "entry", entryId: "entry-old-2" },
			]);
			expect(controller.getCallCount()).toBe(2);
		});

		it("bulk deletes grep-matched entries with embedded guardrails", async () => {
			const controller = createContextDeletionTool(createTranscript());
	
			const result = await controller.grepTool.execute("toolu_grep", {
				pattern: "Old",
				target: "entry",
			});
	
			expect(result.terminate).toBe(false);
			expect(controller.getDeletionRequest().deletions).toEqual([
				{ kind: "entry", entryId: "entry-old-1" },
				{ kind: "entry", entryId: "entry-old-2" },
			]);
			expect(result.details.matches.map((match) => match.entryId)).toEqual(["entry-old-1", "entry-old-2"]);
			expect(result.details.skipped).toEqual([]);
		});

		it("grep bulk deletion skips protected matches inside the tool", async () => {
			const controller = createContextDeletionTool(createTranscript());
	
			const result = await controller.grepTool.execute("toolu_grep", {
				pattern: "Keep",
				target: "entry",
			});
	
			expect(result.terminate).toBe(false);
			expect(controller.getDeletionRequest().deletions).toEqual([]);
			expect(result.details.matches).toEqual([]);
			expect(result.details.skipped).toEqual([
				expect.objectContaining({ entryId: "entry-user", reason: "protected_entry" }),
			]);
		});

		it("supports regex grep matching and invalid regex tool errors", async () => {
			const controller = createContextDeletionTool(createTranscript());
	
			const regexResult = await controller.grepTool.execute("toolu_regex", {
				pattern: "Old (search|file)",
				regex: true,
				target: "entry",
			});
	
			expect(regexResult.terminate).toBe(false);
			expect(regexResult.details.error).toBeUndefined();
			expect(regexResult.details.matches.map((match) => match.entryId)).toEqual(["entry-old-1", "entry-old-2"]);
			expect(controller.getDeletionRequest().deletions).toEqual([
				{ kind: "entry", entryId: "entry-old-1" },
				{ kind: "entry", entryId: "entry-old-2" },
			]);
	
			const invalidResult = await controller.grepTool.execute("toolu_invalid_regex", {
				pattern: "[",
				regex: true,
				target: "entry",
			});
	
			expect(invalidResult.terminate).toBe(false);
			expect(invalidResult.details.error).toMatch(/Invalid grep regex/);
			expect(controller.getDeletionRequest().deletions).toEqual([
				{ kind: "entry", entryId: "entry-old-1" },
				{ kind: "entry", entryId: "entry-old-2" },
			]);
		});

		it("guards regex pattern length, backtracking shapes, and scan size", async () => {
			const controller = createContextDeletionTool(createTranscript());
	
			const longPattern = await controller.grepTool.execute("toolu_long_regex", {
				pattern: "a".repeat(513),
				regex: true,
				target: "entry",
			});
			const unsafePattern = await controller.grepTool.execute("toolu_unsafe_regex", {
				pattern: "(a+)+$",
				regex: true,
				target: "entry",
			});
	
			expect(longPattern.terminate).toBe(false);
			expect(longPattern.details.error).toMatch(/Regex pattern is too long/);
			expect(unsafePattern.terminate).toBe(false);
			expect(unsafePattern.details.error).toMatch(/excessive backtracking/);
	
			const largeTranscript = createTranscript();
			largeTranscript.entries[1] = {
				...largeTranscript.entries[1],
				text: `${"a".repeat(250_001)} old regex scan sentinel`,
			};
			const scanResult = await createContextDeletionTool(largeTranscript).grepTool.execute("toolu_scan_regex", {
				pattern: "sentinel",
				regex: true,
				target: "entry",
			});
	
			expect(scanResult.terminate).toBe(false);
			expect(scanResult.details.error).toMatch(/Regex grep would scan/);
		});

		it("supports content-block grep deletion", async () => {
			const controller = createContextDeletionTool(createContentBlockTranscript());
	
			const result = await controller.grepTool.execute("toolu_block_grep", {
				pattern: "alpha",
				target: "content_block",
			});
	
			expect(result.terminate).toBe(false);
			expect(result.details.error).toBeUndefined();
			expect(result.details.matches).toEqual([
				expect.objectContaining({ entryId: "entry-multi", target: "content_block", blockIndex: 0 }),
			]);
			expect(controller.getDeletionRequest().deletions).toEqual([
				{ kind: "content_block", entryId: "entry-multi", blockIndex: 0 },
			]);
		});

		it("regex grep removes non-protected content blocks and ignores protected block matches", async () => {
			const controller = createContextDeletionTool(createProtectedContentBlockTranscript());
	
			const result = await controller.grepTool.execute("toolu_regex_protected_block", {
				pattern: "alpha .* stale block",
				regex: true,
				target: "content_block",
				expectedMatchCount: 1,
			});
	
			expect(result.terminate).toBe(false);
			expect(result.details.error).toBeUndefined();
			expect(result.details.matches).toEqual([
				expect.objectContaining({ entryId: "entry-safe-block", target: "content_block", blockIndex: 0 }),
			]);
			expect(result.details.skipped).toEqual([
				expect.objectContaining({ entryId: "entry-protected-block", target: "content_block", blockIndex: 0, reason: "protected_block" }),
			]);
			expect(result.details.stats.objectsDeleted).toBe(1);
			expect(controller.getDeletionRequest().deletions).toEqual([
				{ kind: "content_block", entryId: "entry-safe-block", blockIndex: 0 },
			]);
		});
});
