import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactableTranscript, CompactableTranscriptEntry } from "../src/core/compaction/index.ts";
import { runDeterministicContextEviction } from "../src/core/compaction/context-compaction-eviction.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";

function message(role: AgentMessage["role"], text: string, signed = false): AgentMessage {
	return {
		role,
		content: signed
			? [{ type: "thinking", thinking: text, thinkingSignature: `sig-${text}` }]
			: [{ type: "text", text }],
		timestamp: Date.now(),
	} as AgentMessage;
}

function entry(
	entryId: string,
	role: AgentMessage["role"],
	tokenEstimate: number,
	signed = false,
	protectedEntry = false,
): CompactableTranscriptEntry {
	return {
		entryId,
		entryType: "message",
		role,
		text: entryId,
		tokenEstimate,
		protected: protectedEntry,
		contentBlocks: [{
			entryId,
			blockIndex: 0,
			type: signed ? "thinking" : "text",
			text: entryId,
			tokenEstimate,
			protected: protectedEntry,
		}],
		message: message(role, entryId, signed),
		toolCallIds: [],
	};
}

function transcript(entries: CompactableTranscriptEntry[]): CompactableTranscript {
	return {
		entries,
		protectedEntryIds: entries.filter((candidate) => candidate.protected).map((candidate) => candidate.entryId),
		tokensBefore: entries.reduce((sum, candidate) => sum + candidate.tokenEstimate, 0),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, preserveRecent: 0 },
		parameters: { compression_ratio: 0.5, preserve_recent: 0, query: "semantic exchange" },
	};
}

function tail(tokens = 1): CompactableTranscriptEntry[] {
	return Array.from({ length: 5 }, (_, index) => entry(`tail-${index}`, "assistant", tokens, false, true));
}

function deletedIds(result: ReturnType<typeof runDeterministicContextEviction>): Set<string> {
	return new Set(result.deletedTargets.map((target) => target.entryId));
}

describe("deterministic eviction semantic exchange", () => {
	it("restores an interior signed deletion while retaining deletions on both sides", () => {
		const input = transcript([
			entry("task-anchor", "user", 1, false, true),
			entry("A", "assistant", 60),
			entry("B", "assistant", 100, true),
			entry("C", "assistant", 60),
			entry("D", "user", 150),
			...tail(),
		]);
		const result = runDeterministicContextEviction(input, 120);
		expect(deletedIds(result)).toEqual(new Set(["A", "C", "D"]));
		expect(result.stats.tokensAfter).toBe(106);
	});

	it("accepts a temporarily worse boundary exchange before deleting later filler", () => {
		const input = transcript([
			entry("task", "user", 5),
			entry("filler-before", "assistant", 100),
			entry("signed", "assistant", 5, true),
			entry("boundary", "user", 100),
			entry("filler-after", "assistant", 5),
			...tail(),
		]);
		const result = runDeterministicContextEviction(input, 15);
		expect([...deletedIds(result)]).toEqual(["filler-before", "boundary", "filler-after"]);
		expect(result.stats.tokensAfter).toBe(15);
	});

	it("restores noncontiguous signed entries while keeping safe surrounding deletions", () => {
		const input = transcript([
			entry("0", "user", 5),
			entry("1", "assistant", 21),
			entry("2", "assistant", 11, true),
			entry("3", "user", 10),
			entry("4", "assistant", 5),
			entry("5", "assistant", 3, true),
			entry("6", "assistant", 23),
			entry("7", "user", 23),
			...tail(5),
		]);
		const result = runDeterministicContextEviction(input, 38);
		expect(deletedIds(result)).toEqual(new Set(["0", "1", "2", "4", "6", "7"]));
		expect(result.stats.tokensAfter).toBe(38);
	});

	it("retains the topology-preserving task boundary instead of the smallest task", () => {
		const cases = [
			{
				entries: [
					entry("a0", "user", 24), entry("a1", "user", 3), entry("a2", "assistant", 34, true),
					entry("a3", "user", 29), entry("a4", "user", 36), ...tail(),
				], budget: 34, deleted: ["a0", "a1", "a2", "a4"],
			},
			{
				entries: [
					entry("b0", "user", 11), entry("b1", "user", 4), entry("b2", "assistant", 24, true),
					entry("b3", "user", 15), entry("b4", "user", 30), ...tail(),
				], budget: 20, deleted: ["b0", "b1", "b2", "b4"],
			},
			{
				entries: [
					entry("c0", "user", 4), entry("c1", "assistant", 9, true), entry("c2", "user", 5),
					entry("c3", "assistant", 7, true), entry("c4", "user", 7), entry("c5", "assistant", 7),
					entry("c6", "user", 9), ...tail(),
				], budget: 12, deleted: ["c0", "c1", "c2", "c3", "c5", "c6"],
			},
		];
		for (const testCase of cases) {
			const result = runDeterministicContextEviction(transcript(testCase.entries), testCase.budget);
			expect(deletedIds(result)).toEqual(new Set(testCase.deleted));
			expect(result.stats.tokensAfter).toBe(testCase.budget);
		}
	});

	it("batches two boundaries whose repaired singletons cannot improve the plan", () => {
		const input = transcript([
			entry("batch-task", "user", 1, false, true),
			entry("batch-retained-signed", "assistant", 1, true, true),
			entry("batch-boundary-one", "user", 10),
			entry("batch-restored-signed", "assistant", 15, true),
			entry("batch-boundary-two", "user", 10),
			...tail(),
		]);
		const result = runDeterministicContextEviction(input, 22);
		const deleted = deletedIds(result);
		expect(deleted.has("batch-boundary-one")).toBe(true);
		expect(deleted.has("batch-boundary-two")).toBe(true);
		expect(deleted.has("batch-restored-signed")).toBe(false);
		expect(result.stats.tokensAfter).toBe(22);
	});

	it("combines a non-prefix restoration-equivalent boundary group", () => {
		const input = transcript([
			entry("group-task", "user", 1, false, true),
			entry("group-s0", "assistant", 100, true),
			entry("group-b0", "user", 50),
			entry("group-retained", "assistant", 1, true, true),
			entry("group-b1", "user", 40),
			entry("group-s1", "assistant", 60, true),
			entry("group-b2", "user", 40),
			...tail(),
		]);
		const result = runDeterministicContextEviction(input, 117);
		const deleted = deletedIds(result);
		for (const entryId of ["group-s0", "group-b1", "group-b2"]) expect(deleted.has(entryId)).toBe(true);
		for (const entryId of ["group-b0", "group-retained", "group-s1"]) expect(deleted.has(entryId)).toBe(false);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(117);
	});

	it("backtracks a larger accepted boundary to reach a 22-token budget", () => {
		const input = transcript([
			entry("alternate-filler-0", "assistant", 30),
			entry("alternate-filler-1", "assistant", 21),
			entry("alternate-boundary-0", "user", 12),
			entry("alternate-boundary-1", "user", 10),
			entry("alternate-signed", "assistant", 10, true),
			entry("alternate-retained-boundary", "user", 15),
			...tail(),
		]);
		const result = runDeterministicContextEviction(input, 22);
		expect(deletedIds(result)).toEqual(new Set([
			"alternate-filler-0",
			"alternate-filler-1",
			"alternate-boundary-0",
			"alternate-boundary-1",
			"alternate-signed",
		]));
		expect(result.stats.tokensAfter).toBe(20);
	});

	it("backtracks a locally improving boundary to reach a 50-token budget", () => {
		const input = transcript([
			entry("backtrack-boundary-0", "user", 17),
			entry("backtrack-boundary-1", "user", 25),
			entry("backtrack-boundary-2", "user", 3),
			entry("backtrack-filler", "assistant", 25),
			entry("backtrack-historical-signed", "assistant", 24, true),
			entry("backtrack-retained-boundary", "user", 25),
			entry("backtrack-active-signed", "assistant", 19, true),
			...tail(),
		]);
		const result = runDeterministicContextEviction(input, 50);
		expect(deletedIds(result)).toEqual(new Set([
			"backtrack-boundary-0",
			"backtrack-boundary-1",
			"backtrack-boundary-2",
			"backtrack-filler",
			"backtrack-historical-signed",
		]));
		expect(result.stats.tokensAfter).toBe(49);
	});
	it("stays bounded on one thousand historical signed turns", () => {
		const entries: CompactableTranscriptEntry[] = [];
		for (let index = 0; index < 1_000; index++) {
			entries.push(entry(`task-${index}`, "user", 1), entry(`signed-${index}`, "assistant", 1, true));
		}
		entries.push(...tail());
		const result = runDeterministicContextEviction(transcript(entries), 10);
		expect(result.stats.tokensAfter).toBeLessThanOrEqual(10);
	}, 15_000);
});
