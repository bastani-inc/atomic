import type { SessionManager } from "../src/core/session-manager.ts";

export function appendTestCompaction(manager: SessionManager, tokensBefore: number, tokensAfter: number): string {
	const firstKeptEntryId = manager.getBranch()[0]?.id;
	if (!firstKeptEntryId) throw new Error("Test compaction requires an existing session entry");
	const compactedText = "[User]: retained test context\n(filtered 1 lines)";
	return manager.appendCompaction(compactedText, firstKeptEntryId, tokensBefore, {
		strategy: "verbatim-lines",
		promptVersion: 3,
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" },
		stats: {
			linesBefore: 2,
			linesDeleted: 1,
			linesKept: 1,
			rangeCount: 1,
			tokensBefore,
			tokensAfter,
			percentReduction: tokensBefore === 0 ? 0 : ((tokensBefore - tokensAfter) / tokensBefore) * 100,
		},
		rung: "planned",
	});
}
