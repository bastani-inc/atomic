import assert from "node:assert/strict";
import { test } from "vitest";
import type { NumberedRegion } from "../src/core/compaction/compaction-types.js";
import {
	keepTargetForView,
	sliceRegion,
	splitRegionAtMessageBoundary,
	trimRegionHead,
} from "../src/core/compaction/region-trimming.js";
import { buildStructuredCompactionInput } from "../src/core/compaction/structured-compaction-input.js";
import { createNumberedRegion } from "../src/core/compaction/transcript-serialization.js";
import { conversationRegion } from "./compaction-midstream-fixtures.js";

const PARAMETERS = { compression_ratio: 0.5, preserve_recent: 0, query: "continue" };

function withTrackedLines(region: NumberedRegion): NumberedRegion {
	return {
		...region,
		protectedLineNumbers: new Set([2, 6, 7, 14]),
		priorMarkerNs: new Map([
			[3, 40],
			[10, 7],
		]),
	};
}

test("a slice renumbers its lines, spans, headers, markers and protected lines from 1 (#4543)", () => {
	const region = withTrackedLines(conversationRegion(4));
	const part = sliceRegion(region, 3, 10);

	assert.deepEqual(part.lines, region.lines.slice(2, 10));
	assert.deepEqual(part.messageSpans, [
		{ role: "user", start: 1, end: 2 },
		{ role: "assistant", start: 3, end: 6 },
		{ role: "user", start: 7, end: 8 },
	]);
	assert.deepEqual([...part.headerLineNumbers], [3, 7]);
	assert.deepEqual(
		[...part.priorMarkerNs],
		[
			[1, 40],
			[8, 7],
		],
	);
	assert.deepEqual([...(part.protectedLineNumbers ?? [])], [4, 5]);
	assert.equal(part.tokenEstimate, Math.ceil(part.lines.join("\n").length / 4));
	assert.equal(part.__brand, "NumberedRegion");
});

test("a slice keeps a span that overlaps it by a single line at either edge (#4543)", () => {
	const part = sliceRegion(conversationRegion(4), 4, 9);

	assert.deepEqual(part.messageSpans, [
		{ role: "user", start: 1, end: 1 },
		{ role: "assistant", start: 2, end: 5 },
		{ role: "user", start: 6, end: 6 },
	]);
});

test("a slice of a region without message spans or protected lines carries neither (#4543)", () => {
	const region = createNumberedRegion(Array.from({ length: 6 }, (_, index) => `line ${index + 1}`).join("\n"));
	const part = sliceRegion(region, 2, 4);

	assert.deepEqual(part.lines, ["line 2", "line 3", "line 4"]);
	assert.equal("messageSpans" in part, false);
	assert.equal(part.protectedLineNumbers, undefined);
	assert.deepEqual([...part.priorMarkerNs], []);
});

test("withholding the head is a slice that runs to the last line (#4543)", () => {
	const region = withTrackedLines(conversationRegion(4));

	assert.deepEqual(trimRegionHead(region, 5), sliceRegion(region, 6, region.lines.length));
	assert.equal(trimRegionHead(region, 0), undefined);
	assert.equal(trimRegionHead(region, region.lines.length), undefined);
});

test("the keep target is the ratio's share and never fewer than the protected lines (#4543)", () => {
	const region = conversationRegion(4);
	const withProtected = (lines: number[]): NumberedRegion => ({ ...region, protectedLineNumbers: new Set(lines) });

	assert.equal(keepTargetForView(region, 0.5), 8);
	assert.equal(keepTargetForView(region, 0.2), 3);
	assert.equal(keepTargetForView(withProtected([1, 2]), 0.5), 8);
	assert.equal(keepTargetForView(withProtected([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 0.5), 10);
});

test("a region splits at the message boundary nearest its middle (#4543)", () => {
	const region = conversationRegion(8);
	const parts = splitRegionAtMessageBoundary(region);

	assert.ok(parts);
	const [first, second] = parts;
	assert.equal(first.firstLine, 1);
	assert.equal(second.firstLine, 17);
	assert.deepEqual([...first.region.lines, ...second.region.lines], region.lines);
	assert.deepEqual(
		buildStructuredCompactionInput(first.region, PARAMETERS).messages.map((message) => message.id),
		[1, 2, 3, 4],
	);
	assert.deepEqual(
		buildStructuredCompactionInput(second.region, PARAMETERS).messages.map((message) => message.id),
		[1, 2, 3, 4],
	);
});

test("an exact tie splits at the earlier boundary (#4543)", () => {
	const region: NumberedRegion = {
		__brand: "NumberedRegion",
		lines: ["aaaa", "aaaa", "bbbbbbbb", "aaaa", "aaaa"],
		messageSpans: [
			{ role: "user", start: 1, end: 2 },
			{ role: "assistant", start: 3, end: 3 },
			{ role: "user", start: 4, end: 5 },
		],
		headerLineNumbers: new Set<number>(),
		priorMarkerNs: new Map<number, number>(),
		tokenEstimate: 8,
	};
	const parts = splitRegionAtMessageBoundary(region);

	assert.ok(parts);
	assert.equal(parts[1].firstLine, 3);
});

test("the middle is measured in characters, not lines (#4543)", () => {
	const region = conversationRegion(3);
	const longTool = "x".repeat(400);
	const lopsided: NumberedRegion = {
		...region,
		lines: region.lines.map((line, index) => (index === 9 ? longTool : line)),
	};
	const parts = splitRegionAtMessageBoundary(lopsided);

	assert.ok(parts);
	assert.equal(parts[1].firstLine, 9);
});

test("a split keeps protected lines, markers and spans with the part that holds them (#4543)", () => {
	const region = withTrackedLines(conversationRegion(4));
	const parts = splitRegionAtMessageBoundary(region);

	assert.ok(parts);
	const [first, second] = parts;
	assert.equal(second.firstLine, 9);
	assert.deepEqual([...(first.region.protectedLineNumbers ?? [])], [2, 6, 7]);
	assert.deepEqual([...(second.region.protectedLineNumbers ?? [])], [6]);
	assert.deepEqual([...first.region.priorMarkerNs], [[3, 40]]);
	assert.deepEqual([...second.region.priorMarkerNs], [[2, 7]]);
	assert.deepEqual(second.region.messageSpans, [
		{ role: "user", start: 1, end: 4 },
		{ role: "assistant", start: 5, end: 7 },
	]);
	assert.deepEqual(buildStructuredCompactionInput(first.region, PARAMETERS).protected, [
		{ id: 1, start: 2, end: 2 },
		{ id: 2, start: 2, end: 3 },
	]);
});

test("a region holding one message cannot be split (#4543)", () => {
	assert.equal(splitRegionAtMessageBoundary(conversationRegion(1, 12)), undefined);
});

test("a region without recorded spans splits at its role headers (#4543)", () => {
	const lines = ["[User]: a", "a2", "", "[Assistant]: b", "b2", "", "[User]: c", "c2"];
	const parts = splitRegionAtMessageBoundary(createNumberedRegion(lines.join("\n")));

	assert.ok(parts);
	assert.equal(parts[1].firstLine, 4);
	assert.deepEqual(parts[0].region.lines, lines.slice(0, 3));
	assert.deepEqual(parts[1].region.lines, lines.slice(3));
});

test("a region without recorded spans or role headers cannot be split (#4543)", () => {
	const region = createNumberedRegion(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"));

	assert.equal(splitRegionAtMessageBoundary(region), undefined);
});
