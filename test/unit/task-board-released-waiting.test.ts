import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import { taskPanelState } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import {
	supersededReleasedAttempts,
	withoutSupersededAttempts,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
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
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
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
	assert.doesNotMatch(text, /◯/);
});

test("a chat's task footer lists a released subagent as waiting, and counts its running shells", () => {
	const shell = { ...taskRecord("s", "command"), title: "npm run build" };
	const footer = stripVTControlCharacters(renderTaskFooter([released("r"), shell], 80).join("\n"));
	assert.match(footer, /◌ worker .*waiting on bash · 12m/);
	assert.match(footer, /^ {2}1 shell$/m);
	assert.doesNotMatch(footer, /npm run build/);
	assert.doesNotMatch(footer, /◯ worker/);
});

test("a released attempt is superseded by a later attempt of the same subagent, and a re-released latest attempt still waits", () => {
	const first = { ...released("a0"), launchOperationId: "run:0", launchOrdinal: 0 } as TaskRecord;
	const woken = { ...done("a1"), launchOperationId: "run:0:resume:x", launchOrdinal: 1 } as TaskRecord;
	const other = { ...released("b0"), launchOperationId: "run:1", launchOrdinal: 2 } as TaskRecord;
	assert.deepEqual([...supersededReleasedAttempts([first, woken, other])], ["a0"]);
	assert.deepEqual(
		withoutSupersededAttempts([first, woken, other]).map((task) => task.ref.taskId),
		["a1", "b0"],
	);
	const releasedAgain = { ...released("a2"), launchOperationId: "run:0:resume:y", launchOrdinal: 3 } as TaskRecord;
	assert.deepEqual([...supersededReleasedAttempts([first, woken, releasedAgain])], ["a0"]);
	const footer = stripVTControlCharacters(renderTaskFooter([first, woken, releasedAgain], 80).join("\n"));
	assert.equal(footer.match(/waiting on bash/g)?.length, 1);
});

test("with NO_COLOR a waiting row carries no colour codes", () => {
	const saved = process.env.NO_COLOR;
	process.env.NO_COLOR = "1";
	try {
		const raw = renderBoardRow(row(released("r")), false, 80);
		assert.doesNotMatch(raw, /\x1b\[/);
		assert.match(raw, /◌ worker/);
	} finally {
		if (saved === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = saved;
	}
});
