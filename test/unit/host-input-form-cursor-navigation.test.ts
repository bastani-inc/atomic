import assert from "node:assert/strict";
import { Editor, type Terminal, TuiMainScreen } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { HostInputFormComponent } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form.js";
import { getEditorTheme, initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

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

beforeAll(() => {
	initTheme("dark");
});

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const HOME = "\x01";
const END = "\x05";
const WORD_LEFT = "\x1bb";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

function createForm(initialValue: string) {
	const tui = new TuiMainScreen(new QuietTerminal());
	const component = new HostInputFormComponent(
		tui,
		theme,
		new KeybindingsManager(),
		{
			title: "demo",
			fields: [
				{ name: "f", type: "text", initialValue },
				{ name: "g", type: "string", initialValue: "" },
			],
		},
		{ onSubmit: () => {}, onCancel: () => {} },
	);
	const editor = (Reflect.get(component, "editors") as Editor[])[0]!;
	const state = Reflect.get(editor, "state") as EditorState;
	return { tui, component, editor, state };
}

function isControl(code: number): boolean {
	return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function displayOracle(line: string): { display: string; displayCols: number[]; rawOffsets: number[] } {
	let out = "";
	let col = 0;
	const displayCols = [0];
	const rawOffsets = [0];
	for (const ch of line) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "\n") {
			out += " ";
			col = 0;
		} else if (ch === "\t") {
			const pad = 4 - (col % 4);
			out += " ".repeat(pad);
			col += pad;
		} else if (isControl(code)) {
			const escaped = `\\x${code.toString(16).padStart(2, "0")}`;
			out += escaped;
			col += escaped.length;
		} else {
			out += ch;
			col += 1;
		}
		displayCols.push(out.length);
		rawOffsets.push(rawOffsets[rawOffsets.length - 1]! + ch.length);
	}
	return { display: out, displayCols, rawOffsets };
}

function nearestRawOffset(line: string, displayCol: number): number {
	const { displayCols, rawOffsets } = displayOracle(line);
	let best = 0;
	for (let index = 1; index < displayCols.length; index++) {
		if (Math.abs(displayCol - displayCols[index]!) < Math.abs(displayCol - displayCols[best]!)) best = index;
	}
	return rawOffsets[best]!;
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

function countedRestoreVisits(n: number): { visits: number; restored: number; moved: number } {
	const line = "a".repeat(n);
	const { component, editor, state } = createForm(`${line}\n${"x".repeat(n)}`);
	component.render(20000);
	state.cursorLine = 1;
	state.cursorCol = n;
	const original = editor.handleInput.bind(editor);
	let visits = 0;
	let counting = false;
	const proto = String.prototype as unknown as Record<symbol, unknown>;
	const nativeIterator = proto[Symbol.iterator] as (this: string) => Iterator<string>;
	let moved = -1;
	editor.handleInput = (data: string) => {
		original(data);
		moved = (Reflect.get(editor, "state") as EditorState).cursorCol;
		counting = true;
	};
	proto[Symbol.iterator] = function (this: string) {
		const iterator = nativeIterator.call(this);
		return {
			next(): IteratorResult<string> {
				const step = iterator.next();
				if (counting && !step.done) visits++;
				return step;
			},
			[Symbol.iterator]() {
				return this;
			},
		};
	};
	try {
		component.handleInput(UP);
	} finally {
		proto[Symbol.iterator] = nativeIterator;
	}
	return { visits, restored: editor.getCursor().col, moved };
}

test("vertical cursor restoration scans the target line once in linear time (#5224)", () => {
	for (const n of [50, 100, 200, 400]) {
		const result = countedRestoreVisits(n);
		assert.equal(result.moved, n);
		assert.equal(result.restored, n);
		assert.equal(result.visits, n, `expected ${n} character visits for n=${n}, got ${result.visits}`);
	}
});

test("vertical cursor movement progresses across escaped characters before leaving the text field (#5224)", () => {
	for (const initial of ["\x01\x01\x01\x01", "\t\t\t\t", "\x9b\x9b\x9b\x9b"]) {
		for (const width of [8, 9, 10]) {
			const { component, editor } = createForm(initial);
			component.render(width);
			component.handleInput(UP);
			assert.equal(editor.getCursor().col, 3);
			assert.equal(Reflect.get(component, "focusedIndex"), 0);

			component.render(width);
			component.handleInput(UP);
			assert.equal(editor.getCursor().col, 2);
			assert.equal(Reflect.get(component, "focusedIndex"), 0);

			component.render(width);
			component.handleInput(DOWN);
			assert.equal(editor.getCursor().col, 3);
			assert.equal(Reflect.get(component, "focusedIndex"), 0);

			component.render(width);
			component.handleInput(DOWN);
			assert.equal(editor.getCursor().col, 4);
			assert.equal(Reflect.get(component, "focusedIndex"), 0);

			component.render(width);
			component.handleInput(DOWN);
			assert.equal(editor.getCursor().col, 4);
			assert.equal(Reflect.get(component, "focusedIndex"), 1);
		}
	}
});

test("PageUp and PageDown navigate wrapped escaped and tab-expanded text using displayed rows (#5224)", () => {
	for (const unit of ["\x01", "\t"]) {
		const initial = unit.repeat(600);
		const { component, editor } = createForm(initial);
		component.render(60);
		const layoutWidth = Reflect.get(editor, "lastWidth") as number;
		const displayedRow = (): number => {
			const cursor = editor.getCursor();
			return Math.floor(displayOracle(initial.slice(0, cursor.col)).display.length / layoutWidth);
		};
		const startRow = displayedRow();
		assert.equal(startRow, 45);

		component.handleInput(PAGE_UP);
		const afterFirstUp = displayedRow();
		assert.equal(startRow - afterFirstUp, 12);

		component.handleInput(PAGE_UP);
		const afterSecondUp = displayedRow();
		assert.equal(afterFirstUp - afterSecondUp, 12);

		component.handleInput(PAGE_DOWN);
		const afterDown = displayedRow();
		assert.equal(afterDown - afterSecondUp, 12);
		assert.equal(Reflect.get(component, "focusedIndex"), 0);
	}
});

test("differential vertical navigation matches display-line editor movement and nearest raw boundaries (#5224)", () => {
	const tokens = [
		"a",
		"b",
		" ",
		"\t",
		"\x01",
		"\x1b",
		"\x7f",
		"\x85",
		"\x9b",
		"\r",
		"😀",
		"漢",
		"e\u0301",
		"👨‍👩‍👧",
		"\u200d",
		"\ud800",
	];
	const randBoundary = seededRandom(4242);
	let ties = 0;
	for (let trial = 0; trial < 200; trial++) {
		const length = Math.floor(randBoundary() * 9);
		let line = "";
		for (let i = 0; i < length; i++) line += tokens[Math.floor(randBoundary() * tokens.length)]!;
		const { display, displayCols } = displayOracle(line);
		const totalDisplay = display.length;
		for (let targetCol = 0; targetCol <= totalDisplay + 2; targetCol++) {
			const { component, editor, state } = createForm(`${line}\n${"x".repeat(targetCol)}`);
			component.render(400);
			state.cursorLine = 1;
			state.cursorCol = targetCol;
			let movedCol = -1;
			const original = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				original(data);
				movedCol = (Reflect.get(editor, "state") as EditorState).cursorCol;
			};
			component.handleInput(UP);
			const cursor = editor.getCursor();
			assert.equal(cursor.line, 0);
			assert.equal(cursor.col, nearestRawOffset(line, movedCol));
			const low = line.charCodeAt(cursor.col);
			const high = line.charCodeAt(cursor.col - 1);
			assert.ok(!(low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff));
			const left = displayCols.filter((v) => v <= movedCol).pop();
			const right = displayCols.find((v) => v > movedCol);
			if (left !== undefined && right !== undefined && movedCol - left === right - movedCol) ties++;
		}
	}
	assert.ok(ties > 0);

	const randTrajectory = seededRandom(5245);
	const widths = [4, 5, 6, 8, 10, 12, 16, 24, 40, 80];
	const ops = [UP, UP, DOWN, DOWN, LEFT, RIGHT, HOME, END, WORD_LEFT];
	for (let scenario = 0; scenario < 300; scenario++) {
		const lineCount = 1 + Math.floor(randTrajectory() * 3);
		const rawLines: string[] = [];
		for (let i = 0; i < lineCount; i++) {
			const len = Math.floor(randTrajectory() * (randTrajectory() < 0.2 ? 40 : 12));
			let text = "";
			for (let j = 0; j < len; j++) text += tokens[Math.floor(randTrajectory() * tokens.length)]!;
			rawLines.push(text);
		}
		const initial = rawLines.join("\n");
		const width = widths[Math.floor(randTrajectory() * widths.length)]!;
		const { tui, component, editor, state } = createForm(initial);
		let changed = false;
		const originalOnChange = editor.onChange;
		editor.onChange = (text: string) => {
			changed = true;
			originalOnChange?.(text);
		};
		for (let step = 0; step < 12; step++) {
			component.render(width);
			const key = ops[Math.floor(randTrajectory() * ops.length)]!;
			if (key !== UP && key !== DOWN) {
				component.handleInput(key);
				continue;
			}
			const before = { line: state.cursorLine, col: state.cursorCol };
			const savedLines = [...state.lines];
			const displayLines = savedLines.map((l) => displayOracle(l).display);
			const startDisplayCol = displayOracle((savedLines[before.line] ?? "").slice(0, before.col)).display.length;
			const reference = new Editor(
				tui,
				{ ...getEditorTheme(), borderColor: (segment: string) => segment },
				{ paddingX: 0 },
			);
			reference.setText(displayLines.join("\n"));
			Reflect.set(reference, "state", {
				lines: displayLines,
				cursorLine: before.line,
				cursorCol: startDisplayCol,
			});
			Reflect.set(reference, "preferredVisualCol", Reflect.get(editor, "preferredVisualCol"));
			Reflect.set(reference, "snappedFromCursorCol", Reflect.get(editor, "snappedFromCursorCol"));
			Reflect.set(reference, "lastWidth", Reflect.get(editor, "lastWidth"));
			reference.handleInput(key);
			const refState = Reflect.get(reference, "state") as EditorState;
			const refMoved = refState.cursorLine !== before.line || refState.cursorCol !== startDisplayCol;

			const focusBefore = Reflect.get(component, "focusedIndex") as number;
			component.handleInput(key);
			const focusAfter = Reflect.get(component, "focusedIndex") as number;
			const after = { line: state.cursorLine, col: state.cursorCol };
			const hostCursorMoved = after.line !== before.line || after.col !== before.col;
			const hostFocusMoved = focusAfter !== focusBefore;

			if (refMoved) {
				assert.equal(hostCursorMoved, true, `scenario ${scenario} step ${step}: cursor stalled at width ${width}`);
				assert.equal(hostFocusMoved, false, `scenario ${scenario} step ${step}: focus left field early`);
				assert.equal(after.line, refState.cursorLine);
			} else {
				assert.equal(hostCursorMoved, false);
				assert.equal(hostFocusMoved, true);
			}
			const currentLine = savedLines[after.line] ?? "";
			assert.ok(after.col >= 0 && after.col <= currentLine.length);
			const low = currentLine.charCodeAt(after.col);
			const high = currentLine.charCodeAt(after.col - 1);
			assert.ok(!(low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff));
			assert.deepEqual(state.lines, savedLines);
			if (hostFocusMoved) {
				Reflect.set(component, "focusedIndex", 0);
				Reflect.set(editor, "focused", true);
			}
		}
		assert.equal(changed, false);
	}
});
