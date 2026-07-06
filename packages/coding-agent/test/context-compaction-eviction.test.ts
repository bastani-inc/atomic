import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactableTranscript, CompactableTranscriptEntry } from "../src/core/compaction/index.ts";
import type { ContextDeletionTarget } from "../src/core/session-manager.ts";
import {
	CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT,
	isCriticalOverflowProtectedEntryDeletable,
	relaxTranscriptForCriticalEviction,
} from "../src/core/compaction/context-compaction-critical.ts";
import { validateContextDeletionRequest } from "../src/core/compaction/index.ts";
import {
	CONTEXT_COMPACTION_MAX_EVICTION_PASSES,
	runDeterministicContextEviction,
} from "../src/core/compaction/context-compaction-eviction.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import { canDeleteTarget, deletionRequestFromTargets } from "../src/core/compaction/context-deletion-targets.ts";

function textMessage(role: AgentMessage["role"], text: string): AgentMessage {
	return { role, content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}
function thinkingAssistantMessage(text: string): AgentMessage {
	return {
		...textMessage("assistant", text),
		content: [
			{ type: "text", text },
			{ type: "thinking", thinking: `${text} private reasoning`, thinkingSignature: "sig-thinking" },
		],
	} as unknown as AgentMessage;
}


function entry(
	entryId: string,
	role: AgentMessage["role"],
	tokenEstimate: number,
	protectedEntry = false,
	message: AgentMessage = textMessage(role, entryId),
): CompactableTranscriptEntry {
	return {
		entryId,
		entryType: "message",
		role,
		text: entryId,
		tokenEstimate,
		protected: protectedEntry,
		contentBlocks: [
			{ entryId, blockIndex: 0, type: "text", text: entryId, tokenEstimate, protected: protectedEntry },
		],
		message,
		toolCallIds: [],
	};
}

function transcript(entries: CompactableTranscriptEntry[], preserveRecent = 2): CompactableTranscript {
	return {
		entries,
		protectedEntryIds: entries.filter((candidate) => candidate.protected).map((candidate) => candidate.entryId),
		tokensBefore: entries.reduce((sum, candidate) => sum + candidate.tokenEstimate, 0),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, preserveRecent },
		parameters: { compression_ratio: 0.5, preserve_recent: preserveRecent, query: "test" },
	};
}

function recentTail(prefix = "critical-recent", count = CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT, tokens = 5): CompactableTranscriptEntry[] {
	return Array.from({ length: count }, (_, index) => entry(`${prefix}-${index}`, "assistant", tokens, true));
}

function recentUserTail(prefix = "critical-recent-user", count = CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT, tokens = 1): CompactableTranscriptEntry[] {
	return Array.from({ length: count }, (_, index) => entry(`${prefix}-${index}`, "user", tokens, true));
}

function expectProtectedIdsDisjointFromDeleted(result: { protectedEntryIds: string[]; deletedTargets: Array<{ kind: string; entryId: string }> }) {
	const protectedIds = new Set(result.protectedEntryIds);
	for (const target of result.deletedTargets) {
		expect(protectedIds.has(target.entryId)).toBe(false);
	}
}

function oracleHasFittingEntryDeletionPlan(input: CompactableTranscript, tokenBudget: number): boolean {
	const relaxed = relaxTranscriptForCriticalEviction(input);
	const candidates: ContextDeletionTarget[] = relaxed.entries
		.filter((candidate) => canDeleteTarget(relaxed, { kind: "entry", entryId: candidate.entryId }))
		.map((candidate) => ({ kind: "entry", entryId: candidate.entryId }));
	for (let mask = 1; mask < 2 ** candidates.length; mask++) {
		const targets = candidates.filter((_, index) => (mask & (1 << index)) !== 0);
		try {
			const result = validateContextDeletionRequest(deletionRequestFromTargets(targets), relaxed);
			if (result.deletedTargets.length > 0 && result.stats.tokensAfter <= tokenBudget) return true;
		} catch {
			// Invalid subsets are intentionally ignored by the oracle.
		}
	}
	return false;
}

function expectEvictionMatchesOracle(input: CompactableTranscript, tokenBudget: number): void {
	const oracleFits = oracleHasFittingEntryDeletionPlan(input, tokenBudget);
	if (oracleFits) {
		const result = runDeterministicContextEviction(input, tokenBudget);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(tokenBudget);
		expect(result.deletedTargets.length).toBeGreaterThan(0);
		return;
	}
	expect(() => runDeterministicContextEviction(input, tokenBudget)).toThrow(/nothing more was safely deletable/);
}

describe("critical overflow transcript relaxation and deterministic eviction", () => {
	it("relaxes only stale protected task-bearing entries outside the critical recent boundary", () => {
		const assistantError = { ...textMessage("assistant", "error"), stopReason: "error" } as AgentMessage;
		const toolError = { ...textMessage("toolResult", "tool error"), isError: true } as AgentMessage;
		const bashFailed = { ...textMessage("bashExecution", "failed"), exitCode: 1 } as AgentMessage;
		const original = transcript([
			entry("old-user", "user", 5, true),
			entry("old-custom", "custom", 5, true),
			entry("old-summary", "branchSummary", 5, true),
			entry("assistant-error", "assistant", 5, true, assistantError),
			entry("tool-error", "toolResult", 5, true, toolError),
			entry("bash-failed", "bashExecution", 5, true, bashFailed),
			...Array.from({ length: CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT }, (_, index) =>
				entry(`recent-user-${index}`, "user", 5, true),
			),
		]);
		const relaxed = relaxTranscriptForCriticalEviction(original);
		for (const id of ["old-user", "old-custom", "old-summary"]) {
			const relaxedEntry = relaxed.entries.find((candidate) => candidate.entryId === id)!;
			expect(isCriticalOverflowProtectedEntryDeletable(original.entries.find((candidate) => candidate.entryId === id)!, original)).toBe(true);
			expect(relaxedEntry.protected).toBe(false);
			expect(relaxedEntry.contentBlocks[0]!.protected).toBe(false);
		}
		for (const id of ["assistant-error", "tool-error", "bash-failed", "recent-user-0", "recent-user-4"]) {
			expect(relaxed.entries.find((candidate) => candidate.entryId === id)!.protected).toBe(true);
		}
		expect(relaxed.protectedEntryIds).not.toEqual(original.protectedEntryIds);
		expect(relaxed.protectedEntryIds).toEqual([
			"assistant-error",
			"tool-error",
			"bash-failed",
			"recent-user-0",
			"recent-user-1",
			"recent-user-2",
			"recent-user-3",
			"recent-user-4",
		]);
		for (const id of ["old-user", "old-custom", "old-summary"]) {
			expect(relaxed.protectedEntryIds).not.toContain(id);
		}
	});

	it("evicts oldest deletable entries first and stops as soon as the budget fits", () => {
		const input = transcript([
			entry("task", "user", 10, true),
			entry("old-1", "assistant", 10),
			entry("old-2", "assistant", 15),
			entry("old-3", "assistant", 20),
			...recentTail(),
		]);
		const result = runDeterministicContextEviction(input, 55);
		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "old-1" },
			{ kind: "entry", entryId: "old-2" },
		]);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(55);
		expectProtectedIdsDisjointFromDeleted(result);
	});

	it("reconciles tool call and tool result pairing during deterministic eviction", () => {
		const callId = "call-old";
		const callMessage = { ...textMessage("assistant", "call"), content: [{ type: "toolCall", id: callId, name: "read", arguments: {} }] } as AgentMessage;
		const resultMessage = { ...textMessage("toolResult", "result"), toolCallId: callId, toolName: "read", isError: false } as AgentMessage;
		const callEntry = { ...entry("tool-call", "assistant", 20, false, callMessage), toolCallIds: [callId] };
		const resultEntry = { ...entry("tool-result", "toolResult", 15, false, resultMessage), toolResultFor: callId };
		const input = transcript([entry("task", "user", 10, true), callEntry, resultEntry, ...recentTail()]);
		const result = runDeterministicContextEviction(input, 35);
		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "tool-call" },
			{ kind: "entry", entryId: "tool-result" },
		]);
	});

	it("preserves the task-bearing floor and reports terminal exhaustion with achieved stats", () => {
		const input = transcript([
			entry("only-task", "user", 100, true),
			entry("old", "assistant", 5),
			...recentTail(),
		]);
		expect(() => runDeterministicContextEviction(input, 1)).toThrow(/achieved tokensAfter=.*nothing more was safely deletable/);
	});

	it("never evicts entries inside the critical last-5 floor", () => {
		const input = transcript([entry("task", "user", 10, true), entry("critical-recent-unprotected", "assistant", 100), ...recentTail("tail", 4, 5)]);
		const relaxed = relaxTranscriptForCriticalEviction(input);
		expect(relaxed.parameters?.preserve_recent).toBe(CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT);
		expect(() => validateContextDeletionRequest({ deletions: [{ kind: "entry", entryId: "critical-recent-unprotected" }] }, relaxed)).toThrow(/recent context/);
		expect(() => runDeterministicContextEviction(input, 20)).toThrow(/nothing more was safely deletable/);
	});

	it("never evicts configured preserve_recent entries", () => {
		const input = transcript([entry("task", "user", 10, true), entry("old", "assistant", 10), entry("recent-1", "assistant", 100, true), entry("recent-2", "assistant", 100, true)]);
		expect(() => runDeterministicContextEviction(input, 20)).toThrow(/nothing more was safely deletable/);
	});

	it("still evicts one oldest entry when the budget already fits", () => {
		const input = transcript([entry("task", "user", 10, true), entry("old", "assistant", 5), ...recentTail()]);
		const result = runDeterministicContextEviction(input, 100);
		expect(result.deletedTargets).toEqual([{ kind: "entry", entryId: "old" }]);
		expectProtectedIdsDisjointFromDeleted(result);
	});

	it("can evict an older thinking assistant when a newer non-thinking assistant remains", () => {
		const input = transcript(
			[
				entry("task", "user", 20, true),
				entry("older-thinking", "assistant", 60, false, thinkingAssistantMessage("older thinking")),
				...recentTail("newer-assistant", CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT, 2),
			],
			0,
		);
		const result = runDeterministicContextEviction(input, 30);
		expect(result.deletedTargets).toEqual([{ kind: "entry", entryId: "older-thinking" }]);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(30);
	});

	it("drops an older thinking deletion when it blocks a newer fitting deletion plan", () => {
		const input = transcript(
			[
				entry("older-thinking", "assistant", 10, false, thinkingAssistantMessage("older thinking")),
				entry("newer-a", "assistant", 40),
				entry("newer-b", "assistant", 40),
				entry("task", "user", 1, true),
				...Array.from({ length: CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT - 1 }, (_, index) =>
					entry(`critical-tail-${index}`, "user", 1, true),
				),
			],
			0,
		);
		const result = runDeterministicContextEviction(input, 30);
		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "newer-a" },
			{ kind: "entry", entryId: "newer-b" },
		]);
		expect(result.deletedTargets.some((target) => target.entryId === "older-thinking")).toBe(false);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(30);
	});

	it("retains the newest planned thinking assistant when that enables an older thinking plus newer assistant deletion", () => {
		const input = transcript(
			[
				entry("thinking-large", "assistant", 40, false, thinkingAssistantMessage("large older thinking")),
				entry("thinking-small-newest", "assistant", 5, false, thinkingAssistantMessage("small newest thinking")),
				entry("latest-non-thinking", "assistant", 35),
				...recentUserTail("retain-thinking-tail"),
			],
			0,
		);
		const result = runDeterministicContextEviction(input, 10);
		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "thinking-large" },
			{ kind: "entry", entryId: "latest-non-thinking" },
		]);
		expect(result.deletedTargets.some((target) => target.entryId === "thinking-small-newest")).toBe(false);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(10);
	});

	it("drops an older task-bearing deletion when it blocks a newer fitting deletion plan", () => {
		const input = transcript(
			[
				entry("task-old", "user", 10, true),
				entry("task-new", "user", 80, true),
				...recentTail("tail", CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT, 1),
			],
			0,
		);
		const result = runDeterministicContextEviction(input, 15);
		expect(result.deletedTargets).toEqual([{ kind: "entry", entryId: "task-new" }]);
		expect(result.deletedTargets.some((target) => target.entryId === "task-old")).toBe(false);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(15);
	});

	it("retains the smallest task anchor when multiple task deletions are needed to fit", () => {
		const input = transcript(
			[
				entry("task-small", "user", 10, true),
				entry("task-medium", "user", 30, true),
				entry("task-large", "user", 60, true),
				...recentTail("tail", CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT, 1),
			],
			0,
		);
		const result = runDeterministicContextEviction(input, 15);
		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "task-medium" },
			{ kind: "entry", entryId: "task-large" },
		]);
		expect(result.deletedTargets.some((target) => target.entryId === "task-small")).toBe(false);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(15);
	});

	it("matches a bounded brute-force oracle for deterministic eviction success and exhaustion", () => {
		const callId = "oracle-call";
		const toolCall = {
			...entry("tool-call-oracle", "assistant", 15, false, {
				...textMessage("assistant", "call"),
				content: [{ type: "toolCall", id: callId, name: "read", arguments: {} }],
			} as AgentMessage),
			toolCallIds: [callId],
		};
		const toolResult = {
			...entry("tool-result-oracle", "toolResult", 15, false, {
				...textMessage("toolResult", "result"),
				toolCallId: callId,
				toolName: "read",
				isError: false,
			} as AgentMessage),
			toolResultFor: callId,
		};
		const multiThinking = transcript(
			[
				entry("thinking-large-o", "assistant", 40, false, thinkingAssistantMessage("large older")),
				entry("thinking-small-newest-o", "assistant", 5, false, thinkingAssistantMessage("small newest")),
				entry("latest-non-thinking-o", "assistant", 35),
				...recentUserTail("oracle-tail-e", 5, 1),
			],
			0,
		);
		const mixedTaskThinking = transcript(
			[
				entry("task-small-mix-o", "user", 5, true),
				entry("task-large-mix-o", "user", 40, true),
				entry("thinking-large-mix-o", "assistant", 30, false, thinkingAssistantMessage("mixed older")),
				entry("thinking-small-mix-o", "assistant", 5, false, thinkingAssistantMessage("mixed newest")),
				entry("latest-non-thinking-mix-o", "assistant", 25),
				...recentUserTail("oracle-tail-f", 5, 1),
			],
			0,
		);
		const cases: Array<{ input: CompactableTranscript; budget: number }> = [
			{
				input: transcript([entry("task-small-o", "user", 10, true), entry("task-medium-o", "user", 30, true), entry("task-large-o", "user", 60, true), ...recentTail("oracle-tail-a", 5, 1)], 0),
				budget: 15,
			},
			{
				input: transcript([entry("older-thinking-o", "assistant", 10, false, thinkingAssistantMessage("older")), entry("assistant-a-o", "assistant", 40), entry("assistant-b-o", "assistant", 40), entry("task-o", "user", 1, true), ...recentTail("oracle-tail-b", 4, 1)], 0),
				budget: 30,
			},
			{ input: multiThinking, budget: 10 },
			{ input: multiThinking, budget: 9 },
			{ input: mixedTaskThinking, budget: 16 },
			{ input: mixedTaskThinking, budget: 15 },
			{
				input: transcript([entry("task-pair-o", "user", 10, true), toolCall, toolResult, ...recentTail("oracle-tail-c", 5, 1)], 0),
				budget: 20,
			},
			{
				input: transcript([entry("only-task-o", "user", 30, true), entry("tiny-old-o", "assistant", 5), ...recentTail("oracle-tail-d", 5, 1)], 0),
				budget: 1,
			},
		];
		for (const { input, budget } of cases) {
			expectEvictionMatchesOracle(input, budget);
		}
	});

	it("does not replace a better task-bearing plan with a worse validating exchange", () => {
		const input = transcript(
			[
				entry("task-old-large", "user", 80, true),
				entry("task-new-small", "user", 10, true),
				entry("old-filler", "assistant", 10),
				...recentTail("tail", CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT, 1),
			],
			0,
		);
		const result = runDeterministicContextEviction(input, 15);
		expect(result.deletedTargets).toEqual([
			{ kind: "entry", entryId: "task-old-large" },
			{ kind: "entry", entryId: "old-filler" },
		]);
		expect(result.deletedTargets.some((target) => target.entryId === "task-new-small")).toBe(false);
		expect(result.stats.tokensAfter).toBe(15);
	});

	it("still skips the actual latest assistant when it contains thinking", () => {
		const input = transcript(
			[
				entry("task", "user", 20, true),
				entry("older", "assistant", 10),
				...recentTail("tail", CONTEXT_CRITICAL_OVERFLOW_RECENT_ENTRY_COUNT - 1, 1),
				entry("latest-thinking", "assistant", 60, false, thinkingAssistantMessage("latest thinking")),
			],
			0,
		);
		expect(() => runDeterministicContextEviction(input, 20)).toThrow(/nothing more was safely deletable/);
	});

	it("uses a 50 pass cap and is deterministic for repeated inputs", () => {
		const input = transcript([entry("task", "user", 10, true), entry("old-1", "assistant", 5), entry("old-2", "assistant", 5), ...recentTail()]);
		expect(CONTEXT_COMPACTION_MAX_EVICTION_PASSES).toBe(50);
		expect(runDeterministicContextEviction(input, 35).deletedTargets).toEqual(runDeterministicContextEviction(input, 35).deletedTargets);
	});
});
