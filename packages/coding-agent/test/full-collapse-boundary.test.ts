import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";
import { prepareFullCollapseBoundary } from "../src/core/compaction/full-collapse-boundary.js";
import { serializeConversationForCompaction } from "../src/core/compaction/transcript-serialization.js";
import { convertToLlm } from "../src/core/messages.js";
import type { SessionEntry } from "../src/core/session-manager-types.js";

function user(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp,
	};
}

function toolResult(text: string, timestamp: number): AgentMessage {
	return { role: "toolResult", toolCallId: `tc-${timestamp}`, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp };
}

function entry(id: string, message: AgentMessage, parentId: string | null): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date(Number(id.slice(1)) * 1000).toISOString(), message };
}

/** One user turn followed by many assistant/tool entries, chained parent→child. */
function incidentEntries(assistantTurns: number): SessionEntry[] {
	const entries: SessionEntry[] = [entry("m1", user("kick off the long task\nwith detail", 1), null)];
	for (let i = 0; i < assistantTurns; i++) {
		const id = `m${i + 2}`;
		const parent = `m${i + 1}`;
		const message = i % 2 === 0 ? assistant(`step ${i}\nwork line`, i + 2) : toolResult(`result ${i}\noutput line`, i + 2);
		entries.push(entry(id, message, parent));
	}
	return entries;
}

describe("prepareFullCollapseBoundary", () => {
	it("collapses one user turn plus hundreds of assistant/tool entries without user-turn widening", () => {
		const entries = incidentEntries(400);
		const prep = prepareFullCollapseBoundary(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 });
		expect(prep).toBeDefined();
		expect(prep?.format).toBe("full-collapse");
		// Self-anchor is the current leaf (last entry), never a user-turn start.
		expect(prep?.firstKeptEntryId).toBe(entries[entries.length - 1].id);
		expect(prep?.keptTailMessageCount).toBe(0);
		expect(prep?.protectedMessageCount).toBe(2);
		expect(prep?.regionEntryIds.length).toBe(entries.length);
		expect((prep?.region.lines.length ?? 0)).toBeGreaterThanOrEqual(20);
	});

	it("protects the last two visible messages byte-identically inside the region string", () => {
		const entries = incidentEntries(40);
		const prep = prepareFullCollapseBoundary(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 });
		expect(prep).toBeDefined();
		const region = prep!.region;
		const protectedLines = [...(region.protectedLineNumbers ?? [])].sort((a, b) => a - b);
		expect(protectedLines.length).toBeGreaterThan(0);
		const protectedText = protectedLines.map((line) => region.lines[line - 1]).join("\n");
		const lastTwo = [entries[entries.length - 2], entries[entries.length - 1]].map((e) => (e as { message: AgentMessage }).message);
		expect(protectedText).toBe(serializeConversationForCompaction(convertToLlm(lastTwo)));
	});

	it("returns undefined below the region minimum", () => {
		const entries = [entry("m1", user("one", 1), null), entry("m2", assistant("two", 2), "m1"), entry("m3", user("three", 3), "m2")];
		expect(prepareFullCollapseBoundary(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 2 })).toBeUndefined();
	});

	it("returns undefined when preserve_recent protects every eligible line", () => {
		const long = Array.from({ length: 12 }, (_, index) => `line ${index}`).join("\n");
		const entries = [
			entry("m1", user(long, 1), null),
			entry("m2", assistant(long, 2), "m1"),
			entry("m3", user(long, 3), "m2"),
		];
		// preserve_recent covering all three visible messages leaves nothing deletable.
		expect(prepareFullCollapseBoundary(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 3 })).toBeUndefined();
	});

	it("folds a previous full-collapse summary into the front of the new region", () => {
		const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
		const entries: SessionEntry[] = [
			entry("m1", user(long, 1), null),
			{
				type: "compaction", id: "c2", parentId: "m1", timestamp: new Date(2_000).toISOString(),
				summary: "[User]: prior durable\n(filtered 40 lines)", firstKeptEntryId: "m1", tokensBefore: 500,
				details: { strategy: "verbatim-lines", promptVersion: 4, format: "full-collapse", parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "q" }, stats: { linesBefore: 50, linesDeleted: 40, linesKept: 10, rangeCount: 1, tokensBefore: 500, tokensAfter: 100, percentReduction: 80 }, rung: "planned" },
			},
			entry("m3", assistant(long, 3), "c2"),
			entry("m4", user("newest turn", 4), "m3"),
		];
		const prep = prepareFullCollapseBoundary(entries, DEFAULT_COMPACTION_SETTINGS, { preserve_recent: 1 });
		expect(prep).toBeDefined();
		expect(prep?.region.lines.slice(0, 2)).toEqual(["[User]: prior durable", "(filtered 40 lines)"]);
		expect(prep?.firstKeptEntryId).toBe("m4");
	});
});
