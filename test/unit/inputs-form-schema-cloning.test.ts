import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Terminal, TuiMainScreen } from "@bastani/atomic-tui";
import { type TSchema, Type } from "typebox";
import { beforeAll, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { HostInputFormComponent } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.ts";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.ts";
import {
	renderWorkflowToolContent,
	workflowGetResult,
} from "../../packages/workflows/src/extension/workflow-tool-content.ts";
import { resolveAndValidateInputs } from "../../packages/workflows/src/runs/foreground/executor-inputs.ts";
import { deriveInputField, deriveInputFields } from "../../packages/workflows/src/shared/schema-introspection.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { openHostInputsForm } from "../../packages/workflows/src/tui/host-input-form.ts";
import {
	coerceValues,
	createInputsPickerState,
	initialInputText,
	invalidForField,
	renderInputsPicker,
} from "../../packages/workflows/src/tui/inputs-picker.ts";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.ts";

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

test("initialInputText serializes non-null default and prefilled objects and arrays as JSON (#5245)", async () => {
	const schema = {
		config: Type.Object({ retries: Type.Number() }, { default: { retries: 3 } }),
		items: Type.Array(Type.String(), { default: ["a", "b"] }),
	};
	const fields = deriveInputFields(schema);
	assert.equal(initialInputText(fields[0]!, {}), '{"retries":3}');
	assert.equal(initialInputText(fields[1]!, {}), '["a","b"]');
	assert.equal(initialInputText(fields[0]!, { config: { retries: 5 } }), '{"retries":5}');
	assert.equal(initialInputText(fields[1]!, { items: ["x", "y"] }), '["x","y"]');
	const state = createInputsPickerState(fields, {});
	assert.equal(invalidForField(fields[0]!, state.rawText.config!, 0), null);
	assert.equal(invalidForField(fields[1]!, state.rawText.items!, 1), null);
	const coerced = coerceValues(fields, state.rawText);
	assert.deepEqual(coerced, { config: { retries: 3 }, items: ["a", "b"] });
	assert.deepEqual(resolveAndValidateInputs(schema, coerced, "test"), {
		config: { retries: 3 },
		items: ["a", "b"],
	});
});

test("unknown and any object and array defaults keep their JSON values (#5245)", () => {
	for (const schema of [Type.Unknown({ default: { a: 1 } }), Type.Any({ default: [1, 2] })]) {
		const fields = deriveInputFields({ f: schema });
		const state = createInputsPickerState(fields, {});
		assert.equal(state.rawText.f, JSON.stringify(fields[0]!.default));
		assert.deepEqual(coerceValues(fields, state.rawText), { f: fields[0]!.default });
	}
});

test("deriveInputField omits schema and ready mark for Type.Refine inputs (#5245)", async () => {
	const refinedObj = Type.Refine(
		Type.Object({ a: Type.Number() }),
		(value) => value.a > 0,
		() => "a must be positive",
	);
	const nestedRefined = Type.Object({
		a: Type.Refine(
			Type.Number(),
			(value) => value > 0,
			() => "a must be positive",
		),
	});
	for (const schema of [refinedObj, nestedRefined]) {
		const fields = deriveInputFields({ f: schema });
		assert.equal(fields[0]!.schema, undefined);
		assert.equal(fields[0]!.validationDeferred, true);
		assert.equal(invalidForField(fields[0]!, '{"a":-1}', 0), null);
		const state = createInputsPickerState(fields, { f: { a: -1 } });
		const rendered = renderInputsPicker({
			width: 80,
			theme: graphTheme,
			workflowName: "demo",
			fields,
			state,
			cursorOn: false,
		})
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		assert.doesNotMatch(rendered, / f ✓/);
		assert.match(rendered, / f \?/);
		const hostOut = await openHostInputsForm(
			{ hostInputForm: async () => ({ f: '{"a":-1}' }) },
			{ workflowName: "demo", fields },
		);
		assert.deepEqual(hostOut, { kind: "unsupported" });
	}
});

test("non-finite parsed JSON numbers are rejected instead of accepted as Infinity (#5245)", () => {
	const arrFields = deriveInputFields({ f: Type.Array(Type.Unknown()) });
	assert.notEqual(invalidForField(arrFields[0]!, "[1e309]", 0), null);
	const objFields = deriveInputFields({ f: Type.Object({ a: Type.Unknown() }) });
	assert.notEqual(invalidForField(objFields[0]!, '{"a":1e309}', 0), null);
	const unkFields = deriveInputFields({ f: Type.Unknown() });
	for (const schema of [Type.Unknown(), Type.Any(), Type.Array(Type.Unknown())]) {
		const field = deriveInputField("f", schema);
		for (const value of ["1e999", "[1e999]", '{"a":1e999}']) {
			assert.notEqual(invalidForField(field, value, 0), null);
		}
	}
	const coercedUnk = coerceValues(unkFields, { f: "[1e309]" });
	assert.deepEqual(coercedUnk, { f: "[1e309]" });
	assert.deepEqual(resolveAndValidateInputs({ f: Type.Unknown() }, coercedUnk, "test"), {
		f: "[1e309]",
	});

	const component = new HostInputFormComponent(
		new TuiMainScreen(new QuietTerminal()),
		theme,
		new KeybindingsManager(),
		{
			title: "demo",
			fields: [
				{
					name: "f",
					type: "string",
					required: true,
					initialValue: "[1e309]",
					schema: arrFields[0]!.schema,
				},
			],
		},
		{ onSubmit: () => {}, onCancel: () => {} },
	);
	const hostText = component
		.render(100)
		.map((line) => stripVTControlCharacters(line))
		.join("\n");
	assert.doesNotMatch(hostText, /✓/);
	assert.match(hostText, /✗/);
});

test("schema checking reports unexpected errors instead of claiming readiness (#5245)", () => {
	const field = deriveInputField("f", Type.Object({ a: Type.Number() }));
	assert.ok(field.schema);
	Object.defineProperty(field.schema, "type", {
		get() {
			throw new TypeError("broken schema dereference");
		},
	});
	assert.equal(invalidForField(field, '{"a":1}', 0), "broken schema dereference");
	const component = new HostInputFormComponent(
		new TuiMainScreen(new QuietTerminal()),
		theme,
		new KeybindingsManager(),
		{
			title: "demo",
			fields: [{ name: "f", type: "string", required: true, initialValue: '{"a":1}', schema: field.schema }],
		},
		{ onSubmit: () => {}, onCancel: () => {} },
	);
	assert.match(stripVTControlCharacters(component.render(100).join("\n")), /✗ broken schema dereference/);
});

test("model-facing inputs and get tool outputs omit field.schema while dispatch keeps it for forms (#5245)", async () => {
	const wf = {
		normalizedName: "structured-wf",
		name: "structured-wf",
		description: "demo",
		inputs: {
			config: Type.Object({ retries: Type.Number() }),
			items: Type.Array(Type.String()),
		},
		run: async () => ({}),
	};
	const registry = createRegistry([wf as never]);
	const runtime = {
		registry,
		dispatch: (args: Parameters<typeof dispatch>[0], opts?: Partial<Parameters<typeof dispatch>[1]>) =>
			dispatch(args, { registry, ...opts }),
		inspectDurableWorkflow: async () => ({ kind: "not_found" as const, message: "not found" }),
		resumeDurableWorkflow: async () => ({ status: "failed" as const, message: "not found" }),
	};

	const dispatched = await runtime.dispatch({ action: "inputs", workflow: "structured-wf" });
	assert.ok(dispatched.action === "inputs");
	assert.notEqual(dispatched.inputs[0]!.schema, undefined);

	const execute = makeExecuteWorkflowTool(runtime as never, () => undefined);
	const toolInputs = await execute({ action: "inputs", workflow: "structured-wf" }, {} as never);
	assert.ok(toolInputs.action === "inputs");
	for (const entry of toolInputs.inputs) {
		assert.equal("schema" in entry, false);
		assert.equal("validationDeferred" in entry, false);
	}
	const renderedInputs = JSON.parse(
		renderWorkflowToolContent(dispatched, { action: "inputs", workflow: "structured-wf" }),
	);
	for (const entry of renderedInputs.inputs) {
		assert.equal("schema" in entry, false);
	}

	const getRes = workflowGetResult(runtime as never, { action: "get", workflow: "structured-wf" });
	assert.ok(getRes.action === "get");
	assert.ok(getRes.details);
	const getInputs = (getRes.details.output as { inputs: Array<Record<string, unknown>> }).inputs;
	for (const entry of getInputs) {
		assert.equal("schema" in entry, false);
		assert.equal("validationDeferred" in entry, false);
	}
});

test("deriveInputField does not swallow a failed schema clone silently (#5245)", () => {
	const cyclic = Type.Object({ a: Type.Number() }) as TSchema & { self?: unknown };
	cyclic.self = cyclic;
	assert.throws(() => deriveInputField("bad", cyclic), TypeError);
});
