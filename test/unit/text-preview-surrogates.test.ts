import assert from "node:assert/strict";
import { sliceHead } from "@bastani/atomic";
import type { Message } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import {
	summarizeSubagentTask,
	TASK_SUMMARY_LIMIT,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { formatToolCall } from "../../packages/subagents/src/shared/formatters.js";
import { detectSubagentError, extractToolArgsPreview } from "../../packages/subagents/src/shared/utils.js";

const EMOJI = "😀";

/** `count` copies of `char`, then an emoji whose first half is the last unit a cut at `count + 1` would keep. */
function emojiAt(char: string, count: number, after = ""): string {
	return `${char.repeat(count)}${EMOJI}${after}`;
}

function toolResult(toolName: string, text: string | undefined, isError: boolean): Message {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName,
		content: text === undefined ? [] : [{ type: "text", text }],
		isError,
	} as unknown as Message;
}

test("sliceHead keeps at most the given UTF-16 units and backs off before a split pair (#5097)", () => {
	assert.equal(sliceHead("ab😀cd", 3), "ab");
	assert.equal(sliceHead("ab😀cd", 4), "ab😀");
	assert.equal(sliceHead("ab😀cd", 2), "ab");
	assert.equal(sliceHead("abc", 10), "abc");
	assert.equal(sliceHead("abc", 0), "");
});

test("a subagent task summary cut next to an emoji keeps no half of it (#5097)", () => {
	const summary = summarizeSubagentTask(emojiAt("x", TASK_SUMMARY_LIMIT - 2, " and more"));
	assert.ok(summary.isWellFormed(), `lone surrogate in ${JSON.stringify(summary.slice(-4))}`);
	assert.equal(summary, `${"x".repeat(TASK_SUMMARY_LIMIT - 2)}…`);
});

test("a subagent's tool-call line cuts a long command or argument list before a split emoji (#5097)", () => {
	assert.equal(formatToolCall("bash", { command: "c".repeat(60) }), `$ ${"c".repeat(60)}`);
	assert.equal(formatToolCall("bash", { command: emojiAt("c", 59) }), `$ ${"c".repeat(59)}...`);
	assert.equal(formatToolCall("bash", { command: emojiAt("c", 239) }, true), `$ ${"c".repeat(239)}...`);
	assert.equal(formatToolCall("bash", { command: "c".repeat(240) }, true), `$ ${"c".repeat(240)}`);

	const fits = { k: "v".repeat(32) };
	assert.equal(JSON.stringify(fits).length, 40);
	assert.equal(formatToolCall("custom", fits), `custom ${JSON.stringify(fits)}`);
	assert.equal(formatToolCall("custom", { k: emojiAt("v", 33) }), `custom {"k":"${"v".repeat(33)}...`);
	assert.equal(formatToolCall("custom", { k: emojiAt("v", 153) }, true), `custom {"k":"${"v".repeat(153)}...`);
});

test("a subagent's tool-argument preview cuts before a split emoji (#5097)", () => {
	assert.equal(extractToolArgsPreview({ query: "q".repeat(60) }), "q".repeat(60));
	assert.equal(extractToolArgsPreview({ query: emojiAt("q", 56, "zzz") }), `${"q".repeat(56)}...`);
	assert.equal(
		extractToolArgsPreview({ tool: "t", server: "s", args: emojiAt("a", 39, "b") }),
		`s/t ${"a".repeat(39)}`,
	);
	assert.equal(extractToolArgsPreview({ tool: "t", args: "a".repeat(40) }), `t ${"a".repeat(40)}`);
	assert.equal(extractToolArgsPreview({ tool: "t" }), "t");
	assert.equal(extractToolArgsPreview({ tool: "t", args: { a: 1 } }), "t");
});

test("a subagent error's details cut before a split emoji (#5097)", () => {
	assert.deepEqual(detectSubagentError([toolResult("read", emojiAt("e", 199), true)]), {
		hasError: true,
		exitCode: 1,
		errorType: "read",
		details: "e".repeat(199),
	});
	assert.deepEqual(detectSubagentError([toolResult("read", undefined, true)]), {
		hasError: true,
		exitCode: 1,
		errorType: "read",
		details: undefined,
	});
	assert.deepEqual(detectSubagentError([toolResult("bash", `exit code 2 ${emojiAt("o", 187)}`, false)]), {
		hasError: true,
		exitCode: 2,
		errorType: "bash",
		details: `exit code 2 ${"o".repeat(187)}`,
	});
	assert.deepEqual(detectSubagentError([toolResult("bash", `permission denied ${emojiAt("o", 181)}`, false)]), {
		hasError: true,
		exitCode: 1,
		errorType: "bash",
		details: `permission denied ${"o".repeat(181)}`,
	});
});
