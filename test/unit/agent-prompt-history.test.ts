import assert from "node:assert/strict";
import { Editor, type Terminal, TuiMainScreen } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import {
	addMainPromptHistory,
	promptHistoryFor,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-prompt-history.js";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

class QuietTerminal implements Terminal {
	columns = 100;
	rows = 40;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";

beforeAll(() => {
	initTheme("dark");
});

/** The one prompt editor of the screen, with main's history as its session gave it, and what Up shows key by key. */
function prompt(mainPrompts: readonly string[] = ["main one", "main two"]) {
	const editor = new Editor(new TuiMainScreen(new QuietTerminal()), getEditorTheme());
	for (const text of mainPrompts) editor.addToHistory(text);
	/** Press Up `count` times from an empty, idle prompt and collect what each press shows; Down back to the draft. */
	const recall = (count: number): string[] => {
		const shown: string[] = [];
		for (let i = 0; i < count; i++) {
			editor.handleInput(UP);
			shown.push(editor.getText());
		}
		for (let i = 0; i < count; i++) editor.handleInput(DOWN);
		return shown;
	};
	return { editor, history: promptHistoryFor(editor), recall };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("viewing a subagent, Up recalls its own prompts newest first and never main's; back on main, main's are as they were", () => {
	const { editor, history, recall } = prompt();
	history.viewAgent("task-1", ["trace the loader", "resume note"]);
	assert.deepEqual(recall(3), ["resume note", "trace the loader", "trace the loader"]);
	assert.equal(editor.getText(), "");
	history.viewMain();
	assert.deepEqual(recall(3), ["main two", "main one", "main one"]);
});

test("a prompt submitted while viewing a subagent joins its history, not main's, and viewing it again starts from what it was delivered", () => {
	const { editor, history, recall } = prompt();
	history.viewAgent("task-1", ["trace the loader"]);
	editor.addToHistory("typed to the subagent");
	assert.deepEqual(recall(2), ["typed to the subagent", "trace the loader"]);
	history.viewMain();
	assert.deepEqual(recall(2), ["main two", "main one"]);
	editor.addToHistory("typed to main");

	// Still queued when the subagent is viewed again: not among its delivered messages, so not recalled.
	history.viewAgent("task-1", ["trace the loader"]);
	assert.deepEqual(recall(2), ["trace the loader", "trace the loader"]);
	history.viewMain();
	history.viewAgent("task-1", ["trace the loader", "typed to the subagent"]);
	assert.deepEqual(recall(2), ["typed to the subagent", "trace the loader"]);
	history.viewMain();
	assert.deepEqual(recall(3), ["typed to main", "main two", "main one"]);
});

test("switching keeps the prompt's text and cursor, and the same subagent viewed again while viewed keeps what was submitted", () => {
	const { editor, history, recall } = prompt();
	editor.setText("half typed");
	history.viewAgent("task-1", ["trace the loader"]);
	assert.equal(editor.getText(), "half typed");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 10 });
	editor.setText("");
	editor.addToHistory("typed to the subagent");
	history.viewAgent("task-1", ["trace the loader"]);
	assert.deepEqual(recall(2), ["typed to the subagent", "trace the loader"]);
	history.viewAgent("task-2", ["another agent's task"]);
	assert.deepEqual(recall(2), ["another agent's task", "another agent's task"]);
});

test("while a subagent's prompts are read, Up recalls what was submitted meanwhile, which stays newest once they arrive", async () => {
	const { editor, history, recall } = prompt();
	const read = deferred<readonly string[]>();
	history.viewAgent("task-1", read.promise);
	assert.deepEqual(recall(1), [""]);
	editor.addToHistory("sent while reading");
	assert.deepEqual(recall(2), ["sent while reading", "sent while reading"]);
	read.resolve(["trace the loader"]);
	await read.promise;
	await Promise.resolve();
	assert.deepEqual(recall(3), ["sent while reading", "trace the loader", "trace the loader"]);

	// Delivered before the read finished, it is the newest of the agent's prompts too: one entry, not two.
	history.viewMain();
	const again = deferred<readonly string[]>();
	history.viewAgent("task-1", again.promise);
	editor.addToHistory("delivered at once");
	again.resolve(["trace the loader", "delivered at once"]);
	await again.promise;
	await Promise.resolve();
	assert.deepEqual(recall(3), ["delivered at once", "trace the loader", "trace the loader"]);
});

test("a read that arrives after the view moved on is dropped: neither main nor the agent viewed now gets it", async () => {
	const { history, recall } = prompt();
	const late = deferred<readonly string[]>();
	history.viewAgent("task-1", late.promise);
	history.viewAgent("task-2", ["second agent's task"]);
	late.resolve(["first agent's task"]);
	await late.promise;
	await Promise.resolve();
	assert.deepEqual(recall(2), ["second agent's task", "second agent's task"]);

	const later = deferred<readonly string[]>();
	history.viewAgent("task-3", later.promise);
	history.viewMain();
	later.resolve(["third agent's task"]);
	await later.promise;
	await Promise.resolve();
	assert.deepEqual(recall(3), ["main two", "main one", "main one"]);
});

test("a failed read leaves only what was submitted while viewing", async () => {
	const { editor, history, recall } = prompt();
	history.viewAgent("task-1", Promise.reject(new Error("engine lost")));
	editor.addToHistory("sent anyway");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(recall(2), ["sent anyway", "sent anyway"]);
});

test("main's history that a re-render adds while a subagent is viewed waits for main and never reaches the subagent", () => {
	const { editor, history, recall } = prompt();
	addMainPromptHistory(editor, "main three");
	assert.deepEqual(recall(1), ["main three"]);
	history.viewAgent("task-1", ["trace the loader"]);
	addMainPromptHistory(editor, "main four");
	assert.deepEqual(recall(2), ["trace the loader", "trace the loader"]);
	history.viewMain();
	assert.deepEqual(recall(5), ["main four", "main three", "main two", "main one", "main one"]);
});

test("an editor that cannot replace its history keeps one history, as before", () => {
	const added: string[] = [];
	const editor = { addToHistory: (text: string) => added.push(text) };
	const history = promptHistoryFor(editor);
	assert.equal(promptHistoryFor(editor), history);
	history.viewAgent("task-1", ["trace the loader"]);
	addMainPromptHistory(editor, "main one");
	history.viewMain();
	assert.deepEqual(added, ["main one"]);
});
