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

		it("surfaces the deletion tool error when context compaction has no safe deletions", async () => {
			const faux = registerFauxProvider();
			cleanups.push(() => faux.unregister());
			faux.setResponses([
				() =>
					fauxAssistantMessage(
						fauxToolCall(
							"context_delete",
							{ deletions: [{ kind: "entry", entryId: "entry-user" }] },
							{ id: "toolu_bad_standard_delete" },
						),
						{ stopReason: "toolUse" },
					),
				() => fauxAssistantMessage("Unable to find safe deletions."),
				() => fauxAssistantMessage("Still unable after target nudge."),
			]);
	
			await expect(
				contextCompact({ transcript: createTranscript(), branchEntries: [] }, faux.getModel(), "test-key"),
			).rejects.toThrow(/attempt reached 0%.*last deletion tool error: Deletion target entry-user is protected/s);
		});

		it("records grep bulk deletions through context compaction", async () => {
			const faux = registerFauxProvider();
			cleanups.push(() => faux.unregister());
			faux.setResponses([
				() =>
					fauxAssistantMessage(
						fauxToolCall(
							"context_grep_delete",
							{ pattern: "Old", target: "entry" },
							{ id: "toolu_grep" },
						),
						{ stopReason: "toolUse" },
					),
				() => {
					throw new Error("provider should not be called after grep deletion meets the target");
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
});
