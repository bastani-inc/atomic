import assert from "node:assert/strict";
import { visibleWidth } from "@bastani/atomic-tui";
import { afterEach, test } from "vitest";
import type { TaskHeartbeatDetails } from "../../packages/coding-agent/src/core/tasks/heartbeat-notice.js";
import { CustomMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/custom-message.js";
import { TASK_HEARTBEAT_COLLAPSED_TASKS } from "../../packages/coding-agent/src/modes/interactive/components/task-heartbeat-message.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const MINUTE = 60_000;
const WIDTHS = [40, 80, 120] as const;
/** A background colour, or any box border a card used to draw. */
const BACKGROUND_OR_BORDER = /\x1b\[48;|\x1b\[(?:4[0-7]|10[0-7])m|[╭╮╰╯┌┐└┘]/;

const previousNoColor = process.env.NO_COLOR;
afterEach(() => {
	if (previousNoColor === undefined) delete process.env.NO_COLOR;
	else process.env.NO_COLOR = previousNoColor;
});

function shell(index: number): TaskHeartbeatDetails["tasks"][number] {
	return {
		taskId: `task-shell-${index}`,
		kind: "command",
		title: `npm run build:${index}`,
		elapsedMs: 45 * MINUTE,
		intervalMs: 15 * MINUTE,
		lastActivityAgoMs: 12_000,
		output: { bytes: 4096, tail: [`compiling ${index}/900`] },
	};
}

function details(tasks: number, moreCount = 0): TaskHeartbeatDetails {
	return {
		scheduledAt: Date.UTC(2026, 0, 1, 9, 45),
		tasks: Array.from({ length: tasks }, (_, index) => shell(index + 1)),
		more: Array.from({ length: moreCount }, (_, index) => ({
			taskId: `task-more-${index}`,
			kind: "command" as const,
			title: "tail -f log",
		})),
		moreCount,
	};
}

function taskHeartbeat(value: TaskHeartbeatDetails, expanded: boolean, width: number, outputPad = 1): string[] {
	const component = new CustomMessageComponent(
		{
			role: "custom",
			customType: "task-heartbeat",
			content: "♥ Task heartbeat (shell task-shell-1: npm run build:1) — still running after 45m",
			display: true,
			details: value,
			timestamp: 0,
		},
		undefined,
		undefined,
		outputPad,
	);
	component.setExpanded(expanded);
	return component.render(width);
}

const plain = (lines: readonly string[]) => lines.map(stripVTControlCharacters);

test("a task heartbeat is a notice: one ♥ header row, a ⎿ row per task and the hint under them, with no box", () => {
	initTheme("dark");
	for (const width of WIDTHS) {
		const lines = taskHeartbeat(details(2), false, width);
		assert.equal(lines[0], "", "one blank row before it, like any notice");
		const rows = plain(lines.slice(1));
		assert.match(rows[0] ?? "", /^ ♥ Task heartbeat/);
		if (width >= 80) assert.equal(rows[0], " ♥ Task heartbeat · 2 tasks still running");
		assert.match(rows[1] ?? "", /^ {3}⎿ {2}shell task-shell-1 npm run/);
		assert.match(rows[2] ?? "", /^ {3}⎿ {2}shell task-shell-2/);
		assert.match(rows[3] ?? "", /^ {6}\/tasks to inspect/);
		assert.equal(rows.length, 4, "collapsed: header, one row per task, and the hint");
		for (const line of lines) {
			assert.doesNotMatch(line, BACKGROUND_OR_BORDER);
			assert.ok(visibleWidth(line) <= width);
		}
	}
	if (process.env.NO_COLOR === undefined) {
		const header = taskHeartbeat(details(2), false, 80)[1] ?? "";
		assert.match(header, /\x1b\[[0-9;]*m♥/, "the mark carries its own colour");
	}
});

test("an expanded task heartbeat adds each task's status and last output lines as continuation rows", () => {
	initTheme("dark");
	for (const width of WIDTHS) {
		const rows = plain(taskHeartbeat(details(1), true, width).slice(1));
		assert.match(rows[1] ?? "", /^ {3}⎿ {2}shell task-shell-1/);
		assert.match(rows[2] ?? "", /^ {6}elapsed 45m/);
		assert.ok(
			rows.some((row) => /^ {6}│ compiling 1\/900/.test(row)),
			"output lines continue the task's record",
		);
		assert.match(rows.at(-1) ?? "", /^ {6}\/tasks to inspect$/, "nothing left to expand");
	}
});

test("a collapsed task heartbeat lists a named number of tasks and counts the rest in one row", () => {
	initTheme("dark");
	const rows = plain(taskHeartbeat(details(TASK_HEARTBEAT_COLLAPSED_TASKS + 2, 3), false, 120).slice(1));
	const taskRows = rows.filter((row) => /⎿ {2}shell task-shell-/.test(row));
	assert.equal(taskRows.length, TASK_HEARTBEAT_COLLAPSED_TASKS);
	assert.ok(rows.some((row) => /^ {3}⎿ {2}… \+5 more$/.test(row)));
	assert.match(rows[0] ?? "", /· 10 tasks still running/);
});

test("under NO_COLOR a heartbeat is plain text and keeps its ♥ mark", () => {
	initTheme("dark");
	process.env.NO_COLOR = "1";
	for (const lines of [taskHeartbeat(details(2), false, 80), taskHeartbeat(details(2), true, 80)]) {
		for (const line of lines) assert.doesNotMatch(line, /\x1b/);
		assert.ok(lines.some((line) => line.startsWith(" ♥ ")));
	}
});

test("a heartbeat renders the same rows in every chat; only the output pad differs", () => {
	initTheme("dark");
	const withPad = (lines: readonly string[], pad: number) => plain(lines).map((line) => line.slice(pad));
	assert.deepEqual(
		withPad(taskHeartbeat(details(2), true, 81, 1).slice(1), 1),
		withPad(taskHeartbeat(details(2), true, 80, 0).slice(1), 0),
	);
});
