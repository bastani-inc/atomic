import { describe } from "vitest";
import { resolveInputEnvironmentBinding } from "../../packages/workflows/src/runs/foreground/executor-inputs.js";
import { assert, resolveInputs, Type, test } from "./executor-shared.js";

describe("resolveInputs", () => {
	test("applies defaults for missing optional inputs", () => {
		const result = resolveInputs(
			{
				foo: Type.String({ default: "bar" }),
				count: Type.Number({ default: 42 }),
			},
			{},
		);
		assert.equal(result.foo, "bar");
		assert.equal(result.count, 42);
	});

	test("passes through provided values", () => {
		const result = resolveInputs({ foo: Type.String({ default: "bar" }) }, { foo: "override" });
		assert.equal(result.foo, "override");
	});

	test("does not override provided value with default", () => {
		const result = resolveInputs({ flag: Type.Boolean({ default: false }) }, { flag: true });
		assert.equal(result.flag, true);
	});

	test("throws for missing required input", () => {
		assert.throws(() => resolveInputs({ prompt: Type.String() }, {}), {
			message: 'atomic-workflows: required input "prompt" not provided',
		});
	});

	test("does not throw when required input is provided", () => {
		const result = resolveInputs({ prompt: Type.String() }, { prompt: "hello" });
		assert.equal(result.prompt, "hello");
	});
});

describe("resolveInputEnvironmentBinding", () => {
	test("resolves a per-run template input to its complete configured binding", () => {
		const binding = resolveInputEnvironmentBinding(
			{ inputBindings: { environment: { template: "template" } } },
			{ template: "dev-windows" },
			{
				deployment: "https://coder.example.com",
				organization: "default",
				templates: {
					"dev-large": { preset: "standard" },
					"dev-windows": {
						preset: "standard",
						parameters: { instance_type: "Standard_D4s_v5" },
					},
				},
				defaultTemplate: "dev-large",
			},
		);

		assert.deepEqual(binding, {
			deployment: "https://coder.example.com",
			organization: "default",
			template: "dev-windows",
			preset: "standard",
			parameters: { instance_type: "Standard_D4s_v5" },
			idleMinutes: 240,
			retentionHours: 12,
		});
	});

	test("keeps local execution unchanged when no environment is configured", () => {
		assert.equal(resolveInputEnvironmentBinding({ inputBindings: {} }, {}, undefined), undefined);
	});

	test("resolves the single-template shorthand when no run input overrides it", () => {
		assert.deepEqual(
			resolveInputEnvironmentBinding(
				{ inputBindings: {} },
				{},
				{ deployment: "https://coder.example.com", template: "dev-large" },
			),
			{
				deployment: "https://coder.example.com",
				template: "dev-large",
				parameters: {},
				idleMinutes: 240,
				retentionHours: 12,
			},
		);
	});

	test("rejects a run input that names an unconfigured template", () => {
		assert.throws(
			() =>
				resolveInputEnvironmentBinding(
					{ inputBindings: { environment: { template: "template" } } },
					{ template: "missing" },
					{
						deployment: "https://coder.example.com",
						templates: { "dev-large": {} },
						defaultTemplate: "dev-large",
					},
				),
			{ message: 'atomic-workflows: environment template "missing" is not configured' },
		);
	});

	test("rejects an inherited Object prototype name as an unconfigured template", () => {
		assert.throws(
			() =>
				resolveInputEnvironmentBinding(
					{ inputBindings: { environment: { template: "template" } } },
					{ template: "toString" },
					{
						deployment: "https://coder.example.com",
						templates: { "dev-large": { preset: "standard" } },
						defaultTemplate: "dev-large",
					},
				),
			{ message: 'atomic-workflows: environment template "toString" is not configured' },
		);
	});

	test("rejects a run override outside a single-template shorthand binding", () => {
		assert.throws(
			() =>
				resolveInputEnvironmentBinding(
					{ inputBindings: { environment: { template: "template" } } },
					{ template: "other-template" },
					{ deployment: "https://coder.example.com", template: "dev-large" },
				),
			{ message: 'atomic-workflows: environment template "other-template" is not configured' },
		);
	});
});

// ---------------------------------------------------------------------------
// executor.run
// ---------------------------------------------------------------------------
