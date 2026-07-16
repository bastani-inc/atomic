import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, estimateContextTokens } from "../src/core/compaction/compaction.js";
import type { NumberedRegion, VerbatimCompactionStats } from "../src/core/compaction/compaction-types.js";
import { runFullCollapseCompaction } from "../src/core/compaction/compaction-runner.js";
import { prepareFullCollapseBoundary } from "../src/core/compaction/full-collapse-boundary.js";
import { convertToLlm, isVerbatimCompactionMessage, type CustomMessage } from "../src/core/messages.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createFauxStreamFn } from "./test-harness.js";

const model: Model<Api> = {
	id: "collapse-test", name: "Collapse Test", api: "anthropic-messages", provider: "test", baseUrl: "https://example.com",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192,
};

function assistant(text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: "test", model: "collapse-test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp,
	};
}

function toolResult(text: string, timestamp: number): AgentMessage {
	return { role: "toolResult", toolCallId: `tc-${timestamp}`, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp };
}

/** A valid subsequence: keep line 1 plus every protected line, delete the rest. */
function validCollapseOutput(region: NumberedRegion): string {
	const keep = new Set<number>([1, ...(region.protectedLineNumbers ?? [])]);
	return region.lines.filter((_, index) => keep.has(index + 1)).join("\n");
}

function detailsFull(stats: VerbatimCompactionStats) {
	return {
		strategy: "verbatim-lines" as const, promptVersion: 4, format: "full-collapse" as const,
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" }, stats, rung: "planned" as const,
	};
}

function seedIncidentSession(assistantTurns: number): SessionManager {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: [{ type: "text", text: "kick off the long task\nwith much detail" }], timestamp: 1 });
	for (let i = 0; i < assistantTurns; i++) {
		manager.appendMessage(i % 2 === 0 ? assistant(`step ${i}\nwork line ${i}`, i + 2) : toolResult(`result ${i}\noutput line ${i}`, i + 2));
	}
	return manager;
}

async function collapseOnce(manager: SessionManager): Promise<number> {
	const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 });
	expect(prep).toBeDefined();
	const faux = createFauxStreamFn([validCollapseOutput(prep!.region)]);
	const compacted = await runFullCollapseCompaction(prep!, model, "key", undefined, undefined, "off", { streamFn: faux.streamFn });
	manager.appendCompaction(compacted.text, prep!.firstKeptEntryId, prep!.tokensBefore, detailsFull(compacted.stats));
	return estimateContextTokens(manager.buildSessionContext().messages).tokens;
}

describe("runFullCollapseCompaction", () => {
	it("validates a returned string subsequence and rebuilds a planned rung", async () => {
		const manager = seedIncidentSession(40);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const faux = createFauxStreamFn([validCollapseOutput(prep.region)]);
		const result = await runFullCollapseCompaction(prep, model, "key", undefined, undefined, "off", { streamFn: faux.streamFn });
		expect(faux.state.callCount).toBe(1);
		expect(result.rung).toBe("planned");
		expect(result.stats.linesDeleted).toBeGreaterThan(0);
		expect(result.stats.tokensBefore).toBe(prep.tokensBefore);
	});

	it("reconstructs v2 as one compaction message plus post-boundary entries only", async () => {
		const manager = seedIncidentSession(20);
		const prep = prepareFullCollapseBoundary(manager.getBranch(), DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })!;
		const faux = createFauxStreamFn([validCollapseOutput(prep.region)]);
		const compacted = await runFullCollapseCompaction(prep, model, "key", undefined, undefined, "off", { streamFn: faux.streamFn });
		manager.appendCompaction(compacted.text, prep.firstKeptEntryId, prep.tokensBefore, detailsFull(compacted.stats));
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "post boundary follow up" }], timestamp: 9999 });

		const context = manager.buildSessionContext();
		expect(isVerbatimCompactionMessage(context.messages[0] as CustomMessage)).toBe(true);
		// Only the boundary message + the single post-boundary user message survive.
		expect(context.messages).toHaveLength(2);
		const serialized = JSON.stringify(convertToLlm(context.messages));
		expect(serialized).not.toContain("work line 0");
		expect(serialized).toContain("post boundary follow up");
	});

	it("recovers from the incident shape across repeated same-turn collapse with monotonic reduction", async () => {
		const manager = seedIncidentSession(300);
		for (let round = 0; round < 3; round++) {
			const before = estimateContextTokens(manager.buildSessionContext().messages).tokens;
			const after = await collapseOnce(manager);
			// Never dead-ends on "nothing deletable" and always reduces this round's context.
			expect(after).toBeLessThan(before);
			// Append more assistant/tool work WITHOUT a new user turn.
			for (let i = 0; i < 40; i++) {
				manager.appendMessage(i % 2 === 0 ? assistant(`more ${round}-${i}\ntail ${i}`, 10_000 + round * 100 + i) : toolResult(`out ${round}-${i}\ntail ${i}`, 10_000 + round * 100 + i));
			}
		}
	});
});
