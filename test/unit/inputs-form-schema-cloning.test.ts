import assert from "node:assert/strict";
import { type TSchema, Type } from "typebox";
import { test } from "vitest";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.ts";
import {
	parseWorkflowArgs,
	tokenizeWorkflowArgs,
} from "../../packages/workflows/src/extension/workflow-command-utils.ts";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.ts";
import {
	renderWorkflowToolContent,
	workflowGetResult,
} from "../../packages/workflows/src/extension/workflow-tool-content.ts";
import { renderInputsSchema } from "../../packages/workflows/src/shared/render-inputs-schema.ts";
import { deriveInputField, deriveInputFields } from "../../packages/workflows/src/shared/schema-introspection.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.ts";

const graphTheme = deriveGraphTheme({});

test("workflow inputs and get tool outputs include declared constraints and JSON defaults without UI-only fields (#5224)", async () => {
	const wf = {
		normalizedName: "structured-wf",
		name: "structured-wf",
		description: "demo",
		inputs: {
			config: Type.Object({ retries: Type.Number() }, { default: { retries: 3 } }),
			items: Type.Array(Type.String(), { default: ["a", "b"] }),
			slug: Type.String({ minLength: 2, maxLength: 8, pattern: "^[a-z]+$", format: "hostname", const: "prod" }),
			count: Type.Integer({ minimum: 1, maximum: 10, exclusiveMinimum: 0, exclusiveMaximum: 11, multipleOf: 2 }),
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
	assert.equal(dispatched.action, "inputs");
	if (dispatched.action !== "inputs") return;
	assert.deepEqual(dispatched.inputs[0]?.default, { retries: 3 });
	assert.deepEqual(dispatched.inputs[1]?.default, ["a", "b"]);
	assert.equal(dispatched.inputs[2]?.minLength, 2);
	assert.equal(dispatched.inputs[2]?.maxLength, 8);
	assert.equal(dispatched.inputs[2]?.pattern, "^[a-z]+$");
	assert.equal(dispatched.inputs[2]?.format, "hostname");
	assert.equal(dispatched.inputs[2]?.const, "prod");
	assert.equal(dispatched.inputs[3]?.minimum, 1);
	assert.equal(dispatched.inputs[3]?.maximum, 10);
	assert.equal(dispatched.inputs[3]?.exclusiveMinimum, 0);
	assert.equal(dispatched.inputs[3]?.exclusiveMaximum, 11);
	assert.equal(dispatched.inputs[3]?.multipleOf, 2);

	const execute = makeExecuteWorkflowTool(runtime as never, () => undefined);
	const toolInputs = await execute({ action: "inputs", workflow: "structured-wf" }, {} as never);
	assert.equal(toolInputs.action, "inputs");
	if (toolInputs.action === "inputs") {
		for (const entry of toolInputs.inputs) {
			assert.equal("schema" in entry, false);
			assert.equal("validationDeferred" in entry, false);
		}
	}
	const renderedInputs = JSON.parse(
		renderWorkflowToolContent(dispatched, { action: "inputs", workflow: "structured-wf" }),
	);
	for (const entry of renderedInputs.inputs) {
		assert.equal("schema" in entry, false);
		assert.equal("validationDeferred" in entry, false);
	}

	const getRes = workflowGetResult(runtime as never, { action: "get", workflow: "structured-wf" });
	assert.equal(getRes.action, "get");
	if (getRes.action === "get" && getRes.details) {
		const getInputs = (getRes.details.output as { inputs: Array<Record<string, unknown>> }).inputs;
		for (const entry of getInputs) {
			assert.equal("schema" in entry, false);
			assert.equal("validationDeferred" in entry, false);
		}
	}
});

test.each([
	["BigInt", Type.Optional(Type.BigInt({ default: 1n }))],
	["primitive with BigInt default", Type.Number({ default: 1n as never })],
	["object containing BigInt", Type.Optional(Type.Object({ count: Type.BigInt() }, { default: { count: 1n } }))],
	[
		"null-prototype object containing BigInt",
		Type.Optional(
			Type.Object(
				{ count: Type.BigInt() },
				{ default: Object.assign(Object.create(null) as Record<string, bigint>, { count: 1n }) },
			),
		),
	],
	["function", Type.Optional(Type.String({ default: () => "runtime" }))],
	["symbol", Type.String({ default: Symbol("s") as never })],
	["Infinity", Type.Number({ default: Number.POSITIVE_INFINITY })],
	["-Infinity", Type.Number({ default: Number.NEGATIVE_INFINITY })],
	["NaN", Type.Number({ default: Number.NaN })],
	["Date", Type.String({ default: new Date(0) as never })],
	["RegExp", Type.String({ default: /x/ as never })],
	["Map", Type.Unknown({ default: new Map([["a", 1]]) })],
	["toJSON returning undefined", Type.Unknown({ default: { toJSON: () => undefined } })],
	["toJSON returning string", Type.Unknown({ default: { toJSON: () => "custom" } })],
	[
		"toJSON throwing",
		Type.Unknown({
			default: {
				toJSON: () => {
					throw new Error("boom");
				},
			},
		}),
	],
])("workflow inputs and get omit an unencodable or non-round-tripping %s default (#5224)", async (_label, schema) => {
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
		const rendered = renderInputsSchema("default-wf", result.inputs, options);
		assert.match(rendered, /value/);
		assert.doesNotMatch(rendered, /default:/);
	}
	const field = result.inputs[0]!;
	assert.equal(Object.hasOwn(field, "default"), false);
	assert.equal(field.required, false);
	const get = workflowGetResult({ registry } as never, { action: "get", workflow: "default-wf" });
	assert.doesNotThrow(() => JSON.stringify(get));
	assert.doesNotThrow(() => renderWorkflowToolContent(get, { action: "get", workflow: "default-wf" }));
});

test("cyclic schemas and cyclic defaults do not crash deriveInputField (#5224)", () => {
	const cyclic = Type.Object({ a: Type.Number() }) as TSchema & { self?: unknown; default?: unknown };
	cyclic.self = cyclic;
	const cyclicDefault: { self?: unknown } = {};
	cyclicDefault.self = cyclicDefault;
	cyclic.default = cyclicDefault;
	const field = deriveInputField("cyclic", cyclic);
	assert.equal(Object.hasOwn(field, "default"), false);
	assert.equal(field.required, false);
});

test("a trailing backslash inside double quotes does not swallow following arguments (#5224)", () => {
	const parsed = parseWorkflowArgs(tokenizeWorkflowArgs('dir="C:\\tmp\\" n=3'));
	assert.equal(parsed.n, 3);
	assert.equal(parsed.dir, '"C:\\tmp\\"');
});

test("inputs and argument parsing preserve __proto__ and constructor keys as own properties (#5224)", () => {
	const schemaMap: Record<string, TSchema> = {};
	Object.defineProperty(schemaMap, "__proto__", {
		value: Type.String({ default: "proto-default" }),
		enumerable: true,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(schemaMap, "constructor", {
		value: Type.Number({ default: 7 }),
		enumerable: true,
		configurable: true,
		writable: true,
	});
	const fields = deriveInputFields(schemaMap);
	assert.deepEqual(
		fields.map((f) => ({ name: f.name, type: f.type, default: f.default })),
		[
			{ name: "__proto__", type: "text", default: "proto-default" },
			{ name: "constructor", type: "number", default: 7 },
		],
	);
	const parsed = parseWorkflowArgs(["__proto__=alpha", "constructor=42"]);
	assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
	assert.equal(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value, "alpha");
	assert.equal(Object.getOwnPropertyDescriptor(parsed, "constructor")?.value, 42);
});
