import { describe, expect, it } from "vitest";
import type { Api } from "@earendil-works/pi-ai";
import {
	resetIds,
	user,
	assistantText,
	entry,
	DEFAULT_COMPACTION_SETTINGS,
	prepareContextCompaction,
	validateContextDeletionRequest,
	type CompactableTranscript,
	type SessionEntry,
} from "./context-compaction-helpers.js";
import {
	computeCompactionFeasibility,
	computeLivenessBudget,
	buildEvictionTargets,
	findEvictionCandidates,
	buildMaximalDeletableRequest,
} from "../src/core/compaction/context-compaction-feasibility.ts";
import type { CompactableTranscriptEntry } from "../src/core/compaction/context-compaction-types.ts";
import type { CompactionSettings } from "../src/core/compaction/compaction.ts";

function settingsWith(reserveTokens: number): CompactionSettings {
	return { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens };
}

describe("computeCompactionFeasibility", () => {
	it("reports target feasible and meet_target when enough is deletable", () => {
		resetIds();
		const task = entry(user("Task that must remain."));
		const old1 = entry(assistantText("old deletable assistant text one"));
		const old2 = entry(assistantText("old deletable assistant text two"));
		const old3 = entry(assistantText("old deletable assistant text three"));
		const recent1 = entry(assistantText("recent protected one"));
		const recent2 = entry(assistantText("recent protected two"));
		const entries: SessionEntry[] = [task, old1, old2, old3, recent1, recent2];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		const budget = computeLivenessBudget(1_000_000, 0);
		const feasibility = computeCompactionFeasibility(preparation.transcript, preparation.parameters, budget);

		expect(feasibility.tokensBefore).toBe(preparation.transcript.tokensBefore);
		expect(feasibility.targetFeasible).toBe(true);
		expect(feasibility.recommendedStrategy).toBe("meet_target");
		// Three old assistant entries are deletable.
		expect(feasibility.maxDeletableTokens).toBeGreaterThan(0);
		expect(feasibility.achievableReductionPercent).toBeGreaterThanOrEqual(feasibility.qualityTargetPercent);
	});

	it("reports best_effort when target is infeasible but result fits budget", () => {
		resetIds();
		// Only one deletable assistant entry; protected task + recents dominate.
		const task = entry(user("Task that must remain available."));
		const old = entry(assistantText("small old deletable assistant text"));
		const recent1 = entry(assistantText("recent protected one with enough text to dominate"));
		const recent2 = entry(assistantText("recent protected two with enough text to dominate"));
		const entries: SessionEntry[] = [task, old, recent1, recent2];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		// Large budget so the (small) achievable reduction fits, but the reduction
		// is far below the 50% quality target.
		const budget = computeLivenessBudget(10_000_000, 0);
		const feasibility = computeCompactionFeasibility(preparation.transcript, preparation.parameters, budget);

		expect(feasibility.targetFeasible).toBe(false);
		expect(feasibility.fitsBudgetAtMaxDeletion).toBe(true);
		expect(feasibility.recommendedStrategy).toBe("best_effort");
	});

	it("reports evict_protected when protected floor overflows a tight budget", () => {
		resetIds();
		const task = entry(user("Task that must remain available."));
		// No deletable entries — only protected task + recents.
		const recent1 = entry(assistantText("recent protected one"));
		const recent2 = entry(assistantText("recent protected two"));
		const entries: SessionEntry[] = [task, recent1, recent2];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		// Budget smaller than the protected floor.
		const budget = computeLivenessBudget(1, 0);
		const feasibility = computeCompactionFeasibility(preparation.transcript, preparation.parameters, budget);

		expect(feasibility.maxDeletableTokens).toBe(0);
		expect(feasibility.targetFeasible).toBe(false);
		expect(feasibility.fitsBudgetAtMaxDeletion).toBe(false);
		expect(feasibility.recommendedStrategy).toBe("evict_protected");
	});

	it("never mutates the transcript", () => {
		resetIds();
		const task = entry(user("Task that must remain."));
		const old = entry(assistantText("old deletable assistant text"));
		const recent1 = entry(assistantText("recent protected one"));
		const recent2 = entry(assistantText("recent protected two"));
		const entries: SessionEntry[] = [task, old, recent1, recent2];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;
		const tokensBefore = preparation.transcript.tokensBefore;
		const entryCount = preparation.transcript.entries.length;

		const budget = computeLivenessBudget(1_000_000, 0);
		computeCompactionFeasibility(preparation.transcript, preparation.parameters, budget);

		expect(preparation.transcript.tokensBefore).toBe(tokensBefore);
		expect(preparation.transcript.entries.length).toBe(entryCount);
	});
});

describe("computeCompactionFeasibility — validator-backed feasible subset search (P2a)", () => {
	it("reports non-zero feasible deletion when the maximal set is invalid but a subset is feasible", () => {
		// Build a transcript directly so we control `protected` flags. The only
		// task-bearing entry is NOT protected, so `buildMaximalDeletableRequest`
		// includes it. The maximal set deletes every deletable entry including
		// the only task-bearing one → validation rejects it ("would leave no user
		// task in context"). The subset search must keep the task entry and report
		// the feasible deletion of the old assistant entries, NOT zero.
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 0 };
		const entries: CompactableTranscriptEntry[] = [
			{
				entryId: "task", entryType: "message", role: "user",
				text: "the only task-bearing entry stays", tokenEstimate: 1000,
				protected: false, contentBlocks: [],
				message: { role: "user", content: [{ type: "text", text: "task" }], timestamp: 0 },
				toolCallIds: [],
			},
			{
				entryId: "old1", entryType: "message", role: "assistant",
				text: "old deletable assistant one", tokenEstimate: 600,
				protected: false, contentBlocks: [],
				message: {
					role: "assistant", content: [{ type: "text", text: "old1" }],
					api: "faux" as Api, provider: "faux", model: "faux-1",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop", timestamp: 0,
				},
				toolCallIds: [],
			},
			{
				entryId: "old2", entryType: "message", role: "assistant",
				text: "old deletable assistant two", tokenEstimate: 600,
				protected: false, contentBlocks: [],
				message: {
					role: "assistant", content: [{ type: "text", text: "old2" }],
					api: "faux" as Api, provider: "faux", model: "faux-1",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop", timestamp: 1,
				},
				toolCallIds: [],
			},
			{
				entryId: "recent1", entryType: "message", role: "assistant",
				text: "recent protected one", tokenEstimate: 500,
				protected: true, contentBlocks: [],
				message: {
					role: "assistant", content: [{ type: "text", text: "recent1" }],
					api: "faux" as Api, provider: "faux", model: "faux-1",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop", timestamp: 2,
				},
				toolCallIds: [],
			},
			{
				entryId: "recent2", entryType: "message", role: "assistant",
				text: "recent protected two", tokenEstimate: 500,
				protected: true, contentBlocks: [],
				message: {
					role: "assistant", content: [{ type: "text", text: "recent2" }],
					api: "faux" as Api, provider: "faux", model: "faux-1",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop", timestamp: 3,
				},
				toolCallIds: [],
			},
		];
		const tokensBefore = entries.reduce((total, e) => total + e.tokenEstimate, 0);
		const transcript: CompactableTranscript = {
			entries, protectedEntryIds: ["recent1", "recent2"], tokensBefore,
			settings,
			parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" },
		};

		const budget = computeLivenessBudget(1_000_000, 0);
		const feasibility = computeCompactionFeasibility(transcript, transcript.parameters!, budget);

		// The maximal set is invalid (would leave no task-bearing entry), but the
		// subset search keeps the task entry and deletes old1+old2 (1200 tokens).
		expect(feasibility.maxDeletableTokens).toBe(1200);
		expect(feasibility.achievableTokensAfter).toBe(tokensBefore - 1200);
		expect(feasibility.achievableReductionPercent).toBeGreaterThan(0);
	});
});

describe("buildMaximalDeletableRequest", () => {
	it("includes deletable entries and excludes protected ones", () => {
		resetIds();
		const task = entry(user("Task that must remain."));
		const old = entry(assistantText("old deletable assistant text"));
		const recent1 = entry(assistantText("recent protected one"));
		const recent2 = entry(assistantText("recent protected two"));
		const entries: SessionEntry[] = [task, old, recent1, recent2];
		const preparation = prepareContextCompaction(entries, DEFAULT_COMPACTION_SETTINGS)!;

		const request = buildMaximalDeletableRequest(preparation.transcript);
		const ids = request.deletions.map((d) => d.entryId);
		expect(ids).toContain(old.id);
		expect(ids).not.toContain(task.id);
		expect(ids).not.toContain(recent1.id);
		expect(ids).not.toContain(recent2.id);
	});
});

describe("findEvictionCandidates", () => {
	it("excludes recent and the most-recent task-bearing entry", () => {
		resetIds();
		const task1 = entry(user("first task"));
		const task2 = entry(user("second task most recent"));
		const recent1 = entry(assistantText("recent protected one"));
		const entries: SessionEntry[] = [task1, task2, recent1];
		const preparation = prepareContextCompaction(entries, settingsWith(0))!;

		const candidates = findEvictionCandidates(preparation.transcript);
		const ids = candidates.map((c) => c.entryId);
		// task2 is the most-recent task-bearing → excluded; recent1 is recent → excluded.
		expect(ids).not.toContain(task2.id);
		expect(ids).not.toContain(recent1.id);
		// task1 is an older protected task-bearing entry → candidate.
		expect(ids).toContain(task1.id);
	});
});

describe("buildEvictionTargets", () => {
	it("evicts oldest-first protected task-bearing entries until the result fits", () => {
		resetIds();
		// Multiple protected user tasks; a tight budget forces eviction of the oldest.
		const task1 = entry(user("first old task to evict"));
		const task2 = entry(user("second task that stays as most-recent task-bearing"));
		const recent1 = entry(assistantText("recent protected one"));
		const entries: SessionEntry[] = [task1, task2, recent1];
		const preparation = prepareContextCompaction(entries, settingsWith(0))!;

		// Budget just below the full protected floor so evicting task1 is enough.
		const tokensAfterKeepingTask2AndRecent =
			preparation.transcript.entries
				.filter((e) => e.entryId !== task1.id)
				.reduce((sum, e) => sum + e.tokenEstimate, 0);
		const budget = computeLivenessBudget(tokensAfterKeepingTask2AndRecent, 0);

		const { deletions, evictedProtectedEntryIds } = buildEvictionTargets(
			preparation.transcript,
			[],
			budget,
		);

		expect(evictedProtectedEntryIds).toEqual([task1.id]);
		const entryDeletions = deletions.filter((d) => d.kind === "entry").map((d) => d.entryId);
		expect(entryDeletions).toContain(task1.id);
		expect(entryDeletions).not.toContain(task2.id);
	});

	it("validates the eviction set under relaxed protection and preserves ≥1 task-bearing", () => {
		resetIds();
		const task1 = entry(user("first old task to evict"));
		const task2 = entry(user("second task that stays as most-recent task-bearing"));
		const recent1 = entry(assistantText("recent protected one"));
		const entries: SessionEntry[] = [task1, task2, recent1];
		const preparation = prepareContextCompaction(entries, settingsWith(0))!;

		const tokensAfterKeepingTask2AndRecent =
			preparation.transcript.entries
				.filter((e) => e.entryId !== task1.id)
				.reduce((sum, e) => sum + e.tokenEstimate, 0);
		const budget = computeLivenessBudget(tokensAfterKeepingTask2AndRecent, 0);

		const { deletions } = buildEvictionTargets(preparation.transcript, [], budget);
		const validated = validateContextDeletionRequest(
			{ deletions },
			preparation.transcript,
			{ evict: true },
		);
		expect(validated.deletedTargets.length).toBeGreaterThan(0);
		// task2 (the most-recent task-bearing) must survive.
		const deletedIds = new Set(validated.deletedTargets.map((t) => t.entryId));
		expect(deletedIds.has(task2.id)).toBe(false);
	});
});

describe("validateContextDeletionRequest evict option", () => {
	it("rejects protected entries without evict and accepts them with evict", () => {
		resetIds();
		const task1 = entry(user("first old task"));
		const task2 = entry(user("second task most recent"));
		const recent1 = entry(assistantText("recent protected one"));
		const entries: SessionEntry[] = [task1, task2, recent1];
		const preparation = prepareContextCompaction(entries, settingsWith(0))!;

		// Without evict, deleting the protected task1 is rejected.
		expect(() =>
			validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: task1.id }] },
				preparation.transcript,
			),
		).toThrow(/protected/i);

		// With evict, deleting the protected task1 is accepted.
		const validated = validateContextDeletionRequest(
			{ deletions: [{ kind: "entry", entryId: task1.id }] },
			preparation.transcript,
			{ evict: true },
		);
		expect(validated.deletedTargets).toContainEqual({ kind: "entry", entryId: task1.id });
	});

	it("still refuses recent entries even under evict", () => {
		resetIds();
		const task = entry(user("task"));
		const recent1 = entry(assistantText("recent protected one"));
		const entries: SessionEntry[] = [task, recent1];
		const preparation = prepareContextCompaction(entries, settingsWith(0))!;

		expect(() =>
			validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: recent1.id }] },
				preparation.transcript,
				{ evict: true },
			),
		).toThrow(/recent/i);
	});

	it("still refuses to leave zero task-bearing entries even under evict", () => {
		resetIds();
		const task1 = entry(user("only task"));
		const old = entry(assistantText("old deletable assistant text"));
		const recent1 = entry(assistantText("recent protected one"));
		const entries: SessionEntry[] = [task1, old, recent1];
		const preparation = prepareContextCompaction(entries, settingsWith(0))!;

		// Evicting the only task-bearing entry would leave no task in context.
		expect(() =>
			validateContextDeletionRequest(
				{ deletions: [{ kind: "entry", entryId: task1.id }] },
				preparation.transcript,
				{ evict: true },
			),
		).toThrow(/no user task/i);
	});
});
