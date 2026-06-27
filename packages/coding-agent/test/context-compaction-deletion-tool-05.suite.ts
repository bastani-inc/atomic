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

	it("recovers via best_effort (maximal feasible) when the planner fails but unprotected deletions exist", async () => {
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

		// The planner tried to delete a protected entry (entry-user) which failed,
		// then gave up with 0% reduction. Previously the runner threw a strict
		// failure. With the graduated-protection ladder, when maximal feasible
		// unprotected deletions (entry-old-1 + entry-old-2) fit the budget, the
		// runner recovers via best_effort instead of throwing — the session is
		// kept continuable even when the planner made no valid deletions.
		const result = await contextCompact(
			{ transcript: createTranscript(), branchEntries: [] },
			faux.getModel(),
			"test-key",
		);

		expect(result.fitStrategy).toBe("best_effort");
		expect(result.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-old-1" });
		expect(result.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-old-2" });
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
