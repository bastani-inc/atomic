/**
 * Last-resort removal of protected spans (#4568): only the fresh rung, only when the protected
 * content alone cannot fit, oldest spans first, each replaced by a recall marker.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { runVerbatimCompaction } from "../../packages/coding-agent/src/core/compaction/compaction-runner.js";
import type { NumberedRegion } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import {
	droppedProtectedWarning,
	PROTECTED_DROP_SAFETY_MARGIN_RATIO,
	protectedDropMarker,
	protectedSpanQuote,
} from "../../packages/coding-agent/src/core/compaction/protected-overflow.js";
import {
	createNumberedRegion,
	FILTERED_MARKER_RE,
	ROLE_HEADER_RE,
} from "../../packages/coding-agent/src/core/compaction/transcript-serialization.js";
import { preparation, runRequest, scriptedStream, testModel } from "./compaction-rung-support.js";

const SESSION_ID = "session-4568";
const SPAN_LINES = 3;
const LINE_CHARACTERS = 400;
const FAILING_PLANNER = { default: [{ errorMessage: "429 Too Many Requests" }] };

function filler(count: number, label: string): string[] {
	return Array.from({ length: count }, (_, index) => `${label} unprotected ${index + 1}`);
}

function spanLinesOf(name: string): string[] {
	return Array.from({ length: SPAN_LINES }, (_, index) =>
		`${name} protected ${index + 1} `.padEnd(LINE_CHARACTERS, "x"),
	);
}

interface Layout {
	region: NumberedRegion;
	spans: { name: string; start: number; end: number; lines: string[] }[];
}

/** Unprotected filler between spans, so each span is its own contiguous protected run. */
function layout(names: string[], fillerLines = 6): Layout {
	const lines: string[] = [];
	const protectedLines: number[] = [];
	const spans: Layout["spans"] = [];
	for (const name of names) {
		lines.push(...filler(fillerLines, name));
		const spanLines = spanLinesOf(name);
		const start = lines.length + 1;
		lines.push(...spanLines);
		for (let line = start; line < start + spanLines.length; line++) protectedLines.push(line);
		spans.push({ name, start, end: start + spanLines.length - 1, lines: spanLines });
	}
	lines.push(...filler(fillerLines, "tail"));
	return {
		spans,
		region: {
			__brand: "NumberedRegion",
			lines,
			headerLineNumbers: new Set<number>(),
			priorMarkerNs: new Map<number, number>(),
			protectedLineNumbers: new Set<number>(protectedLines),
			tokenEstimate: Math.ceil(lines.join("\n").length / 4),
		} as NumberedRegion,
	};
}

function spanTokens(spans: Layout["spans"]): number {
	return Math.ceil(spans.flatMap((span) => span.lines).join("\n").length / 4);
}

async function freshRun(built: Layout, contextWindow: number, overrides: { keptTailTokens?: number | null } = {}) {
	const prep = preparation({
		region: built.region,
		keptTailMessageCount: 0,
		keptTailTokens: 0,
		...overrides,
	});
	const stream = scriptedStream(FAILING_PLANNER);
	const result = await runVerbatimCompaction(
		prep,
		testModel({ contextWindow }),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing", sessionId: SESSION_ID }),
	);
	return { result, stream };
}

function markerLines(text: string): string[] {
	return text.split("\n").filter((line) => line.startsWith("[protected block removed"));
}

test("protected spans survive the fresh rung whenever they fit (#4568)", async () => {
	const built = layout(["alpha", "beta", "gamma"]);
	const limit = spanTokens(built.spans) + 500;
	const { result } = await freshRun(built, limit);

	assert.equal(result.rung, "fresh");
	assert.equal(result.droppedProtected, undefined);
	assert.equal("droppedProtected" in result, false);
	for (const span of built.spans) for (const line of span.lines) assert.ok(result.text.includes(line));
	assert.deepEqual(markerLines(result.text), []);
});

test("protected content exactly at the limit is not dropped (#4568)", async () => {
	const built = layout(["alpha", "beta", "gamma"]);
	const probe = await freshRun(built, 1_000_000);
	const exactLimit = probe.result.stats.tokensAfter;
	const { result } = await freshRun(built, exactLimit);

	assert.equal(result.droppedProtected, undefined);
});

test("when protected spans alone exceed the limit the oldest are dropped first and only as many as needed (#4568)", async () => {
	const built = layout(["alpha", "beta", "gamma", "delta"]);
	const limit = Math.floor(spanTokens(built.spans) * 0.8);
	const target = limit - Math.ceil(limit * PROTECTED_DROP_SAFETY_MARGIN_RATIO);
	const { result } = await freshRun(built, limit);

	assert.ok(result.droppedProtected);
	const dropped = result.droppedProtected;
	assert.equal(dropped.count, 2, "two oldest spans are enough");
	assert.deepEqual(
		dropped.ranges,
		built.spans.slice(0, 2).map((span) => ({ start: span.start, end: span.end })),
	);
	assert.equal(dropped.lines, 2 * SPAN_LINES);
	for (const span of built.spans.slice(0, 2))
		for (const line of span.lines) assert.equal(result.text.includes(line), false);
	for (const span of built.spans.slice(2)) for (const line of span.lines) assert.ok(result.text.includes(line));

	assert.ok(result.stats.tokensAfter <= target, "rebuilt context sits inside the safety margin");
	const [lastDropped] = markerLines(result.text).slice(-1);
	const lastSpan = built.spans[1];
	const withLastSpanRestored = result.text.length - lastDropped.length + lastSpan.lines.join("\n").length;
	assert.ok(Math.ceil(withLastSpanRestored / 4) > target, "keeping the second span would not fit, so it had to go");
});

test("a rebuilt context within the margin of the limit still drops until it clears the margin (#4568)", async () => {
	const built = layout(["alpha", "beta"]);
	const probe = await freshRun(built, 1_000_000);
	const limit = probe.result.stats.tokensAfter - 1;
	const { result } = await freshRun(built, limit);

	assert.equal(result.droppedProtected?.count, 1);
	assert.ok(result.stats.tokensAfter <= limit - Math.ceil(limit * PROTECTED_DROP_SAFETY_MARGIN_RATIO));
});

test("every dropped span becomes a one-line marker that says how to recall it (#4568)", async () => {
	const built = layout(["alpha", "beta", "gamma"]);
	const limit = Math.floor(spanTokens(built.spans) * 0.4);
	const { result } = await freshRun(built, limit);

	const markers = markerLines(result.text);
	assert.equal(markers.length, result.droppedProtected?.count);
	assert.ok(markers.length >= 2);
	for (const [index, marker] of markers.entries()) {
		const span = built.spans[index];
		assert.equal(marker.includes("\n"), false);
		assert.match(marker, /protected block removed to fit the context window/);
		assert.match(marker, new RegExp(`${SPAN_LINES} lines`));
		assert.match(marker, /search/);
		assert.ok(marker.includes(`history://sessions/${SESSION_ID}`));
		assert.ok(marker.includes(`"${span.lines[0].replace(/\s+/g, " ").trim().slice(0, 48)}"`));
		assert.match(marker, /read the match with :N-M/);
		assert.equal(FILTERED_MARKER_RE.test(marker), false);
		assert.equal(ROLE_HEADER_RE.test(marker), false);
	}
});

test("a marker is plain content on the next compaction and creates no protection (#4568)", async () => {
	const built = layout(["alpha", "beta"]);
	const { result } = await freshRun(built, Math.floor(spanTokens(built.spans) * 0.4));

	const next = createNumberedRegion(result.text);
	assert.equal(next.protectedLineNumbers?.size ?? 0, 0);
	assert.equal(
		next.priorMarkerNs.size,
		result.text.split("\n").filter((line) => FILTERED_MARKER_RE.test(line)).length,
	);
});

test("result stats and ranges account for the dropped spans (#4568)", async () => {
	const built = layout(["alpha", "beta", "gamma"]);
	const { result } = await freshRun(built, Math.floor(spanTokens(built.spans) * 0.5));
	const dropped = result.droppedProtected;
	assert.ok(dropped);

	const filteredLines = built.region.lines.length - built.spans.length * SPAN_LINES;
	assert.equal(result.stats.linesDeleted, filteredLines + dropped.lines);
	assert.equal(result.stats.linesKept, built.region.lines.length - result.stats.linesDeleted);
	assert.equal(result.stats.rangeCount, result.ranges.length);
	assert.equal(result.stats.tokensAfter, Math.ceil(result.text.length / 4));
	for (const range of dropped.ranges)
		assert.ok(result.ranges.some((r) => r.start === range.start && r.end === range.end));
	for (const range of dropped.ranges)
		assert.equal(
			result.keptRanges.some((kept) => kept.start === range.start),
			false,
		);
	assert.equal(result.keptRanges.length, built.spans.length - dropped.count);
});

test("a span a marker cannot shrink is never dropped (#4568)", async () => {
	const lines = [...filler(6, "head"), "tiny protected", ...filler(6, "mid")];
	const protectedLines = new Set([7]);
	const bigStart = lines.length + 1;
	const big = spanLinesOf("big");
	lines.push(...big);
	for (let line = bigStart; line < bigStart + big.length; line++) protectedLines.add(line);
	const built: Layout = {
		spans: [],
		region: {
			__brand: "NumberedRegion",
			lines,
			headerLineNumbers: new Set<number>(),
			priorMarkerNs: new Map<number, number>(),
			protectedLineNumbers: protectedLines,
			tokenEstimate: Math.ceil(lines.join("\n").length / 4),
		} as NumberedRegion,
	};
	const { result } = await freshRun(built, 150);

	assert.ok(result.text.includes("tiny protected"));
	assert.deepEqual(result.droppedProtected?.ranges, [{ start: bigStart, end: bigStart + big.length - 1 }]);
});

test("the preserve_recent tail counts against the budget without changing the tail decision (#4568)", async () => {
	const built = layout(["alpha", "beta", "gamma"]);
	const limit = spanTokens(built.spans) + 200;
	const withoutTail = await freshRun(built, limit);
	assert.equal(withoutTail.result.droppedProtected, undefined);

	const prep = preparation({ region: built.region, keptTailTokens: 300 });
	const stream = scriptedStream(FAILING_PLANNER);
	const withTail = await runVerbatimCompaction(
		prep,
		testModel({ contextWindow: limit }),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing", sessionId: SESSION_ID }),
	);
	assert.equal(withTail.keptTail, true);
	assert.ok(withTail.droppedProtected);
	assert.ok(withTail.stats.tokensAfter <= limit - Math.ceil(limit * PROTECTED_DROP_SAFETY_MARGIN_RATIO));
});

test("a dropped tail is not counted against the protected budget (#4568)", async () => {
	const built = layout(["alpha", "beta", "gamma"]);
	const limit = spanTokens(built.spans) + 200;
	const prep = preparation({ region: built.region, keptTailTokens: limit + 1 });
	const stream = scriptedStream(FAILING_PLANNER);
	const result = await runVerbatimCompaction(
		prep,
		testModel({ contextWindow: limit }),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing", sessionId: SESSION_ID }),
	);
	assert.equal(result.keptTail, false);
	assert.equal(result.droppedProtected, undefined);
});

test("an unknown hard input limit never drops protected spans (#4568)", async () => {
	const built = layout(["alpha", "beta"]);
	const { result } = await freshRun(built, 0);
	assert.equal(result.droppedProtected, undefined);
});

test("the sub-minimum region fresh path drops spans without calling any planner (#4568)", async () => {
	const lines = [...spanLinesOf("alpha"), "unprotected one", ...spanLinesOf("beta")];
	const protectedLines = new Set([1, 2, 3, 5, 6, 7]);
	const region = {
		__brand: "NumberedRegion",
		lines,
		headerLineNumbers: new Set<number>(),
		priorMarkerNs: new Map<number, number>(),
		protectedLineNumbers: protectedLines,
		tokenEstimate: Math.ceil(lines.join("\n").length / 4),
	} as NumberedRegion;
	const stream = scriptedStream(FAILING_PLANNER);
	const result = await runVerbatimCompaction(
		preparation({ region, keptTailMessageCount: 0, keptTailTokens: 0 }),
		testModel({ contextWindow: 500 }),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing", sessionId: SESSION_ID }),
	);

	assert.equal(stream.calls.length, 0);
	assert.equal(result.rung, "fresh");
	assert.equal(result.droppedProtected?.count, 1);
	assert.deepEqual(result.droppedProtected?.ranges, [{ start: 1, end: 3 }]);
	assert.ok(result.text.includes(lines[4]));
});

test("the planner path never drops protected lines even when they exceed the limit (#4568)", async () => {
	const built = layout(["alpha", "beta", "gamma"]);
	const prep = preparation({ region: built.region, keptTailMessageCount: 0, keptTailTokens: 0 });
	const stream = scriptedStream({ default: [{ text: `1,${built.region.lines.length}\n` }] });
	const result = await runVerbatimCompaction(
		prep,
		testModel({ contextWindow: Math.floor(spanTokens(built.spans) * 0.3) }),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing", sessionId: SESSION_ID }),
	);

	assert.equal(result.rung, "planned");
	assert.equal(result.droppedProtected, undefined);
	for (const span of built.spans) for (const line of span.lines) assert.ok(result.text.includes(line));
	assert.deepEqual(markerLines(result.text), []);
});

test("quote comes from the first content line, not the keepContext tag (#4568)", () => {
	assert.equal(
		protectedSpanQuote(["[User]: <keepContext>", "Decision: ship the v2 API", "more", "</keepContext>"]),
		"Decision: ship the v2 API",
	);
	assert.equal(protectedSpanQuote(["[User]: <keepContext>", "</keepContext>"]), "<keepContext>");
	assert.equal(protectedSpanQuote(["[Assistant]: spoken text", "x"]), "spoken text");
	assert.equal(protectedSpanQuote(["   ", ""]), "");
	assert.equal(protectedSpanQuote([`${"y".repeat(100)}`]).length, 48);
});

test("marker wording: singular line, regex escaping, optional history range (#4568)", () => {
	const single = protectedDropMarker({ lineCount: 1, quote: "a.b (c)", sessionId: "s1" });
	assert.match(single, /: 1 line;/);
	assert.ok(single.includes('search on history://sessions/s1 for "a\\.b \\(c\\)"'));

	const ranged = protectedDropMarker({
		lineCount: 4,
		quote: "q",
		sessionId: "s1",
		historyRange: { start: 10, end: 13 },
	});
	assert.ok(ranged.includes("read history://sessions/s1:10-13"));

	const anonymous = protectedDropMarker({ lineCount: 2, quote: "q" });
	assert.ok(anonymous.includes("this session's history"));
	assert.equal(anonymous.includes("history://"), false);
});

test("the user warning names the count and lines (#4568)", () => {
	const message = droppedProtectedWarning({ count: 2, lines: 9, ranges: [] });
	assert.match(message, /2 protected blocks \(9 lines\)/);
	assert.match(droppedProtectedWarning({ count: 1, lines: 1, ranges: [] }), /1 protected block \(1 line\)/);
});
