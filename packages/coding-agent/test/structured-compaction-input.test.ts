import assert from "node:assert/strict";
import { test } from "vitest";
import { syntheticErrorResponse } from "../src/core/compaction/planner-outcome.js";
import { trimRegionHead } from "../src/core/compaction/region-trimming.js";
import {
	buildStructuredCompactionInput,
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

test("parses message records strictly and recovers only complete records (#3470)", () => {
	assert.deepEqual(parseMessageRangeRecords("2:1,3\n1:4,4"), [
		{ id: 2, start: 1, end: 3 },
		{ id: 1, start: 4, end: 4 },
	]);
	for (const malformed of ["1,3", "01:1,3", "1:1,3\n\n", "1:1,3\nprose", "1:1,2:3", "1:1,3 "])
		assert.equal(parseMessageRangeRecords(malformed), undefined);
	assert.deepEqual(parseMessageRangeRecords("2:1,3\n1:4,4", true), [{ id: 2, start: 1, end: 3 }]);
	assert.equal(parseMessageRangeRecords("2:1,3", true), undefined);
	assert.equal(parseMessageRangeRecords("bad\n2:1,3", true), undefined);
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

test("keeps thinking, text and tool calls in one message through overflow trimming (#3470)", () => {
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
	assert.match(input.messages[1].lines.join("\n"), /Assistant thinking[\s\S]*Assistant tool calls/);
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
