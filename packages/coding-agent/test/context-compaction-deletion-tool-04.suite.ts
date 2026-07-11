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

		it("returns a non-terminating tool error when merged targets violate validation", async () => {
			const controller = createContextDeletionTool(createContentBlockTranscript());
	
			const first = await controller.tool.execute("toolu_block_1", {
				deletions: [{ kind: "content_block", entryId: "entry-multi", blockIndex: 0 }],
			});
			const second = await controller.tool.execute("toolu_block_2", {
				deletions: [{ kind: "content_block", entryId: "entry-multi", blockIndex: 1 }],
			});
	
			expect(first.terminate).toBe(false);
			expect(first.details.error).toBeUndefined();
			expect(second.terminate).toBe(false);
			expect(second.details.error).toMatch(/would remove every content block/);
			expect(controller.getDeletionRequest().deletions).toEqual([
				{ kind: "content_block", entryId: "entry-multi", blockIndex: 0 },
			]);
		});

		it("throws when context compaction is cancelled", async () => {
			const faux = registerFauxProvider();
			cleanups.push(() => faux.unregister());
			const abort = new AbortController();
			abort.abort();
	
			await expect(
				contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key", undefined, abort.signal),
			).rejects.toThrow(/Request was aborted/);
		});

		it("stops deterministically once validated deletions meet the strict reduction target", async () => {
			const faux = registerFauxProvider();
			cleanups.push(() => faux.unregister());
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						"context_delete",
						{
							deletions: [
								{ kind: "entry", entryId: "entry-old-1" },
								{ kind: "entry", entryId: "entry-old-2" },
							],
						},
						{ id: "toolu_target_delete" },
					),
					{ stopReason: "toolUse" },
				),
				() => {
					throw new Error("provider should not be called after the target is met");
				},
			]);
	
			const result = await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key");
	
			expect(result.deletedTargets).toEqual([
				{ kind: "entry", entryId: "entry-old-1" },
				{ kind: "entry", entryId: "entry-old-2" },
			]);
			expect(result.stats.percentReduction).toBeGreaterThanOrEqual(CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT);
			expect(faux.state.callCount).toBe(1);
		});

		it("nudges the planner when it tries to stop before the strict reduction target", async () => {
			const contexts: Context[] = [];
			const faux = registerFauxProvider();
			cleanups.push(() => faux.unregister());
			faux.setResponses([
				(context) => {
					contexts.push(context);
					return fauxAssistantMessage("Done too early.");
				},
				(context) => {
					contexts.push(context);
					return fauxAssistantMessage(
						fauxToolCall(
							"context_delete",
							{
								deletions: [
									{ kind: "entry", entryId: "entry-old-1" },
									{ kind: "entry", entryId: "entry-old-2" },
								],
							},
							{ id: "toolu_nudged_delete" },
						),
						{ stopReason: "toolUse" },
					);
				},
			]);
	
			const result = await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key");
	
			expect(result.stats.percentReduction).toBeGreaterThanOrEqual(CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT);
			expect(JSON.stringify(contexts[1]!)).toContain(
				`strict ${CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT}% context-reduction requirement is not met yet`,
			);
			expect(JSON.stringify(contexts[1]!)).toContain("Continue removing low-value message entries or message content blocks");
			expect(faux.state.callCount).toBe(2);
		});

		it("still fails non-overflow provider errors after recording deletions", async () => {
			const faux = registerFauxProvider();
			cleanups.push(() => faux.unregister());
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						"context_delete",
						{ deletions: [{ kind: "entry", entryId: "entry-old-1" }] },
						{ id: "toolu_partial_delete" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "529 overloaded",
				}),
			]);
	
			await expect(
				contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key"),
			).rejects.toThrow(/Context compaction failed: 529 overloaded/);
		});

		it("inherits the selected thinking level for reasoning-model context compaction", async () => {
			let capturedReasoning: string | undefined;
			const faux = registerFauxProvider({ models: [{ id: "faux-reasoning", reasoning: true }] });
			cleanups.push(() => faux.unregister());
			faux.setResponses([
				(_context, options) => {
					capturedReasoning = (options as (StreamOptions & { reasoning?: string }) | undefined)?.reasoning;
					return fauxAssistantMessage(
						fauxToolCall(
							"context_delete",
							{
								deletions: [
									{ kind: "entry", entryId: "entry-old-1" },
									{ kind: "entry", entryId: "entry-old-2" },
								],
							},
							{ id: "toolu_delete" },
						),
						{ stopReason: "toolUse" },
					);
				},
				() => fauxAssistantMessage("Done recording deletion targets."),
			]);
	
			await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key", undefined, undefined, "high");
	
			expect(capturedReasoning).toBe("high");
		});

		it("keeps the inherited thinking level when lower variants are unsupported", async () => {
			let capturedReasoning: string | undefined;
			const faux = registerFauxProvider({ models: [{ id: "faux-reasoning-low", reasoning: true }] });
			cleanups.push(() => faux.unregister());
			const model = { ...faux.getModel(), thinkingLevelMap: { off: null, minimal: null } };
			faux.setResponses([
				(_context, options) => {
					capturedReasoning = (options as (StreamOptions & { reasoning?: string }) | undefined)?.reasoning;
					return fauxAssistantMessage(
						fauxToolCall(
							"context_delete",
							{
								deletions: [
									{ kind: "entry", entryId: "entry-old-1" },
									{ kind: "entry", entryId: "entry-old-2" },
								],
							},
							{ id: "toolu_delete" },
						),
						{ stopReason: "toolUse" },
					);
				},
				() => fauxAssistantMessage("Done recording deletion targets."),
			]);
	
			await contextCompact({ transcript: createTranscript(), branchEntries: [] }, model, "test-key", undefined, undefined, "high");
	
			expect(capturedReasoning).toBe("high");
		});

		it("keeps thinking off for non-reasoning-model context compaction", async () => {
			let capturedReasoning: string | undefined;
			const faux = registerFauxProvider({ models: [{ id: "faux-non-reasoning", reasoning: false }] });
			cleanups.push(() => faux.unregister());
			faux.setResponses([
				(_context, options) => {
					capturedReasoning = (options as (StreamOptions & { reasoning?: string }) | undefined)?.reasoning;
					return fauxAssistantMessage(
						fauxToolCall(
							"context_delete",
							{
								deletions: [
									{ kind: "entry", entryId: "entry-old-1" },
									{ kind: "entry", entryId: "entry-old-2" },
								],
							},
							{ id: "toolu_delete" },
						),
						{ stopReason: "toolUse" },
					);
				},
				() => fauxAssistantMessage("Done recording deletion targets."),
			]);
	
			await contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key", undefined, undefined, "off");
	
			expect(capturedReasoning).toBeUndefined();
		});
});
