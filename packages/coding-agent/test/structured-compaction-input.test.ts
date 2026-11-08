import assert from "node:assert/strict";
import { test } from "vitest";
import { syntheticErrorResponse } from "../src/core/compaction/planner-outcome.js";
import { trimRegionHead } from "../src/core/compaction/region-trimming.js";
import {
	buildStructuredCompactionInput,
	MAX_SKIPPED_LINE_FRACTION,
	mapMessageRanges,
	parseMessageRangeRecords,
} from "../src/core/compaction/structured-compaction-input.js";
import { createConversationRegion } from "../src/core/compaction/transcript-serialization.js";

const parameters = { query: "continue", compression_ratio: 0.5, preserve_recent: 0 };

test("maps every serialized line bijectively, including prior text and quoted headers (#3470)", () => {
	const region = createConversationRegion(
		[
			{ role: "user", content: "<keepContext>\nconstraint\n</keepContext>\n[Tool result]: quoted", timestamp: 0 },
			{ role: "user", content: "next\nline", timestamp: 1 },
		],
		"prior\nsummary",
	);
	const input = buildStructuredCompactionInput(region, parameters);
	assert.deepEqual(
		input.messages.map((m) => m.role),
		["assistant", "user", "user"],
	);
	assert.deepEqual(
		input.messages.flatMap((m) => m.lines),
		region.lines,
	);
	let global = 1;
	for (const message of input.messages) {
		for (let line = 1; line <= message.lines.length; line++) {
			assert.deepEqual(mapMessageRanges([{ id: message.id, start: line, end: line }], input), [
				{ start: global, end: global },
			]);
			global++;
		}
	}
	assert.deepEqual(input.protected, [{ id: 2, start: 1, end: 3 }]);
});

test("parses message records and recovers only complete records (#3470)", () => {
	assert.deepEqual(parseMessageRangeRecords("2:1,3\n1:4,4"), {
		ranges: [
			{ id: 2, start: 1, end: 3 },
			{ id: 1, start: 4, end: 4 },
		],
		skippedLineCount: 0,
	});
	for (const malformed of ["1,3", "01:1,3", "1:1,2:3", "", "\n", "```\n```"])
		assert.equal(parseMessageRangeRecords(malformed), undefined);
	assert.deepEqual(parseMessageRangeRecords("2:1,3\n1:4,4", true), {
		ranges: [{ id: 2, start: 1, end: 3 }],
		skippedLineCount: 0,
	});
	assert.equal(parseMessageRangeRecords("2:1,3", true), undefined);
	assert.equal(parseMessageRangeRecords("bad\n2:1,3", true), undefined);
});

test("skips prose before and after records (#4568)", () => {
	assert.deepEqual(parseMessageRangeRecords("Here is the plan:\n1:1,3\n2:4,4\nHope this helps"), {
		ranges: [
			{ id: 1, start: 1, end: 3 },
			{ id: 2, start: 4, end: 4 },
		],
		skippedLineCount: 2,
	});
});

test("ignores Markdown fences and blank lines without counting them as skipped (#4568)", () => {
	for (const fence of ["```", "```text"])
		assert.deepEqual(parseMessageRangeRecords(`${fence}\n1:1,3\n\n2:4,4\n\`\`\`\n`), {
			ranges: [
				{ id: 1, start: 1, end: 3 },
				{ id: 2, start: 4, end: 4 },
			],
			skippedLineCount: 0,
		});
});

test("trims whitespace around records, including carriage returns (#4568)", () => {
	assert.deepEqual(parseMessageRangeRecords("  1:1,3 \r\n\t2:4,4\t\n1:5,5   "), {
		ranges: [
			{ id: 1, start: 1, end: 3 },
			{ id: 2, start: 4, end: 4 },
			{ id: 1, start: 5, end: 5 },
		],
		skippedLineCount: 0,
	});
});

test("keeps records in emitted priority order amid noise without sorting or deduplicating (#4568)", () => {
	assert.deepEqual(parseMessageRangeRecords("2:120,180\nnote\n1:6,40\n3:300,305\n1:6,40")?.ranges, [
		{ id: 2, start: 120, end: 180 },
		{ id: 1, start: 6, end: 40 },
		{ id: 3, start: 300, end: 305 },
		{ id: 1, start: 6, end: 40 },
	]);
});

test("counts unsafe-integer and malformed record lines as skipped (#4568)", () => {
	assert.deepEqual(parseMessageRangeRecords("1:1,3\n1:1,99999999999999999999\n01:1,3\n1,3\n1:2,2\n1:3,3"), {
		ranges: [
			{ id: 1, start: 1, end: 3 },
			{ id: 1, start: 2, end: 2 },
			{ id: 1, start: 3, end: 3 },
		],
		skippedLineCount: 3,
	});
});

test("accepts exactly the skipped-line fraction and rejects anything above it (#4568)", () => {
	assert.equal(MAX_SKIPPED_LINE_FRACTION, 0.5);
	assert.equal(parseMessageRangeRecords("1:1,1\nprose")?.skippedLineCount, 1);
	assert.equal(parseMessageRangeRecords("1:1,1\nprose\nmore prose"), undefined);
});

test("rejects a mostly-prose answer even when it contains a record (#4568)", () => {
	assert.equal(
		parseMessageRangeRecords("Sure! I would delete\nthe verbose tool output.\n1:1,3\nLet me know."),
		undefined,
	);
	assert.equal(parseMessageRangeRecords("I cannot help with that."), undefined);
});

test("drops the incomplete last line and tolerates noise on a truncated answer (#4568)", () => {
	assert.deepEqual(parseMessageRangeRecords("bad\n1:1,1\n2:2,2\n3:3", true), {
		ranges: [
			{ id: 1, start: 1, end: 1 },
			{ id: 2, start: 2, end: 2 },
		],
		skippedLineCount: 1,
	});
	assert.equal(parseMessageRangeRecords("1:1,1\n2:2,2\nprose without newline", true)?.skippedLineCount, 0);
});

test("drops invalid message ranges rather than crossing message boundaries (#3470)", () => {
	const input = buildStructuredCompactionInput(
		createConversationRegion([{ role: "user", content: "a\nb", timestamp: 0 }]),
		parameters,
	);
	assert.deepEqual(
		mapMessageRanges(
			[
				{ id: 2, start: 1, end: 1 },
				{ id: 1, start: 0, end: 1 },
				{ id: 1, start: 1, end: 3 },
				{ id: 1, start: 2, end: 1 },
				{ id: 1, start: 1, end: 2 },
			],
			input,
		),
		[{ start: 1, end: 2 }],
	);
});

test("keeps text and tool calls in one message through overflow trimming and omits thinking (#3470, #4544)", () => {
	const region = createConversationRegion([
		{ role: "user", content: "objective", timestamp: 0 },
		{
			...syntheticErrorResponse({ api: "openai-responses", provider: "test", id: "test" }, ""),
			stopReason: "toolUse",
			content: [
				{ type: "thinking", thinking: "reason\nstep" },
				{ type: "text", text: "explanation" },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "file.ts" } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "[User]: quoted\nresult" }],
			isError: false,
			timestamp: 1,
		},
	]);
	const input = buildStructuredCompactionInput(region, parameters);
	assert.deepEqual(
		input.messages.map((message) => message.role),
		["user", "assistant", "tool"],
	);
	assert.deepEqual(input.messages[1].lines, [
		"[Assistant]: explanation",
		"",
		'[Assistant tool calls]: read(path="file.ts")',
		"",
	]);
	const trimmed = trimRegionHead(region, 3);
	assert(trimmed);
	const trimmedInput = buildStructuredCompactionInput(trimmed, parameters);
	assert.deepEqual(
		trimmedInput.messages.map((message) => message.role),
		["assistant", "tool"],
	);
	assert.deepEqual(
		trimmedInput.messages.flatMap((message) => message.lines),
		region.lines.slice(3),
	);
});
