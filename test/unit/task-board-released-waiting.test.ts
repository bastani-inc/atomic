import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import { taskPanelState } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import type { TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { renderAgentPanelRows } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import {
	renderBoardRow,
	rowMeta,
	type TaskBoardRow,
	taskBoardCounts,
	taskBoardGroups,
	taskBoardState,
} from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";

beforeAll(() => {
	initTheme("dark");
});

function released(id: string, elapsedMs = 720_000): TaskRecord {
	return {
		...taskRecord(id),
		agentName: "worker",
		metrics: { elapsedMs },
		execution: {
			kind: "settled",
			result: {
				kind: "cancelled",
				cause: "pause",
				released: { waitingOn: [{ toolCallId: "toolu_1", toolName: "bash" }] },
			},
		},
	};
}

function done(id: string): TaskRecord {
	const task = taskRecord(id);
	return { ...task, execution: { kind: "settled", result: { kind: "completed", output: task.output } } };
}

const row = (task: TaskRecord): TaskBoardRow => ({ id: task.ref.taskId, kind: "task", task });

test("/tasks lists a released subagent under Waiting, between Working and Done, not as working", () => {
	const rows = [row(done("d")), row(released("r")), row(taskRecord("w"))];
	assert.equal(taskBoardState(released("r")), "waiting");
	assert.deepEqual(
		taskBoardGroups(rows).map((group) => [group.title, group.rows.map((entry) => entry.id)]),
		[
			["Working", ["w"]],
			["Waiting", ["r"]],
			["Done", ["d"]],
		],
	);
	assert.equal(taskBoardCounts(rows), "1 working · 1 waiting · 1 done");
});

test("a released subagent's row says what it waits on and how long, with a still, dim glyph", () => {
	assert.equal(rowMeta(row(released("r"))), "waiting on bash · 12m");
	const line = stripVTControlCharacters(renderBoardRow(row(released("r")), false, 80));
	assert.match(line, /^ {2}◌ worker/);
	assert.doesNotMatch(line, /∀/);
	assert.match(line, /waiting on bash · 12m$/);
	assert.equal(visibleWidth(line), 80);
	const narrow = stripVTControlCharacters(renderBoardRow(row(released("r")), false, 40));
	assert.equal(visibleWidth(narrow), 40);
	assert.match(narrow, /◌ worker/);
});

test("the agent panel shows a released subagent as waiting, kept among unfinished rows", () => {
	const task = released("r");
	assert.equal(taskPanelState(task), "waiting");
	const style = {
		text: (text: string) => text,
		muted: (text: string) => text,
		dim: (text: string) => text,
		bold: (text: string) => text,
		accent: (text: string) => text,
		success: (text: string) => text,
		error: (text: string) => text,
		warning: (text: string) => text,
		border: (text: string) => text,
	};
	const lines = renderAgentPanelRows(
		[
			{
				id: "task:r",
				kind: "agent",
				state: "waiting",
				name: "worker",
				task: "Task r",
				elapsedMs: 720_000,
				waitingOn: "bash",
			},
		],
		80,
		style,
		{ showMain: false },
	);
	const text = lines.join("\n");
	assert.match(text, /◌ worker/);
	assert.match(text, /waiting on bash · 12m/);
	assert.doesNotMatch(text, /∀/);
});
