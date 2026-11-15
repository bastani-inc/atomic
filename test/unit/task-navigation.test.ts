import assert from "node:assert/strict";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	TaskNavigation,
	type TaskNavigationActions,
} from "../../packages/coding-agent/src/modes/interactive/components/task-navigation.js";
import { taskRecord } from "../helpers/task-record.js";

function navigation(overrides: Partial<TaskNavigationActions> = {}, now: () => number = Date.now) {
	return new TaskNavigation(
		new KeybindingsManager(),
		{
			inspect() {},
			openChat() {},
			transcript() {},
			armStop() {},
			cancel() {},
			dismiss() {},
			input() {},
			stdinAvailable() {
				return false;
			},
			openQuestion() {},
			...overrides,
		},
		now,
	);
}

// RFC #2884: task controls must not reassign global editor/host shortcuts.
test("list actions are namespaced without stealing global shortcuts (#5224)", () => {
	const keys = new KeybindingsManager();
	assert.deepEqual(keys.getKeys("app.tasks.open"), []);
	assert.deepEqual(keys.getKeys("app.list.open"), ["enter", "right"]);
	assert.deepEqual(keys.getKeys("app.list.stop"), ["x"]);
	assert.deepEqual(keys.getKeys("app.tasks.input"), []);
	assert.deepEqual(keys.getKeys("app.tools.expand"), ["ctrl+o"]);
	assert.deepEqual(keys.getKeys("app.exit"), ["ctrl+d"]);
	assert.deepEqual(keys.getKeys("app.interrupt"), ["escape"]);
});

// RFC #2884: task selection follows identity, never changing execution state.
test("task navigation preserves selection and admission order while yielding to composer and HIL", () => {
	const first = taskRecord("first");
	const second = taskRecord("second");
	const shell = taskRecord("shell", "command");
	let inspected = "";
	let opened = "";
	const nav = navigation({
		inspect(task) {
			inspected = task.ref.taskId;
		},
		openChat(task) {
			opened = task.ref.taskId;
		},
	});
	nav.update([shell, first, second]);
	nav.open();
	assert.equal(nav.selectedTaskId, first.ref.taskId);
	assert.equal(nav.handleInput("\x1b[B", "composer"), false);
	assert.equal(nav.handleInput("\r", "hil"), false);
	assert.equal(nav.handleInput("\x1b[B", "tasks"), true);
	assert.equal(nav.selectedTaskId, second.ref.taskId);
	second.execution = { kind: "settled", result: { kind: "failed", code: "fixture", message: "done" } };
	nav.update([shell, first, second]);
	assert.equal(nav.selectedTaskId, second.ref.taskId);
	// Enter opens the chat; Space peeks at the detail page (#5224).
	assert.equal(nav.handleInput("\r", "tasks"), true);
	assert.equal(opened, second.ref.taskId);
	assert.equal(inspected, "");
	assert.equal(nav.handleInput("\x1b", "tasks"), true);
	assert.equal(nav.handleInput(" ", "tasks"), true);
	assert.equal(inspected, second.ref.taskId);
	assert.equal(nav.focus.kind, "detail");
	assert.equal(nav.handleInput("\x1b", "tasks"), true);
	assert.equal(nav.focus.kind, "tasks");
	for (const key of ["\x0f", "\x04", "\x15", "\x1bOQ"]) assert.equal(nav.handleInput(key, "tasks"), false);
});

// RFC #2884: a stop needs a second press on the same task; another selection starts over.
test("x stops a task only on a second press within three seconds, and dismisses a finished one (#5224)", async () => {
	const first = taskRecord("first");
	const second = taskRecord("second");
	const route = { sessionId: "child", promptId: "question", stageAttemptId: "attempt" };
	first.attention = { kind: "input-needed", requestId: "question", prompt: "", route };
	let clock = 0;
	const armed: string[] = [];
	const cancelled: string[] = [];
	const dismissed: string[] = [];
	const nav = navigation(
		{
			armStop(task) {
				armed.push(task.ref.taskId);
			},
			cancel(task) {
				cancelled.push(task.ref.taskId);
			},
			dismiss(task) {
				dismissed.push(task.ref.taskId);
			},
			openQuestion(actual) {
				assert.equal(actual, route);
			},
			stdinAvailable() {
				return true;
			},
		},
		() => clock,
	);
	nav.update([first, second]);
	nav.open();
	await nav.activate("question");
	assert.equal(nav.handleInput("x", "tasks"), true);
	assert.deepEqual(armed, [first.ref.taskId]);
	assert.deepEqual(cancelled, []);
	// A second press on another task arms that task instead of stopping either.
	nav.open(second.ref.taskId);
	nav.handleInput("x", "tasks");
	assert.deepEqual(cancelled, []);
	clock += 3001;
	nav.handleInput("x", "tasks");
	assert.deepEqual(cancelled, [], "a press after the window starts over");
	clock += 1000;
	nav.handleInput("x", "tasks");
	assert.deepEqual(cancelled, [second.ref.taskId]);
	await nav.activate("input");
	assert.deepEqual({ ...nav.focus }, { kind: "stdin", taskId: second.ref.taskId });
	assert.equal(nav.handleInput("draft", "tasks"), false);
	assert.equal(nav.handleInput("\x1b", "tasks"), true);
	assert.equal(nav.focus.kind, "tasks");
	second.execution = { kind: "settled", result: { kind: "failed", code: "fixture", message: "done" } };
	await nav.activate("input");
	nav.handleInput("x", "tasks");
	assert.equal(nav.focus.kind, "tasks");
	assert.deepEqual(cancelled, [second.ref.taskId]);
	assert.deepEqual(dismissed, [second.ref.taskId]);
});
