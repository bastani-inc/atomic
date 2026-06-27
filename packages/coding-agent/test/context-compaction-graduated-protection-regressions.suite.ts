/** Regression coverage for graduated-protection review blockers. */
import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { contextCompact, type CompactableTranscript } from "../src/core/compaction/index.ts";

function assistantEntry(entryId: string, text: string, tokenEstimate: number, protectedEntry = false): CompactableTranscript["entries"][number] {
	return {
		entryId,
		entryType: "message",
		role: "assistant",
		text,
		tokenEstimate,
		protected: protectedEntry,
		contentBlocks: [],
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "faux" as Api,
			provider: "faux",
			model: "faux-1",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: 0,
		},
		toolCallIds: [],
	};
}

function userEntry(entryId: string, text: string, tokenEstimate: number, timestamp: number): CompactableTranscript["entries"][number] {
	return {
		...assistantEntry(entryId, text, tokenEstimate, true),
		role: "user",
		message: { role: "user", content: [{ type: "text", text }], timestamp },
	};
}

function queueBudgetOnlyThenGiveUp(faux: ReturnType<typeof registerFauxProvider>): void {
	faux.setResponses([
		() => fauxAssistantMessage([fauxToolCall("context_compaction_budget", {}, { id: "toolu_budget_1" })], { stopReason: "toolUse" }),
	]);
	faux.appendResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("no more deletions", { stopReason: "stop" })));
}

describe("contextCompact graduated-protection regressions", () => {
	it("accepts a no-op best_effort result when protected context already fits", async () => {
		const entries = [
			userEntry("entry-user", "protected user task", 1000, 0),
			assistantEntry("entry-recent-1", "recent protected assistant one", 1000, true),
			assistantEntry("entry-recent-2", "recent protected assistant two", 1000, true),
		];
		const transcript: CompactableTranscript = {
			entries,
			protectedEntryIds: entries.map((entry) => entry.entryId),
			tokensBefore: 3000,
			settings: { enabled: true, reserveTokens: 1000, compression_ratio: 0.5, preserve_recent: 2 },
		};
		const faux = registerFauxProvider();
		try {
			queueBudgetOnlyThenGiveUp(faux);
			const model = { ...faux.getModel(), contextWindow: 10_000 } as Model<Api>;
			const result = await contextCompact(
				{ transcript, branchEntries: [], parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" } },
				model,
				"test-key",
			);

			expect(result.fitStrategy).toBe("best_effort");
			expect(result.deletedTargets).toEqual([]);
			expect(result.stats.tokensAfter).toBe(3000);
		} finally {
			faux.unregister();
		}
	});

	it("seeds protected eviction from maximal feasible unprotected deletions", async () => {
		const entries = [
			userEntry("entry-user-1", "old protected user task one", 3000, 0),
			userEntry("entry-user-2", "old protected user task two", 3000, 1),
			assistantEntry("entry-old-assistant", "old unprotected assistant", 3000),
			userEntry("entry-user-3", "recent protected user task", 2000, 2),
			assistantEntry("entry-recent-1", "recent protected assistant one", 1000, true),
			assistantEntry("entry-recent-2", "recent protected assistant two", 1000, true),
		];
		const transcript: CompactableTranscript = {
			entries,
			protectedEntryIds: ["entry-user-1", "entry-user-2", "entry-user-3", "entry-recent-1", "entry-recent-2"],
			tokensBefore: 13_000,
			settings: { enabled: true, reserveTokens: 1000, compression_ratio: 0.5, preserve_recent: 2 },
		};
		const faux = registerFauxProvider();
		try {
			queueBudgetOnlyThenGiveUp(faux);
			const model = { ...faux.getModel(), contextWindow: 8500 } as Model<Api>;
			const result = await contextCompact(
				{ transcript, branchEntries: [], parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" } },
				model,
				"test-key",
			);

			expect(result.fitStrategy).toBe("evict_protected");
			expect(result.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-old-assistant" });
			expect(result.evictedProtectedEntryIds).toEqual(["entry-user-1"]);
			expect(result.deletedTargets).not.toContainEqual({ kind: "entry", entryId: "entry-user-2" });
			expect(result.stats.tokensAfter).toBeLessThanOrEqual(7500);
		} finally {
			faux.unregister();
		}
	});
});
