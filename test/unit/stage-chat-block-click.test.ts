import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@bastani/atomic";
import type { TuiMouseEvent } from "@bastani/atomic-tui";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { makeHandle, makeTestTui, setupRun } from "./stage-chat-view-helpers.ts";

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-9;:]*m|\x1b\]8;;[^\x07]*\x07/g, "");
const output = (label: string) => Array.from({ length: 20 }, (_, index) => `${label} line ${index + 1}`).join("\n");

function click(x: number, y: number, width: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
}

for (const width of [80, 160]) {
	test(`in a stage chat a click on a block header expands it, a second click collapses it, and its output does not toggle, at ${width} columns`, () => {
		const store = createStore();
		setupRun(store, "run-1", "stage-a");
		const { handle, emit } = makeHandle();
		const view = new StageChatView({
			store,
			graphTheme: deriveGraphTheme({}),
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			handle,
			onDetach: () => {},
			onClose: () => {},
		});
		const screen = () => view.render(width).map(stripAnsi);
		const rowOf = (pattern: RegExp) => {
			const row = screen().findIndex((line) => pattern.test(line));
			assert.notEqual(row, -1, `no row matches ${pattern}:\n${screen().join("\n")}`);
			return row;
		};
		const expanded = () => screen().some((line) => line.trimEnd().endsWith("stage line 1"));
		try {
			emit({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "stage-cmd" },
			} as AgentSessionEvent);
			emit({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: { content: [{ type: "text", text: output("stage") }] },
				isError: false,
			} as AgentSessionEvent);
			assert.ok(!expanded(), screen().join("\n"));

			const shown = rowOf(/stage line 18$/);
			assert.equal(view.handleMouse(click(8, shown, width)), undefined);
			assert.ok(!expanded(), "a click in a block's output selects, it does not toggle");

			const header = rowOf(/Bash\(stage-cmd\)/);
			assert.equal(view.handleMouse(click(screen()[header]!.indexOf("stage-cmd"), header, width))?.handled, true);
			assert.ok(expanded(), screen().join("\n"));

			const again = rowOf(/Bash\(stage-cmd\)/);
			view.handleMouse(click(screen()[again]!.indexOf("Bash"), again, width));
			assert.ok(!expanded(), screen().join("\n"));
		} finally {
			view.dispose();
		}
	});
}

test("a click on a block header in a paused stage's transcript expands it", () => {
	const store = createStore();
	setupRun(store, "run-1", "stage-a", "paused");
	const { handle, emit } = makeHandle(undefined, [], "paused");
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
	});
	const width = 100;
	const screen = () => view.render(width).map(stripAnsi);
	const expanded = () => screen().some((line) => line.trimEnd().endsWith("stage line 1"));
	try {
		emit({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "bash",
			args: { command: "stage-cmd" },
		} as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "bash",
			result: { content: [{ type: "text", text: output("stage") }] },
			isError: false,
		} as AgentSessionEvent);
		assert.match(screen().join("\n"), /PAUSED/);
		assert.ok(!expanded(), screen().join("\n"));
		const header = screen().findIndex((line) => /Bash\(stage-cmd\)/.test(line));
		assert.notEqual(header, -1, screen().join("\n"));
		assert.equal(view.handleMouse(click(screen()[header]!.indexOf("stage-cmd"), header, width))?.handled, true);
		assert.ok(expanded(), screen().join("\n"));
	} finally {
		view.dispose();
	}
});

/** A stage chat showing one finished bash call, with keys and a terminal so its prompt search and dialogs work. */
function stageWithBlock(store = createStore(), broker?: StageUiBroker) {
	if (broker === undefined) setupRun(store, "run-1", "stage-a");
	const { handle, emit } = makeHandle();
	const keybindings = new KeybindingsManager();
	const view = new StageChatView({
		store,
		graphTheme: deriveGraphTheme({}),
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		handle,
		onDetach: () => {},
		onClose: () => {},
		piTui: makeTestTui(40),
		piTheme: theme,
		piKeybindings: keybindings,
		...(broker ? { stageUiBroker: broker } : {}),
	});
	emit({
		type: "tool_execution_start",
		toolCallId: "t1",
		toolName: "bash",
		args: { command: "stage-cmd" },
	} as AgentSessionEvent);
	emit({
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		result: { content: [{ type: "text", text: output("stage") }] },
		isError: false,
	} as AgentSessionEvent);
	const width = 100;
	const screen = () => view.render(width).map(stripAnsi);
	const expanded = () => screen().some((line) => line.trimEnd().endsWith("stage line 1"));
	const clickHeader = () => {
		const header = screen().findIndex((line) => /Bash\(stage-cmd\)/.test(line));
		assert.notEqual(header, -1, screen().join("\n"));
		return view.handleMouse(click(screen()[header]!.indexOf("stage-cmd"), header, width));
	};
	return { view, store, screen, expanded, clickHeader };
}

test("a click on a block header in a stage chat does nothing while its prompt search owns input", async () => {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const chat = stageWithBlock();
	try {
		chat.view.handleInput("\x12");
		await vi.waitFor(() => assert.match(chat.screen().join("\n"), /Search prompts/));
		assert.equal(chat.clickHeader(), undefined);
		assert.ok(!chat.expanded(), chat.screen().join("\n"));
		assert.match(chat.screen().join("\n"), /Search prompts/, "the search stays open");
	} finally {
		chat.view.dispose();
		setKeybindings(previous);
	}
});

test("a click on a block header in a stage chat does nothing while a dialog the stage opened owns input", async () => {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const broker = new StageUiBroker(store);
	const chat = stageWithBlock(store, broker);
	try {
		void broker.requestCustomUi("run-1", "stage-a", () => ({ render: () => ["STAGE DIALOG"], invalidate: () => {} }));
		await vi.waitFor(() => assert.match(chat.screen().join("\n"), /STAGE DIALOG/));
		assert.match(chat.screen().join("\n"), /Bash\(stage-cmd\)/, "the transcript shows above the dialog");
		assert.equal(chat.clickHeader(), undefined);
		assert.ok(!chat.expanded(), chat.screen().join("\n"));
	} finally {
		chat.view.dispose();
		setKeybindings(previous);
	}
});

test("pressing Ctrl+O twice before the next paint collapses a block a click expanded in a stage chat", () => {
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const chat = stageWithBlock();
	try {
		assert.equal(chat.clickHeader()?.handled, true);
		assert.ok(chat.expanded(), chat.screen().join("\n"));

		chat.view.handleInput("\x0f");
		chat.view.handleInput("\x0f");
		assert.ok(!chat.expanded(), chat.screen().join("\n"));
	} finally {
		chat.view.dispose();
		setKeybindings(previous);
	}
});
