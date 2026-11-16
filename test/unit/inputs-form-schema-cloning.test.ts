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
import { renderInputsSchema } from "../../packages/workflows/src/shared/render-inputs-schema.ts";
import { deriveInputField, deriveInputFields } from "../../packages/workflows/src/shared/schema-introspection.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { openHostInputsForm } from "../../packages/workflows/src/tui/host-input-form.ts";
import { renderInlineCard } from "../../packages/workflows/src/tui/inline-form-card.ts";
import { openInputsPicker } from "../../packages/workflows/src/tui/inputs-overlay.ts";
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

test("refined inputs retain structural checks while deferring their runtime refinements (#5245)", async () => {
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
	const refinedArray = Type.Refine(Type.Array(Type.Number()), (value) => value.length > 0);
	for (const [schema, validText, invalidText, reason] of [
		[refinedObj, '{"a":-1}', '{"a":"x"}', /must be number/],
		[nestedRefined, '{"a":-1}', '{"a":"x"}', /must be number/],
		[refinedArray, "[]", "x", /must be array/],
	] as const) {
		const fields = deriveInputFields({ f: schema });
		assert.match(invalidForField(fields[0]!, invalidText, 0)!, reason);
		assert.equal(invalidForField(fields[0]!, validText, 0), null);
		assert.equal(fields[0]!.validationDeferred, true);
		const state = createInputsPickerState(fields);
		state.rawText.f = validText;
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
		for (const raw of [validText, invalidText]) {
			state.rawText.f = raw;
			const pickerText = stripVTControlCharacters(
				renderInputsPicker({
					width: 80,
					theme: graphTheme,
					workflowName: "demo",
					fields,
					state,
					cursorOn: false,
				}).join("\n"),
			);
			const inlineText = stripVTControlCharacters(
				renderInlineCard({
					width: 80,
					theme: graphTheme,
					state: { ...state, fields, formId: "refined", workflowName: "demo", status: "editing", version: 0 },
				}).join("\n"),
			);
			for (const text of [pickerText, inlineText]) {
				if (raw === validText) assert.match(text, / f \?/);
				else {
					assert.match(text, / f ✗/);
					assert.match(text, reason);
				}
			}
		}
		const hostOut = await openHostInputsForm(
			{ hostInputForm: async () => ({ f: '{"a":-1}' }) },
			{ workflowName: "demo", fields },
		);
		assert.deepEqual(hostOut, { kind: "unsupported" });
	}
});

test("non-finite JSON uses the literal string only when that string matches the schema (#5245)", async () => {
	for (const [schema, text, ready] of [
		[Type.Union([Type.String(), Type.Number()]), "1e9999", true],
		[Type.Union([Type.Number(), Type.Null()]), "1e9999", false],
		[Type.Unknown(), "1e9999", true],
		[Type.Any(), "[1e999]", true],
		[Type.Array(Type.Unknown()), "[1e999]", false],
		[Type.Object({ a: Type.Unknown() }), '{"a":1e999}', false],
	] as const) {
		const fields = deriveInputFields({ f: schema });
		const state = createInputsPickerState(fields);
		state.rawText.f = text;
		const values = coerceValues(fields, state.rawText);
		assert.deepEqual(values, { f: text });
		assert.equal(invalidForField(fields[0]!, text, 0) === null, ready);
		if (ready) assert.deepEqual(resolveAndValidateInputs({ f: schema }, values, "test"), values);
		else assert.throws(() => resolveAndValidateInputs({ f: schema }, values, "test"));
		const component = new HostInputFormComponent(
			new TuiMainScreen(new QuietTerminal()),
			theme,
			new KeybindingsManager(),
			{
				title: "demo",
				fields: [{ name: "f", type: "string", required: true, initialValue: text, schema: fields[0]!.schema }],
			},
			{ onSubmit: () => {}, onCancel: () => {} },
		);
		const rendered = [
			component.render(100),
			renderInputsPicker({ width: 100, theme: graphTheme, workflowName: "demo", fields, state, cursorOn: false }),
			renderInlineCard({
				width: 100,
				theme: graphTheme,
				state: { ...state, fields, formId: "finite", workflowName: "demo", status: "editing", version: 0 },
			}),
		];
		for (const lines of rendered) {
			const renderedText = stripVTControlCharacters(lines.join("\n"));
			assert.match(renderedText, ready ? /✓/ : /✗/);
			assert.doesNotMatch(renderedText, ready ? /✗/ : /✓/);
		}
		if (ready) {
			assert.deepEqual(
				await openHostInputsForm({ hostInputForm: async () => ({ f: text }) }, { workflowName: "demo", fields }),
				{ kind: "run", values },
			);
		}
	}
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

test.each([
	["BigInt", Type.Optional(Type.BigInt({ default: 1n }))],
	["object containing BigInt", Type.Optional(Type.Object({ count: Type.BigInt() }, { default: { count: 1n } }))],
	["function", Type.Optional(Type.String({ default: () => "runtime" }))],
])("workflow inputs and get omit an unencodable %s default (#5245)", async (_label, schema) => {
	const registry = createRegistry([
		{
			normalizedName: "default-wf",
			name: "default-wf",
			description: "demo",
			inputs: { value: schema },
			run: async () => ({}),
		} as never,
	]);
	const result = await dispatch({ action: "inputs", workflow: "default-wf" }, { registry });
	assert.equal(result.action, "inputs");
	if (result.action !== "inputs") return;
	assert.doesNotThrow(() => renderWorkflowToolContent(result, { action: "inputs", workflow: "default-wf" }));
	for (const options of [{}, { theme: graphTheme }]) {
		assert.match(renderInputsSchema("default-wf", result.inputs, options), /value/);
	}
	const field = result.inputs[0]!;
	assert.equal(Object.hasOwn(field, "default"), false);
	assert.equal(field.required, false);
	assert.equal(field.validationDeferred, true);
	const get = workflowGetResult({ registry } as never, { action: "get", workflow: "default-wf" });
	assert.doesNotThrow(() => JSON.stringify(get));
	assert.doesNotThrow(() => renderWorkflowToolContent(get, { action: "get", workflow: "default-wf" }));
});

test("an input whose schema cannot be copied defers validation instead of crashing (#5245)", () => {
	const cyclic = Type.Object({ a: Type.Number() }) as TSchema & { self?: unknown };
	cyclic.self = cyclic;
	const field = deriveInputField("cyclic", cyclic);
	assert.equal(field.schema, undefined);
	assert.equal(field.validationDeferred, true);
});

test("picker defaults that cannot be JSON encoded start blank instead of coercing or throwing (#5245)", () => {
	const cyclic: { self?: object } = {};
	cyclic.self = cyclic;
	const nullPrototype = Object.assign(Object.create(null), { count: 1n });
	for (const value of [
		1n,
		{ count: 1n },
		nullPrototype,
		cyclic,
		{ toJSON: () => undefined },
		() => "runtime",
		Symbol("default"),
	]) {
		const field = { name: "config", type: "unknown", required: false, default: value };
		assert.equal(initialInputText(field, {}), "");
		assert.equal(createInputsPickerState([field]).rawText.config, "");
	}
});

test("an optional object input with a BigInt default opens a cancellable form (#5245)", async () => {
	const fields = deriveInputFields({
		config: Type.Optional(Type.Object({ count: Type.BigInt({ default: 1n }) }, { default: { count: 1n } })),
	});
	assert.equal(fields[0]!.schema, undefined);
	assert.equal(fields[0]!.validationDeferred, true);
	assert.equal(initialInputText(fields[0]!, {}), "");
	let rendered = "";
	const result = await openInputsPicker(
		{
			custom: async (factory) => {
				const component = await factory({ requestRender() {} }, undefined, undefined, () => {});
				rendered = stripVTControlCharacters(component.render(80).join("\n"));
				component.handleInput?.("\x1b");
				return undefined;
			},
		},
		{ workflowName: "demo", fields, theme: graphTheme },
	);
	assert.match(rendered, /config \?/);
	assert.deepEqual(result, { kind: "cancel" });
});
