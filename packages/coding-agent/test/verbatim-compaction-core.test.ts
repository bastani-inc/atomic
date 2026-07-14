import type { Message } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	createNumberedRegion,
	FILTERED_MARKER_RE,
	filteredMarker,
	numberRegionLines,
	serializeConversationForCompaction,
} from "../src/core/compaction/transcript-serialization.js";
import { reconstructCompactedTranscript, validateDeletedRanges } from "../src/core/compaction/deleted-ranges.js";
import { evictLinesDeterministically } from "../src/core/compaction/deterministic-line-eviction.js";
import type { LineRange, RawLineRange } from "../src/core/compaction/compaction-types.js";

function assistant(content: Extract<Message, { role: "assistant" }>["content"]): Extract<Message, { role: "assistant" }> {
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

	it("numbers lines and detects headers and prior markers", () => {
		const region = createNumberedRegion("[User]: task\nbody\n(filtered 12 lines)\n[Assistant]: done");
		expect(numberRegionLines(region)).toBe(
			"1→[User]: task\n2→body\n3→(filtered 12 lines)\n4→[Assistant]: done",
		);
		expect([...region.headerLineNumbers]).toEqual([1, 4]);
		expect([...region.priorMarkerNs]).toEqual([[3, 12]]);
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

	it("splits ranges around role headers and additional protected lines", () => {
		const region = createNumberedRegion("one\n[User]: task\nthree\nfour\n[Assistant]: ok\nsix", new Set([4]));
		expect([...validateDeletedRanges([{ start: 1, end: 6 }], region)]).toEqual([
			{ start: 1, end: 1 },
			{ start: 3, end: 3 },
			{ start: 6, end: 6 },
		]);
	});

	it("returns an empty branded range list when nothing valid is deletable", () => {
		const region = createNumberedRegion("[User]: task\n[Assistant]: ok");
		expect([...validateDeletedRanges([{ start: 1, end: 2 }, {}], region)]).toEqual([]);
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
				for (const header of region.headerLineNumbers) {
					expect(header < range.start || header > range.end).toBe(true);
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

	it("retains cumulative original-line accounting across two compactions", () => {
		const original = "a\nb\nc\nd\ne\nf\ng\nh";
		const firstRegion = createNumberedRegion(original);
		const first = reconstructCompactedTranscript(firstRegion, validateDeletedRanges([{ start: 2, end: 4 }], firstRegion));
		const secondRegion = createNumberedRegion(first.text);
		const second = reconstructCompactedTranscript(secondRegion, validateDeletedRanges([{ start: 3, end: 4 }], secondRegion));
		expect(expandLineCount(first.text)).toBe(8);
		expect(expandLineCount(second.text)).toBe(8);
	});
});

describe("deterministic line eviction", () => {
	const transcript = [
		"[User]: objective",
		"must remain",
		"old detail one",
		"old detail two",
		"[Assistant]: answer",
		"answer lead",
		"answer detail",
		"[Tool result]: output",
		"latest anchor",
		"bulk one",
		"bulk two",
	].join("\n");

	it("guts section bodies oldest-first and keeps every role header", () => {
		const region = createNumberedRegion(transcript);
		const result = evictLinesDeterministically(region, 39);
		expect(result.ranges[0]).toEqual({ start: 3, end: 4 });
		for (const header of region.headerLineNumbers) {
			expect(result.ranges.every((range: LineRange) => header < range.start || header > range.end)).toBe(true);
		}
		expect(result.text).toContain("must remain");
	});

	it("returns unchanged text when already within budget", () => {
		const region = createNumberedRegion(transcript);
		expect(evictLinesDeterministically(region, region.tokenEstimate).text).toBe(transcript);
	});

	it("throws loudly for non-positive and exhausted budgets", () => {
		const region = createNumberedRegion(transcript);
		expect(() => evictLinesDeterministically(region, 0)).toThrow("nothing more was safely deletable");
		expect(() => evictLinesDeterministically(region, 1)).toThrow(
			/achieved tokensAfter=\d+; budget=1; nothing more was safely deletable/,
		);
	});
});
