import assert from "node:assert/strict";
import { test } from "vitest";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import type { QuestionParams } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import {
	initTheme,
	type Theme,
	type ThemeColor,
	theme,
} from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const ENTER = "\r";
const SPACE = " ";
const WIDTH = 140;

/**
 * The real theme with one change: every foreground token gets its own 256-color index, so a
 * rendered frame says which token painted each character. Reset semantics (`39`, `0`) are the
 * real ones, so a sequence that drops the color mid-field shows up as uncolored characters.
 */
function tokenTheme(): { readonly theme: Theme; readonly tokenOf: (index: number) => ThemeColor | undefined } {
	initTheme("dark");
	const ids = new Map<ThemeColor, number>();
	const tagged = Object.create(theme) as Theme;
	tagged.fg = (color: ThemeColor, text: string): string => {
		let id = ids.get(color);
		if (id === undefined) {
			id = 16 + ids.size;
			ids.set(color, id);
		}
		return `\x1b[38;5;${id}m${text}\x1b[39m`;
	};
	const tokenOf = (index: number): ThemeColor | undefined => {
		for (const [color, id] of ids) if (id === index) return color;
		return undefined;
	};
	return { theme: tagged, tokenOf };
}

/** Plain text of `line` plus the foreground token of every character, read like a terminal would. */
function paint(line: string, tokenOf: (index: number) => ThemeColor | undefined): { text: string; fg: string[] } {
	let text = "";
	const fg: string[] = [];
	let current = "default";
	for (let i = 0; i < line.length; ) {
		if (line[i] === "\x1b") {
			const sgr = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
			if (sgr) {
				const params = sgr[1] === "" ? ["0"] : sgr[1]!.split(";");
				for (let p = 0; p < params.length; p++) {
					if (params[p] === "0" || params[p] === "39") current = "default";
					else if (params[p] === "38" && params[p + 1] === "5") {
						current = tokenOf(Number(params[p + 2])) ?? "unknown";
						p += 2;
					}
				}
				i += sgr[0].length;
				continue;
			}
			const other = /^\x1b(?:_[^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[A-Za-z])/.exec(line.slice(i));
			i += other ? other[0].length : 1;
			continue;
		}
		const ch = String.fromCodePoint(line.codePointAt(i)!);
		text += ch;
		for (let k = 0; k < ch.length; k++) fg.push(current);
		i += ch.length;
	}
	return { text, fg };
}

function makeParams(): QuestionParams {
	return {
		questions: [
			{
				question: "Which database?",
				header: "DB",
				options: [
					{ label: "Postgres", description: "Relational" },
					{ label: "SQLite", description: "Embedded" },
				],
			},
			{
				question: "Which features?",
				header: "Features",
				multiSelect: true,
				options: [
					{ label: "Auth", description: "Login" },
					{ label: "Billing", description: "Payments" },
				],
			},
			{
				question: "Which layout?",
				header: "Layout",
				options: [
					{ label: "Grid", description: "Cards", preview: "# Grid\n\n- a" },
					{ label: "List", description: "Rows", preview: "# List\n\n1. a" },
				],
			},
		],
	};
}

interface Dialog {
	readonly press: (...keys: string[]) => void;
	readonly type: (text: string) => void;
	readonly frame: () => string[];
	/** The one token painting every character of `text`, `"mixed"` when it changes inside, `"absent"` when not shown. */
	readonly colorOf: (text: string) => string;
}

function openDialog(): Dialog {
	const { theme: tagged, tokenOf } = tokenTheme();
	const params = makeParams();
	const session = new QuestionnaireSession({
		tui: { terminal: { columns: WIDTH }, requestRender() {} },
		theme: tagged,
		params,
		itemsByTab: params.questions.map((q) => buildItemsForQuestion(q)),
		done() {},
	});
	const frame = () => session.component.render(WIDTH);
	return {
		press: (...keys) => {
			for (const key of keys) session.component.handleInput(key);
		},
		type: (text) => {
			for (const ch of text) session.component.handleInput(ch);
		},
		frame,
		colorOf: (text) => {
			const found: string[] = [];
			for (const line of frame()) {
				const painted = paint(line, tokenOf);
				const at = painted.text.indexOf(text);
				if (at < 0) continue;
				const tokens = new Set(painted.fg.slice(at, at + text.length));
				found.push(tokens.size === 1 ? [...tokens][0]! : "mixed");
			}
			if (found.length === 0) return "absent";
			assert.equal(found.length, 1, `"${text}" is rendered more than once`);
			return found[0]!;
		},
	};
}

test("Type something. keeps its field color after navigating back (#4741)", () => {
	const d = openDialog();
	assert.equal(d.colorOf("Type something."), "muted", "an empty field shows its placeholder color");

	d.press(DOWN, DOWN);
	d.type("custom1");
	const editing = d.frame();
	assert.equal(d.colorOf("custom1"), "accent");
	d.press(LEFT, LEFT, LEFT);
	assert.equal(d.colorOf("custom1"), "accent", "moving the caret back keeps the editing color after it");
	d.press(RIGHT, RIGHT, RIGHT);

	d.press(UP, UP);
	const forward = d.frame();
	assert.equal(d.colorOf("custom1"), "text", "a filled field without focus shows the answered color");

	d.press(TAB, LEFT);
	assert.deepEqual(d.frame(), forward, "← back renders like forward");
	d.press(TAB, TAB, SHIFT_TAB, SHIFT_TAB);
	assert.deepEqual(d.frame(), forward, "Shift+Tab back renders like forward");
	d.press(TAB, TAB, TAB, SHIFT_TAB, SHIFT_TAB, SHIFT_TAB);
	assert.deepEqual(d.frame(), forward, "back from the review tab renders like forward");

	d.press(DOWN, DOWN);
	assert.deepEqual(d.frame(), editing, "refocusing after back navigation edits like forward");

	d.press(ENTER, LEFT);
	assert.equal(d.colorOf("custom1 ✔"), "text", "the confirmed answer shows the answered color");
});

for (const [tab, layout] of [
	[0, "single-select"],
	[1, "multi-select"],
	[2, "preview"],
] as const) {
	test(`Chat about this keeps its field color after navigating back in the ${layout} layout (#4741)`, () => {
		const d = openDialog();
		for (let i = 0; i < tab; i++) d.press(TAB);
		assert.equal(d.colorOf("Chat about this"), "muted", "an empty field shows its placeholder color");

		d.press(UP);
		d.type("chat1");
		const editing = d.frame();
		assert.equal(d.colorOf("chat1"), "accent");

		d.press(DOWN);
		const forward = d.frame();
		assert.equal(d.colorOf("chat1"), "text", "a filled field without focus shows the answered color");

		d.press(TAB, SHIFT_TAB);
		assert.deepEqual(d.frame(), forward, "Shift+Tab back renders like forward");
		d.press(TAB, LEFT);
		assert.deepEqual(d.frame(), forward, "← back renders like forward");

		d.press(UP);
		assert.deepEqual(d.frame(), editing, "refocusing after back navigation edits like forward");
	});
}

test("notes keep their field color after navigating back and on the review tab (#4741)", () => {
	const d = openDialog();
	d.press(TAB, TAB);
	assert.equal(d.colorOf("Notes: n add notes"), "muted", "empty notes show the placeholder color");

	d.press("n");
	d.type("note3");
	const editing = d.frame();
	assert.equal(d.colorOf("note3"), "accent");

	d.press(ENTER);
	const forward = d.frame();
	assert.equal(d.colorOf("note3"), "text", "saved notes without focus show the answered color");

	d.press(TAB, SHIFT_TAB);
	assert.deepEqual(d.frame(), forward, "back from the review tab renders like forward");
	d.press(SHIFT_TAB, TAB);
	assert.deepEqual(d.frame(), forward, "returning to the tab renders like forward");

	d.press("n");
	assert.deepEqual(d.frame(), editing, "reopening notes after back navigation edits like forward");

	d.press(ENTER, ENTER);
	assert.equal(d.colorOf("note3"), "text", "the review tab shows saved notes in the answered color");
	assert.equal(d.colorOf("Grid"), "text", "the review tab shows the answer in the answered color");
});

test("answered rows follow focus after navigating back (#4741)", () => {
	const d = openDialog();
	d.press(TAB, SPACE);
	assert.equal(d.colorOf("[✔]"), "accent", "the focused checked row shows the editing color");
	d.press(DOWN);
	const forward = d.frame();
	assert.equal(d.colorOf("[✔]"), "text", "a checked row without focus shows the answered color");
	assert.equal(d.colorOf("Auth"), "text");

	d.press(TAB, LEFT, DOWN);
	assert.deepEqual(d.frame(), forward, "← back renders like forward");

	d.press(TAB, ENTER, SHIFT_TAB);
	assert.equal(d.colorOf("Grid ✔"), "accent", "the focused confirmed row shows the editing color");
	d.press(DOWN);
	assert.equal(d.colorOf("Grid ✔"), "text", "the confirmed row without focus shows the answered color");
});

test("a long draft without focus keeps the dialog height after navigating back (#4741)", () => {
	const d = openDialog();
	const height = d.frame().length;
	const long = "word ".repeat(80).trim();

	d.press(UP);
	d.type(long);
	d.press(DOWN);
	assert.equal(d.frame().length, height, "a long chat draft at rest stays on one row");
	d.press(DOWN, DOWN);
	d.type(long);
	d.press(UP);
	assert.equal(d.frame().length, height, "a long custom draft at rest stays on one row");

	d.press(TAB, LEFT);
	assert.equal(d.frame().length, height, "← back keeps the height");
});
