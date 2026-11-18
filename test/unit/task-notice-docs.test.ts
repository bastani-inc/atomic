import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { taskCompletionNotice } from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { Sequence } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskCompletionMessage } from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";

const backgroundTasks = readFileSync(
	new URL("../../packages/coding-agent/docs/background-tasks.md", import.meta.url),
	"utf8",
);
const subagents = readFileSync(new URL("../../packages/coding-agent/docs/subagents.md", import.meta.url), "utf8");
const subagentReadme = readFileSync(new URL("../../packages/subagents/README.md", import.meta.url), "utf8");

test("task notice docs describe unshaded lines and quit notices without a model line (#5342)", () => {
	assert.doesNotMatch(
		backgroundTasks,
		/within the card width|Its background covers|same shaded card|still delivers a \*\*stopped\*\* card/,
	);
	assert.doesNotMatch(backgroundTasks, /Agent rows and completion cards show/);
	assert.doesNotMatch(
		subagents,
		/background completion cards retain these settings|remains visible when replaying chat history|This includes stopping the subagent from `\/tasks`/,
	);
	assert.doesNotMatch(subagentReadme, /shaded notification card|confirm with `y`|receives a stopped notification/);
	assert.match(subagentReadme, /unshaded notice line with an outcome glyph and task title/);
	assert.match(subagentReadme, /first result line\. Ctrl\+O expands the full retained result/);
	initTheme("dark");
	const task = { ...taskRecord("quit-docs"), title: "Trace the authentication flow", agentName: "debugger" };
	const notice = taskCompletionNotice(
		{
			completionId: "quit-docs",
			ownerId: task.ref.ownerId,
			taskId: task.ref.taskId,
			terminalSequence: "1" as Sequence,
			result: { kind: "cancelled", cause: "quit" },
			display: false,
		},
		task,
	);
	const [line] = new TaskCompletionMessage(notice, false).render(160).map(stripVTControlCharacters);
	assert.ok(line);
	assert.ok(backgroundTasks.includes(line), `missing rendered quit notice: ${line}`);
});

test("the completion docs show a released subagent's notice with the waiting mark it renders (#5489)", () => {
	initTheme("dark");
	const task = {
		...taskRecord("released-docs"),
		title: "Update docs and changelog",
		agentName: "worker",
		metrics: { elapsedMs: 976_000 },
	};
	const notice = taskCompletionNotice(
		{
			completionId: "released-docs",
			ownerId: task.ref.ownerId,
			taskId: task.ref.taskId,
			terminalSequence: "1" as Sequence,
			result: {
				kind: "cancelled",
				cause: "pause",
				released: { waitingOn: [{ toolCallId: "toolu_01", toolName: "bash" }] },
			},
			display: false,
		},
		task,
	);
	const [line] = new TaskCompletionMessage(notice, false).render(160).map(stripVTControlCharacters);
	assert.equal(line, " ◌ worker is waiting on bash (toolu_01) · 16m 16s");
	assert.ok(backgroundTasks.includes(line), `missing rendered released notice: ${line}`);
	assert.match(subagents, /`◌ <name> is waiting on <tool> \(<call id>\)`/);
});
