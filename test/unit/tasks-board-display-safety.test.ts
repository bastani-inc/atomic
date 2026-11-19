import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import {
	compactTokens,
	renderBoardRow,
	type TaskBoardRow,
} from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import { taskDisplayText } from "../../packages/coding-agent/src/modes/interactive/components/task-row.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

test("task text removes terminal strings and direction overrides before display (#5224)", () => {
	assert.equal(taskDisplayText("Ship\x1b]0;hidden title\x07 it\u202e?\nNow"), "Ship it? Now");
	assert.equal(taskDisplayText("A\x90hidden command\x9cB\x1b[2JC"), "ABC");
	assert.equal(taskDisplayText("A\x1b]unclosed"), "A[unterminated control sequence removed]");
});

test("failed task rows sanitize the failure reason before truncation (#5224)", () => {
	initTheme("dark");
	const row: TaskBoardRow = {
		id: "run:failed",
		kind: "item",
		item: {
			id: "run:failed",
			kind: "agent",
			name: "Build",
			task: "compile",
			state: "failed",
			reason: "failed \x1b]0;hidden title\x07\x1b[2Jbad\u202e",
		},
	};
	const rendered = renderBoardRow(row, false, 120);
	assert.ok(!rendered.includes("\x1b]"));
	assert.ok(!rendered.includes("\x1b[2J"));
	assert.ok(!rendered.includes("\u202e"));
	assert.match(stripVTControlCharacters(rendered), /failed bad/);
});

test("token rounding promotes millions to billions at the display boundary (#5224)", () => {
	assert.equal(compactTokens(999_949_999), "999.9M");
	assert.equal(compactTokens(999_950_000), "1.0B");
	assert.equal(compactTokens(1_500_000_000), "1.5B");
});
