import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Terminal, TuiMainScreen } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { beforeAll, test } from "vitest";
import type { HostInputFormField } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { HostInputFormComponent } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { deriveInputFields } from "../../packages/workflows/src/shared/schema-introspection.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { renderInlineCard } from "../../packages/workflows/src/tui/inline-form-card.ts";
import type { InlineFormState } from "../../packages/workflows/src/tui/inline-form-store.ts";
import {
	createInputsPickerState,
	handleInputsPickerInput,
	invalidForField,
	renderInputsPicker,
} from "../../packages/workflows/src/tui/inputs-picker.ts";

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
const paste = (text: string): string => `\x1b[200~${text}\x1b[201~`;

function hostForm(fields: HostInputFormField[]) {
	const submitted: Record<string, string>[] = [];
	const tui = new TuiMainScreen(new QuietTerminal());
	const component = new HostInputFormComponent(
		tui,
		theme,
		new KeybindingsManager(),
		{ title: "demo", fields },
		{
			onSubmit: (values) => submitted.push(values),
			onCancel: () => {},
		},
	);
	const text = () =>
		component
			.render(100)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
	return { component, submitted, text, tui };
}

const NO_OP_KEYS: ReadonlyArray<readonly [string, readonly string[]]> = [
	["Delete at the end", ["\x1b[3~"]],
	["Ctrl+K at the end", ["\x0b"]],
	["Ctrl+D at the end", ["\x04"]],
	["Alt+D at the end", ["\x1bd"]],
	["Backspace at the start", ["\x01", "\x7f"]],
	["Ctrl+W at the start", ["\x01", "\x17"]],
];

for (const [label, keys] of NO_OP_KEYS) {
	for (const [size, pasted] of [
		["1200 characters", "q".repeat(1200)],
		["12 lines", "line\n".repeat(12)],
	] as const) {
		test(`host text field submits a pasted ${size} after ${label}, never the paste marker (#5245)`, () => {
			const { component, submitted } = hostForm([
				{ name: "prompt", type: "text", required: true, initialValue: "" },
			]);
			component.handleInput(paste(pasted));
			for (const key of keys) component.handleInput(key);
			component.handleInput("\t");
			component.handleInput("\r");
			assert.deepEqual(submitted, [{ prompt: pasted }]);
		});
	}
}

test("host text field checks maxLength against the expanded paste after a no-op key (#5245)", () => {
	const { component, submitted, text } = hostForm([
		{ name: "prompt", type: "text", required: true, initialValue: "", maxLength: 100 },
	]);
	component.handleInput(paste("q".repeat(1200)));
	component.handleInput("\x1b[3~");
	assert.match(text(), /✗ must not have more than 100 characters/);
	component.handleInput("\t");
	component.handleInput("\r");
	assert.deepEqual(submitted, []);
});

const BAD_PATTERNS = ["(", "^foo\\:bar$", "^[\\w-.]+$", "^\\d+\\-\\d+$"];

for (const pattern of BAD_PATTERNS) {
	test(`host form with schema pattern ${JSON.stringify(pattern)} renders and says the pattern is invalid (#5245)`, () => {
		const prefilled = hostForm([{ name: "f", type: "string", required: true, initialValue: "12-34", pattern }]);
		assert.match(prefilled.text(), /✗ invalid pattern in the workflow schema/);
		const typed = hostForm([{ name: "f", type: "string", required: true, initialValue: "", pattern }]);
		typed.component.handleInput("a");
		assert.match(typed.text(), /✗ invalid pattern in the workflow schema/);
		typed.tui.addChild(typed.component);
		assert.doesNotThrow(() => typed.tui.renderNow(true));
		typed.component.handleInput("\t");
		typed.component.handleInput("\r");
		assert.deepEqual(typed.submitted, []);
	});

	test(`picker and inline card with schema pattern ${JSON.stringify(pattern)} render and say the pattern is invalid (#5245)`, () => {
		const fields = deriveInputFields({ f: Type.String({ pattern, default: "12-34" }) });
		const state = createInputsPickerState(fields, {});
		assert.equal(invalidForField(fields[0]!, "12-34", 0), "invalid pattern in the workflow schema");
		const picker = renderInputsPicker({
			width: 100,
			theme: graphTheme,
			workflowName: "w",
			fields,
			state,
			cursorOn: false,
		})
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.match(picker, /invalid pattern in the workflow schema/);
		state.focusedIdx = fields.length;
		assert.equal(handleInputsPickerInput("\r", state, fields).kind, "noop");
		const inline: InlineFormState = {
			formId: "x",
			workflowName: "w",
			fields,
			rawText: { f: "12-34" },
			focusedIdx: 0,
			caret: 5,
			status: "editing",
			version: 0,
		};
		assert.doesNotThrow(() => renderInlineCard({ width: 100, theme: graphTheme, state: inline }));
	});
}
