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

		it("records deletion targets through an executable context_delete tool", async () => {
			let capturedContext: Context | undefined;
			const faux = registerFauxProvider();
			cleanups.push(() => faux.unregister());
			faux.setResponses([
				(context) => {
					capturedContext = context;
					return fauxAssistantMessage(
						[
							fauxToolCall(
								"context_delete",
								{ deletions: [{ kind: "entry", entryId: "entry-old-1" }] },
								{ id: "toolu_delete_1" },
							),
							fauxToolCall(
								"context_delete",
								{ deletions: [{ kind: "entry", entryId: "entry-old-2" }] },
								{ id: "toolu_delete_2" },
							),
						],
						{ stopReason: "toolUse" },
					);
				},
				() => {
					throw new Error("provider should not be called after the strict reduction target is met");
				},
			]);
	
			const result = await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key");
	
			expect(result.deletedTargets).toEqual([
				{ kind: "entry", entryId: "entry-old-1" },
				{ kind: "entry", entryId: "entry-old-2" },
			]);
			expect(faux.state.callCount).toBe(1);
			expect(result.stats.percentReduction).toBeGreaterThanOrEqual(CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT);
			expect(capturedContext).toMatchObject({
				systemPrompt: expect.stringContaining("context_delete"),
				tools: expect.arrayContaining([
					expect.objectContaining({ name: "context_delete", executionMode: "parallel" }),
					expect.objectContaining({ name: "context_grep_delete", executionMode: "parallel" }),
					expect.objectContaining({ name: "context_search_transcript", executionMode: "parallel" }),
					expect.objectContaining({ name: "context_read_entry", executionMode: "parallel" }),
					expect.objectContaining({ name: "context_compaction_budget", executionMode: "parallel" }),
				]),
			});
		});

		it("sets the transcript-bound deletion tool result to terminate false explicitly", async () => {
			const controller = createContextDeletionTool(createTranscript());
	
			const result = await controller.tool.execute("toolu_delete", {
				deletions: [{ kind: "entry", entryId: "entry-old-1" }],
			});
	
			expect(result.terminate).toBe(false);
			expect(controller.getDeletionRequest().deletions).toEqual([{ kind: "entry", entryId: "entry-old-1" }]);
			expect(controller.getCallCount()).toBe(1);
		});

		it("reports context-window fullness and 50 percent reduction progress", async () => {
			const controller = createContextDeletionTool(createTranscript(), { contextWindow: 100 });
	
			const before = await controller.budgetTool.execute("toolu_budget_before", {});
			await controller.tool.execute("toolu_delete", {
				deletions: [{ kind: "entry", entryId: "entry-old-1" }],
			});
			const after = await controller.budgetTool.execute("toolu_budget_after", {});
	
			expect(before.terminate).toBe(false);
			expect(before.details.contextWindowBeforePercent).toBe(32);
			expect(before.details.contextWindowAfterPercent).toBe(32);
			expect(before.details.compression_ratio).toBe(0.5);
			expect(before.details.targetReductionPercent).toBe(CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT);
			expect(before.details.tokensToDeleteForTarget).toBe(16);
			expect(after.details.currentReductionPercent).toBe(25);
			expect(after.details.contextWindowAfterPercent).toBe(24);
			expect(after.details.tokensToDeleteForTarget).toBe(8);
			expect(after.content[0]?.type === "text" ? after.content[0].text : "").toContain(`${CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT}% reduction target`);
		});

		it("uses custom compression_ratio for budget targets", async () => {
			const controller = createContextDeletionTool(createTranscript(), { contextWindow: 100, compression_ratio: 0.25 });
	
			const result = await controller.budgetTool.execute("toolu_budget_custom_ratio", {});
	
			expect(result.details.compression_ratio).toBe(0.25);
			expect(result.details.targetReductionPercent).toBe(75);
			expect(result.details.targetTokensAfter).toBe(8);
			expect(result.details.tokensToDeleteForTarget).toBe(24);
		});

		it("rejects deletion tool calls that include transcript text instead of id-only targets", async () => {
			const controller = createContextDeletionTool(createTranscript());
	
			const result = await controller.tool.execute("toolu_delete_with_text", {
				deletions: [{ kind: "entry", entryId: "entry-old-1", text: "Old search output that can be deleted." }],
			} as never);
	
			expect(result.terminate).toBe(false);
			expect(result.details.error).toMatch(/id-only/);
			expect(result.details.error).toMatch(/unsupported property "text"/);
			expect(controller.getDeletionRequest().deletions).toEqual([]);
		});

		it("returns an explicit tool error for deletion of the last two context entries", async () => {
			const controller = createContextDeletionTool(createTranscript());
	
			const result = await controller.tool.execute("toolu_delete_recent", {
				deletions: [{ kind: "entry", entryId: "entry-recent-1" }],
			});
	
			expect(result.terminate).toBe(false);
			expect(result.details.error).toMatch(/Cannot delete recent context entry entry-recent-1/);
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toMatch(/corrected tool call/);
			expect(controller.getDeletionRequest().deletions).toEqual([]);
		});

		it("grep deletion ignores matches against recent context", async () => {
			const controller = createContextDeletionTool(createTranscript());
	
			const result = await controller.grepTool.execute("toolu_grep_recent", {
				pattern: "Recent assistant context entry-recent 1",
				target: "entry",
			});
	
			expect(result.terminate).toBe(false);
			expect(result.details.error).toBeUndefined();
			expect(result.details.matches).toEqual([]);
			expect(result.details.skipped).toEqual([expect.objectContaining({ entryId: "entry-recent-1", reason: "protected_entry" })]);
			expect(controller.getDeletionRequest().deletions).toEqual([]);
		});

		it("builds a bounded prompt with a transcript file path instead of full transcript text", () => {
			const transcript = createTranscript();
			for (let index = 0; index < 120; index++) {
				const message = assistantMessage(`Large omitted preview ${index} ${"x".repeat(1000)} SENTINEL_FULL_TEXT_${index}`);
				transcript.entries.push({
					entryId: `entry-large-${index}`,
					entryType: "message",
					role: "assistant",
					text: `Large omitted preview ${index} ${"x".repeat(1000)} SENTINEL_FULL_TEXT_${index}`,
					tokenEstimate: 400,
					protected: false,
					contentBlocks: [],
					message,
					toolCallIds: [],
				});
			}
	
			const prompt = buildContextCompactionPrompt(transcript, "/tmp/full-transcript.jsonl");
	
			expect(prompt).toContain("/tmp/full-transcript.jsonl");
			expect(prompt).toContain("context_delete");
			expect(prompt).toContain("context_search_transcript");
			expect(prompt).toContain("context_compaction_budget");
			expect(prompt).not.toContain("context_deletion_plan");
			expect(prompt).not.toContain("<standard-mode>");
			expect(prompt).not.toContain("overflow-mode>");
			expect(prompt).toContain("Start by calling context_compaction_budget");
			expect(prompt).toContain("Spend a few turns exploring with search/read tools");
			expect(prompt).toContain(`Strict requirement: reduce current context by at least ${CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT}%`);
			expect(prompt).toContain(`Do not send a final plain-text completion message until context_compaction_budget reports at least ${CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT}%`);
			expect(prompt).toContain('"compression_ratio": 0.5');
			expect(prompt).toContain('"preserve_recent": 2');
			expect(prompt).toContain('"query": "auto-detected"');
			expect(prompt).toContain("Prefer high-confidence exploit actions");
			expect(prompt.length).toBeLessThan(80_000);
			expect(prompt).not.toContain("SENTINEL_FULL_TEXT_119");
			expect(prompt).not.toContain("x".repeat(1000));
		});
});
