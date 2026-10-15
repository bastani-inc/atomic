import assert from "node:assert/strict";
import { test } from "vitest";
import type { RunSnapshot } from "../../packages/workflows/src/authoring.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import * as inlineFormEditor from "../../packages/workflows/src/tui/inline-form-editor.js";
import { createForm, finalizeForm } from "../../packages/workflows/src/tui/inline-form-store.js";
import { createInputsPickerState } from "../../packages/workflows/src/tui/inputs-picker.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";

test("a current public snapshot with an explicit empty tool collection starts a run", () => {
	const snapshot = {
		id: "public-empty",
		name: "current",
		status: "running",
		inputs: {},
		stages: [],
		toolNodes: [],
		startedAt: 1,
	} satisfies RunSnapshot & { inputs: Record<string, never> };
	const store = createStore();
	store.recordRunStart(snapshot);
	assert.deepEqual(store.snapshot().runs[0]?.toolNodes, []);
});

test("current input picker state has no retired submit-choice index", () => {
	const state = createInputsPickerState([]);
	assert.equal(Object.hasOwn(state, "submitChoiceIdx"), false);
});

test("inline editors reject a missing injected keybinding manager", () => {
	const opts = {
		formId: "missing-manager",
		theme: deriveGraphTheme({}),
		keybindings: { matches: () => false },
		onExit: () => {},
	};
	Reflect.deleteProperty(opts, "keybindings");
	assert.throws(
		() => new inlineFormEditor.InlineFormEditor({}, opts),
		(error: Error) => error instanceof inlineFormEditor.InlineFormKeybindingsError && error.formId === opts.formId,
	);
});

test("injected editor actions edit verbatim text and submit the current form", () => {
	const state = createForm({
		formId: "current-edit",
		workflowName: "current",
		fields: [{ name: "prompt", type: "string", required: true }],
		rawText: { prompt: "" },
		focusedIdx: 0,
		caret: 0,
		status: "editing",
	});
	const editor = new inlineFormEditor.InlineFormEditor(
		{},
		{
			formId: state.formId,
			theme: deriveGraphTheme({}),
			keybindings: makeFakeKeybindings({ "tui.editor.deleteCharBackward": ["!"] }),
			onExit: (outcome) => finalizeForm(state.formId, outcome),
		},
	);
	editor.handleInput("alpha ");
	editor.handleInput("x");
	editor.handleInput("!");
	assert.equal(state.rawText.prompt, "alpha ");
	editor.handleInput("\t");
	editor.handleInput("\r");
	assert.equal(state.status, "submitted");
	assert.equal(Object.hasOwn(state, "submitChoiceIdx"), false);
	editor.dispose?.();
});
