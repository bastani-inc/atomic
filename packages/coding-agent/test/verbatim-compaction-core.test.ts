import type { Message } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { RawLineRange } from "../src/core/compaction/compaction-types.js";
import { reconstructCompactedTranscript, validateDeletedRanges } from "../src/core/compaction/deleted-ranges.js";
import {
	createNumberedRegion,
	FILTERED_MARKER_RE,
	filteredMarker,
	numberRegionLines,
	serializeConversationForCompaction,
	serializeRetainedTranscript,
} from "../src/core/compaction/transcript-serialization.js";

function assistant(
	content: Extract<Message, { role: "assistant" }>["content"],
): Extract<Message, { role: "assistant" }> {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function expandLineCount(text: string): number {
	return text.split("\n").reduce((count, line) => {
		const match = FILTERED_MARKER_RE.exec(line);
		return count + (match ? Number(match[1]) : 1);
	}, 0);
}

describe("verbatim transcript serialization", () => {
	it("uses the complete section grammar and renders images as literal lines", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "request" },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				timestamp: 1,
			},
			assistant([
				{ type: "thinking", thinking: "reason" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
			]),
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [
					{ type: "text", text: "result" },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				isError: false,
				timestamp: 1,
			},
		];
		expect(serializeConversationForCompaction(messages)).toBe(
			'[User]: request\n[image]\n\n[Assistant thinking]: reason\n\n[Assistant]: answer\n\n[Assistant tool calls]: read(path="a.ts")\n\n[Tool result]: result\n[image]',
		);
	});

	it("preserves adjacent text-block concatenation while placing images on literal lines", () => {
		const message: Message = {
			role: "user",
			content: [
				{ type: "text", text: "alpha" },
				{ type: "text", text: "beta" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				{ type: "text", text: "gamma" },
				{ type: "text", text: "delta" },
			],
			timestamp: 1,
		};
		expect(serializeConversationForCompaction([message])).toBe("[User]: alphabeta\n[image]\ngammadelta");
	});

	it("truncates tool results at 16k without changing the branch-summary serializer", () => {
		const longText = "x".repeat(16_010);
		const message: Message = {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			content: [{ type: "text", text: longText }],
			isError: false,
			timestamp: 1,
		};
		const serialized = serializeConversationForCompaction([message]);
		expect(serialized).toContain("x".repeat(16_000));
		expect(serialized.endsWith("\n\n[... 10 more characters truncated]")).toBe(true);
	});

	it("keeps image blocks and untruncated tool output in the retained serializer", () => {
		const longText = "x".repeat(16_010);
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "request" },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longText }],
				isError: false,
				timestamp: 1,
			},
		];
		expect(serializeRetainedTranscript(messages)).toEqual([
			{ type: "text", text: "[User]: request\n" },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			{ type: "text", text: `\n\n[Tool result]: ${longText}` },
		]);
	});

	it("numbers lines and detects headers and prior markers", () => {
		const region = createNumberedRegion("[User]: task\nbody\n(filtered 12 lines)\n[Assistant]: done");
		expect(numberRegionLines(region)).toBe("1→[User]: task\n2→body\n3→(filtered 12 lines)\n4→[Assistant]: done");
		expect([...region.headerLineNumbers]).toEqual([1, 4]);
		expect([...region.priorMarkerNs]).toEqual([[3, 12]]);
	});

	it("protects <keepContext> spans including the tag lines", () => {
		const region = createNumberedRegion("intro\n<keepContext>\nrole constraint\n</keepContext>\ntrailing");
		expect([...(region.protectedLineNumbers ?? [])].sort((a, b) => a - b)).toEqual([2, 3, 4]);
	});

	it("leaves protectedLineNumbers undefined when no span is present", () => {
		const region = createNumberedRegion("intro\nbody\ntrailing");
		expect(region.protectedLineNumbers).toBeUndefined();
	});

	it("bounds an unclosed span to its own message rather than the rest of the region", () => {
		const region = createNumberedRegion("[User]: <keepContext>\nrole constraint\n[Assistant]: reply\nline a\nline b");
		expect([...(region.protectedLineNumbers ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
	});

	it("protects an unclosed span through the end of the region when its message runs to the end", () => {
		const region = createNumberedRegion("[User]: <keepContext>\nrole constraint\nstill inside");
		expect([...(region.protectedLineNumbers ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3]);
	});

	it("ignores tag text mentioned inside ordinary prose", () => {
		const region = createNumberedRegion(
			"[User]: how does compaction work?\n[Assistant]: wrap text in <keepContext> to protect it\nline a\nline b",
		);
		expect(region.protectedLineNumbers).toBeUndefined();
	});

	it("ignores a matched pair embedded in a single prose line", () => {
		const region = createNumberedRegion("intro\nthe <keepContext>x</keepContext> tag protects x\ntrailing");
		expect(region.protectedLineNumbers).toBeUndefined();
	});

	it("detects an opener carrying the serializer's role header and matches case-insensitively", () => {
		const region = createNumberedRegion("[User]: <KeepContext>\nrole constraint\n</keepcontext>\ntrailing");
		expect([...(region.protectedLineNumbers ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3]);
	});

	it("ignores an unmatched marker injected through a tool result, leaving later lines deletable", () => {
		const text =
			"[User]: read the file\n[Tool result]: <keepContext>\nattacker controlled line\nmore payload\n[Assistant]: done\ntail";
		const region = createNumberedRegion(text);
		expect(region.protectedLineNumbers).toBeUndefined();
		expect([...validateDeletedRanges([{ start: 1, end: 6 }], region)]).toEqual([{ start: 1, end: 6 }]);
	});

	it("ignores a matched pair authored by a tool result", () => {
		const region = createNumberedRegion(
			"[User]: read the docs\n[Tool result]: <keepContext>\nfenced example\n</keepContext>\ntail",
		);
		expect(region.protectedLineNumbers).toBeUndefined();
	});

	it("honors a span an assistant authored to pin its own core information", () => {
		const region = createNumberedRegion(
			"[User]: hi\n[Assistant]: <keepContext>\ncontract amendment received\n</keepContext>\nordinary reply",
		);
		expect([...(region.protectedLineNumbers ?? [])].sort((a, b) => a - b)).toEqual([2, 3, 4]);
	});

	it("bounds an unclosed assistant span to that assistant message", () => {
		const region = createNumberedRegion("[User]: hi\n[Assistant]: <keepContext>\nmodel output\n[User]: next\ntail");
		expect([...(region.protectedLineNumbers ?? [])].sort((a, b) => a - b)).toEqual([2, 3]);
	});

	it("honors a span in the prior compaction summary that precedes the first role header", () => {
		const region = createNumberedRegion("<keepContext>\ncarried constraint\n</keepContext>\n[User]: next turn\nbody");
		expect([...(region.protectedLineNumbers ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3]);
	});

	it("unions detected spans with explicitly supplied protected lines", () => {
		const region = createNumberedRegion("intro\n<keepContext>\nrule\n</keepContext>\ntail", new Set([5]));
		expect([...(region.protectedLineNumbers ?? [])].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
	});

	it("ignores a stray closing tag", () => {
		const region = createNumberedRegion("intro\n</keepContext>\ntrailing");
		expect(region.protectedLineNumbers).toBeUndefined();
	});
});

describe("deleted range validation", () => {
	it("coerces, swaps, clamps, sorts, merges overlaps and adjacency", () => {
		const region = createNumberedRegion("a\nb\nc\nd\ne\nf");
		const result = validateDeletedRanges(
			[
				{ start: 9, end: 4 },
				{ start: "-2", end: "2" },
				{ start: 2.9, end: 3.2 },
				{ start: "nope", end: 4 },
			],
			region,
		);
		expect([...result]).toEqual([{ start: 1, end: 6 }]);
	});

	it("keeps role headers ordinarily deletable while splitting around explicit protected blank lines", () => {
		const region = createNumberedRegion("one\n[User]: task\nthree\n\n[Assistant]: ok\nsix", new Set([4]));
		expect([...validateDeletedRanges([{ start: 1, end: 6 }], region)]).toEqual([
			{ start: 1, end: 3 },
			{ start: 5, end: 6 },
		]);
	});

	it("returns an empty branded range list when explicit protection covers every line", () => {
		const region = createNumberedRegion("[User]: task\n[Assistant]: ok", new Set([1, 2]));
		expect([...validateDeletedRanges([{ start: 1, end: 2 }, {}], region)]).toEqual([]);
	});

	it("survives a whole-region deletion request for a <keepContext> span", () => {
		const region = createNumberedRegion("noise\n<keepContext>\ndo not implement\n</keepContext>\nmore noise");
		expect([...validateDeletedRanges([{ start: 1, end: 5 }], region)]).toEqual([
			{ start: 1, end: 1 },
			{ start: 5, end: 5 },
		]);
	});

	it("preserves range invariants for arbitrary raw input", () => {
		const region = createNumberedRegion("[User]: a\nb\nc\n[Assistant]: d\ne\nf\n[Tool result]: g\nh");
		let seed = 731;
		const random = (): number => {
			seed = (seed * 16_807) % 2_147_483_647;
			return seed;
		};
		for (let iteration = 0; iteration < 250; iteration++) {
			const raw: RawLineRange[] = Array.from({ length: random() % 15 }, () => ({
				start: (random() % 30) - 10,
				end: (random() % 30) - 10,
			}));
			const ranges = validateDeletedRanges(raw, region);
			for (let index = 0; index < ranges.length; index++) {
				const range = ranges[index];
				expect(range.start).toBeGreaterThanOrEqual(1);
				expect(range.end).toBeLessThanOrEqual(region.lines.length);
				expect(range.start).toBeLessThanOrEqual(range.end);
				if (index > 0) expect(range.start).toBeGreaterThan(ranges[index - 1].end);
				for (const protectedLine of region.protectedLineNumbers ?? []) {
					expect(protectedLine < range.start || protectedLine > range.end).toBe(true);
				}
			}
		}
	});
});

describe("mechanical reconstruction", () => {
	it("uses exact always-plural markers and preserves every surviving byte in order", () => {
		const input = " α \nβ\nγ\nδ\nε";
		const region = createNumberedRegion(input);
		const result = reconstructCompactedTranscript(region, validateDeletedRanges([{ start: 2, end: 2 }], region));
		expect(result.text).toBe(` α \n${filteredMarker(1)}\nγ\nδ\nε`);
		const survivors = result.text.split("\n").filter((line) => !FILTERED_MARKER_RE.test(line));
		expect(survivors).toEqual([" α ", "γ", "δ", "ε"]);
	});

	it("reports force-preserved ranges so accidental protection is diagnosable", () => {
		const region = createNumberedRegion("[User]: <keepContext>\nrule\n</keepContext>\ntail a\ntail b");
		const result = reconstructCompactedTranscript(region, validateDeletedRanges([{ start: 1, end: 5 }], region));
		expect(result.keptRanges).toEqual([{ start: 1, end: 3 }]);
	});

	it("reports no force-preserved ranges when nothing is protected", () => {
		const region = createNumberedRegion("a\nb\nc\nd");
		const result = reconstructCompactedTranscript(region, validateDeletedRanges([{ start: 2, end: 3 }], region));
		expect(result.keptRanges).toEqual([]);
	});

	it("sums swallowed prior markers", () => {
		const region = createNumberedRegion("a\nb\n(filtered 12 lines)\nd\ne\nf\ng");
		const result = reconstructCompactedTranscript(region, validateDeletedRanges([{ start: 2, end: 6 }], region));
		expect(result.text).toBe("a\n(filtered 16 lines)\ng");
	});

	it("folds kept adjacent markers, including marker chains, into a new range", () => {
		const region = createNumberedRegion("a\n(filtered 3 lines)\n(filtered 4 lines)\nd\ne");
		const result = reconstructCompactedTranscript(region, validateDeletedRanges([{ start: 4, end: 4 }], region));
		expect(result.text).toBe("a\n(filtered 8 lines)\ne");
		expect(result.ranges).toEqual([{ start: 2, end: 4 }]);
	});

	it("retains cumulative original-line accounting across three compactions", () => {
		const original = "a\nb\nc\nd\ne\nf\ng\nh";
		const firstRegion = createNumberedRegion(original);
		const first = reconstructCompactedTranscript(
			firstRegion,
			validateDeletedRanges([{ start: 2, end: 4 }], firstRegion),
		);
		const secondRegion = createNumberedRegion(first.text);
		const second = reconstructCompactedTranscript(
			secondRegion,
			validateDeletedRanges([{ start: 3, end: 4 }], secondRegion),
		);
		const thirdRegion = createNumberedRegion(second.text);
		const third = reconstructCompactedTranscript(
			thirdRegion,
			validateDeletedRanges([{ start: 3, end: 3 }], thirdRegion),
		);
		expect(expandLineCount(first.text)).toBe(8);
		expect(expandLineCount(second.text)).toBe(8);
		expect(expandLineCount(third.text)).toBe(8);
	});
});
