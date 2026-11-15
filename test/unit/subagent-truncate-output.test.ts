import assert from "node:assert/strict";
import { test } from "vitest";
import {
	INLINE_TASK_OUTPUT_MAX_BYTES,
	retainedTaskOutput,
	retainTaskOutput,
} from "../../packages/subagents/src/runs/foreground/task-output-retention.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";
import { truncateOutput } from "../../packages/subagents/src/shared/types-output.js";

const child: SingleResult = {
	agent: "fake",
	task: "report",
	status: "ok",
	messages: [],
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
};

/** The text after truncateOutput's one-line marker. */
function shownText(text: string): string {
	return text.slice(text.indexOf("]\n") + 2);
}

function assertValidPrefix(shown: string, original: string, budget: number): void {
	assert.ok(shown.isWellFormed(), `lone surrogate in ${JSON.stringify(shown.slice(-8))}`);
	assert.ok(!shown.includes("\uFFFD"), `replacement character in ${JSON.stringify(shown.slice(-8))}`);
	assert.ok(original.startsWith(shown), "truncated text is not a prefix of the original");
	assert.ok(Buffer.byteLength(shown, "utf-8") <= budget, "truncated text exceeds the byte budget");
}

test("truncateOutput never keeps half of an emoji at the byte boundary (#4938)", () => {
	const result = truncateOutput("ab😀cd", { bytes: 5, lines: 100 });
	assert.equal(shownText(result.text), "ab");
	assertValidPrefix(shownText(result.text), "ab😀cd", 5);
});

test("truncateOutput never keeps part of a CJK character at the byte boundary (#4938)", () => {
	const original = "漢字かな交じり文";
	for (let budget = 0; budget < Buffer.byteLength(original); budget++) {
		const shown = shownText(truncateOutput(original, { bytes: budget, lines: 100 }).text);
		assertValidPrefix(shown, original, budget);
		assert.equal(shown, [...original].slice(0, Math.floor(budget / 3)).join(""));
	}
});

test("truncateOutput reports zero lines shown when the line budget is zero (#4938)", () => {
	const result = truncateOutput("one\ntwo\nthree", { bytes: 1000, lines: 0 });
	assert.match(result.text, /^\[TRUNCATED: showing first 0 of 3 lines,/);
	assert.equal(shownText(result.text), "");
});

/** Deterministic PRNG so a failing case reproduces. */
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x0a, 0x0a],
	[0x20, 0x7e],
	[0x80, 0x7ff],
	[0x800, 0xd7ff],
	[0xe000, 0xffff],
	[0x10000, 0x10ffff],
];

function randomUnicode(random: () => number, length: number): string {
	let text = "";
	for (let i = 0; i < length; i++) {
		const [low, high] = CODE_POINT_RANGES[Math.floor(random() * CODE_POINT_RANGES.length)];
		text += String.fromCodePoint(low + Math.floor(random() * (high - low + 1)));
	}
	return text;
}

test("truncateOutput keeps the longest whole-character prefix within both budgets for random Unicode (#4938)", () => {
	const random = mulberry32(4938);
	for (let run = 0; run < 2000; run++) {
		const original = randomUnicode(random, Math.floor(random() * 40));
		const bytes = Math.floor(random() * (Buffer.byteLength(original) + 4));
		const lines = Math.floor(random() * 6);
		const result = truncateOutput(original, { bytes, lines });
		if (!result.truncated) {
			assert.equal(result.text, original);
			continue;
		}
		const shown = shownText(result.text);
		assertValidPrefix(shown, original, bytes);
		const lineCapped = original.split("\n").slice(0, lines).join("\n");
		const next = [...lineCapped.slice(shown.length)][0];
		if (next !== undefined) {
			assert.ok(Buffer.byteLength(shown + next) > bytes, "truncation dropped a character that fits");
		}
		const shownLines = shown === "" ? 0 : shown.split("\n").length;
		assert.ok(result.text.startsWith(`[TRUNCATED: showing first ${shownLines} of `), result.text);
	}
});

test("the retained inline output head never splits a multibyte character (#4938)", () => {
	const owner = `owner-utf8-head-${process.pid}`;
	const text = `${"a".repeat(INLINE_TASK_OUTPUT_MAX_BYTES - 1)}😀 and more`;
	retainTaskOutput(child, text, { ownerId: owner, taskId: "emoji" });
	const head = retainedTaskOutput(owner, "emoji")?.head ?? "";
	assertValidPrefix(head, text, INLINE_TASK_OUTPUT_MAX_BYTES);
	assert.equal(head, "a".repeat(INLINE_TASK_OUTPUT_MAX_BYTES - 1));

	const cjk = "字".repeat(INLINE_TASK_OUTPUT_MAX_BYTES);
	retainTaskOutput(child, cjk, { ownerId: owner, taskId: "cjk" });
	const cjkHead = retainedTaskOutput(owner, "cjk")?.head ?? "";
	assertValidPrefix(cjkHead, cjk, INLINE_TASK_OUTPUT_MAX_BYTES);
	assert.equal(cjkHead.length, Math.floor(INLINE_TASK_OUTPUT_MAX_BYTES / 3));
});
