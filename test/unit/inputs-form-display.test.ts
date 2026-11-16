import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Editor, type Terminal, TuiMainScreen, visibleWidth } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { HostInputFormComponent } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { deriveInputFields } from "../../packages/workflows/src/shared/schema-introspection.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { renderInlineCard } from "../../packages/workflows/src/tui/inline-form-card.ts";
import type { InlineFormState } from "../../packages/workflows/src/tui/inline-form-store.ts";
import { renderSubmitReview } from "../../packages/workflows/src/tui/submit-pane.ts";

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

const graphTheme = deriveGraphTheme({});

test("the inputs review fits widths narrower than its heading (#5245)", () => {
	for (const width of [1, 5, 10, 17]) {
		const lines = renderSubmitReview({ workflowName: "w", fields: [], rawText: {}, theme: graphTheme, width });
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} columns`);
	}
});

test("the submitted inputs line shows the values the run received (#5245)", () => {
	const fields = deriveInputFields({
		note: Type.Optional(Type.String()),
		count: Type.Optional(Type.Integer()),
		ok: Type.Optional(Type.Boolean()),
		body: Type.String(),
	});
	const state: InlineFormState = {
		formId: "x",
		workflowName: "demo",
		fields,
		rawText: { note: "  ", count: "+5", ok: "ON", body: "line1 line2" },
		focusedIdx: 4,
		caret: 0,
		status: "submitted",
		version: 0,
	};
	const line = stripVTControlCharacters(renderInlineCard({ width: 200, theme: graphTheme, state })[0]!);
	assert.match(line, /\/workflow demo count=5 ok=true body="line1 line2"$/);
});

test("Up in a prefilled text field moves one displayed row of its escaped text (#5245)", () => {
	const component = new HostInputFormComponent(
		new TuiMainScreen(new QuietTerminal()),
		theme,
		new KeybindingsManager(),
		{
			title: "demo",
			fields: [
				{ name: "f", type: "text", initialValue: "\x01".repeat(60) },
				{ name: "g", type: "string", initialValue: "" },
			],
		},
		{ onSubmit: () => {}, onCancel: () => {} },
	);
	const editor = (Reflect.get(component, "editors") as Editor[])[0]!;
	component.render(40);
	component.handleInput("\x1b[A");
	const cursor = editor.getCursor();
	assert.equal(cursor.line, 0);
	assert.ok(cursor.col > 0 && cursor.col < 60, `Up moved the cursor to column ${cursor.col}`);
	component.render(40);
	component.handleInput("\x1b[B");
	assert.equal(editor.getCursor().col, 60);
});

test("the host form draws wide text and control characters within every width from 1 to 200 (#5245)", () => {
	const wide = "漢字🙂‍👩e\u0301".repeat(20);
	const component = new HostInputFormComponent(
		new TuiMainScreen(new QuietTerminal()),
		theme,
		new KeybindingsManager(),
		{
			title: `t${wide}`,
			heading: `H${wide}`,
			fields: [
				{
					name: `n${wide}`,
					type: "string",
					initialValue: `\x1b]52;c;x\x07${wide}`,
					description: wide,
					required: true,
					maxLength: 3,
				},
				{ name: "t", type: "text", initialValue: `${wide}\n\t\x01${wide}` },
				{ name: "s", type: "select", choices: [wide, "b"], initialValue: "" },
				{ name: "b", type: "boolean", initialValue: "" },
			],
		},
		{ onSubmit: () => {}, onCancel: () => {} },
	);
	for (let width = 1; width <= 200; width++) {
		for (const line of component.render(width))
			assert.ok(visibleWidth(line) <= width, `width ${width}: a line takes ${visibleWidth(line)} columns`);
	}
});
