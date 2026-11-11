import assert from "node:assert/strict";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	TaskNavigation,
	type TaskNavigationActions,
} from "../../packages/coding-agent/src/modes/interactive/components/task-navigation.js";
import { taskRecord } from "../helpers/task-record.js";

function navigation(overrides: Partial<TaskNavigationActions> = {}) {
	return new TaskNavigation(new KeybindingsManager(), {
		inspect() {},
		transcript() {},
		async confirmCancel() {
			return false;
		},
		cancel() {},
		input() {},
		stdinAvailable() {
			return false;
		},
		openQuestion() {},
		...overrides,
	});
}

// RFC #2884: task controls must not reassign global editor/host shortcuts.
test("task actions are namespaced without stealing global shortcuts", () => {
	const keys = new KeybindingsManager();
	assert.deepEqual(keys.getKeys("app.tasks.open"), []);
	assert.deepEqual(keys.getKeys("app.tasks.inspect"), ["enter"]);
	for (const action of ["app.tasks.cancel", "app.tasks.input"] as const) {
		assert.deepEqual(keys.getKeys(action), []);
	}
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
	const nav = navigation({
		inspect(task) {
			inspected = task.ref.taskId;
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
	assert.equal(nav.handleInput("\r", "tasks"), true);
	assert.equal(inspected, second.ref.taskId);
	assert.equal(nav.focus.kind, "detail");
	assert.equal(nav.handleInput("\x1b", "tasks"), true);
	assert.equal(nav.focus.kind, "tasks");
	for (const key of ["\x0f", "\x04", "\x15", "\x1bOQ"]) assert.equal(nav.handleInput(key, "tasks"), false);
});

// RFC #2884: confirmation cannot redirect cancellation after selection changes.
test("actions retain confirmation target, exact PromptRoute and terminal guard", async () => {
	const first = taskRecord("first");
	const second = taskRecord("second");
	const route = { sessionId: "child", promptId: "question", stageAttemptId: "attempt" };
	first.attention = { kind: "input-needed", requestId: "question", prompt: "", route };
	let cancelled = "";
	const nav = navigation({
		async confirmCancel(task) {
			assert.equal(task.ref.taskId, first.ref.taskId);
			nav.open(second.ref.taskId);
			return true;
		},
		cancel(task) {
			cancelled = task.ref.taskId;
		},
		openQuestion(actual) {
			assert.equal(actual, route);
		},
		stdinAvailable() {
			return true;
		},
	});
	nav.update([first, second]);
	nav.open();
	await nav.activate("question");
	await nav.activate("cancel");
	assert.equal(cancelled, first.ref.taskId);
	await nav.activate("input");
	assert.deepEqual({ ...nav.focus }, { kind: "stdin", taskId: second.ref.taskId });
	assert.equal(nav.handleInput("draft", "tasks"), false);
	assert.equal(nav.handleInput("\x1b", "tasks"), true);
	assert.equal(nav.focus.kind, "tasks");
	second.execution = { kind: "settled", result: { kind: "failed", code: "fixture", message: "done" } };
	await nav.activate("input");
	await nav.activate("cancel");
	assert.equal(nav.focus.kind, "tasks");
	assert.equal(cancelled, first.ref.taskId);
});
