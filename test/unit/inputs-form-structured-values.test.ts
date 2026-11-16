import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type Terminal, TuiMainScreen } from "@bastani/atomic-tui";
import { type TSchema, Type } from "typebox";
import { beforeAll, test } from "vitest";
import type { HostInputFormField } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { HostInputFormComponent } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import type { PiHostInputFormRequest } from "../../packages/workflows/src/extension/ui-surface.ts";
import { resolveAndValidateInputs } from "../../packages/workflows/src/runs/foreground/executor-inputs.ts";
import { deriveInputFields } from "../../packages/workflows/src/shared/schema-introspection.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { openHostInputsForm } from "../../packages/workflows/src/tui/host-input-form.ts";
import { coerceValues, invalidForField, renderInputsPicker } from "../../packages/workflows/src/tui/inputs-picker.ts";
import { createInputsPickerState } from "../../packages/workflows/src/tui/inputs-picker-types.ts";

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

function engineAccepts(schema: TSchema, values: Record<string, unknown>): boolean {
	try {
		resolveAndValidateInputs({ f: schema }, values, "test");
		return true;
	} catch {
		return false;
	}
}

async function hostFieldFor(schema: TSchema): Promise<HostInputFormField> {
	let captured: HostInputFormField | undefined;
	await openHostInputsForm(
		{
			hostInputForm: async (request: PiHostInputFormRequest) => {
				captured = request.fields[0] as HostInputFormField;
				return undefined;
			},
		},
		{ workflowName: "demo", fields: deriveInputFields({ f: schema }) },
	);
	assert.ok(captured);
	return captured;
}

function hostReason(field: HostInputFormField, raw: string): string {
	const component = new HostInputFormComponent(
		new TuiMainScreen(new QuietTerminal()),
		theme,
		new KeybindingsManager(),
		{ title: "demo", fields: [{ ...field, initialValue: raw }] },
		{ onSubmit: () => {}, onCancel: () => {} },
	);
	const label = component
		.render(120)
		.map((line) => stripVTControlCharacters(line))
		.find((line) => line.includes(" f "));
	assert.ok(label);
	return label;
}

const CASES: ReadonlyArray<readonly [string, TSchema, readonly string[]]> = [
	["Type.Literal(5)", Type.Literal(5), ["5", "6", "five"]],
	["Type.Literal(true)", Type.Literal(true), ["true", "false", "TRUE"]],
	["a union of 1, 2 and 3", Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]), ["2", "9"]],
	["a nullable number", Type.Union([Type.Number(), Type.Null()]), ["5", "null", "abc"]],
	["a nullable boolean", Type.Union([Type.Boolean(), Type.Null()]), ["true", "maybe"]],
	["a string array", Type.Array(Type.String()), ['["a","b"]', "abc", "{}", "[a,b]"]],
	["an object", Type.Object({ a: Type.Number() }), ['{"a":1}', "[]", "{a:1}", '{"a":"x"}']],
	["a record", Type.Record(Type.String(), Type.Number()), ['{"a":1}', '{"a":"x"}']],
	["an unknown value", Type.Unknown(), ["[draft]", "plain", '{"a":1}']],
];

for (const [label, schema, raws] of CASES) {
	test(`the inputs forms mark ${label} ready exactly when the run accepts the submitted value (#5245)`, async () => {
		const fields = deriveInputFields({ f: schema });
		const hostField = await hostFieldFor(schema);
		for (const raw of raws) {
			const values = coerceValues(fields, { f: raw });
			const accepted = engineAccepts(schema, values);
			assert.ok(Object.hasOwn(values, "f"), `${raw}: the value is dropped from ${JSON.stringify(values)}`);
			const reason = invalidForField(fields[0]!, raw, 0);
			assert.equal(
				reason === null,
				accepted,
				`${raw}: form says ${reason ?? "ready"}, values ${JSON.stringify(values)}`,
			);
			const hostLabel = hostReason(hostField, raw);
			assert.equal(hostLabel.includes("✓"), accepted, `${raw}: host form shows ${hostLabel}`);
		}
	});
}

test("a typed constant number or boolean can be submitted (#5245)", () => {
	const fields = deriveInputFields({ n: Type.Literal(5), b: Type.Literal(true) });
	assert.equal(invalidForField(fields[0]!, "5", 0), null);
	assert.equal(invalidForField(fields[1]!, "true", 1), null);
	assert.deepEqual(coerceValues(fields, { n: "5", b: "true" }), { n: 5, b: true });
});

test("text that is not JSON stays a literal string for an unknown input (#5245)", () => {
	const fields = deriveInputFields({ f: Type.Unknown() });
	assert.deepEqual(coerceValues(fields, { f: "[draft]" }), { f: "[draft]" });
	assert.equal(invalidForField(fields[0]!, "[draft]", 0), null);
});

test("an unchanged value is validated once, not on every frame (#5245)", () => {
	const slow = `${"a".repeat(22)}!`;
	const graphTheme = deriveGraphTheme({});
	const fields = deriveInputFields({ f: Type.String({ pattern: "^(a+)+$" }) });
	let started = performance.now();
	const state = createInputsPickerState(fields, { f: slow });
	const firstCheck = performance.now() - started;
	renderInputsPicker({ width: 80, theme: graphTheme, workflowName: "w", fields, state, cursorOn: false });
	started = performance.now();
	for (let frame = 0; frame < 5; frame++)
		renderInputsPicker({ width: 80, theme: graphTheme, workflowName: "w", fields, state, cursorOn: false });
	const laterFrames = performance.now() - started;
	assert.ok(laterFrames < firstCheck, `5 picker frames took ${laterFrames} ms, one check ${firstCheck} ms`);

	started = performance.now();
	const component = new HostInputFormComponent(
		new TuiMainScreen(new QuietTerminal()),
		theme,
		new KeybindingsManager(),
		{ title: "demo", fields: [{ name: "f", type: "string", initialValue: slow, pattern: "^(a+)+$" }] },
		{ onSubmit: () => {}, onCancel: () => {} },
	);
	const hostFirstCheck = performance.now() - started;
	component.render(80);
	started = performance.now();
	for (let frame = 0; frame < 5; frame++) component.render(80);
	const hostLaterFrames = performance.now() - started;
	assert.ok(
		hostLaterFrames < hostFirstCheck,
		`5 host frames took ${hostLaterFrames} ms, one check ${hostFirstCheck} ms`,
	);
});
