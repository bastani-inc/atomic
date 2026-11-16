import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Terminal, TuiMainScreen, visibleWidth } from "@bastani/atomic-tui";
import { Type } from "typebox";
import { beforeAll, test } from "vitest";
import type { HostInputFormField } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { HostInputFormComponent } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.js";
import type { WorkflowInputEntry } from "../../packages/workflows/src/extension/render-result.js";
import {
	resolveAndValidateInputs,
	resolveInputs,
} from "../../packages/workflows/src/runs/foreground/executor-inputs.js";
import { validateInputs } from "../../packages/workflows/src/runs/shared/validate-inputs.js";
import { deriveInputFields } from "../../packages/workflows/src/shared/schema-introspection.js";
import type { WorkflowInputSchema } from "../../packages/workflows/src/shared/types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { openHostInputsForm } from "../../packages/workflows/src/tui/host-input-form.js";
import { renderInlineCard } from "../../packages/workflows/src/tui/inline-form-card.js";
import { _resetForms, createForm } from "../../packages/workflows/src/tui/inline-form-store.js";
import {
	coerceValues,
	computeInvalid,
	createInputsPickerState,
	handleInputsPickerInput,
	invalidForField,
	renderInputsPicker,
} from "../../packages/workflows/src/tui/inputs-picker.js";
import { KB } from "./inputs-picker-helpers.js";

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

function makeHostForm(fields: HostInputFormField[], title = "ralph") {
	const submitted: Record<string, string>[] = [];
	const component = new HostInputFormComponent(
		new TuiMainScreen(new QuietTerminal()),
		theme,
		new KeybindingsManager(),
		{ title, heading: "WORKFLOW INPUTS", fields },
		{ onSubmit: (values) => submitted.push(values), onCancel: () => {} },
	);
	return {
		component,
		submitted,
		plainAt: (width: number) =>
			component
				.render(width)
				.map((line) => stripVTControlCharacters(line))
				.join("\n"),
	};
}

test("unset optional and required select fields keep index -1 and mark no choice when focused or after Tab (#5245)", () => {
	const optionalFields: WorkflowInputEntry[] = [{ name: "mode", type: "select", choices: ["fast", "careful"] }];
	const optState = createInputsPickerState(optionalFields);
	const graphTheme = deriveGraphTheme({});

	const pickerFocused = renderInputsPicker({
		width: 80,
		theme: graphTheme,
		workflowName: "ralph",
		fields: optionalFields,
		state: optState,
		cursorOn: false,
	})
		.map((l) => stripVTControlCharacters(l))
		.join("\n");
	assert.doesNotMatch(pickerFocused, /❯ 1\. fast/);
	assert.doesNotMatch(pickerFocused, /✓ fast/);
	assert.match(pickerFocused, /1\. fast/);
	assert.match(pickerFocused, /2\. careful/);

	_resetForms();
	const inlineFocusedState = createForm({
		formId: "wf-i1-opt-focused",
		workflowName: "ralph",
		fields: optionalFields,
		rawText: { mode: "" },
		focusedIdx: 0,
		caret: 0,
		status: "editing",
	});
	const inlineFocused = renderInlineCard({ width: 80, state: inlineFocusedState, theme: graphTheme })
		.map((l) => stripVTControlCharacters(l))
		.join("\n");
	assert.doesNotMatch(inlineFocused, /❯ 1\. fast/);
	assert.doesNotMatch(inlineFocused, /✓ fast/);

	handleInputsPickerInput("\t", optState, optionalFields, KB);
	assert.equal(optState.focusedIdx, 1);
	const pickerUnfocused = renderInputsPicker({
		width: 80,
		theme: graphTheme,
		workflowName: "ralph",
		fields: optionalFields,
		state: optState,
		cursorOn: false,
	})
		.map((l) => stripVTControlCharacters(l))
		.join("\n");
	assert.doesNotMatch(pickerUnfocused, /✓ fast/);
	assert.doesNotMatch(pickerUnfocused, /✓ careful/);

	inlineFocusedState.focusedIdx = 1;
	const inlineUnfocused = renderInlineCard({ width: 80, state: inlineFocusedState, theme: graphTheme })
		.map((l) => stripVTControlCharacters(l))
		.join("\n");
	assert.doesNotMatch(inlineUnfocused, /✓ fast/);
	assert.doesNotMatch(inlineUnfocused, /✓ careful/);

	const sub = handleInputsPickerInput("\r", optState, optionalFields, KB);
	assert.deepEqual(sub, { kind: "run", values: {} });

	const requiredFields: WorkflowInputEntry[] = [
		{ name: "mode", type: "select", required: true, choices: ["fast", "careful"] },
	];
	const reqState = createInputsPickerState(requiredFields);
	const reqFocused = renderInputsPicker({
		width: 80,
		theme: graphTheme,
		workflowName: "ralph",
		fields: requiredFields,
		state: reqState,
		cursorOn: false,
	})
		.map((l) => stripVTControlCharacters(l))
		.join("\n");
	assert.doesNotMatch(reqFocused, /❯ 1\. fast/);
	assert.doesNotMatch(reqFocused, /✓ fast/);
	assert.match(reqFocused, /mode ✗ choose one/);

	handleInputsPickerInput("\t", reqState, requiredFields, KB);
	const reqUnfocused = renderInputsPicker({
		width: 80,
		theme: graphTheme,
		workflowName: "ralph",
		fields: requiredFields,
		state: reqState,
		cursorOn: false,
	})
		.map((l) => stripVTControlCharacters(l))
		.join("\n");
	assert.doesNotMatch(reqUnfocused, /✓ fast/);
	assert.match(reqUnfocused, /mode ✗ choose one/);

	_resetForms();
	const inlineReqState = createForm({
		formId: "wf-i1-req",
		workflowName: "ralph",
		fields: requiredFields,
		rawText: { mode: "" },
		focusedIdx: 0,
		caret: 0,
		status: "editing",
	});
	const inlineReqFocused = renderInlineCard({ width: 80, state: inlineReqState, theme: graphTheme })
		.map((l) => stripVTControlCharacters(l))
		.join("\n");
	assert.doesNotMatch(inlineReqFocused, /❯ 1\. fast/);
	assert.doesNotMatch(inlineReqFocused, /✓ fast/);
	assert.match(inlineReqFocused, /mode ✗ choose one/);

	inlineReqState.focusedIdx = 1;
	const inlineReqUnfocused = renderInlineCard({ width: 80, state: inlineReqState, theme: graphTheme })
		.map((l) => stripVTControlCharacters(l))
		.join("\n");
	assert.doesNotMatch(inlineReqUnfocused, /✓ fast/);
	assert.doesNotMatch(inlineReqUnfocused, /✓ careful/);
	assert.match(inlineReqUnfocused, /mode ✗ choose one/);
});

test("validation reason stays visible when the field title truncates or the form is narrow (#5245)", () => {
	const longName = "n".repeat(100);
	const fields: WorkflowInputEntry[] = [{ name: longName, type: "integer", required: true }];
	const state = createInputsPickerState(fields, { [longName]: "1.5" as never });
	const graphTheme = deriveGraphTheme({});

	const picker60 = renderInputsPicker({
		width: 60,
		theme: graphTheme,
		workflowName: "ralph",
		fields,
		state,
		cursorOn: false,
	})
		.map((l) => stripVTControlCharacters(l))
		.join("\n");
	assert.match(picker60, /✗ must be a whole number/);

	_resetForms();
	const inlineState = createForm({
		formId: "wf-i2",
		workflowName: "ralph",
		fields,
		rawText: { [longName]: "1.5" },
		focusedIdx: 0,
		caret: 3,
		status: "editing",
	});
	const inline60 = renderInlineCard({ width: 60, state: inlineState, theme: graphTheme })
		.map((l) => stripVTControlCharacters(l))
		.join("\n");
	assert.match(inline60, /✗ must be a whole number/);

	const picker24 = renderInputsPicker({
		width: 24,
		theme: graphTheme,
		workflowName: "ralph",
		fields,
		state,
		cursorOn: false,
	})
		.map((l) => stripVTControlCharacters(l))
		.join("\n");
	assert.match(picker24, /✗/);
	assert.match(picker24.replace(/\s+/g, " "), /must be a whole number/);

	const hostLong = makeHostForm([{ name: longName, type: "integer", required: true, initialValue: "1.5" }]);
	assert.match(hostLong.plainAt(60), /✗ must be a whole number/);

	const hostNarrow = makeHostForm([{ name: "f", type: "number", required: true, initialValue: "NaN" }]);
	assert.match(hostNarrow.plainAt(32), /✗ must be a number/);

	const hostWrapped = makeHostForm([{ name: longName, type: "integer", required: true, initialValue: "1.5" }]);
	assert.match(hostWrapped.plainAt(24).replace(/│/g, " ").replace(/\s+/g, " "), /✗ must be a whole number/);
});

test("readiness marker ✓ and submission agree with engine validation for literal strings and schema constraints (#5245)", async () => {
	const inputSchema: Readonly<Record<string, WorkflowInputSchema>> = {
		payload: Type.String(),
		slug: Type.String({ minLength: 3, maxLength: 6, pattern: "^[a-z]+$" }),
		tag: Type.Literal("fast"),
		count: Type.Integer({ minimum: 2, maximum: 8 }),
		ratio: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
	};
	const fields = deriveInputFields(inputSchema);

	const jsonShaped = coerceValues(fields, {
		payload: "[1,2]",
		slug: "abc",
		tag: "fast",
		count: "4",
		ratio: "0.5",
	});
	assert.equal(jsonShaped.payload, "[1,2]");
	assert.deepEqual(resolveAndValidateInputs(inputSchema, jsonShaped, 'workflow "demo"'), {
		payload: "[1,2]",
		slug: "abc",
		tag: "fast",
		count: 4,
		ratio: 0.5,
	});

	const structuredSchema: Readonly<Record<string, WorkflowInputSchema>> = {
		items: Type.Array(Type.String()),
		config: Type.Object({ retries: Type.Number() }),
	};
	const structuredFields = deriveInputFields(structuredSchema);
	const coercedStructured = coerceValues(structuredFields, {
		items: '["a","b"]',
		config: '{"retries":3}',
	});
	assert.deepEqual(coercedStructured, {
		items: ["a", "b"],
		config: { retries: 3 },
	});
	assert.deepEqual(resolveAndValidateInputs(structuredSchema, coercedStructured, 'workflow "structured"'), {
		items: ["a", "b"],
		config: { retries: 3 },
	});

	const countField = fields.find((f) => f.name === "count")!;
	assert.match(invalidForField(countField, "-0", 0) ?? "", /2/);
	assert.match(invalidForField(countField, "9", 0) ?? "", /8/);
	assert.equal(invalidForField(countField, "2", 0), null);

	const slugField = fields.find((f) => f.name === "slug")!;
	assert.match(invalidForField(slugField, "ab", 0) ?? "", /minLength 3/);
	assert.match(invalidForField(slugField, "abcdefg", 0) ?? "", /maxLength 6/);
	assert.match(invalidForField(slugField, "ABC", 0) ?? "", /pattern/);
	assert.equal(invalidForField(slugField, "abc", 0), null);

	const tagField = fields.find((f) => f.name === "tag")!;
	assert.match(invalidForField(tagField, "slow", 0) ?? "", /must equal "fast"/);
	assert.equal(invalidForField(tagField, "fast", 0), null);

	let hostRendered = "";
	await openHostInputsForm(
		{
			hostInputForm: async (request) => {
				const frame = serializeInteractiveEngineFrame({
					type: "engine_input_form_open",
					componentId: "c1",
					title: request.title,
					fields: request.fields,
				});
				const parsed = parseInteractiveEngineMessage(frame);
				assert.ok(parsed && parsed.type === "engine_input_form_open");
				const host = makeHostForm(parsed.fields, parsed.title);
				hostRendered = host.plainAt(100);
				return undefined;
			},
		},
		{
			workflowName: "demo",
			fields,
			prefilled: { payload: '{"a":1}', slug: "ab", tag: "slow", count: -0, ratio: 0 },
		},
	);
	assert.match(hostRendered, /payload +.*✓/);
	assert.match(hostRendered, /slug +.*✗/);
	assert.match(hostRendered, /tag +.*✗/);
	assert.match(hostRendered, /count +.*✗/);
	assert.match(hostRendered, /ratio +.*✗/);

	const singleSchemas: ReadonlyArray<WorkflowInputSchema> = [
		Type.String(),
		Type.Optional(Type.String()),
		Type.String({ default: "hello" }),
		Type.String({ minLength: 2, maxLength: 4 }),
		Type.String({ pattern: "^[a-z]+$" }),
		Type.Literal("exact"),
		Type.Integer({ minimum: 2, maximum: 5 }),
		Type.Optional(Type.Integer({ minimum: 2, maximum: 5 })),
		Type.Number({ minimum: 0.5, maximum: 2.5 }),
		Type.Boolean(),
		Type.Union([Type.Literal("fast"), Type.Literal("careful")]),
	];
	const sampleValues = [
		"",
		" ",
		"\t",
		"a",
		"abc",
		"exact",
		"[1,2]",
		'{"a":1}',
		"-0",
		"1",
		"2",
		"6",
		"1.5",
		"true",
		"yes",
		"fast",
	];
	for (const def of singleSchemas) {
		const singleMap = { f: def };
		const derived = deriveInputFields(singleMap);
		for (const rawVal of sampleValues) {
			const pickerValid = computeInvalid(derived, { f: rawVal }).length === 0;
			let hostValid = false;
			await openHostInputsForm(
				{
					hostInputForm: async (request) => {
						const host = makeHostForm(request.fields);
						host.component.handleInput("\t");
						host.component.handleInput("\r");
						hostValid = host.submitted.length === 1;
						return undefined;
					},
				},
				{ workflowName: "matrix", fields: derived, prefilled: { f: rawVal } },
			);
			assert.equal(
				hostValid,
				pickerValid,
				`host vs picker mismatch for ${JSON.stringify(def)} raw=${JSON.stringify(rawVal)}`,
			);
			if (pickerValid) {
				const coerced = coerceValues(derived, { f: rawVal });
				const resolved = resolveInputs(singleMap, coerced);
				const engineErrors = validateInputs(singleMap, resolved);
				assert.deepEqual(
					engineErrors,
					[],
					`form showed ✓ but engine rejected ${JSON.stringify(def)} raw=${JSON.stringify(rawVal)} coerced=${JSON.stringify(coerced)}`,
				);
			}
		}
	}
});

test("whitespace-only optional text and string inputs are omitted so declared defaults survive (#5245)", () => {
	const inputSchema: Readonly<Record<string, WorkflowInputSchema>> = {
		greeting: Type.String({ default: "hello" }),
		note: Type.Optional(Type.String()),
	};
	const fields = deriveInputFields(inputSchema);
	for (const ws of [" ", "\t", "\u00a0", "\ufeff", "\u2028"]) {
		const coerced = coerceValues(fields, { greeting: ws, note: ws });
		assert.deepEqual(coerced, {}, `whitespace ${JSON.stringify(ws)} should be omitted`);
		const resolved = resolveAndValidateInputs(inputSchema, coerced, 'workflow "ws"');
		assert.deepEqual(resolved, { greeting: "hello" });
	}
});

test("control sequences in field names, descriptions, choices, and values are sanitized in rendered lines while preserving raw values on submit (#5245)", () => {
	const payloads = ["\x1b[2J", "\x1b]52;c;QVVESVQ=\x07", "\x1b]0;pwn\x07", "a\rb", "a\x07b"];
	const graphTheme = deriveGraphTheme({});

	for (const payload of payloads) {
		const rawName = `field_${payload}`;
		const rawChoice = `choice_${payload}`;
		const rawDesc = `desc_${payload}`;
		const rawVal = `val_${payload}`;
		const fields: WorkflowInputEntry[] = [
			{ name: rawName, type: "string", required: true, description: rawDesc },
			{ name: "sel", type: "select", required: true, choices: [rawChoice] },
		];
		const state = createInputsPickerState(fields, { [rawName]: rawVal, sel: rawChoice });
		const pickerLines = renderInputsPicker({
			width: 80,
			theme: graphTheme,
			workflowName: `wf_${payload}`,
			fields,
			state,
			cursorOn: true,
		});
		for (const line of pickerLines) {
			assert.equal(line.includes("\x1b[2J"), false, `picker leaked CSI 2J for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\x1b]52;"), false, `picker leaked OSC 52 for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\x1b]0;"), false, `picker leaked OSC 0 for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\r"), false, `picker leaked CR for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\x07"), false, `picker leaked BEL for ${JSON.stringify(payload)}`);
		}
		state.focusedIdx = fields.length;
		const pickerSubmit = handleInputsPickerInput("\r", state, fields, KB);
		assert.deepEqual(pickerSubmit, {
			kind: "run",
			values: { [rawName]: rawVal, sel: rawChoice },
		});

		_resetForms();
		const inlineState = createForm({
			formId: `wf-i5-${payload.length}`,
			workflowName: `wf_${payload}`,
			fields,
			rawText: { [rawName]: rawVal, sel: rawChoice },
			focusedIdx: 0,
			caret: rawVal.length,
			status: "editing",
		});
		const inlineLines = renderInlineCard({ width: 80, state: inlineState, theme: graphTheme });
		inlineState.status = "submitted";
		const submittedLines = renderInlineCard({ width: 80, state: inlineState, theme: graphTheme });
		for (const line of [...inlineLines, ...submittedLines]) {
			assert.equal(line.includes("\x1b[2J"), false);
			assert.equal(line.includes("\x1b]52;"), false);
			assert.equal(line.includes("\x1b]0;"), false);
			assert.equal(line.includes("\r"), false);
			assert.equal(line.includes("\x07"), false);
		}

		const host = makeHostForm(
			[
				{ name: rawName, type: "string", required: true, description: rawDesc, initialValue: rawVal },
				{ name: "notes", type: "text", required: true, initialValue: rawVal },
				{ name: "sel", type: "select", required: true, choices: [rawChoice], initialValue: rawChoice },
			],
			`wf_${payload}`,
		);
		host.component.handleInput("!");
		const hostLinesFocused0 = host.component.render(80);
		host.component.handleInput("\t");
		const hostLinesFocused1 = host.component.render(80);
		for (const rawLine of [...hostLinesFocused0, ...hostLinesFocused1]) {
			const line = rawLine.replace(/\x1b_pi:(?:\/?fc|c)\x07/g, "");
			assert.equal(line.includes("\x1b[2J"), false, `host leaked CSI 2J for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\x1b]52;"), false, `host leaked OSC 52 for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\x1b]0;"), false, `host leaked OSC 0 for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\r"), false, `host leaked CR for ${JSON.stringify(payload)}`);
			assert.equal(line.includes("\x07"), false, `host leaked BEL for ${JSON.stringify(payload)}`);
		}
		host.component.handleInput("\t");
		host.component.handleInput("\t");
		host.component.handleInput("\r");
		assert.deepEqual(host.submitted, [{ [rawName]: `${rawVal}!`, notes: rawVal, sel: rawChoice }]);
	}
});

test("host input form bounds heading and body to the requested width down to 1 column (#5245)", () => {
	const host = makeHostForm([
		{
			name: "objective",
			type: "string",
			required: true,
			description: "Describe the workflow objective in detail.",
			initialValue: "Fix narrow width overflow",
		},
		{ name: "mode", type: "select", required: true, choices: ["fast", "careful"], initialValue: "fast" },
		{ name: "dry_run", type: "boolean", required: true, initialValue: "true" },
	]);
	for (const width of [1, 2, 4, 8, 12, 18]) {
		const lines = host.component.render(width);
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= width,
				`width=${width}: line has visibleWidth=${visibleWidth(line)}: ${JSON.stringify(stripVTControlCharacters(line))}`,
			);
		}
	}
});
