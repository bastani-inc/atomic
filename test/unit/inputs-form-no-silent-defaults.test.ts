import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import {
	coerceValues,
	computeInvalid,
	createInputsPickerState,
	handleInputsPickerInput,
	invalidForField,
	renderInputsPicker,
} from "../../packages/workflows/src/tui/inputs-picker.ts";
import { KB } from "./inputs-picker-helpers.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";

test("a select with no default starts unchosen, and a required one must be chosen before the run starts (#5224)", () => {
	const fields: WorkflowInputEntry[] = [
		{ name: "mode", type: "select", required: true, choices: ["a", "b", "c"] },
		{ name: "tone", type: "select", choices: ["dry", "warm"] },
	];
	const state = createInputsPickerState(fields);
	assert.equal(state.rawText.mode, "", "no first choice picked for the user");
	assert.equal(state.rawText.tone, "");
	assert.equal(invalidForField(fields[0]!, "", 0), "choose one");
	assert.deepEqual(coerceValues(fields, { mode: "b", tone: "" }), { mode: "b" }, "an unchosen optional is omitted");
	handleInputsPickerInput(DOWN, state, fields, KB);
	assert.equal(state.rawText.mode, "a", "↓ from unchosen picks the first choice");
	const fresh = createInputsPickerState(fields);
	handleInputsPickerInput(UP, fresh, fields, KB);
	assert.equal(fresh.rawText.mode, "c", "↑ from unchosen picks the last choice");
});

test("a boolean with no default starts unset; a required one must be set, and only on or off is accepted (#5224)", () => {
	const fields: WorkflowInputEntry[] = [
		{ name: "dry_run", type: "boolean", required: true },
		{ name: "verbose", type: "boolean" },
	];
	const state = createInputsPickerState(fields);
	assert.equal(state.rawText.dry_run, "");
	assert.equal(state.rawText.verbose, "");
	assert.equal(invalidForField(fields[0]!, "", 0), "choose on or off");
	assert.equal(invalidForField(fields[1]!, "yes", 1), "must be on or off", "a typed value is never read as off");
	assert.equal(invalidForField(fields[1]!, "true", 1), null);
	assert.deepEqual(coerceValues(fields, { dry_run: "false", verbose: "" }), { dry_run: false });
});

test("an integer input refuses a fraction instead of rounding or dropping it (#5224)", () => {
	const field: WorkflowInputEntry = { name: "max_loops", type: "integer", required: true };
	assert.equal(invalidForField(field, "1.5", 0), "must be a whole number");
	assert.equal(invalidForField(field, "ten", 0), "must be a whole number");
	assert.equal(invalidForField(field, "10", 0), null);
	const number: WorkflowInputEntry = { name: "ratio", type: "number" };
	assert.equal(invalidForField(number, "ten", 0), "must be a number");
	assert.deepEqual(computeInvalid([field], { max_loops: "1.5" }), [0]);
});

test("each field's label shows ✓ when valid and ✗ with the reason when not, from the start (#5224)", () => {
	const fields: WorkflowInputEntry[] = [
		{ name: "objective", type: "string", required: true },
		{ name: "max_loops", type: "integer", default: 10 },
		{ name: "mode", type: "select", required: true, choices: ["fast", "careful"] },
	];
	const state = createInputsPickerState(fields, { objective: "Fix the benchmark", max_loops: "ten" as never });
	const text = renderInputsPicker({
		width: 80,
		theme: deriveGraphTheme({}),
		workflowName: "ralph",
		fields,
		state,
		cursorOn: false,
	})
		.map((line) => stripVTControlCharacters(line))
		.join("\n");
	assert.match(text, /objective ✓/);
	assert.match(text, /max_loops ✗ must be a whole number/);
	assert.match(text, /mode ✗ choose one/);
});
