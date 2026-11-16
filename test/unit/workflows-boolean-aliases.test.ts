import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { renderInlineCard } from "../../packages/workflows/src/tui/inline-form-card.ts";
import { InlineFormEditor } from "../../packages/workflows/src/tui/inline-form-editor.ts";
import { _resetForms, createForm } from "../../packages/workflows/src/tui/inline-form-store.ts";
import {
	coerceValues,
	createInputsPickerState,
	handleInputsPickerInput,
	initialInputText,
	invalidForField,
	renderInputsPicker,
} from "../../packages/workflows/src/tui/inputs-picker.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.ts";

const BOOLEAN_FIELDS: readonly WorkflowInputEntry[] = [{ name: "verbose", type: "boolean", required: true }];
const THEME = deriveGraphTheme({});
const KB = makeFakeKeybindings();

const TRUE_ALIASES = ["true", "TRUE", " True ", "1", " 1 ", "on", "ON", " On "] as const;
const FALSE_ALIASES = ["false", "FALSE", " False ", "0", " 0 ", "off", "OFF", " Off "] as const;

function renderPickerPlain(rawValue: string, focusedIdx: number): string {
	const state = createInputsPickerState(BOOLEAN_FIELDS, { verbose: rawValue });
	state.focusedIdx = focusedIdx;
	return renderInputsPicker({
		width: 80,
		theme: THEME,
		workflowName: "demo",
		fields: BOOLEAN_FIELDS,
		state,
		cursorOn: false,
	})
		.map((line) => stripVTControlCharacters(line))
		.join("\n");
}

function renderInlinePlain(rawValue: string, focusedIdx: number): string {
	_resetForms();
	const state = createForm({
		formId: "wf-bool-alias",
		workflowName: "demo",
		fields: BOOLEAN_FIELDS,
		rawText: { verbose: initialInputText(BOOLEAN_FIELDS[0]!, { verbose: rawValue }) },
		focusedIdx,
		caret: 0,
		status: "editing",
	});
	return renderInlineCard({ width: 80, state, theme: THEME })
		.map((line) => stripVTControlCharacters(line))
		.join("\n");
}

test("inputs picker and inline form render boolean prefill aliases consistently across case and whitespace (#5245 #5224)", () => {
	for (const alias of TRUE_ALIASES) {
		assert.equal(invalidForField(BOOLEAN_FIELDS[0]!, alias, 0), null, `alias=${JSON.stringify(alias)}`);
		for (const [surface, rendered] of [
			["picker", renderPickerPlain(alias, BOOLEAN_FIELDS.length)],
			["inline", renderInlinePlain(alias, BOOLEAN_FIELDS.length)],
		] as const) {
			assert.match(rendered, /1\. ✓ on/, `${surface} alias=${JSON.stringify(alias)}`);
			assert.doesNotMatch(rendered, /2\. ✓ off/, `${surface} alias=${JSON.stringify(alias)}`);
		}
		for (const [surface, rendered] of [
			["picker-focused", renderPickerPlain(alias, 0)],
			["inline-focused", renderInlinePlain(alias, 0)],
		] as const) {
			assert.match(rendered, /❯ 1\. on/, `${surface} alias=${JSON.stringify(alias)}`);
			assert.doesNotMatch(rendered, /❯ 2\. off/, `${surface} alias=${JSON.stringify(alias)}`);
		}
	}

	for (const alias of FALSE_ALIASES) {
		assert.equal(invalidForField(BOOLEAN_FIELDS[0]!, alias, 0), null, `alias=${JSON.stringify(alias)}`);
		for (const [surface, rendered] of [
			["picker", renderPickerPlain(alias, BOOLEAN_FIELDS.length)],
			["inline", renderInlinePlain(alias, BOOLEAN_FIELDS.length)],
		] as const) {
			assert.match(rendered, /2\. ✓ off/, `${surface} alias=${JSON.stringify(alias)}`);
			assert.doesNotMatch(rendered, /1\. ✓ on/, `${surface} alias=${JSON.stringify(alias)}`);
		}
		for (const [surface, rendered] of [
			["picker-focused", renderPickerPlain(alias, 0)],
			["inline-focused", renderInlinePlain(alias, 0)],
		] as const) {
			assert.match(rendered, /❯ 2\. off/, `${surface} alias=${JSON.stringify(alias)}`);
			assert.doesNotMatch(rendered, /❯ 1\. on/, `${surface} alias=${JSON.stringify(alias)}`);
		}
	}

	for (const invalidAlias of ["", "   ", "yes", "no"]) {
		for (const [surface, rendered] of [
			["picker", renderPickerPlain(invalidAlias, BOOLEAN_FIELDS.length)],
			["inline", renderInlinePlain(invalidAlias, BOOLEAN_FIELDS.length)],
		] as const) {
			assert.doesNotMatch(rendered, /✓ on|✓ off/, `${surface} invalid=${JSON.stringify(invalidAlias)}`);
		}
	}
});

test("toggling prefilled boolean aliases in inputs picker and inline form flips state and coerces values (#5245 #5224)", () => {
	for (const alias of TRUE_ALIASES) {
		assert.deepEqual(coerceValues(BOOLEAN_FIELDS, { verbose: alias }), { verbose: true });

		const pickerState = createInputsPickerState(BOOLEAN_FIELDS, { verbose: alias });
		handleInputsPickerInput(" ", pickerState, BOOLEAN_FIELDS, KB);
		assert.equal(pickerState.rawText.verbose, "false", `picker first toggle alias=${JSON.stringify(alias)}`);
		assert.deepEqual(coerceValues(BOOLEAN_FIELDS, pickerState.rawText), { verbose: false });

		handleInputsPickerInput("\x1b[B", pickerState, BOOLEAN_FIELDS, KB);
		assert.equal(pickerState.rawText.verbose, "true", `picker second toggle alias=${JSON.stringify(alias)}`);
		pickerState.focusedIdx = BOOLEAN_FIELDS.length;
		handleInputsPickerInput("\x1b[A", pickerState, BOOLEAN_FIELDS, KB);
		handleInputsPickerInput(" ", pickerState, BOOLEAN_FIELDS, KB);
		pickerState.focusedIdx = BOOLEAN_FIELDS.length;
		assert.deepEqual(handleInputsPickerInput("\r", pickerState, BOOLEAN_FIELDS, KB), {
			kind: "run",
			values: { verbose: false },
		});

		_resetForms();
		const inlineState = createForm({
			formId: "wf-toggle-true",
			workflowName: "demo",
			fields: BOOLEAN_FIELDS,
			rawText: { verbose: initialInputText(BOOLEAN_FIELDS[0]!, { verbose: alias }) },
			focusedIdx: 0,
			caret: 0,
			status: "editing",
		});
		let submitted = false;
		const editor = new InlineFormEditor(
			{},
			{
				formId: inlineState.formId,
				theme: THEME,
				keybindings: KB,
				onExit: (outcome) => {
					submitted = outcome === "submit";
				},
			},
		);
		editor.handleInput(" ");
		assert.equal(inlineState.rawText.verbose, "false", `inline first toggle alias=${JSON.stringify(alias)}`);
		assert.deepEqual(coerceValues(BOOLEAN_FIELDS, inlineState.rawText), { verbose: false });
		editor.handleInput("\t");
		editor.handleInput("\r");
		assert.equal(submitted, true);
		editor.dispose?.();
	}

	for (const alias of FALSE_ALIASES) {
		assert.deepEqual(coerceValues(BOOLEAN_FIELDS, { verbose: alias }), { verbose: false });

		const pickerState = createInputsPickerState(BOOLEAN_FIELDS, { verbose: alias });
		handleInputsPickerInput(" ", pickerState, BOOLEAN_FIELDS, KB);
		assert.equal(pickerState.rawText.verbose, "true", `picker toggle alias=${JSON.stringify(alias)}`);
		pickerState.focusedIdx = BOOLEAN_FIELDS.length;
		assert.deepEqual(handleInputsPickerInput("\r", pickerState, BOOLEAN_FIELDS, KB), {
			kind: "run",
			values: { verbose: true },
		});

		_resetForms();
		const inlineState = createForm({
			formId: "wf-toggle-false",
			workflowName: "demo",
			fields: BOOLEAN_FIELDS,
			rawText: { verbose: initialInputText(BOOLEAN_FIELDS[0]!, { verbose: alias }) },
			focusedIdx: 0,
			caret: 0,
			status: "editing",
		});
		const editor = new InlineFormEditor(
			{},
			{
				formId: inlineState.formId,
				theme: THEME,
				keybindings: KB,
				onExit: () => {},
			},
		);
		editor.handleInput(" ");
		assert.equal(inlineState.rawText.verbose, "true", `inline toggle alias=${JSON.stringify(alias)}`);
		assert.deepEqual(coerceValues(BOOLEAN_FIELDS, inlineState.rawText), { verbose: true });
		editor.dispose?.();
	}
});
