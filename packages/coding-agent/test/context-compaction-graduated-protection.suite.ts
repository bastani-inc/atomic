/**
 * Runner-level tests for the graduated-protection fallback ladder in
 * `contextCompact`: meet_target → best_effort → evict_protected.
 *
 * See specs/2026-06-27-context-compaction-graduated-protection.md §5.1.
 */
import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import {
	CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT,
	contextCompact,
	type CompactableTranscript,
} from "../src/core/compaction/index.ts";

function fauxAssistantEntry(text: string): CompactableTranscript["entries"][number] {
	return {
		entryId: "",
		entryType: "message",
		role: "assistant",
		text,
		tokenEstimate: 0,
		protected: false,
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

/**
 * Build a transcript where the quality target (50%) is infeasible: only one
 * small deletable assistant entry exists, but the protected task + recents
 * dominate. The model deletes the one entry (sub-target reduction), and because
 * the target is provably infeasible AND the result fits the budget, the runner
 * must accept it as `best_effort` instead of throwing.
 */
function createInfeasibleButFitsTranscript(): CompactableTranscript {
	const task = "Keep the user task protected and dominant.";
	const oldDeletable = "small old deletable assistant text";
	const recent1 = "recent protected assistant text one with enough mass";
	const recent2 = "recent protected assistant text two with enough mass";
	const taskEntry = {
		...fauxAssistantEntry(task),
		entryId: "entry-user",
		role: "user" as const,
		tokenEstimate: 2000,
		protected: true,
		message: { role: "user", content: [{ type: "text", text: task }], timestamp: 0 },
	};
	const oldEntry = { ...fauxAssistantEntry(oldDeletable), entryId: "entry-old", tokenEstimate: 100 };
	const recent1Entry = { ...fauxAssistantEntry(recent1), entryId: "entry-recent-1", tokenEstimate: 2000, protected: true };
	const recent2Entry = { ...fauxAssistantEntry(recent2), entryId: "entry-recent-2", tokenEstimate: 2000, protected: true };
	const entries = [taskEntry, oldEntry, recent1Entry, recent2Entry];
	return {
		entries,
		protectedEntryIds: ["entry-user", "entry-recent-1", "entry-recent-2"],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: { enabled: true, reserveTokens: 1000, compression_ratio: 0.5, preserve_recent: 2 },
	};
}

/**
 * Build a transcript with two old protected user entries (eviction candidates)
 * and one recent protected user entry (not evictable). The quality target is
 * infeasible (no deletable non-protected content) and protected mass overflows
 * a tight budget. Used to verify the `evict_protected` path runs even when the
 * planner makes no deletions at all (P1).
 */
function createEvictionWithoutPlannerTranscript(): CompactableTranscript {
	const oldTask1 = "old protected user task one with enough mass to overflow";
	const oldTask2 = "old protected user task two with enough mass to overflow";
	const recentTask = "recent protected user task that stays as the most-recent task-bearing entry";
	const recent1 = "recent protected assistant text one";
	const recent2 = "recent protected assistant text two";
	const oldTask1Entry = {
		...fauxAssistantEntry(oldTask1),
		entryId: "entry-user-1",
		role: "user" as const,
		tokenEstimate: 3000,
		protected: true,
		message: { role: "user", content: [{ type: "text", text: oldTask1 }], timestamp: 0 },
	};
	const oldTask2Entry = {
		...fauxAssistantEntry(oldTask2),
		entryId: "entry-user-2",
		role: "user" as const,
		tokenEstimate: 3000,
		protected: true,
		message: { role: "user", content: [{ type: "text", text: oldTask2 }], timestamp: 1 },
	};
	const recentTaskEntry = {
		...fauxAssistantEntry(recentTask),
		entryId: "entry-user-3",
		role: "user" as const,
		tokenEstimate: 2000,
		protected: true,
		message: { role: "user", content: [{ type: "text", text: recentTask }], timestamp: 2 },
	};
	const recent1Entry = { ...fauxAssistantEntry(recent1), entryId: "entry-recent-1", tokenEstimate: 2000, protected: true };
	const recent2Entry = { ...fauxAssistantEntry(recent2), entryId: "entry-recent-2", tokenEstimate: 2000, protected: true };
	const entries = [oldTask1Entry, oldTask2Entry, recentTaskEntry, recent1Entry, recent2Entry];
	return {
		entries,
		protectedEntryIds: ["entry-user-1", "entry-user-2", "entry-user-3", "entry-recent-1", "entry-recent-2"],
		tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
		settings: { enabled: true, reserveTokens: 1000, compression_ratio: 0.5, preserve_recent: 2 },
	};
}

/** Queue one tool-call response then many plain-stop responses for the nudge loop. */
function queueDeletionThenGiveUp(faux: ReturnType<typeof registerFauxProvider>): void {
	faux.setResponses([
		() =>
			fauxAssistantMessage(
				[fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "entry-old" }] }, { id: "toolu_delete_1" })],
				{ stopReason: "toolUse" },
			),
	]);
	faux.appendResponses(
		Array.from({ length: 12 }, () => fauxAssistantMessage("no more safe deletions", { stopReason: "stop" })),
	);
}

/** Queue a budget-tool call (no deletion) then many plain-stop responses. */
function queueBudgetOnlyThenGiveUp(faux: ReturnType<typeof registerFauxProvider>): void {
	faux.setResponses([
		() =>
			fauxAssistantMessage(
				[fauxToolCall("context_compaction_budget", {}, { id: "toolu_budget_1" })],
				{ stopReason: "toolUse" },
			),
	]);
	faux.appendResponses(
		Array.from({ length: 12 }, () => fauxAssistantMessage("no deletions to make", { stopReason: "stop" })),
	);
}

describe("contextCompact graduated-protection ladder", () => {
	it("accepts a sub-target result as best_effort when the target is infeasible but fits budget", async () => {
		const transcript = createInfeasibleButFitsTranscript();
		const faux = registerFauxProvider();
		try {
			queueDeletionThenGiveUp(faux);

			// Model with a large context window so the result fits the budget.
			const model = { ...faux.getModel(), contextWindow: 1_000_000 } as Model<Api>;

			const result = await contextCompact(
				{ transcript, branchEntries: [], parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" } },
				model,
				"test-key",
			);

			// The reduction (100/6100 ≈ 1.6%) is far below the 50% target, but the
			// target is infeasible and the result fits, so best_effort accepts it.
			expect(result.fitStrategy).toBe("best_effort");
			expect(result.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-old" });
			expect(result.achievedReductionPercent).toBe(result.stats.percentReduction);
			expect(result.stats.percentReduction).toBeLessThan(CONTEXT_COMPACTION_TARGET_REDUCTION_PERCENT);
		} finally {
			faux.unregister();
		}
	});

	it("does NOT silently accept a sub-target result when the result does not fit budget (strict failure)", async () => {
		// Same infeasible transcript, but a tiny context window so the budget is
		// exceeded even after the one deletion. best_effort cannot apply (does not
		// fit) and there are no eviction candidates that help (the only task-bearing
		// entry cannot be evicted), so the runner must throw the strict failure.
		const transcript = createInfeasibleButFitsTranscript();
		const faux = registerFauxProvider();
		try {
			queueDeletionThenGiveUp(faux);

			// Tiny context window: budget = contextWindow - reserveTokens ≈ tiny.
			const model = { ...faux.getModel(), contextWindow: 100 } as Model<Api>;

			await expect(
				contextCompact(
					{ transcript, branchEntries: [], parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" } },
					model,
					"test-key",
				),
			).rejects.toThrow(/did not meet the strict/);
		} finally {
			faux.unregister();
		}
	});

	it("evict_protected runs even when the planner made no deletion targets (P1)", async () => {
		// The planner only calls the budget tool and then gives up — no
		// `context_delete` call, so validatedResult is undefined. The eviction
		// path must still run with an empty baseline and force-evict oldest-first
		// protected task-bearing entries until the budget fits.
		const transcript = createEvictionWithoutPlannerTranscript();
		const faux = registerFauxProvider();
		try {
			queueBudgetOnlyThenGiveUp(faux);

			// Budget that only fits after evicting one old user entry.
			// tokensBefore = 3000+3000+2000+2000+2000 = 12000.
			// reserveTokens = 1000. contextWindow = 11000 → budget = 10000.
			// Evicting entry-user-1 (3000) brings tokensAfter to 9000 ≤ 10000.
			const model = { ...faux.getModel(), contextWindow: 11_000 } as Model<Api>;

			const result = await contextCompact(
				{ transcript, branchEntries: [], parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" } },
				model,
				"test-key",
			);

			expect(result.fitStrategy).toBe("evict_protected");
			expect(result.evictedProtectedEntryIds).toContain("entry-user-1");
			expect(result.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-user-1" });
			// The most-recent task-bearing entry is never evicted.
			expect(result.evictedProtectedEntryIds).not.toContain("entry-user-3");
			expect(result.stats.tokensAfter).toBeLessThanOrEqual(10_000);
		} finally {
			faux.unregister();
		}
	});
});

describe("contextCompact meet_target liveness budget gate (P1)", () => {
	it("does NOT return meet_target when the target is met but the result overflows the liveness budget; escalates to evict_protected", async () => {
		// Planner deletes both old assistant entries → 60% reduction (target met).
		// But the context window is so tight that even after that deletion the
		// result exceeds the liveness budget. meet_target must be skipped; the
		// ladder escalates to evict_protected, evicting the oldest protected user
		// entry to bring the result under budget.
		const oldTask1 = "old protected user task one to evict";
		const recentTask = "recent protected user task that stays as the most-recent task-bearing entry";
		const oldDeletable1 = "old deletable assistant one";
		const oldDeletable2 = "old deletable assistant two";
		const recent1 = "recent protected assistant text one";
		const recent2 = "recent protected assistant text two";
		const oldTask1Entry = {
			...fauxAssistantEntry(oldTask1),
			entryId: "entry-user-1",
			role: "user" as const,
			tokenEstimate: 2000,
			protected: true,
			message: { role: "user", content: [{ type: "text", text: oldTask1 }], timestamp: 0 },
		};
		const recentTaskEntry = {
			...fauxAssistantEntry(recentTask),
			entryId: "entry-user-2",
			role: "user" as const,
			tokenEstimate: 2000,
			protected: true,
			message: { role: "user", content: [{ type: "text", text: recentTask }], timestamp: 1 },
		};
		const oldDeletable1Entry = { ...fauxAssistantEntry(oldDeletable1), entryId: "entry-old-1", tokenEstimate: 3000 };
		const oldDeletable2Entry = { ...fauxAssistantEntry(oldDeletable2), entryId: "entry-old-2", tokenEstimate: 3000 };
		const recent1Entry = { ...fauxAssistantEntry(recent1), entryId: "entry-recent-1", tokenEstimate: 1000, protected: true };
		const recent2Entry = { ...fauxAssistantEntry(recent2), entryId: "entry-recent-2", tokenEstimate: 1000, protected: true };
		const entries = [oldTask1Entry, recentTaskEntry, oldDeletable1Entry, oldDeletable2Entry, recent1Entry, recent2Entry];
		const transcript: CompactableTranscript = {
			entries,
			protectedEntryIds: ["entry-user-1", "entry-user-2", "entry-recent-1", "entry-recent-2"],
			tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
			settings: { enabled: true, reserveTokens: 1000, compression_ratio: 0.5, preserve_recent: 2 },
		};

		const faux = registerFauxProvider();
		try {
			// Queue two deletion calls so the planner hits the 50% target.
			faux.setResponses([
				() =>
					fauxAssistantMessage(
						[fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "entry-old-1" }] }, { id: "toolu_delete_1" })],
						{ stopReason: "toolUse" },
					),
				() =>
					fauxAssistantMessage(
						[fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "entry-old-2" }] }, { id: "toolu_delete_2" })],
						{ stopReason: "toolUse" },
					),
			]);
			faux.appendResponses(
				Array.from({ length: 12 }, () => fauxAssistantMessage("done", { stopReason: "stop" })),
			);

			// tokensBefore = 2000+2000+3000+3000+1000+1000 = 12000.
			// After deleting old-1+old-2 (6000): tokensAfter = 6000 (50% target met).
			// reserveTokens = 1000. contextWindow = 6500 → budget = 5500.
			// 6000 > 5500 → meet_target must be SKIPPED.
			// evict_protected: evict entry-user-1 (2000) → tokensAfter = 4000 ≤ 5500 → fits.
			const model = { ...faux.getModel(), contextWindow: 6500 } as Model<Api>;

			const result = await contextCompact(
				{ transcript, branchEntries: [], parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" } },
				model,
				"test-key",
			);

			// meet_target was skipped (result over budget); escalation reached evict_protected.
			expect(result.fitStrategy).toBe("evict_protected");
			expect(result.evictedProtectedEntryIds).toContain("entry-user-1");
			expect(result.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-old-1" });
			expect(result.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-old-2" });
			expect(result.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-user-1" });
			expect(result.stats.tokensAfter).toBeLessThanOrEqual(5500);
		} finally {
			faux.unregister();
		}
	});
});

describe("contextCompact maximal-feasible-unprotected best_effort (target-met-over-budget)", () => {
	it("uses maximal feasible unprotected deletions as best_effort when target is met but over budget and unprotected max fits", async () => {
		// Planner deletes only ONE old assistant entry (sub-target, over budget).
		// But there is a THIRD old unprotected assistant entry the planner ignored.
		// The maximal feasible unprotected deletion set (all three old entries)
		// fits the budget. The runner must NOT throw; it must deterministically
		// use the maximal feasible unprotected deletion set as best_effort instead
		// of escalating to evict_protected (which would evict protected entries
		// unnecessarily).
		const task = "recent protected user task that stays as the most-recent task-bearing entry";
		const oldDeletable1 = "old deletable assistant one with enough mass";
		const oldDeletable2 = "old deletable assistant two with enough mass";
		const oldDeletable3 = "old deletable assistant three with enough mass";
		const recent1 = "recent protected assistant text one";
		const recent2 = "recent protected assistant text two";
		const taskEntry = {
			...fauxAssistantEntry(task),
			entryId: "entry-user",
			role: "user" as const,
			tokenEstimate: 2000,
			protected: true,
			message: { role: "user", content: [{ type: "text", text: task }], timestamp: 0 },
		};
		const oldDeletable1Entry = { ...fauxAssistantEntry(oldDeletable1), entryId: "entry-old-1", tokenEstimate: 3000 };
		const oldDeletable2Entry = { ...fauxAssistantEntry(oldDeletable2), entryId: "entry-old-2", tokenEstimate: 3000 };
		const oldDeletable3Entry = { ...fauxAssistantEntry(oldDeletable3), entryId: "entry-old-3", tokenEstimate: 3000 };
		const recent1Entry = { ...fauxAssistantEntry(recent1), entryId: "entry-recent-1", tokenEstimate: 1000, protected: true };
		const recent2Entry = { ...fauxAssistantEntry(recent2), entryId: "entry-recent-2", tokenEstimate: 1000, protected: true };
		const entries = [taskEntry, oldDeletable1Entry, oldDeletable2Entry, oldDeletable3Entry, recent1Entry, recent2Entry];
		const transcript: CompactableTranscript = {
			entries,
			protectedEntryIds: ["entry-user", "entry-recent-1", "entry-recent-2"],
			tokensBefore: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
			settings: { enabled: true, reserveTokens: 1000, compression_ratio: 0.5, preserve_recent: 2 },
		};

		const faux = registerFauxProvider();
		try {
			// Planner deletes only one old entry (sub-target, over budget).
			faux.setResponses([
				() =>
					fauxAssistantMessage(
						[fauxToolCall("context_delete", { deletions: [{ kind: "entry", entryId: "entry-old-1" }] }, { id: "toolu_delete_1" })],
						{ stopReason: "toolUse" },
					),
			]);
			faux.appendResponses(
				Array.from({ length: 12 }, () => fauxAssistantMessage("done", { stopReason: "stop" })),
			);

			// tokensBefore = 2000+3000+3000+3000+1000+1000 = 13000.
			// Planner deletes entry-old-1 (3000): tokensAfter = 10000 (over budget).
			// Maximal feasible unprotected = all three old entries (9000): tokensAfter = 4000.
			// reserveTokens = 1000. contextWindow = 5000 → budget = 4000.
			// 4000 ≤ 4000 → best_effort (maximal feasible) fits, no eviction needed.
			const model = { ...faux.getModel(), contextWindow: 5000 } as Model<Api>;

			const result = await contextCompact(
				{ transcript, branchEntries: [], parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" } },
				model,
				"test-key",
			);

			// best_effort with the maximal feasible unprotected deletion set.
			expect(result.fitStrategy).toBe("best_effort");
			expect(result.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-old-1" });
			expect(result.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-old-2" });
			expect(result.deletedTargets).toContainEqual({ kind: "entry", entryId: "entry-old-3" });
			// No protected entries were evicted.
			expect(result.evictedProtectedEntryIds ?? []).toEqual([]);
			expect(result.stats.tokensAfter).toBeLessThanOrEqual(4000);
		} finally {
			faux.unregister();
		}
	});
});
