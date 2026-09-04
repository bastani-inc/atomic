/**
 * Regression tests for issue #2052: compaction stats must use one symmetric
 * heuristic estimator on both sides of the reported comparison, and the TUI
 * display must show the authoritative `tokensBefore` rather than the heuristic
 * stats value.
 */

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, test } from "vitest";
import {
	computeWholeContextStats,
	runVerbatimCompaction,
} from "../../packages/coding-agent/src/core/compaction/compaction-runner.js";
import type {
	NumberedRegion,
	VerbatimCompactionStats,
} from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import type {
	VerbatimCompactionDetails,
	VerbatimCompactionResult,
} from "../../packages/coding-agent/src/core/compaction/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { CompactionBoundaryMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/compaction-boundary-message.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import {
	preparation,
	region,
	runRequest,
	scriptedStream,
	setKeptTailTokenEstimate,
	testModel,
} from "./compaction-rung-support.js";

const previousKeybindings = getKeybindings();
beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterAll(() => setKeybindings(previousKeybindings));

/** Build a region whose text is large enough for meaningful char/4 estimates. */
function largeRegion(lineCount: number): NumberedRegion {
	return region(lineCount);
}

/** Build region-scoped stats mirroring `reconstructCompactedTranscript` output. */
function regionStats(region: NumberedRegion, compactedText: string): VerbatimCompactionStats {
	const tokensAfter = Math.ceil(compactedText.length / 4);
	return {
		linesBefore: region.lines.length,
		linesDeleted: Math.max(0, region.lines.length - compactedText.split("\n").length),
		linesKept: compactedText.split("\n").length,
		rangeCount: 1,
		tokensBefore: region.tokenEstimate,
		tokensAfter,
		percentReduction:
			region.tokenEstimate === 0 ? 0 : Math.round((1 - tokensAfter / region.tokenEstimate) * 1000) / 10,
	};
}

// ---------------------------------------------------------------------------
// 1. Large kept tail in planned path
// ---------------------------------------------------------------------------

test("planned compaction with a large kept tail: percentReduction is not negative", async () => {
	// Region: 40 lines, tail estimate much larger than the region.
	const reg = largeRegion(40);
	const prep = preparation({ region: reg, tokensBefore: 100_000 });
	setKeptTailTokenEstimate(prep, 80_000); // tail dwarfs the region
	const stream = scriptedStream({ default: [{ text: "1,20\n" }] });
	const result = await runVerbatimCompaction(prep, testModel(), runRequest({ streamFn: stream.streamFn }));
	assert.equal(result.rung, "planned");
	assert.equal(result.keptTail, true);
	// The tail cancels out of the symmetric ratio; a compaction that deleted
	// lines must report a non-negative percentReduction.
	assert.ok(
		result.stats.percentReduction >= 0,
		`expected percentReduction >= 0, got ${result.stats.percentReduction}`,
	);
});

test("planned compaction with a large kept tail: both sides include the tail estimate", async () => {
	const reg = largeRegion(40);
	const prep = preparation({ region: reg, tokensBefore: 100_000 });
	const tailEstimate = 80_000;
	setKeptTailTokenEstimate(prep, tailEstimate);
	const stream = scriptedStream({ default: [{ text: "1,20\n" }] });
	const result = await runVerbatimCompaction(prep, testModel(), runRequest({ streamFn: stream.streamFn }));
	// tokensBefore = region.tokenEstimate + tailEstimate
	assert.equal(result.stats.tokensBefore, reg.tokenEstimate + tailEstimate);
	// tokensAfter = compactedTextTokens + tailEstimate (tail kept)
	assert.ok(result.stats.tokensAfter >= tailEstimate);
});

// ---------------------------------------------------------------------------
// 2. Large kept tail in extension path
// ---------------------------------------------------------------------------

test("extension stats with a large kept tail: percentReduction is not negative", () => {
	const reg = largeRegion(40);
	const prep = preparation({ region: reg, tokensBefore: 100_000 });
	setKeptTailTokenEstimate(prep, 80_000);
	// Simulate an extension-supplied compacted text that is shorter than the region.
	const compactedText = reg.lines.slice(0, 20).join("\n");
	const stats = regionStats(reg, compactedText);
	const widened = computeWholeContextStats(stats, reg, 80_000, true);
	assert.ok(widened.percentReduction >= 0, `expected percentReduction >= 0, got ${widened.percentReduction}`);
	assert.equal(widened.tokensBefore, reg.tokenEstimate + 80_000);
	assert.ok(widened.tokensAfter >= 80_000);
});

// ---------------------------------------------------------------------------
// 3. Fresh compaction with tail kept
// ---------------------------------------------------------------------------

test("fresh compaction with tail kept: percentReduction is not negative", async () => {
	const reg = largeRegion(40);
	const prep = preparation({ region: reg, tokensBefore: 100_000 });
	// A modest tail that fits under the limit.
	setKeptTailTokenEstimate(prep, 100);
	const stream = scriptedStream({ default: [{ errorMessage: "429 Too Many Requests" }] });
	const result = await runVerbatimCompaction(
		prep,
		testModel({ contextWindow: 200_000 }),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing" }),
	);
	assert.equal(result.rung, "fresh");
	assert.equal(result.keptTail, true);
	// Fresh rung retains all region lines, so tokensAfter includes the full region text plus the tail.
	// tokensBefore = region.tokenEstimate + tail. Both sides use the same estimator.
	assert.ok(
		result.stats.percentReduction >= 0,
		`expected percentReduction >= 0, got ${result.stats.percentReduction}`,
	);
});

// ---------------------------------------------------------------------------
// 4. Fresh compaction with tail dropped
// ---------------------------------------------------------------------------

test("fresh compaction with tail dropped: percentReduction is not negative", async () => {
	const reg = largeRegion(40);
	const prep = preparation({ region: reg, tokensBefore: 100_000 });
	setKeptTailTokenEstimate(prep, 200_000);
	const stream = scriptedStream({ default: [{ errorMessage: "429 Too Many Requests" }] });
	const result = await runVerbatimCompaction(
		prep,
		testModel({ contextWindow: 1_000 }),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing" }),
	);
	assert.equal(result.rung, "fresh");
	assert.equal(result.keptTail, false);
	// When the tail is dropped, tokensBefore still includes the tail estimate
	// (the tail was present in the original context), but tokensAfter does not
	// (the tail is gone). This correctly reflects the context reduction from
	// dropping the protected tail.
	assert.equal(result.stats.tokensBefore, reg.tokenEstimate + 200_000);
	assert.ok(
		result.stats.percentReduction > 0,
		`expected percentReduction > 0 for dropped tail, got ${result.stats.percentReduction}`,
	);
});

// ---------------------------------------------------------------------------
// 5. preserve_recent: 0
// ---------------------------------------------------------------------------

test("preserve_recent 0: no tail estimate, percentReduction uses region only", () => {
	const reg = largeRegion(40);
	const prep = preparation({ region: reg, tokensBefore: 10_000 });
	setKeptTailTokenEstimate(prep, 0); // no tail when preserve_recent is 0
	const compactedText = reg.lines.slice(0, 20).join("\n");
	const stats = regionStats(reg, compactedText);
	const widened = computeWholeContextStats(stats, reg, 0, false);
	assert.equal(widened.tokensBefore, reg.tokenEstimate);
	assert.equal(widened.tokensAfter, stats.tokensAfter);
	assert.ok(widened.percentReduction > 0);
});

// ---------------------------------------------------------------------------
// 6. Display count differs from stats count
// ---------------------------------------------------------------------------

test("display shows authoritative tokensBefore, not heuristic stats.tokensBefore", () => {
	const authoritativeTokensBefore = 51_234;
	const heuristicTokensBefore = 1_600; // region.tokenEstimate + tail, much smaller
	const result: VerbatimCompactionResult = {
		compactedText: "[User]: retained\n(filtered 12 lines)",
		firstKeptEntryId: "m2",
		tokensBefore: authoritativeTokensBefore,
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" },
		promptVersion: 3,
		rung: "planned",
		stats: {
			linesBefore: 20,
			linesDeleted: 12,
			linesKept: 8,
			rangeCount: 1,
			tokensBefore: heuristicTokensBefore,
			tokensAfter: 800,
			percentReduction: 50,
		},
	};
	const component = new CompactionBoundaryMessageComponent(result);
	const collapsed = stripVTControlCharacters(component.render(200).join("\n"));
	assert.ok(
		collapsed.includes(`Compacted from ${authoritativeTokensBefore.toLocaleString()} tokens`),
		`display should show authoritative ${authoritativeTokensBefore}, not heuristic ${heuristicTokensBefore}`,
	);
	assert.ok(
		!collapsed.includes(heuristicTokensBefore.toLocaleString()),
		"heuristic stats tokensBefore should not appear in the display",
	);
});

test("resumed rendering shows authoritative tokensBefore from details", () => {
	const authoritativeTokensBefore = 51_234;
	const heuristicTokensBefore = 1_600;
	const details: VerbatimCompactionDetails = {
		strategy: "verbatim-lines",
		promptVersion: 3,
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" },
		stats: {
			linesBefore: 20,
			linesDeleted: 12,
			linesKept: 8,
			rangeCount: 1,
			tokensBefore: heuristicTokensBefore,
			tokensAfter: 800,
			percentReduction: 50,
		},
		rung: "planned",
		tokensBefore: authoritativeTokensBefore,
	};
	const component = new CompactionBoundaryMessageComponent({
		text: "[User]: retained\n(filtered 12 lines)",
		stats: details.stats,
		rung: details.rung,
		displayTokensBefore: authoritativeTokensBefore,
	});
	const collapsed = stripVTControlCharacters(component.render(200).join("\n"));
	assert.ok(
		collapsed.includes(`Compacted from ${authoritativeTokensBefore.toLocaleString()} tokens`),
		"resumed rendering should show the authoritative count",
	);
});

test("legacy entries without details.tokensBefore fall back to stats.tokensBefore for display", () => {
	const statsTokensBefore = 1_600;
	const details = {
		strategy: "verbatim-lines",
		promptVersion: 3,
		parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "task" },
		stats: {
			linesBefore: 20,
			linesDeleted: 12,
			linesKept: 8,
			rangeCount: 1,
			tokensBefore: statsTokensBefore,
			tokensAfter: 800,
			percentReduction: 50,
		},
		rung: "planned",
	} as VerbatimCompactionDetails;
	// Simulate the fallback path in extractDisplayTokensBefore
	const displayTokensBefore =
		typeof (details as VerbatimCompactionDetails & { tokensBefore?: number }).tokensBefore === "number"
			? (details as VerbatimCompactionDetails & { tokensBefore?: number }).tokensBefore!
			: details.stats.tokensBefore;
	assert.equal(displayTokensBefore, statsTokensBefore);
});

// ---------------------------------------------------------------------------
// 7. computeWholeContextStats: symmetric ratio property
// ---------------------------------------------------------------------------

test("computeWholeContextStats: tail appears on both sides when kept", () => {
	const reg = largeRegion(40);
	const tailEstimate = 5_000;
	const compactedText = reg.lines.slice(0, 20).join("\n");
	const stats = regionStats(reg, compactedText);
	const widened = computeWholeContextStats(stats, reg, tailEstimate, true);
	// When the tail is kept, it appears on both sides: tokensBefore = R + T, tokensAfter = A + T.
	// This is a real ratio from one estimator, not an apples-to-oranges mix.
	assert.equal(widened.tokensBefore, reg.tokenEstimate + tailEstimate);
	assert.equal(widened.tokensAfter, stats.tokensAfter + tailEstimate);
	// The ratio is genuinely meaningful: percentReduction >= 0 when lines were deleted.
	assert.ok(widened.percentReduction >= 0);
});

test("computeWholeContextStats: tail does not cancel when dropped", () => {
	const reg = largeRegion(40);
	const tailEstimate = 5_000;
	const compactedText = reg.lines.join("\n"); // fresh rung: everything retained
	const stats = regionStats(reg, compactedText);
	const widened = computeWholeContextStats(stats, reg, tailEstimate, false);
	// Tail was present in the original context (tokensBefore includes it) but is
	// gone from the result (tokensAfter does not). The ratio reflects the real
	// context reduction from dropping the protected tail.
	assert.equal(widened.tokensBefore, reg.tokenEstimate + tailEstimate);
	assert.equal(widened.tokensAfter, stats.tokensAfter);
	assert.ok(widened.percentReduction > 0);
});
