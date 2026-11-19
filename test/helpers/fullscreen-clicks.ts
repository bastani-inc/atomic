/**
 * Atomic's fullscreen renderer over a recording terminal, with the production input gate, for tests that click menus
 * and list rows by sending SGR press and release reports as a terminal does.
 */
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Component, Container, Text, type TuiAltScreen, VStack } from "@bastani/atomic-tui";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { shouldHandleFullscreenViewportInput } from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.js";
import { createFullscreenTui } from "../../packages/coding-agent/src/modes/interactive/interactive-tui.js";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";

/** Lets queued promise callbacks, such as an engine reply or an async input handler, run. */
export async function flushClicks(): Promise<void> {
	for (let index = 0; index < 6; index++) await new Promise<void>((resolve) => setImmediate(resolve));
}

const sgr = (button: number, column: number, row: number, final: "M" | "m") =>
	`\x1b[<${button};${column + 1};${row + 1}${final}`;

export interface ClickScreen {
	readonly terminal: RecordingTerminal;
	readonly tui: TuiAltScreen;
	/** What the selection copied, in order. */
	readonly copied: string[];
	/** The screen as text. */
	screen(): string[];
	/** The first row showing `pattern`, after a paint. */
	rowOf(pattern: RegExp | string): number;
	/** The column `text` starts at on `row`. */
	columnOf(row: number, text: string): number;
	/** A press and release on the first cell of `text` in the first row that shows `pattern`. */
	click(pattern: RegExp | string, text?: string): Promise<void>;
	/** A press and release at a cell. */
	clickAt(column: number, row: number): Promise<void>;
	/** Two clicks on one cell, fast enough to count as a double-click. */
	doubleClick(pattern: RegExp | string, text?: string): Promise<void>;
	/** A press on one cell, a drag to another, and the release there. */
	drag(from: { column: number; row: number }, to: { column: number; row: number }): Promise<void>;
	/** One wheel step over a cell. */
	wheel(direction: "up" | "down", column: number, row: number): Promise<void>;
	/** Give the composer keyboard focus while leaving the pane visible for a first click. */
	focusComposer(): void;
	/** Mount `component` as a full-screen overlay and focus it, as full-screen views are shown. */
	mount(component: Component): void;
	/** Show `component` in place of the prompt and focus it, as pickers and dialogs are shown. */
	dock(component: Component): void;
}

export function makeClickScreen(columns = 100, rows = 30): ClickScreen {
	const terminal = new RecordingTerminal();
	terminal.columns = columns;
	terminal.rows = rows;
	const keybindings = new KeybindingsManager();
	const editor = new Text("editor", 0, 0);
	const copied: string[] = [];
	const tui: TuiAltScreen = createFullscreenTui({
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal,
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
		shouldHandleViewportInput: (data, isMouseInput, focusedIsOverlay, focusedIsViewportSearch) =>
			shouldHandleFullscreenViewportInput(
				tui.getFocusedComponent(),
				editor,
				data,
				isMouseInput,
				focusedIsOverlay,
				keybindings,
				focusedIsViewportSearch,
			),
	}) as TuiAltScreen;
	const dock = new Container();
	dock.addChild(editor);
	tui.setLayoutRoot(
		new VStack([
			{ component: new Text("main chat", 0, 0), basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]),
	);
	tui.setFocus(editor);
	tui.start();
	const screen = () => tui.getScreenLines().map((line) => stripVTControlCharacters(line));
	const rowOf = (pattern: RegExp | string) => {
		tui.renderNow();
		const row = screen().findIndex((line) =>
			typeof pattern === "string" ? line.includes(pattern) : pattern.test(line),
		);
		assert.notEqual(row, -1, `no row shows ${pattern}:\n${screen().join("\n")}`);
		return row;
	};
	const columnOf = (row: number, text: string) => {
		const column = screen()[row]?.indexOf(text) ?? -1;
		assert.notEqual(column, -1, `row ${row} has no ${text}:\n${screen().join("\n")}`);
		return column;
	};
	const clickAt = async (column: number, row: number) => {
		terminal.input(sgr(0, column, row, "M"));
		await flushClicks();
		terminal.input(sgr(0, column, row, "m"));
		await flushClicks();
		tui.renderNow();
	};
	const target = (pattern: RegExp | string, text?: string) => {
		const row = rowOf(pattern);
		const label = text ?? (typeof pattern === "string" ? pattern : undefined);
		return { row, column: label === undefined ? 4 : columnOf(row, label) };
	};
	return {
		terminal,
		tui,
		copied,
		screen,
		rowOf,
		columnOf,
		clickAt,
		click: async (pattern, text) => {
			const { row, column } = target(pattern, text);
			await clickAt(column, row);
		},
		doubleClick: async (pattern, text) => {
			const { row, column } = target(pattern, text);
			terminal.input(sgr(0, column, row, "M"));
			terminal.input(sgr(0, column, row, "m"));
			await flushClicks();
			terminal.input(sgr(0, column, row, "M"));
			terminal.input(sgr(0, column, row, "m"));
			await flushClicks();
			tui.renderNow();
		},
		drag: async (from, to) => {
			terminal.input(sgr(0, from.column, from.row, "M"));
			terminal.input(sgr(32, to.column, to.row, "M"));
			terminal.input(sgr(0, to.column, to.row, "m"));
			await flushClicks();
			tui.renderNow();
		},
		wheel: async (direction, column, row) => {
			terminal.input(sgr(direction === "up" ? 64 : 65, column, row, "M"));
			await flushClicks();
			tui.renderNow();
		},
		focusComposer: () => {
			tui.setFocus(editor);
			tui.renderNow();
			assert.equal(tui.getFocusedComponent(), editor);
		},
		mount: (component) => {
			tui.showOverlay(component, { anchor: "top-left", row: 0, col: 0, width: "100%", maxHeight: "100%" });
			tui.setFocus(component);
			tui.renderNow();
		},
		dock: (component) => {
			dock.clear();
			dock.addChild(component);
			tui.setFocus(component);
			tui.renderNow();
		},
	};
}
